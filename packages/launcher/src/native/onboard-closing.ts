import { join } from "node:path";
import { z } from "zod";
import { hostAgentFamily, hostInstallCommand } from "@konteks/remote-release";
import { RemoteInstanceError } from "@konteks/remote-common";
import { SupervisorStore } from "@konteks/remote-supervisor";
import { SupervisorControl } from "../control.js";
import { agentName } from "./agent-name.js";
import { readNativeRecord } from "./install.js";
import { nativePlatform } from "./service.js";
import type { OnboardState } from "./onboard-state.js";
import type { OwnerApiClient } from "./owner-api.js";
import { isNo } from "./onboard-answers.js";
import { AGAIN, connectedInstanceId, pause, workspaceName, type OnboardSession, type OnboardStep } from "./onboard-session.js";

/**
 * The steps that close onboarding: the first initiative, the workspace's
 * agents, and the summary of what this machine runs.
 */

/** How long, and how often, the agents step waits for the machine to advertise what it can run. */
const AGENTS_WAIT_MS = 10_000;
const AGENTS_WAIT_ATTEMPTS = 9;
/** Still being probed, or never reported: not evidence that the login is missing. */
const UNSETTLED_READINESS = new Set(["ready", "probing", "unknown"]);
/**
 * Agents the connector does not ship: the person's own DeepSeek Harness and
 * OpenCode, and Google Antigravity, which it downloads on their yes. Each runs
 * only once the installation lists it and it started.
 */
const HOST_FAMILIES = new Set(["dsh", "opencode", "antigravity"]);

interface MadeInitiative {
  initiativeId: string;
  title: string;
  pmSessionId: string | undefined;
  setupFailure: string | undefined;
}

/**
 * An initiative name from the person's sentence: its first sentence, without
 * the closing stop, kept to a title's length at a word boundary. The whole
 * sentence still becomes the planning session's first turn.
 */
