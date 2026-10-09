import { nativeSkillLoadObservations } from "../session/native-skill-load-observation.js";
import type { PendingRequest } from "../state/journal.js";
import { expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, jcsDigest, verifyInstanceProof, type JsonValue } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";
const observation = { kind: "skill_read_completed", eventId: "load:skill", instanceId: "instance", agentId: "opencode",
  executionId: "execution", sessionId: "session", assignmentId: "assignment", attempt: 1, claimId: "claim",
  recoveryEpoch: 0, readyRevision: 1, runnerIncarnation: "runner", acpSessionRef: "acp", executionRevision: 1,
  leaseSetId: "lease", turnId: "turn", toolCallId: "native-context:load",
  capabilityId: "7db42743-32df-4990-ad5d-6f5433f872fc", version: "1.0.1", observedAt: "2026-10-10T00:00:00Z" };
const digest = jcsDigest(observation as JsonValue);
function fixture(patch: object = {}) {
  const key = generateInstanceKey();
  const fetchFn = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
    stored: true, observationId: `ri:skill:${digest}`, observationDigest: digest, ...patch,
  }), { status: 202 }));
  const client = new CoreClient({ baseUrl: "https://core.example", key: () => key,
    credential: () => "test-native-lease", clock: new FixedClock(Date.parse(observation.observedAt)), fetchFn });
  return { key, fetchFn, client };
}
it("signs completed loads and refreshes proof without changing immutable retry bytes", async () => {
  const f = fixture();
  await f.client.submitObservation("instance", observation);
  await f.client.submitObservation("instance", observation);
  const [url, init] = f.fetchFn.mock.calls[0];
  const { proof, ...body } = JSON.parse(String(init?.body));
  expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/observations");
  expect(body).toEqual({ observation });
  expect(verifyInstanceProof(f.key.publicKey, { method: "skill_usage_observation", audience: CORE_AUDIENCE,
    subject: "instance", body }, proof)).toBe(true);
  const retry = JSON.parse(String(f.fetchFn.mock.calls[1][1]?.body));
  expect(retry.observation).toEqual(observation);
  expect(retry.proof.nonce).not.toBe(proof.nonce);
});
it.each([{ observationId: "foreign" }, { observationDigest: "a".repeat(43) }, { stored: false }])("refuses an uncorrelated receipt %j", async patch => {
  await expect(fixture(patch).client.submitObservation("instance", observation)).rejects.toThrow();
});
it("refuses foreign runtime loads before transport", async () => {
  const f = fixture();
  await expect(f.client.submitObservation("other", observation)).rejects.toThrow(/mismatch/);
  expect(f.fetchFn).not.toHaveBeenCalled();
});

const load = { loadId: "load", acpSessionRef: "acp", requestId: "request", readOnlyRoots: ["/skill"], observedAt: observation.observedAt };
const skills = [{ skillId: observation.capabilityId, version: observation.version }];
function admittedRequest(patch: object = {}): PendingRequest {
  // Unit fixture for retained admission mapping; signature verification belongs to the execution gate.
  return { acpSessionRef: "acp", id: "request", method: "session/prompt", closedAt: null,
    authorization: { state: "dispatch_started", claims: { ...observation, turnRef: "server-turn" } }, ...patch } as unknown as PendingRequest;
}
it("maps original admission dimensions and gives distinct loads distinct usage identities", () => {
  const first = nativeSkillLoadObservations(admittedRequest(), load, skills)[0];
  const second = nativeSkillLoadObservations(admittedRequest(), { ...load, loadId: "second" }, skills)[0];
  expect(first).toMatchObject({ executionId: "execution", claimId: "claim", leaseSetId: "lease", turnId: "server-turn" });
  expect(second.toolCallId).not.toBe(first.toolCallId);
  expect(nativeSkillLoadObservations(admittedRequest(), load, skills)[0]).toEqual(first);
});
it.each([{ closedAt: observation.observedAt }, { id: "foreign" }, { acpSessionRef: "foreign" },
  { method: "session/cancel" }, { authorization: undefined }])("refuses unavailable original admission %j", patch => {
  expect(() => nativeSkillLoadObservations(admittedRequest(patch), load, skills)).toThrow(/admitted native turn/);
});
it("keeps delivery invocation identity separate from Assistant turns", () => {
  const request = admittedRequest();
  request.authorization!.claims = { ...request.authorization!.claims,
    deliveryIdentity: { invocationId: "delivery-turn" } } as typeof request.authorization.claims;
  expect(nativeSkillLoadObservations(request, load, skills)[0].turnId).toBe("delivery-turn");
});
