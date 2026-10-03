import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteInstanceError } from "@konteks/remote-common";
import { readNativeRecord } from "./install.js";
import { readOnboardState, writeOnboardState, type OnboardState } from "./onboard-state.js";
import { OWNER_ACCESS_REVOKED } from "./owner-api.js";
import { isNo } from "./onboard-answers.js";
import {
  AGAIN, EMAIL_ASK, keptAnswers, lostMachineKey, onboardSiteUrl, OnboardSession, RECONNECT_ASK, setAsideLostIdentity, wireCode,
  type OnboardContext, type OnboardStep,
} from "./onboard-session.js";
import { codeStep, emailStep, identityStep, reconnectStep, startStep, workspaceStep } from "./onboard-connect.js";
import { graftSetupStep, graftStep, inspectStep, pushingStep, pushStep, systemStep } from "./onboard-system.js";
import { agentsStep, closingStep, firstTaskStep, initiativeStep } from "./onboard-closing.js";

/**
 * The conversation the person's own coding agent relays.
 *
 * The agent is a relay and nothing more: it reads one step, puts the question
 * to the person, and runs the command it is told to run. It never composes a
 * Konteks call, never sees a URL or a token, and cannot be talked into either
 * by anything it reads, because the only thing this protocol ever asks it to
 * run is another `konteks-remote` sub-command.
 *
 * Each invocation emits exactly one step and returns. The person is a human
 * typing between commands, so the process does not wait for them.
 */

/** Each step's handler; a step without one (`done`) closes the conversation. */
const STEPS: Partial<Record<OnboardState["step"], (session: OnboardSession) => Promise<OnboardStep>>> = {
  reconnect: reconnectStep,
  identity: identityStep,
  email: emailStep,
  code: codeStep,
  workspace: workspaceStep,
  start: startStep,
  inspect: inspectStep,
  system: systemStep,
  push: pushStep,
  pushing: pushingStep,
  graft: graftStep,
  graft_setup: graftSetupStep,
  first_task: firstTaskStep,
  agents: agentsStep,
  initiative: initiativeStep,
};

/** Steps that can take tens of seconds; never entered without saying so first. */
const SLOW_STEPS: ReadonlySet<string> = new Set(["start", "graft_setup"]);
/** Steps whose question is asked again, with what went wrong, when they could not finish. */
const ASKED_AGAIN_STEPS: ReadonlySet<string> = new Set(["email", "code", "workspace", "first_task"]);
/** Steps that can meet a workspace that is still being made. */
const WORKSPACE_STEPS: ReadonlySet<string> = new Set(["code", "start", "workspace"]);

const isAgain = (run: OnboardStep["run"]) =>
  Boolean(run && run.argv.length === AGAIN.argv.length && run.argv.every((part, index) => part === AGAIN.argv[index]));

/**
 * One invocation as the agent sees it. A step that moved onboarding on and
 * only says "run onboard again" costs the person a whole agent turn. When a
 * step advanced and has nothing to ask or run, the next one runs here, and
 * the agent gets the notes and the next question together. A step that did
 * not advance (something is still starting) is handed back as it is, so
 * waiting still happens between the agent's runs.
 */
export async function runOnboard(context: OnboardContext, maxChained = 4): Promise<OnboardStep> {
  const notes: string[] = [];
  let current = context;
  for (let hop = 0; ; hop += 1) {
    const { result, advanced, slowNext } = await runTracked(current);
    if (!chains(result, advanced, slowNext) || hop >= maxChained) return withNotes(result, notes);
    collectNote(notes, result);
    const { answer: _answered, ...next } = current;
    current = next;
  }
}

async function runTracked(context: OnboardContext): Promise<{ result: OnboardStep; advanced: boolean; slowNext: boolean }> {
  const before = (await readOnboardState(context.root).catch(() => null))?.step;
  const result = await runOnboardStep(context);
  const after = (await readOnboardState(context.root).catch(() => null))?.step;
  // The bind that follows a confirmed code makes the workspace and waits for
  // the agent packages, up to a minute or two. Chaining into it swallowed the
  // note that says so, so that note always reaches the person before the
  // long step starts.
  return { result, advanced: after !== undefined && after !== before, slowNext: after !== undefined && SLOW_STEPS.has(after) };
}

