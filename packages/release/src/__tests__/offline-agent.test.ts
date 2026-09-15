import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { installOfflineAgentPackage, verifyOfflineAgentPackage } from "../offline-agent.js";

const hash = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const folders: string[] = [];
afterEach(async () => { for (const root of folders.splice(0)) await rm(root, { recursive: true, force: true }); });

import { offlineFixture, tar } from "./offline-agent-fixture.js";
import { NativeAgentPackageProfileSchema } from "../offline-profile.js";

describe("complete signed offline agent profile", () => {
  it("requires a real inventoried executable for the Unix-only Codex proxy", () => {
    const { profile } = offlineFixture();
    expect(NativeAgentPackageProfileSchema.safeParse({ ...profile, codexLocalProxy: { version: 1, entrypoint: "missing.js" } }).success).toBe(false);
    expect(NativeAgentPackageProfileSchema.safeParse({ ...profile, codexLocalProxy: { version: 1, entrypoint: "bridge/index.js" } }).success).toBe(false);
    expect(NativeAgentPackageProfileSchema.safeParse({ ...profile, codexLocalProxy: { version: 1, entrypoint: "bin/codex" } }).success).toBe(true);
    const windows = offlineFixture("windows").profile;
    expect(NativeAgentPackageProfileSchema.safeParse({ ...windows, codexLocalProxy: { version: 1, entrypoint: "bin/codex.exe" } }).success).toBe(false);
  });
  it.each(["macos", "windows", "debian"])("installs bridge, official tooling and bundled runtime for %s", async os => {
    const fixture = offlineFixture(os, os === "windows" ? "amd64" : "arm64");
    const root = await mkdtemp(join(tmpdir(), "offline-agent-")); folders.push(root);
    const archive = join(root, "package.tgz"), destination = join(root, "agent");
    await writeFile(archive, fixture.archive, { mode: 0o600 });
    const profile = await installOfflineAgentPackage(archive, destination, fixture.artifact as never);
    expect(profile).toEqual(fixture.profile);
    expect(await readFile(join(destination, fixture.profile.tooling.entrypoint))).toEqual(fixture.files[0]!.bytes);
    await expect(verifyOfflineAgentPackage(destination, fixture.artifact as never)).resolves.toEqual(profile);
    await writeFile(join(destination, "bridge/node_modules/example/package.json"), "modified");
    await expect(verifyOfflineAgentPackage(destination, fixture.artifact as never)).rejects.toThrow();
  });
  it("rejects a re-signed-looking local receipt with a different dependency tree", async () => {
    const fixture = offlineFixture();
    const root = await mkdtemp(join(tmpdir(), "offline-agent-")); folders.push(root);
    const archive = join(root, "package.tgz"); await writeFile(archive, fixture.archive, { mode: 0o600 });
    await expect(installOfflineAgentPackage(archive, join(root, "agent"), { ...fixture.artifact, profileDigest: `sha256:${"f".repeat(64)}` } as never)).rejects.toThrow();
  });
  it.each(["../escape", "C:/escape", "bin/CON.exe", "bin/codex."])("rejects unsafe archive path %s", async path => {
    const fixture = offlineFixture();
    fixture.entries[1]!.path = path;
    const bytes = gzipSync(tar(fixture.entries));
    const root = await mkdtemp(join(tmpdir(), "offline-agent-")); folders.push(root);
    const archive = join(root, "package.tgz"); await writeFile(archive, bytes, { mode: 0o600 });
    await expect(installOfflineAgentPackage(archive, join(root, "agent"), { ...fixture.artifact, digest: hash(bytes), sizeBytes: bytes.length } as never)).rejects.toThrow();
  });
  it.each(["1", "2", "3", "5", "x", "g", "L", "S"])("rejects link/device/directory/extension archive type %s", async type => {
    const fixture = offlineFixture();
    const entries = fixture.entries.map((entry, index) => ({ ...entry, ...(index === 1 ? { type } : {}) }));
    const bytes = gzipSync(tar(entries));
    const root = await mkdtemp(join(tmpdir(), "offline-agent-")); folders.push(root);
    const archive = join(root, "package.tgz"); await writeFile(archive, bytes, { mode: 0o600 });
    await expect(installOfflineAgentPackage(archive, join(root, "agent"), { ...fixture.artifact, digest: hash(bytes), sizeBytes: bytes.length } as never)).rejects.toThrow();
  });
  it("rejects directory spelling collisions across case-insensitive platforms", () => {
    const { profile } = offlineFixture();
    profile.files.push({ ...profile.files[3]!, path: "BRIDGE/other.js" });
    profile.files.sort((a, b) => a.path < b.path ? -1 : 1);
    expect(NativeAgentPackageProfileSchema.safeParse(profile).success).toBe(false);
  });
  it("rejects Pi even with official tooling until native auth and MCP compatibility are proven", () => {
    const { profile } = offlineFixture();
    const pi = { ...profile, agentId: "pi", bridge: { ...profile.bridge, package: "pi-acp", version: "0.0.33" }, tooling: { ...profile.tooling, package: "@earendil-works/pi-coding-agent", version: "0.80.4" } };
    expect(NativeAgentPackageProfileSchema.safeParse(pi).success).toBe(false);
    expect(NativeAgentPackageProfileSchema.safeParse({ ...pi, tooling: { ...pi.tooling, package: "@mariozechner/pi-coding-agent" } }).success).toBe(false);
  });
  it.each(["runtime", "official_tooling", "entrypoint", "arguments"])("rejects an incomplete or mutable %s profile", failure => {
    const { profile } = offlineFixture();
    const changed = failure === "runtime" ? { ...profile, node: undefined }
      : failure === "official_tooling" ? { ...profile, tooling: { ...profile.tooling, package: "unofficial-login-tool" } }
        : failure === "entrypoint" ? { ...profile, bridge: { ...profile.bridge, entrypoint: "missing.js" } }
          : { ...profile, bridge: { ...profile.bridge, args: ["--eval", "untrusted"] } };
    expect(NativeAgentPackageProfileSchema.safeParse(changed).success).toBe(false);
  });
});
