import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAsset, isSea } from "node:sea";
import { RemoteInstanceError } from "@konteks/remote-common";
import type { HostFileAuthority, HostWorkingCopyBinding } from "../host/host-agent.js";
import { dshRuntimePaths, renderDshKonteksProfile } from "./dsh-profile.js";

const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function safeRoot(path: string): string {
  if (!isAbsolute(path) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(path)) throw new RemoteInstanceError("agent_unavailable", "DSH needs an absolute prepared file authority.");
  return path;
}

/** Pure last-overlay composition. Keep stock skill parsing/ranks, but no bundled
 * trustedHost override or Node fallback can serve the selected roots. */
export function renderDshReadFence(backendPath: string, authority: HostFileAuthority): string {
  const marker = "[fs, konteksFileAuthority]";
  return [
    "# Runtime-owned per-child read authority. Written before the child starts.",
    "- id: fs-sandbox", "  disabled: true",
    "- insert:", "    - id: konteks-session-filesystem",
    `      name: ${JSON.stringify(pathToFileURL(backendPath).href)}`,
    "      config:", `        cwd: ${JSON.stringify(authority.cwd)}`,
    ...["acp", "agent-loop", "skill-filesystem", "agent-instructions"].flatMap(id => [`- id: ${id}`, `  inject: ${marker}`]),
    "- id: skill-filesystem", "  config:",
    "    includeDefaultRoots: true",
    `    customSkillDirs: ${JSON.stringify(authority.readOnlyRoots)}`,
    "",
  ].join("\n");
}

interface Preparation {
  credentialDir: string;
  entry: string;
  command: readonly string[];
  cwd: string;
  readOnlyRoots: readonly string[];
  environment: NodeJS.ProcessEnv;
}

/** Keep the native-owner imports in standalone emitted ESM. Release SEA builds
 * embed these exact bytes; ordinary source/dist launches use the maintained
 * emitted file. The URL is evaluated only outside the SEA bundle. */
async function backendBytes(): Promise<Uint8Array> {
  if (isSea()) return new Uint8Array(getAsset("konteks-dsh-filesystem-backend"));
  return readFile(new URL("../../dist/bridge/dsh-filesystem-backend.js", import.meta.url));
}

async function directoryIdentity(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isDirectory()) throw new RemoteInstanceError("agent_unavailable", "DSH file roots must remain directories.");
  return canonical;
}

async function assertIdentities(identities: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, expected] of identities) {
    if (await directoryIdentity(path) !== expected) throw new RemoteInstanceError("agent_unavailable", "DSH file authority changed before a prompt.");
  }
}

async function assertFiles(files: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, expected] of files) {
    if ((await lstat(path)).isSymbolicLink() || digest(await readFile(path)) !== expected) throw new RemoteInstanceError("agent_unavailable", "DSH's bound read policy changed before a prompt.");
  }
}

