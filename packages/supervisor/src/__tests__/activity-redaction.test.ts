import { describe, expect, it } from "vitest";
import {
  canonicalizeAcpToolActivity,
  continuesAtBoundary,
  endsInsidePath,
  redactActivity,
} from "../session/activity.js";

/** Redact a stream chunk by chunk the way RelayedSession does. */
function redactStream(chunks: string[], root = "/Users/me/work"): string {
  let previous: { text: string; inPath: boolean } | undefined;
  return chunks.map(chunk => {
    const startsAtBoundary = continuesAtBoundary(previous?.text);
    const continuesPath = previous?.inPath ?? false;
    previous = { text: chunk, inPath: endsInsidePath(chunk, continuesPath, startsAtBoundary) };
    return redactActivity(chunk, root, { startsAtBoundary, continuesPath }) as string;
  }).join("");
}

describe("streamed activity redaction", () => {
  it.each([
    ["Agent", "other"],
    ["ToolSearch", "search"],
  ] as const)("retains Claude %s identity after private metadata is removed", (name, kind) => {
    const canonical = canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call",
      toolCallId: `tool-${name}`,
      title: "Other",
      kind: "other",
      status: "pending",
      _meta: { "claude.ai/tool": { name, kind: "other", private: "must-not-leave" } },
    }, "claude-code");

    expect(redactActivity(canonical, "/Users/me/work")).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: `tool-${name}`,
      title: name,
      name,
      kind,
      status: "pending",
    });
  });

  it("canonicalizes Claude ToolSearch when the bridge exposes only its public title", () => {
    const canonical = canonicalizeAcpToolActivity({
      sessionUpdate: "tool_call",
      toolCallId: "tool-search-title-only",
      title: "ToolSearch",
      kind: "other",
      status: "pending",
    }, "claude-code");

    expect(canonical).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tool-search-title-only",
      title: "ToolSearch",
      name: "ToolSearch",
      kind: "search",
      status: "pending",
    });
  });

  it("does not mistake a catalog ref split at a chunk boundary for a local path", () => {
    const ref = '"component:default/konteks-component-system-595ee944" "vcsrepository:default/konteks-toopay-orders-api"';
    expect(redactStream(['"component:default', '/konteks-component-system-595ee944" "vcsrepository:defaul', 't/konteks-toopay-orders-api"'])).toBe(ref);
    expect(redactStream(['"componen', 't:default/konteks-component-system-595ee944" "vcsrepository:default/konteks-toopay-orders-api"'])).toBe(ref);
  });

  it("still redacts local paths, including one split across chunks", () => {
    expect(redactStream(["see /Users/other/secret.txt now"])).toBe("see [local-path] now");
    expect(redactStream(["see ", "/Users/oth", "er/secret.txt now"])).toBe("see [local-path][local-path] now");
    expect(redactStream(["open C:", "\\Users\\x.txt"])).toBe("open C:[local-path]");
    expect(redactStream(["a https://example.test/x b"])).toBe("a https://example.test/x b");
  });

  it("keeps a URL scheme split across chunks intact", () => {
    const url = "https://gitea.sev-2.com/toopay/orders-api";
    expect(redactStream(["https", "://gitea.sev-2.com/toopay/orders-api"])).toBe(url);
    expect(redactStream(["https", "://g", "itea.sev-2.com/toopay/orders-api"])).toBe(url);
    expect(redactStream(["https", ":/", "/gitea.sev-2.com/toopay/orders-api"])).toBe(url);
    expect(redactStream(['"repository_urls":["https', '://gitea.sev-2.com/toopay/orders-api"]'])).toBe(
      '"repository_urls":["https://gitea.sev-2.com/toopay/orders-api"]',
    );
  });

  it("redacts a drive path whose letter was emitted in the previous chunk", () => {
    expect(redactStream(["open C", ":\\Users\\alice\\creds.txt"])).toBe("open C[local-path]");
    expect(redactStream(["open C", ":/Users/alice/creds.txt"])).toBe("open C[local-path]");
  });
});
