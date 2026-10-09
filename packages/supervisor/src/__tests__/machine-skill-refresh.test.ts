import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRemoteFileTreeDigest, computeRuntimeSkillSyncCatalogDigest } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { MachineSkillPartialFailure, MachineSkillSyncFailure, machineSkillHomes, refreshMachineSkills } from "../native/skill-refresh.js";
it.each([false, true])("verifies installed trees across configured agent homes, tampered=%s", async tampered => {
  const root = await mkdtemp(join(tmpdir(), "machine-refresh-"));
  try {
    const homes = machineSkillHomes([{ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: join(root, "codex-auth"), RUNNER_NATIVE_CODEX_HOME: join(root, ".codex") }, { RUNNER_AGENT_ID: "claude-code", RUNNER_CREDENTIAL_DIR: join(root, "claude-auth"), RUNNER_NATIVE_CLAUDE_EXECUTABLE: join(root, "claude") }, { RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: join(root, "dsh-auth") }, { RUNNER_AGENT_ID: "opencode", RUNNER_CREDENTIAL_DIR: join(root, "opencode-auth") }, { RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: join(root, "antigravity-auth") }], root);
    for (const home of homes) await mkdir(home, { recursive: true, mode: 0o700 });
    const content = Buffer.from("# Organization Skill");
    const entries = [{ path: "SKILL.md", mode: 0o600 as const, sizeBytes: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, contentBase64: content.toString("base64") }];
    const tree = { format: "konteks-file-tree-v1" as const, entries, treeDigest: computeRemoteFileTreeDigest(entries) };
    const skill = { skillId: "11111111-1111-4111-8111-111111111111", name: "org-example", description: "Example", version: "1.0.0", treeDigest: tree.treeDigest, sizeBytes: content.length, fileCount: 1 };
    const catalog = { version: 1 as const, complete: true as const, binding: { workspaceId: "tenant-a", instanceId: "machine-a", syncId: "sync-a" }, skills: [skill] };
    const envelope = { type: "runtime_skill_sync" as const, instanceId: "machine-a", catalog, catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), signature: "c2lnbmVk" };
    let authorizations = 0;
    const client = { prepare: vi.fn(async () => envelope), read: vi.fn(async () => tree), authorize: vi.fn(async () => {
      if (tampered && ++authorizations === 6) {
        const retained = join(homes[0]!, ".konteks-skill-sync", "trees", `tree-${createHash("sha256").update(tree.treeDigest).digest("hex")}`, "SKILL.md");
        await writeFile(retained, "tampered");
      }
    }) };
    const onVerified = vi.fn();
    const profileBindings = homes.map((home, index) => ({ home, agentId: ["codex", "claude-code", "dsh", "opencode", "antigravity"][index]! }));
    const outcome = refreshMachineSkills({ profileBindings, onVerified, client, scratchRoot: join(root, "cache"), homes, owner: { workspaceId: "tenant-a", instanceId: "machine-a" }, now: Date.now }, new AbortController().signal);
    if (tampered) {
      const error = await outcome.catch(value => value);
      expect(error).toBeInstanceOf(MachineSkillPartialFailure);
      expect(error.inventory.profiles[0]).toMatchObject({ agentId: "codex", status: "failed" });
      expect(error.inventory.profiles.slice(1).every((profile: { status: string }) => profile.status === "installed")).toBe(true);
      expect(onVerified).not.toHaveBeenCalled();
      return;
    }
    const result = await outcome;
    expect(onVerified).toHaveBeenCalledWith(expect.objectContaining({ skills: [expect.objectContaining({ skillId: skill.skillId, fileModes: { "SKILL.md": 0o600 } })] }), homes, { workspaceId: "tenant-a", instanceId: "machine-a" });
    expect(result.skills).toEqual([skill]); expect(result.profiles).toHaveLength(5);
    expect(result.profiles.map(profile => profile.agentId)).toEqual(profileBindings.map(profile => profile.agentId));
    for (const profile of result.profiles) expect(await readFile(join(profile.paths[0]!, "SKILL.md"), "utf8")).toBe("# Organization Skill");
    expect(client.read).toHaveBeenCalledTimes(1); expect(client.authorize.mock.calls.length).toBeGreaterThan(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses unconfigured homes before requesting organization files", async () => {
  const prepare = vi.fn();
  await expect(refreshMachineSkills({ client: { prepare, read: vi.fn(), authorize: vi.fn() }, scratchRoot: "/tmp/unused", homes: [], owner: { workspaceId: "a", instanceId: "b" }, now: Date.now }, new AbortController().signal)).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled();
});

it("includes the DeepSeek Harness home used by its native adapter", () => {
  const credentialDir = join(tmpdir(), "native-dsh-profile");
  expect(machineSkillHomes([{ RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: credentialDir }])).toEqual([join(credentialDir, ".dsh")]);
  expect(machineSkillHomes([{ RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: credentialDir }])).toEqual([]);
});

it("reports a closed failed phase without carrying transport secrets or paths", async () => {
  const prepare = vi.fn(async () => { throw new Error("secret bearer and /private/profile"); });
  const error = await refreshMachineSkills({ client: { prepare, read: vi.fn(), authorize: vi.fn() },
    scratchRoot: "/tmp/unused", homes: ["/tmp/agent"], owner: { workspaceId: "a", instanceId: "b" }, now: Date.now },
    new AbortController().signal).catch(value => value);
  expect(error).toBeInstanceOf(MachineSkillSyncFailure);
  expect(error.phase).toBe("catalog");
  expect(JSON.stringify(error)).not.toMatch(/secret|private|bearer/);
  expect(error.message).toBe("Organization Skill synchronization failed during catalog");
  expect(error.cause).toBeUndefined();
});

it("continues after a failed profile and never reports a partial refresh as verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-partial-refresh-"));
  try {
    const broken = join(root, "broken"), healthy = join(root, "healthy");
    await writeFile(broken, "occupied", { mode: 0o600 });
    await mkdir(healthy, { mode: 0o700 });
    const catalog = { version: 1 as const, complete: true as const,
      binding: { workspaceId: "tenant-a", instanceId: "machine-a", syncId: "sync-a" }, skills: [] };
    const envelope = { type: "runtime_skill_sync" as const, instanceId: "machine-a", catalog,
      catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog), issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), signature: "c2lnbmVk" };
    const onVerified = vi.fn();
    const error = await refreshMachineSkills({ client: { prepare: async () => envelope, read: vi.fn(), authorize: async () => {} },
      scratchRoot: join(root, "cache"), homes: [broken, healthy], unavailableAgentIds: ["codex"],
      profileBindings: [{ home: broken, agentId: "dsh" }, { home: healthy, agentId: "opencode" }, { home: healthy, agentId: "antigravity" }, { home: healthy, agentId: "opencode" }],
      owner: { workspaceId: "tenant-a", instanceId: "machine-a" }, now: Date.now, onVerified },
      new AbortController().signal).catch(value => value);
    expect(error).toBeInstanceOf(MachineSkillPartialFailure);
    expect(error.inventory.profiles).toEqual([
      { agentId: "codex", home: "", paths: [], status: "failed", reason: "native_profile_unconfigured" },
      { agentId: "dsh", home: broken, paths: [], status: "failed", reason: "profile_publication_failed" },
      { agentId: "opencode", home: healthy, paths: [], status: "installed" },
      { agentId: "antigravity", home: healthy, paths: [], status: "installed" },
    ]);
    expect(onVerified).not.toHaveBeenCalled();
    expect(await readFile(broken, "utf8")).toBe("occupied");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("stops publication when authorization is revoked instead of continuing profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-revoked-refresh-"));
  try {
    const homes = [join(root, "first"), join(root, "second")];
    const catalog = { version: 1 as const, complete: true as const,
      binding: { workspaceId: "tenant-a", instanceId: "machine-a", syncId: "sync-a" }, skills: [] };
    const envelope = { type: "runtime_skill_sync" as const, instanceId: "machine-a", catalog,
      catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog), issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), signature: "c2lnbmVk" };
    let calls = 0;
    const authorize = vi.fn(async () => { if (++calls > 3) throw new Error("revoked"); });
    const error = await refreshMachineSkills({ client: { prepare: async () => envelope, read: vi.fn(), authorize },
      scratchRoot: join(root, "cache"), homes,
      owner: { workspaceId: "tenant-a", instanceId: "machine-a" }, now: Date.now },
      new AbortController().signal).catch(value => value);
    expect(error).toBeInstanceOf(MachineSkillSyncFailure);
    expect(error).not.toBeInstanceOf(MachineSkillPartialFailure);
    expect(error.phase).toBe("authorization");
    expect(calls).toBe(4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uses only installer-bound personal profiles and ignores credential directories as discovery homes", () => {
  const operator = join(tmpdir(), "skill-operator");
  const codex = join(operator, "custom-codex");
  expect(machineSkillHomes([
    { RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: join(operator, "credentials-codex"), RUNNER_NATIVE_CODEX_HOME: codex },
    { RUNNER_AGENT_ID: "claude-code", RUNNER_CREDENTIAL_DIR: join(operator, "credentials-claude"), RUNNER_NATIVE_CLAUDE_EXECUTABLE: join(operator, "bin", "claude") },
  ], operator)).toEqual([codex, join(operator, ".claude")]);
  expect(machineSkillHomes([
    { RUNNER_AGENT_ID: "codex", RUNNER_CREDENTIAL_DIR: join(operator, "unbound-codex") },
    { RUNNER_AGENT_ID: "claude-code", RUNNER_CREDENTIAL_DIR: join(operator, "unbound-claude") },
  ], operator)).toEqual([]);
});

it("reports every unconfigured agent without fetching a catalog when no profile is usable", async () => {
  const prepare = vi.fn(), read = vi.fn(), authorize = vi.fn(), onVerified = vi.fn();
  const error = await refreshMachineSkills({ client: { prepare, read, authorize }, scratchRoot: "/tmp/unused",
    homes: [], unavailableAgentIds: ["codex", "claude-code", "codex"],
    owner: { workspaceId: "tenant-a", instanceId: "machine-a" }, now: Date.now, onVerified },
    new AbortController().signal).catch(value => value);
  expect(error).toBeInstanceOf(MachineSkillPartialFailure);
  expect(error.inventory).toEqual({ skills: [], profiles: [
    { agentId: "codex", home: "", paths: [], status: "failed", reason: "native_profile_unconfigured" },
    { agentId: "claude-code", home: "", paths: [], status: "failed", reason: "native_profile_unconfigured" },
  ] });
  expect(prepare).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
  expect(onVerified).not.toHaveBeenCalled();
});