function chains(result: OnboardStep, advanced: boolean, slowNext: boolean): boolean {
  return isAgain(result.run) && !result.ask && !result.done && advanced && !slowNext;
}

/**
 * Every step's news reaches the person. A wait already over, or news the
 * next step says again, is not repeated.
 */
function collectNote(notes: string[], result: OnboardStep): void {
  if (result.note && !result.passing && !notes.includes(result.note)) notes.push(result.note);
}

function withNotes(result: OnboardStep, notes: string[]): OnboardStep {
  const { passing: _passing, ...shown } = result;
  if (notes.length === 0) return shown;
  return { ...shown, note: [...notes, shown.note].filter(Boolean).join(" ") };
}

export async function runOnboardStep(context: OnboardContext): Promise<OnboardStep> {
  const session = await OnboardSession.open(context);
  if (session.state.retryAsked) {
    const retried = await answerRetry(session);
    if (retried) return retried;
  }
  // A machine that lost its key cannot be the runtime it was: every call it
  // signs is refused, and its service will not start. Whatever step this
  // conversation was on, it connects the machine again, as a runtime that
  // takes the old one's place.
  const lost = await lostMachineKey(session.supervisorData);
  if (lost) return reconnectLostMachine(session, lost.instanceId);
  return (STEPS[session.state.step] ?? closingStep)(session);
}

/**
 * The last reply was "Try that step again now?". Its yes or no answers that
 * question, never the step's own: a "yes" must not go on as an email address.
 */
async function answerRetry(s: OnboardSession): Promise<OnboardStep | null> {
  await s.save({ retryAsked: undefined } as never);
  if (s.answer === undefined) return null;
  if (isNo(s.answer.trim())) {
    return { step: s.state.step, note: "Stopped here; nothing you answered was lost. Paste the line again whenever you want to carry on." };
  }
  const { answer: _retry, ...again } = s.context;
  return runOnboardStep(again);
}

async function reconnectLostMachine(s: OnboardSession, instanceId: string): Promise<OnboardStep> {
  const { state } = s;
  await setAsideLostIdentity(s.context.root, instanceId);
  const email = state.email ?? state.resendTo ?? state.ownerEmail;
  await writeOnboardState(s.context.root, {
    schemaVersion: 1,
    step: "email",
    updatedAt: new Date().toISOString(),
    replaces: instanceId,
    ...(email ? { resendTo: email } : {}),
    ...keptAnswers(state),
  } as never);
  const note =
    "This machine lost its Konteks key, so it can no longer connect as the runtime it was. It will connect again as a new runtime that takes the old one's place; your repository and your coding agents' logins are not affected.";
  return email
    ? { step: "identity", note: `${note} A code will be sent to the address it belonged to.`, run: AGAIN }
    : { step: "identity", note, ask: EMAIL_ASK };
}

interface Failure {
  step: OnboardState["step"];
  message: string;
  said: string;
  siteUrl: string;
}

/**
 * The step to show when a step could not finish.
 *
 * The block teaches the agent three shapes and nothing else, so a failure is
 * said inside the protocol: what did not work, in plain words, and the same
 * question again, or an offer to try the step again. Revoked access ends that
 * runtime, and the person is asked whether to connect the machine again.
 */
export async function onboardFailureStep(context: OnboardContext, error: unknown): Promise<OnboardStep> {
  const state = await readOnboardState(context.root).catch(() => null);
  const message = error instanceof Error ? error.message.trim() : "";
  const failure: Failure = { step: state?.step ?? "identity", message, said: sentence(message), siteUrl: onboardSiteUrl(context) };
  const final = await finalRefusal(context, state, error, failure);
  if (final) return final;
  if (stillBeingMade(failure)) {
    return {
      step: failure.step,
      note: "Konteks is still setting up your workspace. That takes about a minute; nothing you answered was lost and it will be used as soon as it is ready.",
      run: AGAIN,
    };
  }
  return askAgainOrRetry(context, state, failure.step, failureNote(failure));
}

