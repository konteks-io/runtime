import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { CoreResponseError, RemoteInstanceError, SupervisorStatusSchema, SystemClock } from "@konteks/remote-common";
import { NativeEnrollment, SupervisorStore } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { SupervisorControl } from "../control.js";
import { CLI_NAME, cliCommand, cliExecutable, commandHintText } from "../cli-command.js";
import { readNativeRecord, type completeNativeEnrollment } from "./install.js";
import { inspectRepository, type commitFirstFiles, type initializeRepository, type planFirstCommit, type pushToManagedRemote } from "./repository-inspect.js";
import type { StagingStatus } from "./enrollment-staging.js";
import { readOnboardState, writeOnboardState, type OnboardState } from "./onboard-state.js";
import type { GraftTool, planGraft, wireGraft } from "./graft.js";
import { deleteOwnerToken, OWNER_ACCESS_REVOKED, OwnerApiClient, readOwnerToken, writeOwnerToken } from "./owner-api.js";

/**
 * What every onboarding step shares: the step shape the person's agent
 * relays, the conversation's state, and the calls to Konteks and to this
 * machine's service that more than one step makes.
 */

export interface OnboardStep {
  step: OnboardState["step"];
  note?: string;
  /** Internal: news a later step in the same call says again, or a wait that is already over. Dropped when chained past. */
  passing?: true;
  ask?: { question: string; kind: "email" | "code" | "choice" | "confirm" | "text"; choices?: string[] };
  run?: { argv: string[] };
  done?: {
    summary: string;
    links: { site: string; system?: string; initiative?: string };
    remedies?: string[];
  };
}

export type OnboardEnrollment = Pick<NativeEnrollment, "openIntent" | "sendChallenge" | "verifyCode" | "bind" | "refreshOwnerToken" | "restoreAccess">;

/** The service's administrative status and the roles it advertises. */
export interface ServiceReadiness { administrativeStatus: string; roles: string[] }

export interface OnboardDeps {
  fetchFn?: typeof fetch;
  inspect?: typeof inspectRepository;
  push?: typeof pushToManagedRemote;
  initialize?: typeof initializeRepository;
  planCommit?: typeof planFirstCommit;
  commitFiles?: typeof commitFirstFiles;
  /** How long the agents step pauses between asks; tests make it instant. */
  agentsWaitMs?: number;
  /** Register this runtime's managed-git key through the local service; answers where the key lives. */
  registerGitKey?: (root: string) => Promise<{ identityFile?: string; user?: string }>;
  enrollment?: OnboardEnrollment;
  complete?: typeof completeNativeEnrollment;
  /** How long the System step waits for managed git still being set up, and how often it asks. */
  managedGitWaitMs?: number;
  managedGitPollMs?: number;
  families?: () => Promise<string[]>;
  /** Each installed agent's readiness as the running service reports it, or null when it cannot say. */
  agentReadiness?: (root: string) => Promise<Record<string, string> | null>;
  /** The agents this installation lists (its record), or null when there is none yet. */
  recordedAgents?: (root: string) => Promise<string[] | null>;
  /** An OpenCode found here that cannot run (OpenCode 1): the remedy line, or null. */
  openCodeProblem?: () => Promise<string | null>;
  dshProblem?: () => Promise<string | null>;
  /** Whether the person's own OpenCode holds sign-ins (existence only), for `auth login opencode --reuse`. */
  personalOpenCode?: () => Promise<boolean>;
  /** Wait for the started service to become active; resolves to the roles it advertises, or null. */
  waitForReady?: (root: string, until?: "ready" | "answering") => Promise<ServiceReadiness | null>;
  /** Graft, injectable for tests. */
  graft?: {
    available?: (root: string) => Promise<boolean>;
    wired?: (repo: string) => Promise<boolean>;
    plan?: typeof planGraft;
    ensure?: (root: string) => Promise<GraftTool>;
    wire?: typeof wireGraft;
  };

  /** The background unpacking of the agent packages. */
  staging?: {
    status: (root: string) => Promise<StagingStatus>;
    spawn: (root: string) => Promise<number | undefined>;
    /** How long one `start` invocation waits for it before reporting progress. */
    waitMs?: number;
  };
}

export interface OnboardContext {
  root: string;
  output: Output;
  /** The person's answer to the question the previous step asked; `""` is an answer too. */
  answer?: string;
  /** `--repo`: the repository to register, instead of the working directory. */
  cwd?: string;
  coreUrl?: string;
  siteUrl?: string;
  deps?: OnboardDeps;
}

