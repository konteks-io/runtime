import { describe, expect, it, vi } from "vitest";
import { McpOnboardFacade } from "../onboard/facade.js";

/**
 * An unreadable repository's gap leaves the machine with its evidence (W2-O3),
 * checked and bounded, while the rest still passes the shared schema.
 */
describe("McpOnboardFacade.evidenceSubmit", () => {
  it("sends why a repository was not read, with the remedy bounded", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: "{}" }], structuredContent: {} } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const facade = new McpOnboardFacade({ endpoint: { url: "https://core.test/mcp", headers: [] }, fetchFn: fetchFn as never });

    await facade.evidenceSubmit("run-1", [
      { canonicalKey: "git.example.com/acme/private", refs: [], facts: {}, gap: { code: "credential_unavailable", remedy: "x".repeat(900) } },
      { canonicalKey: "git.example.com/acme/public", refs: [], facts: {} },
    ]);

    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    const [unread, read] = body.params.arguments.evidence;
    expect(unread.gap.code).toBe("credential_unavailable");
    expect(unread.gap.remedy).toHaveLength(500);
    expect(read).not.toHaveProperty("gap");
  });
});
