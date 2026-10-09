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