export const AGAIN = { argv: [CLI_NAME, "onboard", "--json"] };

/**
 * The step as the person's agent receives it: the agent runs its commands
 * verbatim, in a shell where `konteks-remote` may not be on PATH (the
 * user-local install writes no profile). Each instruction names the command
 * the way this computer runs it: the text as a shell word, `run.argv` as the
 * executable. Ids, kinds, links and answers are kept as they are.
 */
export function runnableStep(step: OnboardStep, command: string = cliCommand(), executable: string = cliExecutable()): OnboardStep {
  return command === CLI_NAME && executable === CLI_NAME ? step : rewrittenStep(step, command, executable);
}

function rewrittenStep(step: OnboardStep, command: string, executable: string): OnboardStep {
  const text = (value: string) => commandHintText(value, command);
  const { note, ask, run, done } = step;
  return {
    ...step,
    ...(note !== undefined ? { note: text(note) } : {}),
    ...(ask ? { ask: { ...ask, question: text(ask.question) } } : {}),
    ...(run ? { run: { argv: runnableArgv(run.argv, executable) } } : {}),
    ...(done ? { done: runnableDone(done, text) } : {}),
  };
}

function runnableArgv(argv: string[], executable: string): string[] {
  return argv.map((part, index) => (index === 0 && part === CLI_NAME ? executable : part));
}

function runnableDone(done: NonNullable<OnboardStep["done"]>, text: (value: string) => string): NonNullable<OnboardStep["done"]> {
  return { ...done, summary: text(done.summary), ...(done.remedies ? { remedies: done.remedies.map(text) } : {}) };
}

export const RECONNECT_ASK = { question: "Give this machine your access again? Konteks sends a code to your email to check it is you.", kind: "confirm" } as const;
export const EMAIL_ASK = { question: "What email address should this machine belong to?", kind: "email" } as const;
/** The owner token is refreshed this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** How long `inspect` waits for the freshly started service before moving on without it. */
// A fresh service opens for work about a minute after the install; one
// invocation waits that long, so the agent is not handed "ask again" twice
// and left to write its own polling loop around onboard.
const READY_WAIT_MS = 75_000;

/** The wire code Core answered with, for refusals the shared code list does not name. */
export function wireCode(error: unknown): string {
  if (error instanceof CoreResponseError) return error.wireCode;
  return error instanceof RemoteInstanceError ? error.code : "";
}

export function pause(ms: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, ms));
}

export function onboardSiteUrl(context: Pick<OnboardContext, "siteUrl">): string {
  return (context.siteUrl ?? process.env.KONTEKS_SITE_URL ?? "https://app.konteks.io").replace(/\/+$/, "");
}

/** "a", "a and b", "a, b and c". */
export function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "nothing") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The runtime an identity on disk names, unless it is still pending. */
export function connectedInstanceId(identity: { instanceId?: string | null | undefined } | null): string | undefined {
  return identity?.instanceId && identity.instanceId !== "pending" ? identity.instanceId : undefined;
}

export function workspaceName(state: { workspaces?: Array<{ tenantId: string; displayName: string }> | undefined }, tenantId: string): string {
  return state.workspaces?.find(entry => entry.tenantId === tenantId)?.displayName ?? tenantId;
}

/**
 * What the person already answered about this machine and folder, kept when the
 * machine connects again as a new runtime: they are not asked twice.
 */
export function keptAnswers(state: { ownerEmail?: string | undefined; graftDecision?: string | undefined; graftRepository?: string | undefined }): Record<string, string> {
  return {
    ...(state.ownerEmail ? { ownerEmail: state.ownerEmail } : {}),
    ...(state.graftDecision && state.graftRepository ? { graftDecision: state.graftDecision, graftRepository: state.graftRepository } : {}),
  };
}

/**
 * A machine that becomes a new runtime keeps only the person's answers, as a
 * machine that lost its key does; what the old runtime knew is not its own.
 * The state is cleared in place, because every later save spreads it.
 */
export function forgetRuntime(state: OnboardState): void {
  const kept = new Set(["schemaVersion", "step", "updatedAt", "resendTo", "resendReason", ...Object.keys(keptAnswers(state))]);
  for (const key of Object.keys(state)) if (!kept.has(key)) delete (state as Record<string, unknown>)[key];
}

