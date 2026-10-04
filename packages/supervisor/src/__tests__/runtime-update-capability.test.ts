import { describe, expect, it, vi } from "vitest";
import { generateEd25519, REMOTE_RUNTIME_UPDATE_CAPABILITY } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";
import type { EmbeddedReleaseRoot } from "@konteks/remote-release";

interface CapabilityInternals {
  runtimeUpdateCapabilities(): string[];
  recoveryAuthority(): string | null;
  roots: EmbeddedReleaseRoot[];
  stopping: boolean;
}

function fixture(updater = true, signingKeys = true) {
  const key = generateEd25519();
  const roots = [{ keyId: "release", publicKeyJwk: key.publicJwk,
    coreControlKeys: signingKeys ? [{ keyId: "control", publicKeyJwk: key.publicJwk }] : [] }];
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({ SUPERVISOR_DEPLOYMENT_KIND: "native_connector",
    SUPERVISOR_DATA_DIR: "/unused-runtime-update-capability", SUPERVISOR_CORE_URL: "https://core.example" }), {
    native: { trustedRoots: roots, runners: [], ...(updater ? { update: {
      fetchManifest: async () => null, launch: async () => ({ pid: 1 }), readLedger: async () => ({ schemaVersion: 1 as const, attempts: [] }),
    } } : {}) },
  });
  const internal = supervisor as unknown as CapabilityInternals;
  internal.roots = roots;
  supervisor.relay = {} as never;
  vi.spyOn(internal, "recoveryAuthority").mockImplementation(() => internal.stopping ? null : "accepted-root-lease");
  return { supervisor, internal };
}

describe("native runtime update capability projection", () => {
  it("advertises the fixed update only with a real configured updater, trusted signatures, accepted ownership and relay", () => {
    const f = fixture();
    expect(f.internal.runtimeUpdateCapabilities()).toEqual([REMOTE_RUNTIME_UPDATE_CAPABILITY]);
    expect(fixture(false).internal.runtimeUpdateCapabilities()).toEqual([]);
    expect(fixture(true, false).internal.runtimeUpdateCapabilities()).toEqual([]);
    f.supervisor.relay = null;
    expect(f.internal.runtimeUpdateCapabilities()).toEqual([]);
    f.supervisor.relay = {} as never;
    f.internal.stopping = true;
    expect(f.internal.runtimeUpdateCapabilities()).toEqual([]);
    f.internal.stopping = false;
    vi.mocked(f.internal.recoveryAuthority).mockReturnValue(null);
    expect(f.internal.runtimeUpdateCapabilities()).toEqual([]);
  });
});
