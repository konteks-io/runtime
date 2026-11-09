import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteInstanceError, startControlSocketServer, writeSecretFile, type ControlSocketServer } from "@konteks/remote-common";
import { createOutput } from "../output.js";
import { nativeCliActions } from "../native/commands.js";

const PRE_STARTUP_REFUSAL = "Konteks has not finished starting on this computer, so this command cannot run yet.";
const previousExitCode = process.exitCode;

let root = "";
let control: ControlSocketServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kr-doctor-startup-"));
  process.exitCode = 0;
});
afterEach(async () => {
  await control?.close().catch(() => undefined);
  control = undefined;
  process.exitCode = previousExitCode;
  await rm(root, { recursive: true, force: true });
});

/**
 * A connector that owns its socket but has not finished starting: the real
 * pre-startup gate, refusing every op it cannot compose with
 * RemoteInstanceError("temporarily_unavailable").
 */
async function refusingControl(): Promise<void> {
  const token = "control-token-0123456789";
  control = await startControlSocketServer({
    token,
    port: 0,
    handler: async () => { throw new RemoteInstanceError("temporarily_unavailable", PRE_STARTUP_REFUSAL); },
  });
  await writeSecretFile(join(root, "supervisor", "control.token"), `${token}\n`);
  await writeSecretFile(join(root, "native-runtime.json"), JSON.stringify({
    schemaVersion: 1, deploymentKind: "native_connector", instanceId: "instance-1", workspaceId: "workspace-1",
    releaseId: "release-1", manifestDigest: "digest-1", bundleVersion: "0.20.0", coreUrl: "https://core.test",
    relayUrl: "wss://relay.test", controlPort: control.port, agents: [],
  }));
}

function sink() {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  return { stream, text: () => text };
}

describe("doctor while the connector has not finished starting", () => {
  it("prints this computer's local report and keeps doctor's exit code instead of propagating the refusal", async () => {
    await refusingControl();
    const out = sink();
    await expect(nativeCliActions.control({
      root,
      output: createOutput({ json: false, stdout: out.stream, stderr: out.stream }),
      operation: "doctor",
    })).resolves.toBeUndefined();
    expect(out.text()).toContain("only these local checks ran");
    expect(out.text()).toContain("Connector log:");
    expect(out.text()).toContain("konteks-remote start");
    expect(out.text()).not.toContain("has not finished starting");
    expect(out.text()).not.toContain("temporarily_unavailable");
    expect(process.exitCode).toBe(2);
  });

  it("prints the same local report for the support bundle preview", async () => {
    await refusingControl();
    const out = sink();
    await expect(nativeCliActions.control({
      root,
      output: createOutput({ json: false, stdout: out.stream, stderr: out.stream }),
      operation: "support",
    })).resolves.toBeUndefined();
    expect(out.text()).toContain("only these local checks ran");
    expect(out.text()).not.toContain("has not finished starting");
    expect(out.text()).not.toContain("temporarily_unavailable");
    expect(process.exitCode).toBe(0);
  });
});
