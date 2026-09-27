import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { STRUCTURED_RESULT_MCP_SERVER_NAME, STRUCTURED_RESULT_TOOL_NAME } from "@konteks/agent-core";
import { createLogger, RemoteInstanceError, type Logger } from "@konteks/remote-common";

/**
 * The session's result tool, `submit_result`, as a connector-local loopback
 * MCP server (streamable HTTP, JSON responses, plus a server-to-client event
 * stream for `notifications/tools/list_changed`) next to the platform facade
 * and the preview tools.
 *
 * A turn whose prompt carries the structured-output contract binds its JSON
 * Schema here (`bind`). The tool then answers `tools/list` with that schema
 * as its input schema, validates each call with Ajv (the rules the cloud
 * callers use), tells the agent exactly what to fix on a mismatch so it can
 * correct itself in the same turn, and keeps the first valid call (later
 * calls are told it is already recorded). Nothing leaves this computer from
 * here: the session attaches the value to the turn's completion.
 *
 * MCP tool lists are read when the agent connects, before any prompt. `bind`
 * therefore announces the new list and waits briefly for the agent to read
 * it again. Claude Code does; an agent that does not (Codex 0.144 ignores
 * `list_changed`) keeps the generic definition it read at start, and `bind`
 * says so, so the session puts the schema in the prompt line instead.
 *
 * The ACP process only receives a random per-session bearer; the server binds
 * 127.0.0.1 on an ephemeral port and closes with the session.
 */
export { STRUCTURED_RESULT_MCP_SERVER_NAME, STRUCTURED_RESULT_TOOL_NAME };

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** A plan or verdict is kilobytes; the completion frame that carries it is bounded at 1 MiB. */
const MAX_REQUEST_BYTES = 512 * 1024;
/** How long `bind` waits for the agent to read the new tool list (Claude Code takes milliseconds). */
export const DEFAULT_RELIST_WAIT_MS = 2_000;
/** Let the agent take in the new list before the prompt that relies on it arrives. */
const RELIST_SETTLE_MS = 100;
const MAX_REPORTED_ERRORS = 20;

/** How the agent sees the tool for the bound turn. */
export type ResultToolDefinition = "schema" | "generic";

const ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** What the tool looks like when no turn asks for a result (and to an agent that never re-reads its tools). */
export const GENERIC_RESULT_TOOL = {
  name: STRUCTURED_RESULT_TOOL_NAME,
  title: "Submit the turn's result",
  description: "Records the final structured result of a Konteks turn. Call it only when the turn's instructions ask you to, once, with the whole result as the arguments; if the result does not match what the turn requires, it answers with exactly what to fix.",
  inputSchema: { type: "object", additionalProperties: true },
  annotations: ANNOTATIONS,
} as const;

const BOUND_DESCRIPTION = "Records your final result for this turn. Call it once, when you are finished, with the whole result as the arguments. If it answers with problems, fix exactly those and call it again.";

/**
 * Compile with the draft the schema names: `z.toJSONSchema` declares draft
 * 2020-12, which the default draft-07 Ajv refuses; an undeclared schema is
 * draft-07. Same rule as `compileStructuredOutputSchema` in agent-adapters.
 */
