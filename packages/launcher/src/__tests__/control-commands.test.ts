import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ControlRequest, SupervisorStatus } from "@konteks/remote-common";
import { authLogin, status, type ControlContext } from "../native/control-commands.js";
import { createOutput } from "../output.js";

const supervisorStatus: SupervisorStatus = {
  instanceId: "inst-1",
  workspaceId: "ws",
  administrativeStatus: "active",
  connectivity: { transport: "relay", relayConnected: true, lastConnectedAt: null, reconciliationComplete: true },
  lease: { mode: "active", expiresAt: null, drainDeadline: null },
  version: { bundle: "1.0.0", protocol: "1", manifestDigest: null, updateAvailable: false, targetBundle: null },
  configRevision: 1,
  components: [],
  roles: [],
  roleBindings: [],
  utilization: { acceptingWork: true, activeSessions: 0, activeTurns: 0, utilizationRatio: 0 },
  previewEnabled: false,
  previewExposure: null,
  pendingErase: 0,
  pendingRevocation: false,
  journal: { assignments: 0, outboxDepth: 0, recoveryRequired: 0 },
};

function fake(options: { json?: boolean; confirm?: boolean } = {}) {
  const calls: ControlRequest[] = [];
  let text = "";
  const sink = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const control = {
    call: async <T,>(request: ControlRequest, schema: { parse: (value: unknown) => T }, callOptions?: { onEvent?: (event: unknown) => void }): Promise<T> => {
      calls.push(request);
      if (request.op === "status") return schema.parse(supervisorStatus);
      if (request.op === "auth.login") {
        callOptions?.onEvent?.({ kind: "started", loginId: "l1", agentId: request.agentId });
        callOptions?.onEvent?.({ kind: "open_url", loginId: "l1", url: "https://login.example/device", userCode: "ABCD-1234" });
        callOptions?.onEvent?.({ kind: "prompt", loginId: "l1", label: "Paste the code", secret: true });
        callOptions?.onEvent?.({ kind: "completed", loginId: "l1", readiness: "ready" });
        return schema.parse({ loginId: "l1" });
      }
      return schema.parse({});
    },
  };
  const context: ControlContext = {
    output: createOutput({ json: options.json ?? false, stdout: sink, stderr: sink }),
    control: control as never,
    confirm: async () => options.confirm ?? true,
    promptSecret: async () => "pasted-secret-value",
  };
  return { context, calls, text: () => text };
}

describe("native control commands", () => {
  it("exposes only the public lease summary in machine-readable status", async () => {
    const f = fake({ json: true });
    await status(f.context);
    const result = JSON.parse(f.text());
    expect(result.leaseStatus).toEqual({ mode: "active", expiresAt: null, drainDeadline: null });
    expect(typeof result.lease).toBe("string"); // generic bearer redaction remains intact
  });

  it("relays the official tooling's URL/code, answers a secret prompt without echo, and records the organization attestation only after consent", async () => {
    const f = fake();
    await authLogin(f.context, "codex", true);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.text()).toContain("https://login.example/device");
    expect(f.text()).toContain("ABCD-1234");
    expect(f.text()).not.toContain("pasted-secret-value");
    expect(f.calls.find(call => call.op === "auth.login")).toMatchObject({ agentId: "codex", organization: true });
    expect(f.calls.find(call => call.op === "auth.input")).toMatchObject({ loginId: "l1", text: "pasted-secret-value" });
    const declined = fake({ confirm: false });
    await expect(authLogin(declined.context, "codex", true)).rejects.toMatchObject({ code: "ownership_promotion_denied" });
  });
});
