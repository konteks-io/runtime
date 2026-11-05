import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSecretFile } from "@konteks/remote-common";
import { SupervisorStore } from "../state/store.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "serving-release-")); roots.push(root);
  const store = new SupervisorStore(root); await store.init();
  await store.saveIdentity({ instanceId: "instance", workspaceId: "tenant", activationId: "activation", activatedAt: new Date().toISOString(), administrativeStatus: "active", exchangeNonce: "nonce" });
  const confirm = (id: string, version: string) => store.confirmServingRelease({ instanceId: "instance", workspaceId: "tenant", release: { releaseId: id, bundleVersion: version, manifestDigest: `digest-${version}` } }, () => undefined);
  return { store, confirm };
}

describe("Core-confirmed serving release retention", () => {
  it("records the first confirmed release with an unknown predecessor", async () => {
    const f = await fixture(); await f.confirm("release-first", "1.0.0");
    expect(await f.store.servingReleaseHistory()).toMatchObject({ instanceId: "instance", workspaceId: "tenant", current: { releaseId: "release-first" }, previous: null });
  });
  it("keeps the previous Core-confirmed release through skipped offline versions", async () => {
    const f = await fixture(); await f.confirm("release-first", "1.0.0"); await f.confirm("release-fourth", "4.0.0");
    expect(await f.store.servingReleaseHistory()).toMatchObject({ current: { releaseId: "release-fourth" }, previous: { releaseId: "release-first" } });
  });
  it("does not invent a known predecessor when agents restage the same bundle", async () => {
    const f = await fixture(); await f.confirm("release-first", "1.0.0"); await f.confirm("release-agents", "1.0.0");
    expect(await f.store.servingReleaseHistory()).toMatchObject({ current: { releaseId: "release-agents" }, previous: null });
    await f.confirm("release-second", "2.0.0"); await f.confirm("release-second-agents", "2.0.0");
    expect(await f.store.servingReleaseHistory()).toMatchObject({ current: { releaseId: "release-second-agents" }, previous: { releaseId: "release-agents" } });
  });
  it("cannot record a release without the caller's live accepted authority", async () => {
    const f = await fixture();
    await expect(f.store.confirmServingRelease({ instanceId: "instance", workspaceId: "tenant", release: { releaseId: "release-next", bundleVersion: "2.0.0", manifestDigest: "digest" } }, () => { throw new Error("authority lost"); })).rejects.toThrow("authority lost");
    expect(await f.store.servingReleaseHistory()).toBeNull();
  });
  it("preserves history when an immutable release folder is reused for another bundle", async () => {
    const f = await fixture(); await f.confirm("release-first", "1.0.0");
    const original = await f.store.servingReleaseHistory();
    await expect(f.confirm("release-first", "2.0.0")).rejects.toThrow();
    expect(await f.store.servingReleaseHistory()).toEqual(original);
  });
  it.each(["instanceId", "workspaceId"])("never replaces history belonging to a different %s", async field => {
    const f = await fixture(); await f.confirm("release-first", "1.0.0");
    const original = await f.store.servingReleaseHistory();
    await expect(f.store.confirmServingRelease({ instanceId: "instance", workspaceId: "tenant", [field]: "other", release: { releaseId: "release-next", bundleVersion: "2.0.0", manifestDigest: "digest" } }, () => undefined)).rejects.toThrow();
    expect(await f.store.servingReleaseHistory()).toEqual(original);
  });
  it("preserves malformed history rather than overwriting unknown rollback references", async () => {
    const f = await fixture(); await writeSecretFile(f.store.path("serving-releases.json"), "unreadable history");
    await expect(f.confirm("release-next", "2.0.0")).rejects.toThrow();
    expect(await readFile(f.store.path("serving-releases.json"), "utf8")).toBe("unreadable history");
  });
});