/** The identity on disk when its key is gone; null for a machine that can still prove itself. */
export async function lostMachineKey(supervisorData: string): Promise<{ instanceId: string } | null> {
  const store = new SupervisorStore(supervisorData);
  const instanceId = connectedInstanceId(await store.identity().catch(() => null));
  if (!instanceId) return null;
  const key = await store.loadInstanceKey().catch(() => null);
  return key ? null : { instanceId };
}

/**
 * Keep a lost identity's state beside the install, never delete it: it is
 * the record of what that runtime was, and it holds nothing that could act
 * for it any more. The machine then enrolls from an empty supervisor.
 */
export async function setAsideLostIdentity(root: string, instanceId: string): Promise<void> {
  const aside = join(root, "retired", `${instanceId}-${Date.now()}`);
  await mkdir(aside, { recursive: true, mode: 0o700 });
  await rename(join(root, "supervisor"), join(aside, "supervisor"));
  await rename(join(root, "native-runtime.json"), join(aside, "native-runtime.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await mkdir(join(root, "supervisor"), { mode: 0o700 });
}

/**
 * A computer its owner connected from the site holds no token of theirs yet;
 * Konteks gives it, once, for the machine's own key.
 */
export async function claimSiteAccess(supervisorData: string, enrollment: OnboardEnrollment): Promise<Awaited<ReturnType<typeof readOwnerToken>>> {
  const instanceId = connectedInstanceId(await new SupervisorStore(supervisorData).identity().catch(() => null));
  if (!instanceId) return null;
  const granted = await enrollment.refreshOwnerToken(instanceId).catch(() => null);
  if (!granted) return null;
  await writeOwnerToken(supervisorData, { ...granted, instanceId });
  return readOwnerToken(supervisorData);
}

/** The person's token, refreshed rather than kept long. */
async function ownerApi(supervisorData: string, coreUrl: string, enrollment: OnboardEnrollment, fetchFn: typeof fetch | undefined): Promise<OwnerApiClient> {
  const stored = (await readOwnerToken(supervisorData)) ?? (await claimSiteAccess(supervisorData, enrollment));
  if (!stored) {
    throw new RemoteInstanceError("permission_denied", "This machine holds no Konteks access for you; run onboard from the start.");
  }
  let token = stored.token;
  if (Date.parse(stored.expiresAt) - Date.now() < TOKEN_REFRESH_MARGIN_MS) token = await refreshedOwnerToken(supervisorData, enrollment, stored.instanceId);
  return new OwnerApiClient({ coreUrl, token, ...(fetchFn ? { fetchFn } : {}) });
}

async function refreshedOwnerToken(supervisorData: string, enrollment: OnboardEnrollment, instanceId: string): Promise<string> {
  let refreshed;
  try {
    refreshed = await enrollment.refreshOwnerToken(instanceId);
  } catch (error) {
    if (wireCode(error) === "enrollment_invalid") {
      // Revoked in Settings, or the lease lapsed: the token is gone for good.
      await deleteOwnerToken(supervisorData);
      throw new RemoteInstanceError("permission_denied", OWNER_ACCESS_REVOKED);
    }
    throw error;
  }
  await writeOwnerToken(supervisorData, { ...refreshed, instanceId });
  return refreshed.token;
}

/**
 * Poll the control socket until the service reports itself active, or give up.
 *
 * Roles are stripped at binding and become real at the first heartbeat, so
 * the summary that says "your Claude Code login will run Konteks work here"
 * waits for that heartbeat rather than claiming it early.
 */
async function waitForServiceReady(root: string, until: "ready" | "answering" = "ready"): Promise<ServiceReadiness | null> {
  const record = await readNativeRecord(root).catch(() => null);
  if (!record) return null;
  const control = new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort);
  const deadline = Date.now() + READY_WAIT_MS;
  let last: ServiceReadiness | null = null;
  while (Date.now() < deadline) {
    const probe = await probeReady(control, until, last);
    if (probe.settled) return probe.last;
    last = probe.last;
    await pause(3_000);
  }
  return last;
}

async function probeReady(control: SupervisorControl, until: "ready" | "answering", last: ServiceReadiness | null): Promise<{ last: ServiceReadiness | null; settled: boolean }> {
  try {
    const status = await control.call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 5_000 });
    const seen = { administrativeStatus: status.administrativeStatus, roles: status.roles };
    return { last: seen, settled: until === "answering" || (status.administrativeStatus === "active" && status.connectivity.reconciliationComplete) };
  } catch (error) {
    // No control token yet means the service has not come up; keep waiting.
    return { last, settled: !(error instanceof RemoteInstanceError) || error.code !== "control_socket_unavailable" };
  }
}

