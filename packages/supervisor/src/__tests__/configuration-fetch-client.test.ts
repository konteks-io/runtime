import { describe, expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey, jcsDigest } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

const configuration = { deploymentKind: "native_connector", roleBindings: [], heartbeatIntervalSeconds: 30, logLevel: "info", updateChannel: "stable", evidenceUpload: "structured_only", permissionResponderDeadlineSeconds: 120, humanDeferralAllowed: false };
const envelope = { type: "desired_configuration", instanceId: "instance", revision: 1, issuedAt: "2026-09-06T00:00:00Z", expiresAt: "2026-09-13T00:00:00Z", digest: jcsDigest(configuration), configuration, signature: "A".repeat(86) };
function client(body: unknown) {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  return new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.parse(envelope.issuedAt)), key: () => generateInstanceKey(), credential: () => "test-provisioning-credential", fetchFn });
}
describe("Core configuration HTTPS boundary", () => {
  it("reads the actual signed envelope without fabricating relay fields", async () => {
    await expect(client(envelope).fetchDesiredConfiguration("instance")).resolves.toEqual(envelope);
  });
  it.each([{ ...envelope, instanceId: "foreign" }, { frame: envelope }, { ...envelope, shell: "ignored?" }, { ...envelope, configuration: { ...configuration, gateway: {} } }])("refuses wrong-instance, wrapped and non-native configuration", async body => {
    await expect(client(body).fetchDesiredConfiguration("instance")).rejects.toThrow();
  });
});
