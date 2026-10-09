import { expect, it, vi } from "vitest";
import { runRequestedSkillSync } from "../native/requested-skill-sync.js";

function fixture() {
  const client = { pendingRequest: vi.fn(async () => ({ requestId: "request-a" })), receipt: vi.fn(async () => true) };
  return { client, signal: new AbortController().signal };
}
it("acknowledges acceptance and completion around the verified refresh", async () => {
  const { client, signal } = fixture();
  const refresh = vi.fn(async () => {
    expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "request-a", state: "accepted" }, signal);
    return ["latest"];
  });
  await expect(runRequestedSkillSync(client as never, refresh, signal)).resolves.toEqual(["latest"]);
  expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "request-a", state: "succeeded" }, signal);
});
it("reports failed refreshes without masking the original failure", async () => {
  const { client, signal } = fixture();
  const failure = new Error("publication failed");
  client.receipt.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("offline"));
  await expect(runRequestedSkillSync(client as never, async () => { throw failure; }, signal)).rejects.toBe(failure);
  expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "request-a", state: "failed" }, signal);
});
it("refuses publication when Core does not accept the request", async () => {
  const { client, signal } = fixture();
  client.receipt.mockResolvedValueOnce(false);
  const refresh = vi.fn();
  await expect(runRequestedSkillSync(client as never, refresh, signal)).rejects.toThrow("acceptance");
  expect(refresh).not.toHaveBeenCalled();
});
it("keeps periodic refresh available when there is no site request", async () => {
  const { client, signal } = fixture();
  client.pendingRequest.mockResolvedValueOnce(null as never);
  await expect(runRequestedSkillSync(client as never, async () => "latest", signal)).resolves.toBe("latest");
  expect(client.receipt).not.toHaveBeenCalled();
});

it("does not report sync success when the completion acknowledgement is refused", async () => {
  const { client, signal } = fixture();
  client.receipt.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(runRequestedSkillSync(client as never, async () => "installed", signal)).rejects.toThrow("completion");
});

it("reports a failed local exchange and does not claim synchronization success", async () => {
  const { client, signal } = fixture();
  const failure = new Error("inventory delivery failed");
  const refresh = vi.fn(async () => "installed");
  await expect(runRequestedSkillSync(client as never, refresh, signal,
    async () => { throw failure; })).rejects.toBe(failure);
  expect(refresh).not.toHaveBeenCalled();
  expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "request-a", state: "failed" }, signal);
});
it("requires local exchange even without a site sync request", async () => {
  const { client, signal } = fixture();
  client.pendingRequest.mockResolvedValueOnce(null as never);
  const failure = new Error("export delivery failed");
  const refresh = vi.fn();
  await expect(runRequestedSkillSync(client as never, refresh, signal,
    async () => { throw failure; })).rejects.toBe(failure);
  expect(refresh).not.toHaveBeenCalled();
});

it("exchanges local sources after request acceptance and before agent refresh", async () => {
  const { client, signal } = fixture();
  const phases: string[] = [];
  const exchange = async () => {
    expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "request-a", state: "accepted" }, signal);
    phases.push("exchange");
  };
  await expect(runRequestedSkillSync(client as never, async () => {
    phases.push("refresh");
    return "installed";
  }, signal, exchange)).resolves.toBe("installed");
  expect(phases).toEqual(["exchange", "refresh"]);
  expect(client.receipt).toHaveBeenLastCalledWith({ requestId: "request-a", state: "succeeded" }, signal);
});