export function initiativeTitle(sentence: string): string {
  const first = sentence.trim().split(/(?<=[.!?])\s+/)[0]!.replace(/[.!?]+$/, "").trim();
  // Up to 100 characters the person's own sentence is the title: any cut
  // inside it loses part of what they asked for.
  if (first.length <= 100) return first;
  // A long sentence reads best cut where a phrase ends ("…for a date and
  // time, and I get an email" becomes "…for a date and time"), not after a
  // dangling "and". Only when no phrase ends in reach, cut at a word.
  const end = phraseEnd(first);
  if (end > 0) return first.slice(0, end).replace(/[,;]$/, "").trim();
  const cut = first.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

/** The last phrase boundary between characters 30 and 90, or -1. */
function phraseEnd(first: string): number {
  const phrase = /,\s|;\s|\s(?:and|so|but|which|because|where|with)\s/g;
  let end = -1;
  for (let match = phrase.exec(first); match && match.index <= 90; match = phrase.exec(first)) {
    if (match.index >= 30) end = match.index;
  }
  return end;
}

export async function firstTaskStep(s: OnboardSession): Promise<OnboardStep> {
  if (s.answer === undefined) return askFirstTask(s);
  const wanted = s.answer.trim();
  // "nothing for now", "skip", "no thanks": a refusal, not an initiative's title.
  if (refusesFirstTask(wanted)) {
    await s.save({ step: "done", closing: true });
    return { step: "first_task", note: wanted ? "No initiative was started; start one from the site with New initiative whenever you like." : "Ending here.", run: AGAIN };
  }
  if (!s.state.systemId) {
    await s.save({ step: "done", closing: true });
    return {
      step: "first_task",
      note: "An initiative needs a System, and none was made here. Start it from the site with New initiative once you have a System.",
      run: AGAIN,
    };
  }
  const title = initiativeTitle(wanted);
  await s.save({ step: "agents", firstTask: wanted, initiativeTitle: title });
  return {
    step: "first_task",
    note: `Setting up your first initiative, "${title}", on ${s.state.repositoryName ?? "your System"}. Konteks is getting this machine's agents ready and opening the initiative's planning session; this takes up to a minute.`,
    passing: true,
    run: AGAIN,
  };
}

function refusesFirstTask(wanted: string): boolean {
  return !wanted || isNo(wanted) || /^(nothing|none|not now|skip|later|maybe later)\b/i.test(wanted);
}

async function askFirstTask(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  // A machine back in a System the workspace already had (a lost key) is
  // not asked for a first initiative it already has.
  if (state.systemExisting && state.systemId && !state.initiativeId) {
    const existing = await existingInitiative(s, state.systemId);
    if (existing) return existing;
  }
  // An invited Viewer can look but not plan: asked for a first task, they
  // got an initiative whose planning refused them. Nothing is made, and they
  // hear why.
  if (state.systemId && !state.initiativeId && await viewerOnly(s)) return viewerCannotStart(s);
  return {
    step: "first_task",
    ask: { question: "What do you want to build first? Your first planning turn is included.", kind: "text" },
  };
}

async function existingInitiative(s: OnboardSession, systemId: string): Promise<OnboardStep | null> {
  const api = await s.ownerApi();
  const existing = (await api.listInitiatives(systemId).catch(() => []))[0];
  if (!existing) return null;
  const url = `${s.siteUrl}/work/${encodeURIComponent(existing.id)}`;
  await s.save({ step: "done", closing: true, initiativeId: existing.id, initiativeTitle: existing.title, initiativeUrl: url } as never);
  Object.assign(s.state, { initiativeId: existing.id, initiativeTitle: existing.title, initiativeUrl: url });
  return { step: "first_task", note: `${s.state.repositoryName ?? "This System"} already has an initiative, "${existing.title}", so no new one is started: ${url}`, run: AGAIN };
}

async function viewerOnly(s: OnboardSession): Promise<boolean> {
  const allowed = await s.ownerApi()
    .then(api => api.canStartWork())
    .catch(() => undefined);
  return allowed === false;
}

async function viewerCannotStart(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  const where = state.tenantId ? ((await s.currentWorkspaceName(state.tenantId)) ?? workspaceName(state, state.tenantId)) : "this workspace";
  await s.save({ step: "done", closing: true });
  return {
    step: "first_task",
    note: `Your role in ${where} can look but not start work, so no initiative was started. Once its owner makes you a Member, start one from the site with New initiative.`,
    run: AGAIN,
  };
}

/**
 * A workspace made from a coding agent has never chosen what runs its work,
 * so its first planning session would be refused for want of a profile. This
 * machine's own agents are the answer, and they are the person's own logins:
 * nothing to ask, nothing to configure.
 */
export async function agentsStep(s: OnboardSession): Promise<OnboardStep> {
  // The first heartbeat, which the folder questions did not wait for.
  const service = await s.waitForReady().catch(() => null);
  if (service?.administrativeStatus === "active") await s.save({ advertisedRoles: service.roles });
  const api = await s.ownerApi();
  if (!(await api.hasExecutionProfile()) && !(await api.setUpAgentsFromThisMachine())) return agentsNotAdvertised(s);
  await s.save({ agentsWaited: undefined } as never);
  await s.save({ step: "initiative" });
  return { step: "agents", note: "This machine's agents will run the work in this workspace.", run: AGAIN, passing: true };
}

/**
 * What the machine can run is discovered by the runtime and accepted on a
 * later heartbeat, a minute or so after it starts, so an empty answer this
 * early means "not yet", not "never".
 */
async function agentsNotAdvertised(s: OnboardSession): Promise<OnboardStep> {
  const waited = (s.state.agentsWaited ?? 0) + 1;
  if (waited <= AGENTS_WAIT_ATTEMPTS) {
    await s.save({ agentsWaited: waited });
    await pause(s.deps.agentsWaitMs ?? AGENTS_WAIT_MS);
    return {
      step: "agents",
      note: "Konteks is still learning what this machine's agents can do; this finishes about a minute after the machine starts.",
      run: AGAIN,
    };
  }
  await s.save({ step: "initiative", agentsWaited: undefined } as never);
  return {
    step: "agents",
    note: "This machine has not told Konteks what its agents can run yet; your initiative is still being created, and you can choose an agent in Settings once it has.",
    run: AGAIN,
  };
}

export async function initiativeStep(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  const api = await s.ownerApi();
  const wanted = state.firstTask ?? "";
  const title = state.initiativeTitle ?? initiativeTitle(wanted);
  const made = state.initiativeId
    ? { initiativeId: state.initiativeId, title, pmSessionId: state.pmSessionId, setupFailure: state.setupFailure }
    : await createInitiative(s, api, title);
  const url = `${s.siteUrl}/work/${encodeURIComponent(made.initiativeId)}`;
  if (made.pmSessionId && !state.firstTurnSent) {
    await api.postFirstTurn(made.pmSessionId, wanted);
    await s.save({ firstTurnSent: true });
  }
  await s.save({ step: "done", closing: true, initiativeUrl: url, firstTask: undefined } as never);
  return initiativeReply(made, url);
}

/** Recorded before the first turn, so a retry never makes a second initiative. */
async function createInitiative(s: OnboardSession, api: OwnerApiClient, title: string): Promise<MadeInitiative> {
  const created = await api.createInitiative({ systemId: s.state.systemId!, title });
  const made: MadeInitiative = { initiativeId: created.initiativeId, title: created.title, pmSessionId: created.pmSessionId, setupFailure: created.setupFailure };
  await s.save({
    initiativeId: made.initiativeId,
    initiativeTitle: made.title,
    initiativeUrl: `${s.siteUrl}/work/${encodeURIComponent(made.initiativeId)}`,
    ...(made.pmSessionId ? { pmSessionId: made.pmSessionId } : {}),
    ...(made.setupFailure ? { setupFailure: made.setupFailure } : {}),
  });
  Object.assign(s.state, { initiativeId: made.initiativeId, initiativeTitle: made.title, pmSessionId: made.pmSessionId, setupFailure: made.setupFailure });
  return made;
}

function initiativeReply(made: MadeInitiative, url: string): OnboardStep {
  if (!made.pmSessionId) {
    return {
      step: "initiative",
      note: `Your first initiative, "${made.title}", is created, but its planning session could not be opened${made.setupFailure ? `: ${made.setupFailure}` : ""}. Open the initiative and choose Retry setup: ${url}`,
      run: AGAIN,
    };
  }
  return {
    step: "initiative",
    note: `Your first initiative, "${made.title}", is ready. Its planning session on this machine has your words as its first message and is replying now; follow it and answer it from the initiative: ${url}`,
    passing: true,
    run: AGAIN,
  };
}

/**
 * The closing summary, and the greeting of a new conversation on a machine
 * that already finished onboarding: replaying the old closing summary there
 * made the new agent suspicious and said a planning session "is working on
 * it here" hours later. It says who and where this machine is connected,
 * then looks at the folder it is in. The run right after the last step is
 * this conversation closing, not a new one; only a later run is a revisit.
 */
export async function closingStep(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  if (state.closing) await s.save({ closing: false });
  if (state.step === "done" && s.answer === undefined && !state.closing) {
    const greeting = await revisitGreeting(s);
    if (greeting) return greeting;
  }
  const agents = await agentPicture(s);
  return { step: "done", done: await closingSummary(s, agents) };
}

async function revisitGreeting(s: OnboardSession): Promise<OnboardStep | null> {
  const { state } = s;
  const identity = await new SupervisorStore(s.supervisorData).identity().catch(() => null);
  if (!connectedInstanceId(identity)) return null;
  // Named before anything is saved: a revoked machine stops here, and the
  // next paste meets the same question instead of a false "all set".
  const tenant = state.tenantId ?? identity?.workspaceId;
  const where = tenant ? ((await s.currentWorkspaceName(tenant)) ?? workspaceName(state, tenant)) : "your workspace";
  await s.save({ step: "inspect", revisit: true });
  return {
    step: "identity",
    note: `This machine is already connected to ${where}${state.ownerEmail ? ` as ${state.ownerEmail}` : ""}; no sign-in is needed.`,
    run: AGAIN,
  };
}

interface AgentPicture {
  installed: string[];
  present: string[];
  remedies: string[];
}

interface AgentFacts {
  installed: string[];
  present: string[];
  /** Host agents found here that the service does not run. */
  hostMissing: string[];
  notLoggedIn: string[];
  recorded: string[] | null;
}

/** Installed is not logged in: only the agents that can run work are named. */
async function agentPicture(s: OnboardSession): Promise<AgentPicture> {
  const readiness = await (s.deps.agentReadiness ?? readAgentReadiness)(s.context.root).catch(() => null);
  // An agent the person installed themselves (DeepSeek Harness, OpenCode)
  // runs only once the connector lists it and it started: when the service
  // answers without it, say which of the two is missing.
  const recorded = await (s.deps.recordedAgents ?? recordedNativeAgents)(s.context.root).catch(() => null);
  // Google Antigravity is never detected, only added: it is here when this
  // installation lists it.
  const installed = [...await s.families(), ...(recorded?.includes("antigravity") ? ["antigravity"] : [])];
  const hostMissing = installed.filter(family => HOST_FAMILIES.has(family) && readiness !== null && readiness[family] === undefined);
  const notLoggedIn = installed.filter(family => readiness?.[family] !== undefined && !UNSETTLED_READINESS.has(readiness[family]!));
  const present = installed.filter(family => !notLoggedIn.includes(family) && !hostMissing.includes(family));
  const remedies = await agentRemedies(s, { installed, present, hostMissing, notLoggedIn, recorded });
  return { installed, present, remedies };
}

async function agentRemedies(s: OnboardSession, facts: AgentFacts): Promise<string[]> {
  const remedies = [...bundledAgentRemedies(facts), ...hostAgentRemedies(facts), ...keyRemedies(facts)];
  if (facts.notLoggedIn.includes("opencode")) remedies.push(await openCodeSignIn(s));
  remedies.push(...await unsupportedHostAgents(s, facts.installed));
  // With no agent at all, one line for a person who wants Gemini: the
  // connector downloads Google Antigravity only after they say yes.
  if (facts.installed.length === 0) remedies.push("If you want Gemini: konteks-remote agent add antigravity downloads Google Antigravity from Google (about 110 MB) after you say yes, then: konteks-remote auth login antigravity");
  if (nativePlatform().os === "debian") {
    remedies.push("To keep the runtime available after logout: loginctl enable-linger $USER");
  }
  return remedies;
}

function bundledAgentRemedies(facts: AgentFacts): string[] {
  return ["claude-code", "codex"].map(family => bundledAgentRemedy(facts, family)).filter((line): line is string => line !== null);
}

function bundledAgentRemedy(facts: AgentFacts, family: string): string | null {
  if (facts.notLoggedIn.includes(family)) return `${agentName(family)} needs you to sign in here: konteks-remote auth login ${family}`;
  // Not here at all: `agent add` installs or sets it up and signs it in; there is nothing yet for `auth login` to sign in.
  if (!facts.installed.includes(family)) return `To also run ${agentName(family)} work here: konteks-remote agent add ${family}`;
  if (!facts.present.includes(family)) return `To also run ${agentName(family)} work here: konteks-remote auth login ${family}`;
  return null;
}

/** DeepSeek Harness and OpenCode are named only when they are here: nobody is told to install them. */
function hostAgentRemedies(facts: AgentFacts): string[] {
  return facts.hostMissing.map(family => facts.recorded?.includes(family)
    ? `${agentName(family)} could not start here; to see why: konteks-remote doctor`
    : `${agentName(family)} is on this computer but not added yet: konteks-remote agent add ${family}`);
}

function keyRemedies(facts: AgentFacts): string[] {
  const lines: string[] = [];
  if (facts.notLoggedIn.includes("antigravity")) lines.push(`${agentName("antigravity")} needs a Gemini API key or Gemini Enterprise sign-in: konteks-remote auth login antigravity`);
  if (facts.notLoggedIn.includes("dsh")) lines.push(`${agentName("dsh")} needs your DeepSeek API key: konteks-remote auth login dsh`);
  return lines;
}

async function openCodeSignIn(s: OnboardSession): Promise<string> {
  const reuse = await (s.deps.personalOpenCode ?? personalOpenCodeData)().catch(() => false);
  return reuse
    ? `${agentName("opencode")} needs a sign-in, starting from the providers your own OpenCode uses: konteks-remote auth login opencode --reuse`
    : `${agentName("opencode")} needs a subscription or an API key: konteks-remote auth login opencode`;
}

/** An unsupported DeepSeek Harness or OpenCode 1 found here is named with a supported one's install command. */
async function unsupportedHostAgents(s: OnboardSession, installed: string[]): Promise<string[]> {
  const lines: string[] = [];
  if (!installed.includes("dsh")) {
    const problem = await (s.deps.dshProblem ?? detectDshProblem)().catch(() => null);
    if (problem) lines.push(problem);
  }
  if (!installed.includes("opencode")) lines.push(...await openCodeRemedy(s, installed));
  return lines;
}

async function openCodeRemedy(s: OnboardSession, installed: string[]): Promise<string[]> {
  const problem = await (s.deps.openCodeProblem ?? detectOpenCodeProblem)().catch(() => null);
  if (problem) return [problem];
  // With no agent at all, OpenCode's own install command is one way in.
  return installed.length === 0
    ? [`To run OpenCode work here: install it with \`${hostInstallCommand(hostAgentFamily("opencode"), process.platform)}\`, then: konteks-remote agent add opencode`]
    : [];
}

async function closingSummary(s: OnboardSession, agents: AgentPicture): Promise<NonNullable<OnboardStep["done"]>> {
  const { state } = s;
  const currentName = await s.currentWorkspaceName(state.tenantId ?? "");
  return {
    summary: [workspaceLine(state, currentName), systemLine(state), initiativeLine(state), agentsLine(state, agents)]
      .filter(Boolean)
      .join(" "),
    links: s.links(),
    ...(agents.remedies.length > 0 ? { remedies: agents.remedies } : {}),
  };
}

/**
 * A workspace this machine joined is named the way its owner named it; only
 * one it made has just its derived id, with the note that it can be renamed.
 */
function workspaceLine(state: OnboardState, currentName: string | undefined): string {
  const joined = state.decision === "join" || state.decision === "choose";
  if (joined || (currentName !== undefined && currentName !== state.tenantId)) {
    return `This machine is connected to your workspace ${currentName ?? workspaceName(state, state.tenantId ?? "")}.`;
  }
  return `This machine is connected to your workspace ${state.tenantId ?? ""}`.trim() + " (you can rename it in Settings).";
}

function systemLine(state: OnboardState): string | null {
  if (!state.systemEntityRef) return null;
  return `${state.repositoryName} is your first System${state.repositoryKind === "managed" ? ", kept on Konteks managed git" : ""}.`;
}

function initiativeLine(state: OnboardState): string | null {
  if (!state.initiativeId) return null;
  if (state.systemExisting) return `Your first initiative "${state.initiativeTitle}" and its planning session are on the site.`;
  return `Your first initiative is "${state.initiativeTitle}"${state.setupFailure ? "; its planning session still needs Retry setup on the initiative page" : ". Its planning session is replying now; answer it from the initiative"}.`;
}

/** People know their agents by name, not by id. */
function agentsLine(state: OnboardState, agents: AgentPicture): string {
  if (agents.present.length === 0) {
    return agents.installed.length > 0
      ? `No coding agent is logged in here yet, so no Konteks work can run on this machine until one is (see below).`
      : "No coding agent was found on this machine; install Claude Code, Codex, DeepSeek Harness or OpenCode, or add Google Antigravity, and run konteks-remote auth login.";
  }
  const names = agents.present.map(agentName).join(" and ");
  const advertised = state.advertisedRoles;
  return advertised && advertised.length === 0
    ? `Your ${names} login is set up; the runtime will advertise it once its first heartbeat lands.`
    : `Your ${names} login will run Konteks work here.`;
}

/** Readiness per agent from the running service; a tooling check alone cannot tell a login apart from an install. */
async function readAgentReadiness(root: string): Promise<Record<string, string> | null> {
  const record = await readNativeRecord(root).catch(() => null);
  if (!record) return null;
  const control = new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort);
  const schema = z.object({ agents: z.array(z.object({ agentId: z.string(), readiness: z.string() }).passthrough()) }).passthrough();
  const report = await control.call({ op: "agents" }, schema, { timeoutMs: 5_000 }).catch(() => null);
  return report ? Object.fromEntries(report.agents.map(agent => [agent.agentId, agent.readiness])) : null;
}