function sentence(message: string): string {
  if (!message) return "Something unexpected went wrong.";
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

/** A refusal that ends this conversation: the release is not accepted, or the access is gone. */
async function finalRefusal(context: OnboardContext, state: OnboardState | null, error: unknown, failure: Failure): Promise<OnboardStep | null> {
  // Konteks does not connect the release this machine installed. Asking the
  // email again would only meet the same refusal, so the flow stops with
  // Konteks's own words, which say what to do.
  if (wireCode(error) === "update_required") {
    await writeOnboardState(context.root, { ...orNewState(state), step: "identity", intentRef: undefined } as never).catch(() => undefined);
    return { step: failure.step, done: { summary: failure.said, links: { site: failure.siteUrl } } };
  }
  if (!(error instanceof RemoteInstanceError) || error.code !== "permission_denied") return null;
  if (failure.message === OWNER_ACCESS_REVOKED) return accessRevoked(context, state);
  return { step: failure.step, done: { summary: `Konteks stopped this setup: ${failure.said} Sign in on the site to see this machine and your workspace.`, links: { site: failure.siteUrl } } };
}

/**
 * Revoked is final for that runtime, not for the machine: offer to connect it
 * again rather than end on a refusal the next paste would only repeat.
 */
async function accessRevoked(context: OnboardContext, state: OnboardState | null): Promise<OnboardStep> {
  await writeOnboardState(context.root, {
    ...orNewState(state),
    step: "reconnect",
    ...(state && state.step !== "reconnect" ? { resumeStep: state.step } : {}),
  } as never).catch(() => undefined);
  return { step: "identity", note: OWNER_ACCESS_REVOKED, ask: RECONNECT_ASK };
}

function orNewState(state: OnboardState | null): Partial<OnboardState> {
  return state ?? { schemaVersion: 1 as const, updatedAt: new Date().toISOString() };
}

/**
 * A workspace takes about a minute to make, and a call that arrives while it
 * is still being made comes back as a bare server error: say what is
 * happening and carry on with the answer the person already gave. Only a
 * nameless answer is read this way (Core's own unnamed envelope, or a bare
 * gateway status while Core is restarting); a refusal that says what it is
 * keeps its own words.
 */
function stillBeingMade(failure: Failure): boolean {
  return WORKSPACE_STEPS.has(failure.step) &&
    (/the request could not be completed/i.test(failure.message) || /^HTTP 50[234]$/.test(failure.message));
}

/**
 * A bare gateway status or a dropped connection anywhere else is Konteks
 * being unreachable for a moment (a restart, a deploy), not a code for the
 * person to read.
 */
function failureNote(failure: Failure): string {
  const unreachable = /^HTTP 50[234]$/.test(failure.message) || /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(failure.message);
  if (unreachable) return "Konteks could not be reached just now; it may be restarting. Nothing you answered was lost.";
  return /nothing you answered was lost/i.test(failure.said)
    ? `Konteks could not finish that step: ${failure.said}`
    : `Konteks could not finish that step: ${failure.said} Nothing you answered was lost.`;
}

async function askAgainOrRetry(context: OnboardContext, state: OnboardState | null, step: OnboardState["step"], note: string): Promise<OnboardStep> {
  if (ASKED_AGAIN_STEPS.has(step)) {
    const { answer: _answer, ...unanswered } = context;
    const again = await runOnboardStep(unanswered).catch(() => null);
    if (again?.ask) return { step, note: `${note} Answer again when you are ready.`, ask: again.ask };
  }
  if (state) await writeOnboardState(context.root, { ...state, retryAsked: true } as never).catch(() => undefined);
  return { step, note, ask: { question: "Try that step again now?", kind: "confirm" } };
}

/**
 * Which Core this machine was installed against.
 *
 * Before binding there is no runtime record, only what `install --enroll`
 * remembered, so the person is never asked for a URL they were not given.
 */
export async function onboardCoreUrl(root: string): Promise<string | undefined> {
  const prepared = await readFile(join(root, "native-enrollment.json"), "utf8")
    .then(raw => JSON.parse(raw) as { coreUrl?: unknown })
    .catch(() => null);
  if (prepared && typeof prepared.coreUrl === "string") return prepared.coreUrl;
  const record = await readNativeRecord(root).catch(() => null);
  return record?.coreUrl;
}