async function privateFile(path: string, bytes: Uint8Array | string): Promise<void> {
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

/** Prepare genuine native profile selection; no native installation is edited.
 * release is called only after the caller verifies this child's group is gone. */
export async function prepareDshReadProfile(options: Preparation): Promise<HostWorkingCopyBinding> {
  if (options.command.length !== 2 || options.command[0] !== "--profile" || options.command[1] !== "acp") {
    throw new RemoteInstanceError("agent_unavailable", "The installed DSH bridge has an unsupported profile command.");
  }
  const authority: HostFileAuthority = Object.freeze({ cwd: safeRoot(options.cwd), readOnlyRoots: Object.freeze(options.readOnlyRoots.map(safeRoot)) });
  const paths = dshRuntimePaths(options.credentialDir);
  if (options.environment.DSH_HOME !== paths.dshHome) throw new RemoteInstanceError("agent_unavailable", "DSH child environment and owned profile home disagree.");
  const profiles = join(paths.dshHome, "profiles");
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const identities = new Map<string, string>();
  for (const path of [profiles, authority.cwd, ...authority.readOnlyRoots]) identities.set(path, await directoryIdentity(path));
  return writeBoundProfile(options, authority, paths.konteksDir, profiles, identities);
}

async function writeBoundProfile(options: Preparation, authority: HostFileAuthority, konteksDir: string, profiles: string, identities: ReadonlyMap<string, string>): Promise<HostWorkingCopyBinding> {
  const id = randomUUID();
  const profileName = `konteks-${id}`;
  const profileDir = join(profiles, profileName);
  const policyDir = join(profiles, `konteks-policy-${id}`);
  const backendPath = join(policyDir, "filesystem-backend.mjs");
  const patchPath = join(policyDir, "read-fence.patch.yml");
  const files = new Map<string, string>();
  await mkdir(policyDir, { mode: 0o700 });
  try {
    const payloads = new Map<string, Uint8Array | string>([
      [backendPath, await backendBytes()],
      [join(policyDir, "read-policy.json"), `${JSON.stringify(authority)}\n`],
      [join(policyDir, "package.json"), `${JSON.stringify({ name: "@konteks/dsh-session-filesystem", private: true, type: "module" })}\n`],
      [patchPath, renderDshReadFence(backendPath, authority)],
    ]);
    for (const [path, bytes] of payloads) { await privateFile(path, bytes); files.set(path, digest(bytes)); }
    for (const file of renderDshKonteksProfile(konteksDir, process.platform).files) files.set(join(konteksDir, file.name), digest(file.content));
    await assertFiles(files);
    await assertIdentities(identities);
  } catch (error) {
    await rm(policyDir, { recursive: true, force: true });
    throw error;
  }
  return boundProfile(options, authority, konteksDir, profileName, profileDir, policyDir, patchPath, identities, files);
}

function boundProfile(options: Preparation, authority: HostFileAuthority, konteksDir: string, profileName: string, profileDir: string, policyDir: string, patchPath: string,
  identities: ReadonlyMap<string, string>, files: ReadonlyMap<string, string>): HostWorkingCopyBinding {
  const environment = { ...options.environment };
  const parent = profilesParent(profileDir);
  const parentIdentity = identities.get(parent);
  if (parentIdentity === undefined) throw new RemoteInstanceError("agent_unavailable", "DSH profile ownership was not recorded.");
  // Stock bundled roots explicitly bypass ctx.fs. No such root is admitted.
  delete environment.DSH_BUNDLED_SKILL_DIR;
  const { patches } = renderDshKonteksProfile(konteksDir, process.platform);
  const args = Object.freeze([options.entry, "--profile", profileName, "--from-default-profile", "acp", ...patches.flatMap(path => ["--patch", path]), "--patch", patchPath]);
  let release: Promise<void> | undefined;
  return {
    authority, args, cwd: authority.cwd, env: environment,
    async beforePrompt() { await assertIdentities(identities); await assertFiles(files); },
    release() {
      if (release !== undefined) return release;
      const attempt = (async () => {
        // These two UUID-owned names alone are removed; global profiles/keys
        // and fallback node_modules remain owned by their existing lifecycle.
        await assertIdentities(new Map([[parent, parentIdentity]]));
        await rm(profileDir, { recursive: true, force: true });
        await rm(policyDir, { recursive: true, force: true });
      })();
      release = attempt;
      // Keep successful settlement, but allow the confirmed-stopped child's
      // owner to retry an exact failed cleanup without signaling it again.
      void attempt.catch(() => { if (release === attempt) release = undefined; });
      return attempt;
    },
  };
}

function profilesParent(profileDir: string): string { return resolve(profileDir, ".."); }


export function dshControlReadPaths(credentialDir: string) {
  const { dshHome } = dshRuntimePaths(credentialDir);
  const policyDir = join(dshHome, "profiles", "konteks-control-policy");
  return { policyDir, cwd: join(dshHome, "konteks-control-workspace"), patchPath: join(policyDir, "read-fence.patch.yml") };
}

async function atomicPrivateFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await privateFile(temporary, bytes); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Control/model discovery creates real native sessions too. Its filesystem
 * service is restricted before initialize/new to an owned empty workspace;
 * credential/profile startup reads remain trusted direct native operations. */
export async function prepareDshControlReadProfile(credentialDir: string): Promise<void> {
  const paths = dshControlReadPaths(credentialDir);
  for (const path of [paths.cwd, paths.policyDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink()) throw new RemoteInstanceError("agent_unavailable", "DSH control policy cannot use a symbolic directory.");
    if (process.platform !== "win32") await chmod(path, 0o700);
  }
  if ((await readdir(paths.cwd)).length !== 0) throw new RemoteInstanceError("agent_unavailable", "DSH control workspace must remain empty.");
  const authority: HostFileAuthority = Object.freeze({ cwd: paths.cwd, readOnlyRoots: Object.freeze([]) });
  const backend = join(paths.policyDir, "filesystem-backend.mjs");
  const files = new Map<string, Uint8Array | string>([
    [backend, await backendBytes()],
    [join(paths.policyDir, "read-policy.json"), `${JSON.stringify(authority)}\n`],
    [join(paths.policyDir, "package.json"), `${JSON.stringify({ name: "@konteks/dsh-control-filesystem", private: true, type: "module" })}\n`],
    [paths.patchPath, renderDshReadFence(backend, authority)],
  ]);
  for (const [path, bytes] of files) await atomicPrivateFile(path, bytes);
}
