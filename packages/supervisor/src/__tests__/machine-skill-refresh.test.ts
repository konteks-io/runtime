import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRemoteFileTreeDigest, computeRuntimeSkillSyncCatalogDigest } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { MachineSkillSyncFailure, machineSkillHomes, refreshMachineSkills } from "../native/skill-refresh.js";
it("publishes the selected complete organization tree into every configured agent home", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-refresh-"));
  try {
    const homes = machineSkillHomes([{ RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: join(root, "dsh-auth"), RUNNER_NATIVE_SKILL_HOMES: [join(root, ".codex"), join(root, ".claude")] }, { RUNNER_AGENT_ID: "opencode", RUNNER_CREDENTIAL_DIR: join(root, "opencode-auth") }, { RUNNER_AGENT_ID: "antigravity", RUNNER_CREDENTIAL_DIR: join(root, "antigravity-auth") }]);
    for (const home of homes) await mkdir(home, { recursive: true, mode: 0o700 });
    const content = Buffer.from("# Organization Skill");
    const entries = [{ path: "SKILL.md", mode: 0o600 as const, sizeBytes: content.length, digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, contentBase64: content.toString("base64") }];
    const tree = { format: "konteks-file-tree-v1" as const, entries, treeDigest: computeRemoteFileTreeDigest(entries) };
    const skill = { skillId: "11111111-1111-4111-8111-111111111111", name: "org-example", description: "Example", version: "1.0.0", treeDigest: tree.treeDigest, sizeBytes: content.length, fileCount: 1 };
    const catalog = { version: 1 as const, complete: true as const, binding: { workspaceId: "tenant-a", instanceId: "machine-a", syncId: "sync-a" }, skills: [skill] };
    const envelope = { type: "runtime_skill_sync" as const, instanceId: "machine-a", catalog, catalogDigest: computeRuntimeSkillSyncCatalogDigest(catalog), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), signature: "c2lnbmVk" };
    const client = { prepare: vi.fn(async () => envelope), read: vi.fn(async () => tree), authorize: vi.fn(async () => {}) };
    const onVerified = vi.fn();
    const result = await refreshMachineSkills({ onVerified, client, scratchRoot: join(root, "cache"), homes, owner: { workspaceId: "tenant-a", instanceId: "machine-a" }, now: Date.now }, new AbortController().signal);
    expect(onVerified).toHaveBeenCalledWith(expect.objectContaining({ skills: [expect.objectContaining({ skillId: skill.skillId, fileModes: { "SKILL.md": 0o600 } })] }), homes, { workspaceId: "tenant-a", instanceId: "machine-a" });
    expect(result.skills).toEqual([skill]); expect(result.profiles).toHaveLength(5);
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
  expect(machineSkillHomes([{ RUNNER_AGENT_ID: "dsh", RUNNER_CREDENTIAL_DIR: credentialDir, RUNNER_NATIVE_SKILL_HOMES: [join(tmpdir(), "personal-dsh")] }])).toEqual([join(tmpdir(), "personal-dsh"), join(credentialDir, ".dsh")]);
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
