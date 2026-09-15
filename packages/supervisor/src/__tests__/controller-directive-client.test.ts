import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof } from "@konteks/remote-common";
import { CORE_AUDIENCE, CoreClient } from "../core/client.js";

const directive = {
  version: 1 as const,
  directiveId: "directive-1",
  directiveSequence: 1,
  activationRef: "activation-1",
  executionRef: "activation-1",
  assignmentId: "assignment-1",
  attempt: 1,
  claimId: "claim-1",
  recoveryEpoch: 0,
  terminalEvidence: {
    kind: "prompt_terminal" as const,
    turnCount: 1,
    finalRequestId: "request-1",
    executionDigest: "a".repeat(64),
    outputDigest: "b".repeat(64),
  },
  decisionClass: "succeeded" as const,
  decisionDigest: "c".repeat(64),
  issuedAt: "2026-09-08T00:00:00.000Z",
  expiresAt: "2026-09-08T00:05:00.000Z",
  signature: "AA",
};

function fixture(response: unknown = { version: 1, directives: [directive], highWater: 1 }) {
  const key = generateInstanceKey();
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const client = new CoreClient({
    baseUrl: "https://core.example",
    clock: new FixedClock(Date.parse("2026-09-08T00:00:01.000Z")),
    key: () => key,
    credential: () => "lease",
    fetchFn,
  });
  return { client, fetchFn, key };
}

describe("planning controller terminal directive pull", () => {
  it("signs the strict path-bound request and returns the exact bounded page", async () => {
    const f = fixture();
    await expect(f.client.pullControllerDirectives("instance-1", {
      version: 1,
      afterSequence: 0,
      runnerIncarnation: "runner-1",
      maxItems: 16,
      waitSeconds: 20,
    })).resolves.toEqual({ version: 1, directives: [directive], highWater: 1 });

    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance-1/controller-directives/pull");
    expect(init?.headers).toMatchObject({ authorization: "Bearer lease" });
    const { proof, ...body } = JSON.parse(String(init?.body));
    expect(body).toEqual({ version: 1, afterSequence: 0, runnerIncarnation: "runner-1", maxItems: 16, waitSeconds: 20 });
    expect(verifyInstanceProof(f.key.publicKey, {
      method: "controller_directives_pull",
      audience: CORE_AUDIENCE,
      subject: "instance-1",
      body,
    }, proof)).toBe(true);
  });

  it.each([
    { version: 1, directives: [directive], highWater: 0 },
    { version: 1, directives: [{ ...directive, directiveSequence: 2 }], highWater: 2 },
    { version: 1, directives: [directive, directive], highWater: 1 },
    { version: 1, directives: [], highWater: -1 },
    { version: 1, directives: [], highWater: 0, secret: "no" },
  ])("rejects a malformed, gapped, duplicate, or non-strict page %#", async response => {
    await expect(fixture(response).client.pullControllerDirectives("instance-1", {
      version: 1, afterSequence: 0, runnerIncarnation: "runner-1", maxItems: 16, waitSeconds: 20,
    })).rejects.toThrow();
  });
});
