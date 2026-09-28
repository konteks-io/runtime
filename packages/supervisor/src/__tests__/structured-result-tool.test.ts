import { afterEach, describe, expect, it } from "vitest";
import {
  GENERIC_RESULT_TOOL,
  STRUCTURED_RESULT_MCP_SERVER_NAME,
  StructuredResultToolServer,
  toolInputSchema,
} from "../structured-result/result-tool-server.js";

const VERDICT = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { verdict: { type: "string", enum: ["pass", "fail"] }, notes: { type: "array", items: { type: "string" } } },
  required: ["verdict", "notes"],
  additionalProperties: false,
};

let server: StructuredResultToolServer | null = null;
const streams: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
afterEach(async () => {
  for (const reader of streams.splice(0)) await reader.cancel().catch(() => undefined);
  await server?.close();
  server = null;
});

async function started(relistWaitMs = 150) {
  server = new StructuredResultToolServer({ relistWaitMs });
  const entry = await server.start();
  const auth = entry.headers[0]!.value;
  const post = async (body: unknown) => (await fetch(entry.url, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) })).json() as Promise<{ result: Record<string, unknown> & { tools?: Array<Record<string, unknown>>; content?: Array<{ text: string }>; isError?: boolean } }>;
  const submit = (args: unknown, id = 9) => post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "submit_result", arguments: args } });
  const list = async () => (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools!;
  /** An agent's server-to-client event stream; `onListChanged` is how that agent reacts. */
  const openStream = async (onListChanged: () => void) => {
    const response = await fetch(entry.url, { headers: { authorization: auth, accept: "text/event-stream" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    streams.push(reader);
    void (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        if (decoder.decode(value).includes("notifications/tools/list_changed")) onListChanged();
      }
    })();
  };
  return { entry, auth, post, submit, list, openStream, server };
}

describe("turn result tool (loopback MCP)", () => {
  it("binds loopback with a per-session bearer, refuses anything else, and speaks MCP with listChanged", async () => {
    const { entry, auth, post } = await started();
    expect(entry).toEqual({ name: STRUCTURED_RESULT_MCP_SERVER_NAME, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/), headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer [A-Za-z0-9_-]{43}$/) }] });
    expect((await fetch(entry.url, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" })).status).toBe(401);
    // Codex probes OAuth discovery with plain GETs; only an event-stream GET is a stream.
    expect((await fetch(entry.url, { headers: { authorization: auth } })).status).toBe(405);
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } });
    expect(init).toMatchObject({ result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "konteks-result" } } });
    expect(await post({ jsonrpc: "2.0", id: 3, method: "server/discover" })).toMatchObject({ error: { code: -32601 } });
  });

  it("offers a generic submit_result until a turn asks, and refuses a call nobody asked for", async () => {
    const { list, submit, server: tool } = await started();
    expect(await list()).toEqual([GENERIC_RESULT_TOOL]);
    const answer = await submit({ verdict: "pass" });
    expect(answer.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("No result is requested") }] });
    expect(tool.result()).toBeNull();
  });

  it("validates each call against the turn's schema, says exactly what to fix, and keeps the first valid result", async () => {
    const { submit, server: tool } = await started();
    expect(await tool.bind(VERDICT)).toBe("generic");
    const wrong = await submit({ verdict: "maybe", extra: 1 });
    expect(wrong.result.isError).toBe(true);
    const text = wrong.result.content![0]!.text;
    expect(text).toContain("Not recorded");
    expect(text).toContain("- /verdict: must be equal to one of the allowed values: \"pass\", \"fail\"");
    expect(text).toContain("- /: must have required property 'notes'");
    expect(text).toContain("must NOT have additional properties (`extra`)");
    expect(tool.result()).toBeNull();
    const right = await submit({ verdict: "pass", notes: ["looks good"] });
    expect(right.result).toEqual({ content: [{ type: "text", text: expect.stringContaining("Recorded.") }] });
    const again = await submit({ verdict: "fail", notes: [] });
    expect(again.result.content![0]!.text).toContain("Already recorded");
    expect(again.result.isError).toBeUndefined();
    expect(tool.result()).toEqual({ value: { verdict: "pass", notes: ["looks good"] } });
    tool.unbind();
    expect(tool.result()).toBeNull();
  });

  it("announces the schema to an agent that re-reads its tools, and shows it as the input schema", async () => {
    const { list, openStream, server: tool } = await started();
    let relisted: Promise<unknown> | undefined;
    await openStream(() => { relisted = list(); });
    expect(await tool.bind(VERDICT)).toBe("schema");
    await relisted;
    const [bound] = await list();
    const { $schema: _draft, ...shape } = VERDICT;
    expect(bound).toMatchObject({ name: "submit_result", inputSchema: shape });
    expect(bound!.inputSchema).not.toHaveProperty("$schema");
    // The turn ended: the next list is generic again.
    tool.unbind();
    expect(await list()).toEqual([GENERIC_RESULT_TOOL]);
  });

  it("falls back to the generic definition for an agent that ignores list_changed, and stops waiting for it", async () => {
    const { openStream, server: tool } = await started(120);
    await openStream(() => undefined);
    const first = Date.now();
    expect(await tool.bind(VERDICT)).toBe("generic");
    expect(Date.now() - first).toBeGreaterThanOrEqual(100);
    tool.unbind();
    const second = Date.now();
    expect(await tool.bind(VERDICT)).toBe("generic");
    expect(Date.now() - second).toBeLessThan(100);
  });

  it("wraps a schema whose root is not an object in `result`", async () => {
    expect(toolInputSchema({ type: "array", items: { type: "string" }, $defs: { a: { type: "string" } } })).toEqual({
      inputSchema: { type: "object", properties: { result: { type: "array", items: { type: "string" } } }, required: ["result"], additionalProperties: false, $defs: { a: { type: "string" } } },
      wrapped: true,
    });
    const { submit, server: tool } = await started();
    await tool.bind({ type: "array", items: { type: "string" } });
    expect((await submit(["a"])).result.content![0]!.text).toContain("`result` argument");
    expect((await submit({ result: [1] })).result.content![0]!.text).toContain("- /result/0: must be string");
    await submit({ result: ["a", "b"] });
    expect(tool.result()).toEqual({ value: ["a", "b"] });
  });

  it("refuses to bind a schema it cannot compile", async () => {
    const { server: tool, list } = await started();
    await expect(tool.bind({ type: "object", properties: { a: { $ref: "#/nowhere" } } })).rejects.toThrow();
    expect(await list()).toEqual([GENERIC_RESULT_TOOL]);
  });
});
