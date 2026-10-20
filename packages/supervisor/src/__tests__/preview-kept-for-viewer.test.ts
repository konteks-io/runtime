/**
 * D214: releasing an agent's finished session stopped the preview the person
 * was trying; a viewer request restarted it as a new process, which had lost
 * the app's in-memory sign-in. A preview a person is using outlives the release.
 */
import { describe, expect, it, vi } from "vitest";
import { generateEd25519 } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";

interface ReleaseInternals {
  releaseSessionPreview(sessionId: string): Promise<void>;
  previewChannel: { activeStreamsFor(sessionId: string): number } | undefined;
}

function fixture(streams: number, viewed: boolean) {
  const key = generateEd25519();
  const roots = [{ keyId: "release", publicKeyJwk: key.publicJwk, coreControlKeys: [] }];
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({ SUPERVISOR_DEPLOYMENT_KIND: "native_connector",
    SUPERVISOR_DATA_DIR: "/unused-preview-kept-for-viewer", SUPERVISOR_CORE_URL: "https://core.example" }), {
    native: { trustedRoots: roots, runners: [] },
  });
  const internal = supervisor as unknown as ReleaseInternals;
  internal.previewChannel = { activeStreamsFor: () => streams };
  const viewedWithin = vi.spyOn(supervisor.previews, "viewedWithin").mockReturnValue(viewed);
  const stop = vi.spyOn(supervisor.previews, "stop").mockResolvedValue(undefined as never);
  return { internal, stop, viewedWithin };
}

describe("a session released while its preview is in use", () => {
  it("keeps a preview with a viewer stream open", async () => {
    const f = fixture(1, false);
    await f.internal.releaseSessionPreview("session-1");
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("keeps a preview a person used in the last ten minutes", async () => {
    const f = fixture(0, true);
    await f.internal.releaseSessionPreview("session-1");
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.viewedWithin).toHaveBeenCalledWith("session-1", 10 * 60_000);
  });

  it("stops a preview nobody is using, as before", async () => {
    const f = fixture(0, false);
    await f.internal.releaseSessionPreview("session-1");
    expect(f.stop).toHaveBeenCalledWith("session-1", "session_released");
  });
});
