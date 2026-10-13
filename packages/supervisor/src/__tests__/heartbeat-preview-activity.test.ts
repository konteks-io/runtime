import { describe, expect, it, vi } from "vitest";
import { generateEd25519 } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";

interface PreviewActivityInternals {
  coreContractVersion: string | undefined;
  agentPreviewActivity(): unknown;
}

function fixture() {
  const key = generateEd25519();
  const roots = [{ keyId: "release", publicKeyJwk: key.publicJwk, coreControlKeys: [] }];
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({ SUPERVISOR_DEPLOYMENT_KIND: "native_connector",
    SUPERVISOR_DATA_DIR: "/unused-heartbeat-preview-activity", SUPERVISOR_CORE_URL: "https://core.example" }), {
    native: { trustedRoots: roots, runners: [] },
  });
  return { supervisor, internal: supervisor as unknown as PreviewActivityInternals };
}

describe("the heartbeat's preview activity", () => {
  it("reports the agent's previews of the last three minutes only to a Core that reads them (7.8)", () => {
    const f = fixture();
    const previews = [{ sessionId: "session-1", startedAt: "2026-10-13T00:00:00.000Z", agentActiveAt: "2026-10-13T00:02:00.000Z" }];
    const agentActive = vi.spyOn(f.supervisor.previews, "agentActive").mockReturnValue(previews);
    for (const older of [undefined, "7.1", "7.7"]) {
      f.internal.coreContractVersion = older;
      expect(f.internal.agentPreviewActivity()).toBeUndefined();
    }
    expect(agentActive).not.toHaveBeenCalled();
    for (const current of ["7.8", "7.10", "8.0"]) {
      f.internal.coreContractVersion = current;
      expect(f.internal.agentPreviewActivity()).toEqual(previews);
    }
    expect(agentActive).toHaveBeenCalledWith(3 * 60_000);
  });
});