async function recordedNativeAgents(root: string): Promise<string[] | null> {
  const record = await readNativeRecord(root).catch(() => null);
  return record ? [...record.agents] : null;
}

/**
 * What the person's own OpenCode needs before it can run Konteks work, beyond
 * a sign-in: an OpenCode 1 (or a version out of range) found here is named,
 * with OpenCode 2's install command; null when there is nothing to say.
 */
export async function detectOpenCodeProblem(): Promise<string | null> {
  const { locateNativeOpenCode } = await import("@konteks/remote-supervisor");
  return locateNativeOpenCode().then(() => null, (error: unknown) => unsupportedVersionRemedy(error, "opencode_unsupported_version", "opencode"));
}

/** A DeepSeek Harness here that Konteks cannot run, named with the command that installs one it can. */
async function detectDshProblem(): Promise<string | null> {
  const { resolveNativeDshInstallation } = await import("@konteks/remote-supervisor");
  return resolveNativeDshInstallation().then(() => null, (error: unknown) => unsupportedVersionRemedy(error, "dsh_unsupported_version", "dsh"));
}

function unsupportedVersionRemedy(error: unknown, diagnostic: string, agentId: string): string | null {
  if (!(error instanceof RemoteInstanceError) || error.diagnostic !== diagnostic) return null;
  return error.message.replace(/,? then retry\.$/, `, then add it here: konteks-remote agent add ${agentId}`);
}

/** Whether the person has their own OpenCode data (signed in with their own OpenCode), checked by existence only. */
async function personalOpenCodeData(): Promise<boolean> {
  const { personalOpenCodeDataExists } = await import("@konteks/remote-supervisor");
  return personalOpenCodeDataExists();
}
