import { describe, expect, it } from "vitest";
import { anthropicDialect } from "../dialects/anthropic.js";
import { decodeJson, encodeJson, type ProviderDialect } from "../dialects/types.js";
import { AssignmentRegistry, decideCap } from "../caps.js";

const body = encodeJson({ model: "claude-x", max_tokens: 5000, messages: [{ role: "user", content: "hi" }] });
const request = { model: "claude-x", stream: false, requestedMaxOutputTokens: 5000, estimatedInputTokens: 40 };

describe("three-stage cap enforcement", () => {
  it("observe forwards unchanged and never blocks", () => {
    const decision = decideCap({ stage: "observe", dialect: anthropicDialect, request, body, binding: { assignmentId: "a", attempt: 1, remainingOutputTokens: 0, remainingInputTokens: 1 } });
    expect(decision).toEqual({ kind: "forward", body });
  });

  it("preflight_block refuses over-cap input and exhausted output without rewriting", () => {
    expect(decideCap({ stage: "preflight_block", dialect: anthropicDialect, request, body, binding: { assignmentId: "a", attempt: 1, remainingOutputTokens: 10, remainingInputTokens: 10 } })).toEqual({ kind: "block", reason: "input_exceeds_cap" });
    expect(decideCap({ stage: "preflight_block", dialect: anthropicDialect, request, body, binding: { assignmentId: "a", attempt: 1, remainingOutputTokens: 0 } })).toEqual({ kind: "block", reason: "cap_exhausted" });
    const allowed = decideCap({ stage: "preflight_block", dialect: anthropicDialect, request, body, binding: { assignmentId: "a", attempt: 1, remainingOutputTokens: 10, remainingInputTokens: 100 } });
    expect(allowed).toEqual({ kind: "forward", body });
  });

  it("provider_enforce rewrites the max_tokens-equivalent down to the remaining cap", () => {
    const decision = decideCap({ stage: "provider_enforce", dialect: anthropicDialect, request, body, binding: { assignmentId: "a", attempt: 1, remainingOutputTokens: 123 } });
    expect(decision.kind).toBe("forward");
    if (decision.kind === "forward") {
      expect(decision.appliedMaxTokens).toBe(123);
      expect(decodeJson(decision.body)).toMatchObject({ max_tokens: 123 });
    }
  });

  it("provider_enforce falls back to stream cutting when the dialect cannot rewrite", () => {
    const opaque: ProviderDialect = { ...anthropicDialect, rewriteMaxOutputTokens: () => null };
    const decision = decideCap({ stage: "provider_enforce", dialect: opaque, request: { ...request, stream: true }, body, binding: { assignmentId: "a", attempt: 1, remainingOutputTokens: 9 } });
    expect(decision).toEqual({ kind: "forward_stream_cut", body, cutAtOutputTokens: 9 });
  });
});

describe("assignment registry", () => {
  it("debits observed output so the next decision sees the spend", () => {
    const registry = new AssignmentRegistry();
    registry.bind("codex", { assignmentId: "a", attempt: 1, remainingOutputTokens: 10 });
    registry.debit("codex", 4);
    expect(registry.get("codex")?.remainingOutputTokens).toBe(6);
    registry.debit("codex", 100);
    expect(registry.get("codex")?.remainingOutputTokens).toBe(0);
    registry.release("codex");
    expect(registry.get("codex")).toBeNull();
  });
});
