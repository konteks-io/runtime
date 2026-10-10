import { antigravitySkillHome, dshRuntimePaths } from "@konteks/remote-agent-runner";
import { userInfo } from "node:os";
import { isAbsolute, resolve, join } from "node:path";
import type { RuntimeSkillSyncItem } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { NativeSkillSyncTransportFailure, type NativeSkillSyncClient } from "./skill-sync-client.js";
import { stageMachineOrganizationSkills, type StagedOrganizationSkills } from "../skills/staging.js";
import { syncAgentHomeSkills, verifyAgentHomeSkillInstallation } from "../skills/home-sync.js";
/** Discovery homes come from local installation settings and native adapter paths only. */
type SkillHomeRunner = {
  RUNNER_AGENT_ID: string; RUNNER_CREDENTIAL_DIR: string; RUNNER_NATIVE_CODEX_HOME?: string | undefined; RUNNER_NATIVE_CLAUDE_EXECUTABLE?: string | undefined;
  RUNNER_NATIVE_SKILL_HOMES?: readonly string[] | undefined;
 RUNNER_NATIVE_CLAUDE_CONFIG_DIR?: string | undefined;
};
export function machineSkillHomes(runners: readonly SkillHomeRunner[], operatorHome = userInfo().homedir): string[] {
  return [...new Set(runners.flatMap(runner => runner.RUNNER_NATIVE_SKILL_HOMES ?? runnerSkillProfileHomes(runner, operatorHome)))];
}
export function runnerSkillProfileHomes(runner: SkillHomeRunner, operatorHome = userInfo().homedir): string[] {
  switch (runner.RUNNER_AGENT_ID) {
    case "codex": return runner.RUNNER_NATIVE_CODEX_HOME ? [runner.RUNNER_NATIVE_CODEX_HOME] : [];
    case "claude-code": return claudeSkillProfileHomes(runner, operatorHome);
    case "dsh": return [dshRuntimePaths(runner.RUNNER_CREDENTIAL_DIR).dshHome];
    case "antigravity": return [antigravitySkillHome(runner.RUNNER_CREDENTIAL_DIR)];
    // OpenCode execution uses working-copy-specific XDG_CONFIG_HOME folders.
    // Its shared state root is not an execution profile.
    case "opencode": return [];
    default: return [];
  }
}
function claudeSkillProfileHomes(runner: SkillHomeRunner, operatorHome: string): string[] {
  return runner.RUNNER_NATIVE_CLAUDE_EXECUTABLE ? [runner.RUNNER_NATIVE_CLAUDE_CONFIG_DIR ?? join(operatorHome, ".claude")] : [];
}
export interface MachineSkillInventory {
  skills: RuntimeSkillSyncItem[];
  profiles: Array<{ home: string; paths: string[]; status: "installed" | "failed"; reason?: string; agentId?: string }>;
}
export type MachineSkillSyncPhase = "configuration" | "catalog" | "staging" | "authorization" | "publication";
/** Base diagnostics carry no underlying transport error or profile path. */
export class MachineSkillSyncFailure extends Error {
  constructor(readonly phase: MachineSkillSyncPhase, readonly httpStatus?: number) {
    super(`Organization Skill synchronization failed during ${phase}`);
  }
}
export class MachineSkillPartialFailure extends MachineSkillSyncFailure {
  constructor(readonly inventory: MachineSkillInventory) { super("publication"); }
}
async function phase<T>(name: MachineSkillSyncPhase, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw error instanceof MachineSkillSyncFailure ? error : new MachineSkillSyncFailure(name,
    error instanceof NativeSkillSyncTransportFailure ? error.httpStatus : undefined); }
}
/** One complete refresh; the coordinator records success only when all homes finish. */
export async function refreshMachineSkills(options: {
  client: Pick<NativeSkillSyncClient, "prepare" | "read" | "authorize">;
  scratchRoot: string; homes: readonly string[]; unavailableAgentIds?: readonly string[];
  profileBindings?: readonly { home: string; agentId: string }[];
  owner: { workspaceId: string; instanceId: string }; now: () => number;
  onVerified?: (staged: StagedOrganizationSkills, homes: readonly string[], owner: { workspaceId: string; instanceId: string }) => void;
}, signal: AbortSignal): Promise<MachineSkillInventory> {
  const homes = [...options.homes], owner = structuredClone(options.owner);
  const profiles = initialProfiles(homes, options.unavailableAgentIds);
  const profileBindings = structuredClone(options.profileBindings ?? []);
  const check = () => { if (signal.aborted) throw new Error("Skill synchronization is stopped"); };
  check(); const envelope = await phase("catalog", () => options.client.prepare(signal)); check();
  const assertAuthorized = async () => phase("authorization", async () => { check(); await options.client.authorize(envelope, signal); check(); });
  const staged = await phase("staging", () => stageMachineOrganizationSkills({ scratchRoot: options.scratchRoot, envelope,
    owner, assertAuthorized, now: options.now,
    fetchTree: skill => { check(); return options.client.read(envelope, skill.skillId, signal); },
  }));
  for (const home of homes) {
    check();
    const published = await publishProfile(home, owner, staged, assertAuthorized);
    profiles.push(...identifyProfiles(published, profileBindings));
    check();
  }
  await assertAuthorized();
  const inventory = { skills: structuredClone(envelope.catalog.skills), profiles };
  if (profiles.some(profile => profile.status === "failed")) throw new MachineSkillPartialFailure(inventory);
  check(); options.onVerified?.(structuredClone(staged), [...homes], { ...owner });
  return inventory;
}

async function publishProfile(home: string, owner: { workspaceId: string; instanceId: string }, staged: StagedOrganizationSkills,
  assertAuthorized: () => Promise<void>): Promise<MachineSkillInventory["profiles"][number]> {
  try {
    const paths = await syncAgentHomeSkills({ home, owner, staged, assertAuthorized });
    for (const skill of staged.skills) {
      if (!await verifyAgentHomeSkillInstallation({ home, owner, skill })) throw new Error("Skill installation could not be verified");
    }
    await assertAuthorized();
    return { home, paths, status: "installed" };
  } catch (error) {
    if (error instanceof MachineSkillSyncFailure) throw error;
    return { home, paths: [], status: "failed", reason: "profile_publication_failed" };
  }
}

function validateDiscoveryHomes(homes: readonly string[]): void {
  if (!homes.length || homes.length > 16 || homes.some(home => !isAbsolute(home)) || new Set(homes.map(home => resolve(home))).size !== homes.length) throw new MachineSkillSyncFailure("configuration");
}

function unavailableProfiles(agentIds: readonly string[] = []): MachineSkillInventory["profiles"] {
  return [...new Set(agentIds)].map(agentId => ({
    agentId, home: "", paths: [], status: "failed", reason: "native_profile_unconfigured",
  }));
}

function initialProfiles(homes: readonly string[], agentIds?: readonly string[]): MachineSkillInventory["profiles"] {
  const profiles = unavailableProfiles(agentIds);
  if (!homes.length && profiles.length) throw new MachineSkillPartialFailure({ skills: [], profiles });
  validateDiscoveryHomes(homes);
  return profiles;
}

/** Several configured agents can discover the same home; publish it once and report each agent. */
function identifyProfiles(profile: MachineSkillInventory["profiles"][number], bindings: readonly { home: string; agentId: string }[]): MachineSkillInventory["profiles"] {
  const agents = [...new Set(bindings.filter(binding => resolve(binding.home) === resolve(profile.home)).map(binding => binding.agentId))];
  return agents.length ? agents.map(agentId => ({ ...profile, paths: [...profile.paths], agentId })) : [profile];
}
