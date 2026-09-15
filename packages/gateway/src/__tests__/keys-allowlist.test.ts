import { describe, expect, it } from "vitest";
import { SECRET_CANARIES, containsCanary, redactValue } from "@konteks/remote-common";
import { EgressAllowlistIndex, EgressAllowlistSchema } from "../allowlist.js";
import { KeyVault } from "../keys.js";
import { SupervisorObservationSink } from "../observation.js";

describe("in-memory key vault", () => {
  it("never serializes a key", () => {
    const vault = new KeyVault();
    vault.set("codex", SECRET_CANARIES.openAiKey);
    expect(JSON.stringify(vault)).toBe('{"keyedAgents":["codex"]}');
    expect(containsCanary(JSON.stringify(redactValue(vault)))).toBe(false);
    expect(vault.use("codex")).toBe(SECRET_CANARIES.openAiKey);
    vault.clearAll();
    expect(vault.use("codex")).toBeNull();
  });
});

describe("signed egress allowlist", () => {
  const index = new EgressAllowlistIndex(
    EgressAllowlistSchema.parse({
      revision: "allow-7",
      entries: [{ provider: "anthropic", hosts: ["api.anthropic.com"], pathPrefixes: ["/v1/messages"] }],
    }),
  );

  it("matches only allowlisted provider + path prefix and never a caller-named host", () => {
    expect(index.match("anthropic", "/v1/messages")).toEqual({ provider: "anthropic", host: "api.anthropic.com", path: "/v1/messages" });
    expect(index.match("anthropic", "/v1/messages/count_tokens?x=1")).not.toBeNull();
    expect(index.match("anthropic", "/v1/complete")).toBeNull();
    expect(index.match("openai", "/v1/responses")).toBeNull();
    expect(index.match("anthropic", "//evil.example/v1/messages")).toBeNull();
    expect(index.match("anthropic", "/v1/messages/../admin")).toBeNull();
  });

  it("rejects an allowlist with an unknown field or duplicate provider", () => {
    expect(EgressAllowlistSchema.safeParse({ revision: "r", entries: [], extra: 1 }).success).toBe(false);
    expect(
      () =>
        new EgressAllowlistIndex({
          revision: "r",
          entries: [
            { provider: "anthropic", hosts: ["a"], pathPrefixes: ["/"] },
            { provider: "anthropic", hosts: ["b"], pathPrefixes: ["/"] },
          ],
        }),
    ).toThrow();
  });
});

describe("observation sink outage marks the rollup incomplete", () => {
  it("keeps the observation queued and records incompleteSince when the supervisor is unreachable", async () => {
    const sink = new SupervisorObservationSink({
      supervisorUrl: "http://supervisor.invalid",
      fetchFn: async () => {
        throw new TypeError("fetch failed");
      },
      now: () => new Date("2026-09-06T00:00:00Z"),
    });
    await sink.emit({
      instanceId: "i",
      assignmentId: "a",
      attempt: 1,
      agentId: "codex",
      provider: "openai",
      model: "gpt-wire",
      inputSemantics: "cache_inside_total",
      capEnforcement: "observe",
      moneyBasis: "gateway_priced",
      observedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(sink.pending).toBe(1);
    expect(sink.rollupIncompleteSince).toBe("2026-09-06T00:00:00.000Z");
  });
});
