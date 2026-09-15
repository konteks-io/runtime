import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, verifyInstanceProof } from "@konteks/remote-common";
import { CoreClient, CORE_AUDIENCE } from "../core/client.js";
const request = { assignmentId: "assignment", attempt: 1, claimId: "claim", recoveryEpoch: 0, runnerIncarnation: "runner", agentId: "codex", acpSessionRef: "acp" };
const ready = { ...request, workspaceId: "tenant", instanceId: "instance", sessionId: "session", channelId: "session:session", readyRevision: 1, registeredAt: "2026-09-06T00:00:00Z" };
function fixture(response: object = ready) {
  const key = generateInstanceKey();
  const fetchFn = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify(response), { status: 200 }));
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(ready.registeredAt)), key: () => key, credential: () => "test-native-lease", fetchFn });
  return { client, fetchFn, key };
}
describe("native readiness Core HTTPS boundary", () => {
  it("signs the exact instance/operation/body and uses fresh proof nonces on retries", async () => {
    const f = fixture();
    await expect(f.client.registerExecutionReady("instance", request)).resolves.toEqual(ready);
    await f.client.registerExecutionReady("instance", request);
    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://core.example/api/remote-instances/internal/remote-instances/instance/executions/ready");
    expect(init?.headers).toMatchObject({ authorization: "Bearer test-native-lease" });
    const { proof, ...body } = JSON.parse(String(init?.body));
    expect(body).toEqual(request);
    expect(verifyInstanceProof(f.key.publicKey, { method: "execution_ready", audience: CORE_AUDIENCE, subject: "instance", body }, proof)).toBe(true);
    expect(JSON.parse(String(f.fetchFn.mock.calls[1]![1]?.body)).proof.nonce).not.toBe(proof.nonce);
  });
  it.each([{ instanceId: "foreign" }, { assignmentId: "foreign" }, { claimId: "foreign" }, { attempt: 2 }, { recoveryEpoch: 1 }, { runnerIncarnation: "foreign" }, { agentId: "foreign" }, { acpSessionRef: "foreign" }, { channelId: "random" }, { extra: true }])("rejects mismatched or noncanonical receipt %j", async patch => {
    await expect(fixture({ ...ready, ...patch }).client.registerExecutionReady("instance", request)).rejects.toThrow();
  });
});
