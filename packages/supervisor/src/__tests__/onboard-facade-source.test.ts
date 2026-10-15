import { describe, expect, it, vi } from "vitest";
import { McpOnboardFacade } from "../onboard/facade.js";
import { computeRemoteFileTreeDigest } from "@konteks/remote-common";
const owner = { assignmentId: "assignment", attempt: 1, instanceId: "instance" };
const binding = { ...owner, runRef: "run", canonicalKey: "git.example/acme/repo", sessionId: "session" };
const result = { revision: "a".repeat(40), tree: { format: "konteks-file-tree-v1", entries: [], treeDigest: computeRemoteFileTreeDigest([]) }, binding };
function client(body: unknown, headers: Record<string, string> = {}) {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { headers }));
  return { fetchFn, facade: new McpOnboardFacade({ endpoint: { url: "https://core.test/mcp", headers: [] }, sourceOwner: owner, fetchFn: fetchFn as never }) };
}
describe("private discovery source transport", () => {
  it("uses a private method with run/key only and refuses redirects", async () => {
    const { facade, fetchFn } = client({ result });
    await expect(facade.sourceFiles("run", binding.canonicalKey)).resolves.toEqual({ revision: result.revision, tree: result.tree });
    const init = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init[1].body))).toMatchObject({ method: "onboarding/read-files", params: { runRef: "run", canonicalKey: binding.canonicalKey } });
    expect(init[1].redirect).toBe("error");
  });
  it.each([
    { runRef: "other" }, { canonicalKey: "other" }, { assignmentId: "other" }, { attempt: 2 }, { instanceId: "other" },
  ])("refuses a response from another claim scope %j", async change => {
    const { facade } = client({ result: { ...result, binding: { ...binding, ...change } } });
    await expect(facade.sourceFiles("run", binding.canonicalKey)).rejects.toThrow("Core did not authorize");
  });
  it("does not expose a refusal body or malformed provider data", async () => {
    for (const body of [{ error: { message: "secret-fixture" } }, { result: { revision: "secret-fixture" } }]) {
      const { facade } = client(body);
      await expect(facade.sourceFiles("run", binding.canonicalKey)).rejects.toThrow("Core did not authorize");
    }
  });
  it("refuses a tree whose declared digest does not match its entries", async () => {
    const { facade } = client({ result: { ...result, tree: { ...result.tree, treeDigest: `sha256:${"b".repeat(64)}` } } });
    await expect(facade.sourceFiles("run", binding.canonicalKey)).rejects.toThrow("Core did not authorize");
  });
  it("sanitizes malformed JSON without exposing its source text", async () => {
    const facade = new McpOnboardFacade({ endpoint: { url: "https://core.test/mcp", headers: [] }, sourceOwner: owner,
      fetchFn: (async () => new Response("invalid-secret-fixture")) as never });
    await expect(facade.sourceFiles("run", binding.canonicalKey)).rejects.toThrow("Core did not authorize");
  });
  it("refuses oversized responses before consuming them", async () => {
    const { facade } = client({ result }, { "content-length": "999999999" });
    await expect(facade.sourceFiles("run", binding.canonicalKey)).rejects.toThrow("Core did not authorize");
  });
});