/**
 * Every family whose local tooling this machine actually has. Google
 * Antigravity is never detected: the connector downloads it on the person's
 * yes (`konteks-remote agent add antigravity`), so neither the Antigravity
 * app nor the `agy` CLI (other products) counts.
 */
export async function detectAgentFamilies(): Promise<string[]> {
  const { locateNativeDsh, locateNativeOpenCode, resolveNativeClaudeExecutable, resolveNativeCodexHome } = await import(
    "@konteks/remote-supervisor"
  );
  const found = (probe: () => Promise<unknown>) => probe().then(() => true).catch(() => false);
  const families: string[] = [];
  if (await found(resolveNativeClaudeExecutable)) families.push("claude-code");
  if (await found(resolveNativeCodexHome)) families.push("codex");
  // A supported DeepSeek Harness and a Node that can run it.
  if (await found(locateNativeDsh)) families.push("dsh");
  // The person's own OpenCode 2; OpenCode 1 is not a family here.
  if (await found(locateNativeOpenCode)) families.push("opencode");
  return families;
}

/** One onboarding invocation: the person's context, the conversation's state, and the services every step reaches. */
export class OnboardSession {
  readonly supervisorData: string;
  readonly clock = new SystemClock();
  readonly coreUrl: string;
  readonly siteUrl: string;
  readonly enrollment: OnboardEnrollment;
  readonly deps: OnboardDeps;
  state!: OnboardState;

  private constructor(readonly context: OnboardContext) {
    this.supervisorData = join(context.root, "supervisor");
    this.deps = context.deps ?? {};
    this.coreUrl = context.coreUrl ?? process.env.KONTEKS_CORE_URL ?? "https://api.konteks.io";
    this.siteUrl = onboardSiteUrl(context);
    this.enrollment = this.deps.enrollment ?? new NativeEnrollment({
      dataDir: this.supervisorData,
      coreUrl: this.coreUrl,
      clock: this.clock,
      ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
    });
  }

  static async open(context: OnboardContext): Promise<OnboardSession> {
    const session = new OnboardSession(context);
    session.state = (await readOnboardState(context.root)) ?? { schemaVersion: 1, step: "identity", updatedAt: new Date().toISOString() };
    return session;
  }

  get answer(): string | undefined {
    return this.context.answer;
  }

  /** The folder onboarding runs in: `--repo`, else the working directory. */
  cwd(): string {
    return this.context.cwd ?? process.cwd();
  }

  save(next: Partial<OnboardState>): Promise<OnboardState> {
    return writeOnboardState(this.context.root, { ...this.state, ...next } as never);
  }

  links(): { site: string; system?: string; initiative?: string } {
    return {
      site: this.siteUrl,
      ...(this.state.systemId ? { system: `${this.siteUrl}/systems/${this.state.systemId}` } : {}),
      ...(this.state.initiativeUrl ? { initiative: this.state.initiativeUrl } : {}),
    };
  }

  families(): Promise<string[]> {
    return (this.deps.families ?? detectAgentFamilies)();
  }

  ownerApi(): Promise<OwnerApiClient> {
    return ownerApi(this.supervisorData, this.coreUrl, this.enrollment, this.deps.fetchFn);
  }

  waitForReady(...until: ["ready" | "answering"] | []): Promise<ServiceReadiness | null> {
    return (this.deps.waitForReady ?? waitForServiceReady)(this.context.root, ...until);
  }

  inspect(): ReturnType<typeof inspectRepository> {
    return (this.deps.inspect ?? inspectRepository)(this.cwd());
  }

  /**
   * The workspace's name as the site shows it now: the person may have
   * renamed it since this machine was told its id. Revoked access still
   * speaks; anything else falls back to what this machine was told.
   */
  async currentWorkspaceName(tenantId: string): Promise<string | undefined> {
    if (!tenantId || !(await readOwnerToken(this.supervisorData).catch(() => null))) return undefined;
    try {
      const api = await this.ownerApi();
      return await api.workspaceDisplayName(tenantId);
    } catch (error) {
      if (error instanceof RemoteInstanceError && error.message === OWNER_ACCESS_REVOKED) throw error;
      return undefined;
    }
  }
}
