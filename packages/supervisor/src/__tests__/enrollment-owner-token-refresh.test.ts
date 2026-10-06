import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedClock, verifyInstanceProof } from "@konteks/remote-common";
import { NativeEnrollment } from "../native/enrollment.js";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { SupervisorStore } from "../state/store.js";

describe("refreshing the person's Konteks access while the connector runs (09-30)", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it("signs with the existing machine key when the running connector holds the data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "enroll-")); dirs.push(dataDir);
    const key = await new SupervisorStore(dataDir).loadOrCreateInstanceKey();
    const running = acquireNativeRootLock(dataDir);
    try {
      const bodies: Array<{ instanceId: string; issuedAt: number; proof: Parameters<typeof verifyInstanceProof>[2] }> = [];
      const fetchFn = vi.fn(async (_input: string | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ token: "t2", expiresAt: "2026-09-30T10:00:00.000Z", userRef: "user:default/hello", tenantId: "konteks-3" });
      });
      const clock = new FixedClock(Date.parse("2026-09-30T09:00:00.999Z"));
      clock.observeCoreTime(clock.now() - 10_000, 0);
      const enrollment = new NativeEnrollment({ dataDir, coreUrl: "https://core.example", clock, fetchFn: fetchFn as never });
      await expect(enrollment.refreshOwnerToken("instance-1")).resolves.toMatchObject({ token: "t2", tenantId: "konteks-3" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const first = bodies[0]!;
      expect(first.issuedAt).toBe(Math.floor(clock.coreNow() / 1000));
      const signed = { method: "enrollment_token", audience: "konteks:remote-instance", subject: "instance-1", body: { instanceId: first.instanceId, issuedAt: first.issuedAt } };
      expect(verifyInstanceProof(key.publicKey, signed, first.proof)).toBe(true);
      expect(verifyInstanceProof(key.publicKey, { ...signed, body: { ...signed.body, issuedAt: first.issuedAt + 1 } }, first.proof)).toBe(false);
      clock.advance(301_000);
      await enrollment.refreshOwnerToken("instance-1");
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(bodies[1]!.issuedAt).toBe(Math.floor(clock.coreNow() / 1000));
      expect(bodies[1]!.proof.nonce).not.toBe(first.proof.nonce);
    } finally {
      running.release();
    }
  });

  it("still refuses when there is no machine key to sign with", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "enroll-")); dirs.push(dataDir);
    const running = acquireNativeRootLock(dataDir);
    try {
      const enrollment = new NativeEnrollment({ dataDir, coreUrl: "https://core.example", clock: new FixedClock(0), fetchFn: vi.fn() as never });
      await expect(enrollment.refreshOwnerToken("instance-1")).rejects.toMatchObject({ code: "temporarily_unavailable" });
    } finally {
      running.release();
    }
  });
});
