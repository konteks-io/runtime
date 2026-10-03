import { antigravitySkillHome, dshRuntimePaths, openCodeRuntimePaths } from "@konteks/remote-agent-runner";
import { isAbsolute, resolve } from "node:path";
import type { RuntimeSkillSyncItem } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { NativeSkillSyncTransportFailure, type NativeSkillSyncClient } from "./skill-sync-client.js";
import { stageMachineOrganizationSkills, type StagedOrganizationSkills } from "../skills/staging.js";
import { syncAgentHomeSkills } from "../skills/home-sync.js";
/** Local adapter-owned discovery homes supplement installer-bound personal profiles. */
export function machineSkillHomes(runners: readonly {
  RUNNER_AGENT_ID: string; RUNNER_CREDENTIAL_DIR: string; RUNNER_NATIVE_SKILL_HOMES?: readonly string[] | undefined;
}[]): string[] {
  return [...new Set(runners.flatMap(runner => [
    ...(runner.RUNNER_NATIVE_SKILL_HOMES ?? []),
    ...(runner.RUNNER_AGENT_ID === "dsh" ? [dshRuntimePaths(runner.RUNNER_CREDENTIAL_DIR).dshHome] : []),
    ...(runner.RUNNER_AGENT_ID === "opencode" ? [openCodeRuntimePaths(runner.RUNNER_CREDENTIAL_DIR).root] : []),
    ...(runner.RUNNER_AGENT_ID === "antigravity" ? [antigravitySkillHome(runner.RUNNER_CREDENTIAL_DIR)] : []),
  ]))];
}
export interface MachineSkillInventory {
  skills: RuntimeSkillSyncItem[];
  profiles: Array<{ home: string; paths: string[] }>;
}
export type MachineSkillSyncPhase = "configuration" | "catalog" | "staging" | "authorization" | "publication";
/** Local diagnostics deliberately carry no underlying error or profile path. */
export class MachineSkillSyncFailure extends Error {
  constructor(readonly phase: MachineSkillSyncPhase, readonly httpStatus?: number) {
    super(`Organization Skill synchronization failed during ${phase}`);
  }
}
async function phase<T>(name: MachineSkillSyncPhase, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw error instanceof MachineSkillSyncFailure ? error : new MachineSkillSyncFailure(name,
    error instanceof NativeSkillSyncTransportFailure ? error.httpStatus : undefined); }
}
/** One complete refresh; the coordinator records success only when all homes finish. */
export async function refreshMachineSkills(options: {
  client: Pick<NativeSkillSyncClient, "prepare" | "read" | "authorize">;
  scratchRoot: string; homes: readonly string[];
  owner: { workspaceId: string; instanceId: string }; now: () => number;
  onVerified?: (staged: StagedOrganizationSkills, homes: readonly string[], owner: { workspaceId: string; instanceId: string }) => void;
}, signal: AbortSignal): Promise<MachineSkillInventory> {
  const homes = [...options.homes], owner = structuredClone(options.owner);
  if (!homes.length || homes.length > 16 || homes.some(home => !isAbsolute(home)) || new Set(homes.map(home => resolve(home))).size !== homes.length) throw new MachineSkillSyncFailure("configuration");
  const check = () => { if (signal.aborted) throw new Error("Skill synchronization is stopped"); };
  check(); const envelope = await phase("catalog", () => options.client.prepare(signal)); check();
  const assertAuthorized = async () => phase("authorization", async () => { check(); await options.client.authorize(envelope, signal); check(); });
  const staged = await phase("staging", () => stageMachineOrganizationSkills({ scratchRoot: options.scratchRoot, envelope,
    owner, assertAuthorized, now: options.now,
    fetchTree: skill => { check(); return options.client.read(envelope, skill.skillId, signal); },
  }));
  const profiles: MachineSkillInventory["profiles"] = [];
  for (const home of homes) {
    check(); const paths = await phase("publication", () => syncAgentHomeSkills({ home, owner, staged, assertAuthorized }));
    check(); profiles.push({ home, paths });
  }
  await assertAuthorized();
  check(); options.onVerified?.(structuredClone(staged), [...homes], { ...owner });
  return { skills: structuredClone(envelope.catalog.skills), profiles };
}