export function compileResultSchema(schema: Record<string, unknown>): ValidateFunction {
  const draft2020 = typeof schema.$schema === "string" && schema.$schema.includes("2020-12");
  const ajv = draft2020 ? new Ajv2020({ allErrors: true, strict: false }) : new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

/** One line per problem, bounded, naming where it is: what the agent reads to correct its call. */
export function describeSchemaErrors(errors: readonly ErrorObject[] | null | undefined, prefix = ""): string[] {
  const lines = (errors ?? []).map((issue) => {
    const where = `${prefix}${issue.instancePath}` || "/";
    const extra = issue.keyword === "additionalProperties" && typeof issue.params.additionalProperty === "string"
      ? ` (\`${issue.params.additionalProperty}\`)`
      : issue.keyword === "enum" && Array.isArray(issue.params.allowedValues)
        ? `: ${issue.params.allowedValues.map((value: unknown) => JSON.stringify(value)).join(", ")}`
        : "";
    return `- ${where}: ${issue.message ?? issue.keyword}${extra}`;
  });
  const unique = [...new Set(lines)];
  return unique.length > MAX_REPORTED_ERRORS ? [...unique.slice(0, MAX_REPORTED_ERRORS), `- … and ${unique.length - MAX_REPORTED_ERRORS} more`] : unique;
}

/**
 * The tool's input schema for a turn schema. MCP tool arguments are a JSON
 * object, so a schema whose root is not an object is wrapped in `result`;
 * `$schema` is dropped (the agent's tool API reads the shape, not the draft).
 */
export function toolInputSchema(schema: Record<string, unknown>): { inputSchema: Record<string, unknown>; wrapped: boolean } {
  const { $schema: _draft, ...rest } = schema;
  if (rest.type === "object") return { inputSchema: rest, wrapped: false };
  const { $defs, definitions, ...inner } = rest;
  return {
    inputSchema: {
      type: "object",
      properties: { result: inner },
      required: ["result"],
      additionalProperties: false,
      ...($defs !== undefined ? { $defs } : {}),
      ...(definitions !== undefined ? { definitions } : {}),
    },
    wrapped: true,
  };
}

interface BoundTurn {
  validate: ValidateFunction;
  inputSchema: Record<string, unknown>;
  wrapped: boolean;
  accepted: { value: unknown } | null;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown }
type ToolAnswer = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export class StructuredResultToolServer {
  private readonly credential = randomBytes(32).toString("base64url");
  private readonly mcpSessionId = randomBytes(16).toString("hex");
  private readonly logger: Logger;
  private readonly relistWaitMs: number;
  private server: Server | null = null;
  private closed = false;
  private turn: BoundTurn | null = null;
  private readonly streams = new Set<ServerResponse>();
  private listWaiters: Array<() => void> = [];
  /** The agent was told the list changed and did not read it again: do not wait for it next time. */
  private relistIgnored = false;

  constructor(private readonly options: { logger?: Logger; context?: Record<string, unknown>; relistWaitMs?: number } = {}) {
    this.logger = options.logger ?? createLogger({ name: "structured-result" });
    this.relistWaitMs = options.relistWaitMs ?? DEFAULT_RELIST_WAIT_MS;
  }

  async start(): Promise<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> {
    if (this.server || this.closed) throw new RemoteInstanceError("assignment_conflict", "The result tool is already started or closed.");
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new RemoteInstanceError("capability_unavailable", "The result tool did not bind a loopback port.");
    server.unref();
    return { name: STRUCTURED_RESULT_MCP_SERVER_NAME, url: `http://127.0.0.1:${address.port}/mcp`, headers: [{ name: "authorization", value: `Bearer ${this.credential}` }] };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.turn = null;
    for (const waiter of this.listWaiters.splice(0)) waiter();
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      const done = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await done;
    }
  }

  /**
   * Bind a turn's schema (compiled first, so an uncompilable schema throws
   * and binds nothing). Resolves "schema" when the agent read the tool list
   * again with it, else "generic".
   */
  async bind(schema: Record<string, unknown>): Promise<ResultToolDefinition> {
    const validate = compileResultSchema(schema);
    const { inputSchema, wrapped } = toolInputSchema(schema);
    this.turn = { validate, inputSchema, wrapped, accepted: null };
    const definition = await this.announce();
    this.logger.info({ event: "structured_result.bound", toolDefinition: definition, wrapped, ...this.options.context }, "turn result tool bound");
    return definition;
  }

  /** The turn ended: the tool goes back to its generic definition. */
  unbind(): void {
    if (this.turn === null) return;
    this.turn = null;
    if (!this.closed && this.streams.size > 0) this.notifyListChanged();
  }

  /** The first valid result recorded for the bound turn, if any. */
  result(): { value: unknown } | null {
    return this.turn?.accepted ?? null;
  }

  private async announce(): Promise<ResultToolDefinition> {
    if (this.closed || this.streams.size === 0 || this.relistIgnored) return "generic";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listed = new Promise<boolean>(resolve => {
      const waiter = () => { if (timer) clearTimeout(timer); resolve(true); };
      this.listWaiters.push(waiter);
      timer = setTimeout(() => {
        this.listWaiters = this.listWaiters.filter(candidate => candidate !== waiter);
        resolve(false);
      }, this.relistWaitMs);
      (timer as { unref?: () => void }).unref?.();
    });
    this.notifyListChanged();
    const relisted = await listed;
    if (!relisted) this.relistIgnored = true;
    return relisted && !this.closed ? "schema" : "generic";
  }

  private notifyListChanged(): void {
    const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  private tools(): unknown[] {
    const turn = this.turn;
    if (!turn) return [GENERIC_RESULT_TOOL];
    return [{ name: STRUCTURED_RESULT_TOOL_NAME, title: "Submit your result", description: BOUND_DESCRIPTION, inputSchema: turn.inputSchema, annotations: ANNOTATIONS }];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    if (this.closed) return this.fail(response, 503, "closed");
    if (!this.authorized(request.headers.authorization)) return this.fail(response, 401, "invalid_local_credential");
    if (request.method === "GET" && String(request.headers.accept ?? "").includes("text/event-stream")) return this.openStream(request, response);
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return this.fail(response, 405, "method_not_allowed");
    }
    let payload: unknown;
    try {
      payload = JSON.parse((await readBounded(request, MAX_REQUEST_BYTES)).toString("utf8"));
    } catch {
      return this.json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error (or a result larger than 512 KiB)" } });
    }
    const batch = Array.isArray(payload);
    const requests = (batch ? payload : [payload]) as JsonRpcRequest[];
    const answers: unknown[] = [];
    let listed = false;
    for (const item of requests) {
      let answer: unknown | null;
      try {
        if ((item as JsonRpcRequest | null)?.method === "tools/list") listed = true;
        answer = this.dispatch(item);
      } catch {
        answer = { jsonrpc: "2.0", id: (item as JsonRpcRequest | null)?.id ?? null, error: { code: -32603, message: "Internal error" } };
      }
      if (answer !== null) answers.push(answer);
    }
    if (listed) response.once("finish", () => this.settleListWaiters());
    if (answers.length === 0) {
      response.statusCode = 202;
      return void response.end();
    }
    response.setHeader("Mcp-Session-Id", this.mcpSessionId);
    return this.json(response, 200, batch ? answers : answers[0]);
  }

  private settleListWaiters(): void {
    const waiters = this.listWaiters.splice(0);
    if (waiters.length === 0) return;
    const timer = setTimeout(() => { for (const waiter of waiters) waiter(); }, RELIST_SETTLE_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  private openStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Mcp-Session-Id": this.mcpSessionId });
    response.write(": konteks-result\n\n");
    this.streams.add(response);
    const forget = () => { this.streams.delete(response); };
    request.once("close", forget);
    response.once("close", forget);
  }

  private dispatch(request: JsonRpcRequest): unknown | null {
    if (!request || typeof request !== "object" || typeof request.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const id = request.id;
    if (id === undefined) return null;
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (request.method) {
      case "initialize": {
        const asked = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        return reply({
          protocolVersion: typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: STRUCTURED_RESULT_MCP_SERVER_NAME, title: "Konteks turn result", version: "1.0.0" },
          instructions: `When a Konteks turn asks for a structured result, call ${STRUCTURED_RESULT_TOOL_NAME} once with it when you are finished. Do not call it otherwise.`,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: this.tools() });
      case "tools/call": {
        const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
        return reply(this.call(typeof params.name === "string" ? params.name : "", params.arguments));
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  }

  private call(name: string, args: unknown): ToolAnswer {
    const answer = (text: string, isError = false): ToolAnswer => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
    const log = (outcome: string, extra: Record<string, unknown> = {}) =>
      this.logger.info({ event: "structured_result.call", outcome, ...extra, ...this.options.context }, "result tool called");
    if (name !== STRUCTURED_RESULT_TOOL_NAME) return answer(`Unknown tool ${name}. This server has one tool, ${STRUCTURED_RESULT_TOOL_NAME}.`, true);
    const turn = this.turn;
    if (!turn) {
      log("not_requested");
      return answer(`No result is requested in this turn. Continue without calling ${STRUCTURED_RESULT_TOOL_NAME}.`, true);
    }
    if (turn.accepted) {
      log("already_recorded");
      return answer(`Already recorded: your result for this turn was accepted. Do not call ${STRUCTURED_RESULT_TOOL_NAME} again; finish your turn.`);
    }
    const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    if (turn.wrapped && !("result" in input)) {
      log("rejected", { problems: 1 });
      return answer("Put your whole result in the `result` argument and call submit_result again.", true);
    }
    const value = turn.wrapped ? input.result : input;
    if (!turn.validate(value)) {
      const problems = describeSchemaErrors(turn.validate.errors, turn.wrapped ? "/result" : "");
      log("rejected", { problems: problems.length });
      return answer(["Not recorded: the result does not match the required schema. Fix these and call submit_result again with the whole result:", ...problems].join("\n"), true);
    }
    turn.accepted = { value };
    log("accepted");
    return answer("Recorded. Your result for this turn is accepted; finish your turn now.");
  }

  private authorized(value: string | undefined): boolean {
    if (!value?.startsWith("Bearer ")) return false;
    const received = Buffer.from(value.slice(7));
    const expected = Buffer.from(this.credential);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  }

  private fail(response: ServerResponse, status: number, code: string): void {
    this.json(response, status, { error: code });
  }
}

async function readBounded(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
