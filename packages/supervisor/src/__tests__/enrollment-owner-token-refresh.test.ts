import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedClock } from "@konteks/remote-common";
import { NativeEnrollment } from "../native/enrollment.js";
import { acquireNativeRootLock } from "../native/root-lock.js";
import { SupervisorStore } from "../state/store.js";

describe("refreshing the person's Konteks access while the connector runs (09-30)", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it("signs with the existing machine key when the running connector holds the data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "enroll-")); dirs.push(dataDir);
    await new SupervisorStore(dataDir).loadOrCreateInstanceKey();
    const running = acquireNativeRootLock(dataDir);
    try {
      const fetchFn = vi.fn(async () => Response.json({ token: "t2", expiresAt: "2026-09-30T10:00:00.000Z", userRef: "user:default/hello", tenantId: "konteks-3" }));
      const enrollment = new NativeEnrollment({ dataDir, coreUrl: "https://core.example", clock: new FixedClock(Date.parse("2026-09-30T09:00:00.000Z")), fetchFn: fetchFn as never });
      await expect(enrollment.refreshOwnerToken("instance-1")).resolves.toMatchObject({ token: "t2", tenantId: "konteks-3" });
      expect(fetchFn).toHaveBeenCalledTimes(1);
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
