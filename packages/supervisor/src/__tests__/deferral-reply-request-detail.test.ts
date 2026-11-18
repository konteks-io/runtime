import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeferredPermissionReplySchema } from "../core/client.js";

/** Core's stored view for a deferred permission, as `permissions/deferred` answers it. */
const view = {
  pendingRef: "pend_7b1c4a52-3f0e-4c8e-9a51-1d2e3f4a5b6c",
  requestDigest: createHash("sha256").update("a deferred permission").digest("base64url"),
  raisedAt: "2026-11-18T22:40:00.000Z",
  deadlineAt: "2026-11-18T22:45:00.000Z",
  requestId: "perm-1",
  assignmentId: "a1",
  agentId: "claude-code",
  kind: "permission" as const,
  permission: { title: "Run a shell command", toolKind: "execute", options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }] },
};

/**
 * 2026-11-18: Core (konteks/core #701) echoes the Core-local top-level
 * `requestDetail` on the view it answers a deferral with. Parsed with the
 * shared strict view, every deferral carrying a detail failed and the prompt
 * failed closed, as soon as Core advertised contract 7.18.
 */
describe("Core's reply to a deferral", () => {
  it("accepts the view Core answers when it carries a request detail, keeping Core's digest", () => {
    const parsed = DeferredPermissionReplySchema.parse({ ...view, requestDetail: "npm test -- --runInBand" });
    expect(parsed).toEqual(view);
    expect(parsed.requestDigest).toBe(view.requestDigest);
  });

  it("accepts today's view without a detail unchanged", () => {
    expect(DeferredPermissionReplySchema.parse(view)).toEqual(view);
  });

  it("still refuses any other unknown field", () => {
    expect(DeferredPermissionReplySchema.safeParse({ ...view, somethingElse: true }).success).toBe(false);
  });
});
