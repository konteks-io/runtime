import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ed25519Sign,
  generateEd25519,
  generateInstanceKey,
  jcsDigest,
  remoteControlSigningBytes,
  type DesiredConfigurationEnvelope,
  type JsonValue,
} from "@konteks/remote-common";
import {
  SupervisorStore,
  type NativeRuntimeRecord,
  type NativeUpdateAttempt,
} from "@konteks/remote-supervisor";
import { beginNativeUpdateProgress } from "../native/update-progress.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-progress-"));
  roots.push(root);
  const store = new SupervisorStore(join(root, "supervisor"));
  await store.replaceInstanceKey(generateInstanceKey());
  await store.saveIdentity({
    instanceId: "instance",
    workspaceId: "tenant",
    activationId: "activation",
    activatedAt: new Date().toISOString(),
    administrativeStatus: "active",
    exchangeNonce: "nonce",
  });
  const lease = {
    lease: "fixture-lease",
    mode: "active" as const,
    workspaceId: "tenant",
    issuedAt: new Date(Date.now() - 5_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    drainDeadline: null,
  };
  await store.saveLease(lease);
  const keys = generateEd25519();
  const trust = [
    {
      keyId: "root",
      publicKeyJwk: generateEd25519().publicJwk,
      coreControlKeys: [{ keyId: "control", publicKeyJwk: keys.publicJwk }],
    },
  ];
  const previous = {
    instanceId: "instance",
    workspaceId: "tenant",
    coreUrl: "https://core.example",
  } as NativeRuntimeRecord;
  const attempt = {
    id: "native-attempt",
    bundleVersion: "1.1.0",
    manifestDigest: "a".repeat(43),
  } as NativeUpdateAttempt;
  const configuration = {
    deploymentKind: "native_connector" as const,
    roleBindings: [],
    heartbeatIntervalSeconds: 15,
    logLevel: "info" as const,
    updateChannel: "stable" as const,
    evidenceUpload: "selected_artifacts" as const,
    permissionResponderDeadlineSeconds: 120,
    humanDeferralAllowed: true,
    coreContractVersion: "7.4",
  };
  const signed = (overrides: Partial<DesiredConfigurationEnvelope> = {}) => {
    const selected = overrides.configuration ?? configuration;
    const body = {
      type: "desired_configuration" as const,
      instanceId: "instance",
      revision: 1,
      issuedAt: new Date(Date.now() - 5_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      configuration: selected,
      digest: jcsDigest(selected as JsonValue),
      ...overrides,
    };
    return {
      ...body,
      signature: ed25519Sign(
        keys.privateKey,
        remoteControlSigningBytes(body as unknown as Record<string, JsonValue>),
      ),
    };
  };
  const view = {
    updateId: "local-update",
    instanceId: "instance",
    targetBundle: attempt.bundleVersion,
    manifestDigest: attempt.manifestDigest,
    state: "updating",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: lease.expiresAt,
  };
  const envelope = { value: signed() };
  const fetchFn = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("desired-configuration")
            ? envelope.value
            : String(url).endsWith("/local")
              ? { update: view }
              : { accepted: true },
        ),
        { status: String(url).endsWith("/local") ? 202 : 200 },
      ),
  );
  return { root, store, lease, trust, previous, attempt, signed, view, envelope, fetchFn };
}

describe("trusted foreground update progress", () => {
  it("uses signed Core 7.4 admission and rereads only the successor lease for the fixed terminal report", async () => {
    const f = await fixture();
    const before = await readdir(join(f.root, "supervisor"));
    const handle = await beginNativeUpdateProgress(f, { roots: f.trust, fetchFn: f.fetchFn });
    expect(handle).not.toBeNull();
    const request = f.fetchFn.mock.calls[1]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toEqual({
      attemptId: f.attempt.id,
      targetBundle: f.attempt.bundleVersion,
      manifestDigest: f.attempt.manifestDigest,
    });
    await f.store.saveLease({ ...f.lease, lease: "successor-fixture-lease" });
    await handle!.finish("succeeded");
    const report = f.fetchFn.mock.calls[2]! as unknown as [string, RequestInit];
    expect(new Headers(report[1].headers).get("authorization")).toBe(
      "Bearer successor-fixture-lease",
    );
    expect(JSON.parse(String(report[1].body))).toEqual({
      updateId: f.view.updateId,
      targetBundle: f.attempt.bundleVersion,
      manifestDigest: f.attempt.manifestDigest,
      state: "succeeded",
    });
    expect(await readdir(join(f.root, "supervisor"))).toEqual(before);
  });

  it.each(["old_core", "expired", "future", "digest", "signature"] as const)(
    "never announces execution with %s configuration",
    async (kind) => {
      const f = await fixture();
      const overrides = {
        old_core: {
          configuration: { ...f.envelope.value.configuration, coreContractVersion: "7.3" },
        },
        expired: {
          issuedAt: new Date(Date.now() - 10_000).toISOString(),
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
        future: {
          issuedAt: new Date(Date.now() + 30_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        digest: { digest: "b".repeat(43) },
        signature: {},
      };
      f.envelope.value = f.signed(overrides[kind]);
      if (kind === "signature") f.envelope.value.signature = "A".repeat(86);
      expect(await beginNativeUpdateProgress(f, { roots: f.trust, fetchFn: f.fetchFn })).toBeNull();
      expect(f.fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it("allows the existing one-second signed-delivery clock tolerance and reports a safe failure without diagnostics", async () => {
    const f = await fixture();
    f.envelope.value = f.signed({ issuedAt: new Date(Date.now() + 500).toISOString() });
    const handle = await beginNativeUpdateProgress(f, { roots: f.trust, fetchFn: f.fetchFn });
    expect(handle).not.toBeNull();
    await handle!.finish("failed");
    const [, request] = f.fetchFn.mock.calls[2]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      updateId: f.view.updateId,
      targetBundle: f.attempt.bundleVersion,
      manifestDigest: f.attempt.manifestDigest,
      state: "failed",
      failure: "update_failed",
    });
  });

  it("cannot use TLS authority alone when the launcher has no independently trusted Core control key", async () => {
    const f = await fixture();
    expect(await beginNativeUpdateProgress(f, { roots: [], fetchFn: f.fetchFn })).toBeNull();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it.each(["missing_identity", "wrong_workspace", "expired_lease", "drain_only"] as const)(
    "never announces execution for %s authority",
    async (kind) => {
      const f = await fixture();
      if (kind === "missing_identity") await rm(join(f.root, "supervisor", "identity.json"));
      if (kind === "wrong_workspace") f.previous = { ...f.previous, workspaceId: "other" };
      if (kind === "expired_lease")
        await f.store.saveLease({
          ...f.lease,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        });
      if (kind === "drain_only") await f.store.saveLease({ ...f.lease, mode: "drain_only" });
      expect(await beginNativeUpdateProgress(f, { roots: f.trust, fetchFn: f.fetchFn })).toBeNull();
      expect(f.fetchFn).not.toHaveBeenCalled();
    },
  );

  it("does not send a terminal report after enrollment was replaced", async () => {
    const f = await fixture();
    const handle = await beginNativeUpdateProgress(f, { roots: f.trust, fetchFn: f.fetchFn });
    const identity = await f.store.identity();
    await f.store.saveIdentity({ ...identity!, instanceId: "replacement" });
    await handle!.finish("failed");
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });
});
