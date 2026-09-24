import { mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, NATIVE_MANIFEST_URL, verifyNativeRelease } from "@konteks/remote-release";
import { z } from "zod";
import { CoreResponseError, RemoteInstanceError, SupervisorStatusSchema, SystemClock } from "@konteks/remote-common";
import { NativeEnrollment, SupervisorStore } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { SupervisorControl } from "../control.js";
import { completeNativeEnrollment, readNativeEnrollment, readNativeRecord } from "./install.js";
import { nativePlatform } from "./service.js";
import { commitFirstFiles, initializeRepository, inspectRepository, planFirstCommit, pushToManagedRemote, type FirstCommitPlan } from "./repository-inspect.js";
import { enrollmentStagingStatus, releaseStaged, spawnEnrollmentStaging, type StagingStatus } from "./enrollment-staging.js";
import { readOnboardState, writeOnboardState, type OnboardState } from "./onboard-state.js";
import { ensureGraft, graftAlreadyWired, graftBuildSeconds, planGraft, readGraftRecord, wireGraft, type GraftTool } from "./graft.js";
import { deleteOwnerToken, OWNER_ACCESS_REVOKED, OwnerApiClient, readOwnerToken, writeOwnerToken } from "./owner-api.js";

/**
 * The conversation the person's own coding agent relays
 * (onboarding-simplified OS2, OS5–OS16).
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

export interface OnboardStep {
  step: OnboardState["step"];
  note?: string;
  ask?: { question: string; kind: "email" | "code" | "choice" | "confirm" | "text"; choices?: string[] };
  run?: { argv: string[] };
  done?: {
    summary: string;
    links: { site: string; system?: string; initiative?: string };
    agents?: string[];
    remedies?: string[];
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
  deps?: {
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
    enrollment?: Pick<NativeEnrollment, "openIntent" | "sendChallenge" | "verifyCode" | "bind" | "refreshOwnerToken">;
    complete?: typeof completeNativeEnrollment;
    /** How long the System step waits for managed git still being set up, and how often it asks (WS1-048). */
    managedGitWaitMs?: number;
    managedGitPollMs?: number;
    families?: () => Promise<string[]>;
    /** Each installed agent's readiness as the running service reports it, or null when it cannot say. */
    agentReadiness?: (root: string) => Promise<Record<string, string> | null>;
    /** Wait for the started service to become active; resolves to the roles it advertises, or null. */
    waitForReady?: (root: string) => Promise<{ administrativeStatus: string; roles: string[] } | null>;
    /** Graft, injectable for tests (W1-G1). */
    graft?: {
      available?: (root: string) => Promise<boolean>;
      wired?: (repo: string) => Promise<boolean>;
      plan?: typeof planGraft;
      ensure?: (root: string) => Promise<GraftTool>;
      wire?: typeof wireGraft;
    };
    /** The background unpacking of the agent packages (WS1-012). */
    staging?: {
      status: (root: string) => Promise<StagingStatus>;
      spawn: (root: string) => Promise<number | undefined>;
      /** How long one `start` invocation waits for it before reporting progress. */
      waitMs?: number;
    };
  };
}

const AFFIRMATIVE = new Set(["y", "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "do it", "please", "go ahead", "go for it", "absolutely", "of course", "sounds good"]);
const NEGATIVE = new Set(["n", "no", "nope", "not now", "skip", "later", "cancel", "stop"]);
/** Words that turn an otherwise agreeable answer into a refusal ("please don't"). */
const NEGATION = /\b(no|not|don'?t|do not|never|cancel|stop|wait)\b/;
/** "send a new code", "resend", "I didn't get it", "another code please". */
/** "use a different email", "wrong address", "change the email". */
const ASKS_OTHER_EMAIL = /\b(different|another|other|wrong|change( the)?) (e-?mail|address)\b/i;
const ASKS_NEW_CODE = /\b(new code|another code|resend|send (it |a code )?again|didn'?t (get|receive|arrive)|did not (get|receive|arrive)|no (code|email) (came|arrived))\b/i;
const AGAIN = { argv: ["konteks-remote", "onboard", "--json"] };
const RECONNECT_ASK = { question: "Connect this machine again? It starts over with your email and a new code.", kind: "confirm" } as const;
/** How long, and how often, the agents step waits for the machine to advertise what it can run. */
const AGENTS_WAIT_MS = 10_000;
const AGENTS_WAIT_ATTEMPTS = 9;
/** How long one `start` invocation waits on the unpacking before saying how far it got. */
const STAGING_WAIT_MS = 25_000;
/** How long `inspect` waits for the freshly started service before moving on without it. */
// A fresh service opens for work about a minute after the install; one
// invocation waits that long, so the agent is not handed "ask again" twice
// and left to write its own polling loop around onboard (WS1-079).
const READY_WAIT_MS = 75_000;
/** The owner token is refreshed this long before it expires (OS15). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The wire code Core answered with, for refusals the shared code list does not name. */
function wireCode(error: unknown): string {
  if (error instanceof CoreResponseError) return error.wireCode;
  return error instanceof RemoteInstanceError ? error.code : "";
}

// People answer in words, and an agent that relays them faithfully passes the
// words on: "Yes.", "Yes, please.", "yes, try it again". Matching only the
// bare word refused all three and made the agent rewrite the person's answer.
// An answer counts when it starts with a yes or a no, ignoring punctuation.
function normalizeAnswer(answer: string): string {
  return answer.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
}
function leadsWith(words: Set<string>, answer: string): boolean {
  if (words.has(answer)) return true;
  for (const word of words) if (answer.startsWith(`${word} `)) return true;
  return false;
}
export function isYes(answer: string): boolean {
  const said = normalizeAnswer(answer);
  if (!leadsWith(AFFIRMATIVE, said)) return false;
  // "yes, but not now" and "please don't" are not a yes.
  return !NEGATION.test(said.replace(/^\S+\s?/, ""));
}
export function isNo(answer: string): boolean {
  return leadsWith(NEGATIVE, normalizeAnswer(answer));
}

/** Every family whose local tooling this machine actually has (OS14). */
export async function detectAgentFamilies(): Promise<string[]> {
  const { resolveNativeClaudeExecutable, resolveNativeCodexHome } = await import(
    "@konteks/remote-supervisor"
  );
  const families: string[] = [];
  if (await resolveNativeClaudeExecutable().then(() => true).catch(() => false)) {
    families.push("claude-code");
  }
  if (await resolveNativeCodexHome().then(() => true).catch(() => false)) {
    families.push("codex");
  }
  return families;
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

/** Still being probed, or never reported: not evidence that the login is missing. */
const UNSETTLED_READINESS = new Set(["ready", "probing", "unknown"]);

/**
 * Poll the control socket until the service reports itself active, or give up.
 *
 * Roles are stripped at binding and become real at the first heartbeat, so
 * the summary that says "your Claude Code login will run Konteks work here"
 * waits for that heartbeat rather than claiming it early (OS14).
 */
async function waitForServiceReady(root: string): Promise<{ administrativeStatus: string; roles: string[] } | null> {
  const record = await readNativeRecord(root).catch(() => null);
  if (!record) return null;
  const control = new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort);
  const deadline = Date.now() + READY_WAIT_MS;
  let last: { administrativeStatus: string; roles: string[] } | null = null;
  while (Date.now() < deadline) {
    try {
      const status = await control.call({ op: "status" }, SupervisorStatusSchema, { timeoutMs: 5_000 });
      last = { administrativeStatus: status.administrativeStatus, roles: status.roles };
      if (status.administrativeStatus === "active" && status.connectivity.reconciliationComplete) return last;
    } catch (error) {
      // No control token yet means the service has not come up; keep waiting.
      if (!(error instanceof RemoteInstanceError) || error.code !== "control_socket_unavailable") return last;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
  }
  return last;
}

/** Steps that can take tens of seconds; never entered without saying so first. */
const SLOW_STEPS: ReadonlySet<string> = new Set(["start", "graft_setup"]);

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "nothing") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const isAgain = (run: OnboardStep["run"]) =>
  Boolean(run && run.argv.length === AGAIN.argv.length && run.argv.every((part, index) => part === AGAIN.argv[index]));

/**
 * One invocation as the agent sees it (WS1-032). A step that moved onboarding
 * on and only says "run onboard again" costs the person a whole agent turn —
 * passes 23–25 spent most of each two-minute gate on those hops, not in
 * Konteks. When a step advanced and has nothing to ask or run, the next one
 * runs here, and the agent gets the notes and the next question together. A
 * step that did not advance (something is still starting) is handed back as
 * it is, so waiting still happens between the agent's runs.
 */
export async function runOnboard(context: OnboardContext, maxChained = 4): Promise<OnboardStep> {
  const notes: string[] = [];
  let current = context;
  for (let hop = 0; ; hop += 1) {
    const before = (await readOnboardState(current.root).catch(() => null))?.step;
    const result = await runOnboardStep(current);
    const after = (await readOnboardState(current.root).catch(() => null))?.step;
    const advanced = after !== undefined && after !== before;
    // The bind that follows a confirmed code makes the workspace and waits for
    // the agent packages, up to a minute or two. Chaining into it swallowed the
    // note that says so, and the person sat 51 s with nothing (WS1-076), so
    // that note always reaches the person before the long step starts.
    const slowNext = after !== undefined && SLOW_STEPS.has(after);
    if (!isAgain(result.run) || result.ask || result.done || !advanced || slowNext || hop >= maxChained) {
      if (notes.length === 0) return result;
      return { ...result, note: [...notes, result.note].filter(Boolean).join(" ") };
    }
    // Every step's news reaches the person: the push that went through, the
    // Graft already there (pass 6 lost both behind the closing). The steps that
    // restated one wait ("will join… is joining… is now…", pass 27) no longer
    // chain, since the slow start is never entered in the same call.
    if (result.note && !notes.includes(result.note)) notes.push(result.note);
    const { answer: _answered, ...next } = current;
    current = next;
  }
}

export async function runOnboardStep(context: OnboardContext): Promise<OnboardStep> {
  const supervisorData = join(context.root, "supervisor");
  const clock = new SystemClock();
  const coreUrl = context.coreUrl ?? process.env.KONTEKS_CORE_URL ?? "https://api.konteks.io";
  const siteUrl = (context.siteUrl ?? process.env.KONTEKS_SITE_URL ?? "https://app.konteks.io").replace(/\/+$/, "");
  const enrollment =
    context.deps?.enrollment ??
    new NativeEnrollment({
      dataDir: supervisorData,
      coreUrl,
      clock,
      ...(context.deps?.fetchFn ? { fetchFn: context.deps.fetchFn } : {}),
    });
  // The workspace's name as the site shows it now: the person may have renamed
  // it since this machine was told its id (WS1-108). Revoked access still
  // speaks; anything else falls back to what this machine was told.
  const currentWorkspaceName = async (tenantId: string): Promise<string | undefined> => {
    if (!tenantId || !(await readOwnerToken(supervisorData).catch(() => null))) return undefined;
    try {
      const api = await ownerApi(supervisorData, coreUrl, enrollment, context);
      return await api.workspaceDisplayName(tenantId);
    } catch (error) {
      if (error instanceof RemoteInstanceError && error.message === OWNER_ACCESS_REVOKED) throw error;
      return undefined;
    }
  };
  const families = context.deps?.families ?? detectAgentFamilies;
  const state = (await readOnboardState(context.root)) ?? {
    schemaVersion: 1 as const,
    step: "identity" as const,
    updatedAt: new Date().toISOString(),
  };
  const save = (next: Partial<OnboardState>) =>
    writeOnboardState(context.root, { ...state, ...next } as never);
  const links = () => ({
    site: siteUrl,
    ...(state.systemId ? { system: `${siteUrl}/systems/${state.systemId}` } : {}),
    ...(state.initiativeUrl ? { initiative: state.initiativeUrl } : {}),
  });

  // A machine that lost its key cannot be the runtime it was: every call it
  // signs is refused, and its service will not start (W1-L1). Whatever step
  // this conversation was on, it connects the machine again, as a runtime
  // that takes the old one's place.
  const lost = await lostMachineKey(supervisorData);
  if (lost) {
    await setAsideLostIdentity(context.root, lost.instanceId);
    const email = state.email ?? state.resendTo;
    await writeOnboardState(context.root, {
      schemaVersion: 1,
      step: "email",
      updatedAt: new Date().toISOString(),
      replaces: lost.instanceId,
      ...(email ? { resendTo: email } : {}),
    } as never);
    const note =
      "This machine lost its Konteks key, so it can no longer connect as the runtime it was. It will connect again as a new runtime that takes the old one's place; your repository and your coding agents' logins are not affected.";
    return email
      ? { step: "identity", note: `${note} A code will be sent to the address it belonged to.`, run: AGAIN }
      : { step: "identity", note, ask: { question: "What email address should this machine belong to?", kind: "email" } };
  }

  switch (state.step) {
    case "reconnect": {
      if (context.answer === undefined || (!isYes(context.answer) && !isNo(context.answer))) {
        return { step: "identity", note: OWNER_ACCESS_REVOKED, ask: RECONNECT_ASK };
      }
      if (isNo(context.answer)) {
        await save({ step: "done", closing: true });
        return { step: "identity", done: { summary: "This machine stays disconnected from Konteks.", links: { site: siteUrl } } };
      }
      // The revoked runtime can never act again; keep its record beside the
      // install and enroll this machine afresh, as a new runtime.
      const revoked = await new SupervisorStore(supervisorData).identity().catch(() => null);
      if (revoked?.instanceId && revoked.instanceId !== "pending") await setAsideLostIdentity(context.root, revoked.instanceId);
      const address = state.ownerEmail ?? state.email;
      await writeOnboardState(context.root, {
        schemaVersion: 1,
        step: "email",
        updatedAt: new Date().toISOString(),
        ...(address ? { resendTo: address } : {}),
      } as never);
      return address
        ? { step: "identity", note: "Starting over as a new runtime.", run: AGAIN }
        : { step: "identity", ask: { question: "What email address should this machine belong to?", kind: "email" } };
    }
    case "identity": {
      // A machine that already has an identity is not enrolling again; it is
      // being asked what it is (OS9).
      const identity = await new SupervisorStore(supervisorData).identity().catch(() => null);
      if (identity?.instanceId && identity.instanceId !== "pending") {
        const stored = await readOwnerToken(supervisorData);
        if (!stored) {
          // Activated through the operator door: connected, but this machine
          // holds no person's access to register a System with. The site does.
          await save({ step: "done", instanceId: identity.instanceId, ...(identity.workspaceId ? { tenantId: identity.workspaceId } : {}) });
          return {
            step: "identity",
            note: `This machine is already connected to ${identity.workspaceId ?? "a workspace"} through an activation; register Systems from the site.`,
            run: AGAIN,
          };
        }
        await save({
          step: "inspect",
          instanceId: identity.instanceId,
          ...(identity.workspaceId ? { tenantId: identity.workspaceId } : {}),
        });
        return {
          step: "identity",
          note: `This machine is already connected to ${identity.workspaceId ?? "a workspace"}.`,
          run: AGAIN,
        };
      }
      // Not connected yet: the first response is the first question, not a
      // bare "run again" the agent has to explain (WS1-017).
      await save({ step: "email" });
      return {
        step: "identity",
        ask: { question: "What email address should this machine belong to?", kind: "email" },
      };
    }

    case "email": {
      // After a lost bind the address is already known; asking for it again
      // would make the person repeat themselves for our failure.
      const email = context.answer?.trim() || state.resendTo;
      if (!email) {
        return { step: "email", ask: { question: "What email address should this machine belong to?", kind: "email" } };
      }
      let intentRef = state.intentRef;
      if (!intentRef) {
        const platform = nativePlatform();
        const prepared = await readNativeEnrollment(context.root).catch(() => null);
        const release = prepared
          ? { manifest: { bundleVersion: prepared.bundleVersion, digest: prepared.manifestDigest } }
          : verifyNativeRelease(
              await fetchNativeReleaseManifest(context.deps?.fetchFn ?? fetch, process.env.KONTEKS_RELEASE_MANIFEST_URL ?? NATIVE_MANIFEST_URL),
              EMBEDDED_RELEASE_ROOTS,
              clock.now(),
            );
        const opened = await enrollment.openIntent({
          platform,
          // `assistant` is what a project-management turn places as, and
          // `onboard` is what the catalog work needs (OS14). Which agent
          // families exist here is recorded locally, not requested as a role.
          requestedRoles: ["assistant", "onboard"],
          bundleVersion: release.manifest.bundleVersion,
          manifestDigest: release.manifest.digest,
        });
        intentRef = opened.intentRef;
      }
      const sent = await enrollment.sendChallenge(intentRef, email);
      await save({ step: "code", intentRef, email, emailMasked: sent.sentToMasked, attemptsRemaining: sent.attemptsRemaining, resendTo: undefined, resendReason: undefined } as never);
      return {
        step: "email",
        note: `${state.resendReason ? `${state.resendReason} ` : ""}A ${state.resendReason ? "new " : ""}six-digit code is on its way to ${sent.sentToMasked}. If it does not arrive within a minute or two, say "send a new code"; for another address, say "use a different email".`,
        run: AGAIN,
      };
    }

    case "code": {
      const codeQuestion = { question: `Paste the six-digit code sent to ${state.emailMasked ?? "your email"}.`, kind: "code" as const };
      if (context.answer === undefined || !context.answer.trim()) {
        return { step: "code", ask: codeQuestion };
      }
      // A mistyped address: go back and ask for it (WS1-088).
      if (ASKS_OTHER_EMAIL.test(context.answer)) {
        await save({ step: "email", intentRef: undefined, email: undefined, emailMasked: undefined, attemptsRemaining: undefined, resendTo: undefined, resendReason: undefined } as never);
        return { step: "code", note: "The code sent before will not be used.", ask: { question: "What email address should this machine belong to?", kind: "email" } };
      }
      // No mail, or a code lost: the person asks for another one (WS1-088).
      if (ASKS_NEW_CODE.test(context.answer)) {
        try {
          const sent = await enrollment.sendChallenge(state.intentRef!, state.email!);
          await save({ emailMasked: sent.sentToMasked, attemptsRemaining: sent.attemptsRemaining });
          return { step: "code", note: `A new code is on its way to ${sent.sentToMasked}; the one before it no longer works.`, ask: codeQuestion };
        } catch (error) {
          if (wireCode(error) === "challenge_active") {
            return { step: "code", note: `The last code was sent less than a minute ago and is probably still on its way. If it has not arrived in a minute, say "send a new code" again.`, ask: codeQuestion };
          }
          if (wireCode(error) === "rate_limited") {
            return { step: "code", note: "Too many codes were sent to this address in the last hour, so no new one can be sent yet. The last code still works until it expires.", ask: codeQuestion };
          }
          throw error;
        }
      }
      let verified;
      try {
        verified = await enrollment.verifyCode(state.intentRef!, context.answer.trim());
      } catch (error) {
        if (wireCode(error) === "code_invalid") {
          const left = Math.max((state.attemptsRemaining ?? 1) - 1, 0);
          await save({ attemptsRemaining: left });
          return {
            step: "code",
            note: `That code was not accepted${left > 0 ? `; ${left} attempt${left === 1 ? "" : "s"} left` : ""}. If the email did not arrive or the code is lost, say "send a new code".`,
            ask: codeQuestion,
          };
        }
        if (["enrollment_invalid", "challenge_expired"].includes(wireCode(error))) {
          // Attempts spent or the intent expired: start the enrollment again
          // with the same key. It costs the person one more email (OS9).
          // Keep the address: the note promises a new code, and the email
          // step sends one to it rather than asking the person for their
          // address again (W1-X1; passes 19 and X1 were asked again).
          // Say why before the new code goes out; the email step, which the
          // chain ends on, carries the reason (Z2: the fifth wrong code was
          // otherwise reported only as "a code is on its way").
          const resendReason =
            wireCode(error) === "challenge_expired"
              ? "That code has expired; codes last ten minutes."
              : "That code was not accepted either, and after five wrong codes a code stops working, to keep your account safe.";
          await save({ step: "email", intentRef: undefined, emailMasked: undefined, attemptsRemaining: undefined, resendReason, ...(state.email ? { resendTo: state.email } : {}) } as never);
          return { step: "code", note: `${resendReason} A new one will be sent.`, run: AGAIN };
        }
        throw error;
      }
      if (verified.decision === "choose") {
        await save({ step: "workspace", decision: verified.decision, ...(verified.workspaces ? { workspaces: verified.workspaces } : {}) });
        return { step: "code", note: "That address belongs to more than one workspace.", run: AGAIN };
      }
      await save({
        step: "start",
        decision: verified.decision,
        ...(verified.workspaces ? { workspaces: verified.workspaces } : {}),
        ...(verified.proposedTenantId ? { proposedTenantId: verified.proposedTenantId } : {}),
      });
      return {
        step: "code",
        note:
          verified.decision === "create"
            ? // The id is only settled when the workspace is made (a taken one
              // gets a suffix), so none is promised here; the next step names it.
              "Your address is confirmed. Konteks is creating your workspace and connecting this machine to it; this can take up to a minute."
            : `This machine will join ${verified.workspaces?.[0]?.displayName ?? "your workspace"}.`,
        run: AGAIN,
      };
    }

    case "workspace": {
      const choices = (state.workspaces ?? []).map(entry => entry.displayName);
      if (context.answer === undefined) {
        return { step: "workspace", ask: { question: "Which workspace should this machine join?", kind: "choice", choices } };
      }
      const wanted = context.answer.trim().toLowerCase();
      const chosen = (state.workspaces ?? []).find(
        entry => entry.displayName.toLowerCase() === wanted || entry.tenantId.toLowerCase() === wanted,
      );
      if (!chosen) {
        return {
          step: "workspace",
          note: "That is not one of the workspaces on offer.",
          ask: { question: "Which workspace should this machine join?", kind: "choice", choices },
        };
      }
      await save({ step: "start", tenantId: chosen.tenantId });
      return { step: "workspace", note: `Joining ${chosen.displayName}.`, run: AGAIN };
    }

    case "start": {
      // A bind that answered but whose record never got written is resumed
      // from the identity on disk rather than asked of Core again.
      const store = new SupervisorStore(supervisorData);
      const existing = await store.identity().catch(() => null);
      let identity = existing && existing.instanceId !== "pending" && existing.workspaceId ? { instanceId: existing.instanceId, workspaceId: existing.workspaceId } : null;
      if (!identity) {
        const prepared = await readNativeEnrollment(context.root);
        let bound;
        try {
          bound = await enrollment.bind(state.intentRef!, {
            email: state.email!,
            ...(state.tenantId ? { tenantId: state.tenantId } : {}),
            ...(state.replaces ? { replacesInstanceId: state.replaces } : {}),
            expectedManifestDigest: prepared.manifestDigest,
          });
        } catch (error) {
          if (wireCode(error) === "enrollment_invalid" && state.email) {
            // The bind finished on Konteks but its answer never arrived, so
            // this intent is spent. A new code for the same address joins the
            // machine to the workspace that bind made (WS1-014).
            await save({ step: "email", intentRef: undefined, emailMasked: undefined, decision: undefined, attemptsRemaining: undefined, resendTo: state.email } as never);
            return {
              step: "start",
              note: "This machine did not hear back from Konteks in time, though your workspace may already be set up. Konteks will send a new code to finish connecting this machine.",
              run: AGAIN,
            };
          }
          if (wireCode(error) === "limit_exceeded") {
            // R18 / W1-A10: the plan allows one connected runtime. Konteks
            // names the machine that holds it, so the person knows which one
            // to revoke. Stop here, but leave onboarding ready to try again:
            // "run onboard again" used to find a finished machine and replay
            // a summary instead of connecting. The next run sends a new code.
            const said = error instanceof Error && /plan allows/i.test(error.message)
              ? error.message.trim().replace(/([^.!?])$/, "$1.")
              : "This workspace's plan allows one connected runtime, and it is in use.";
            // With other workspaces on offer, the address this run proved is
            // still good for them: ask again instead of sending a new code
            // (W1-E2, WS1-104). Core only rolled the refused bind back.
            if (state.decision === "choose" && (state.workspaces?.length ?? 0) > 1) {
              await save({ step: "workspace", tenantId: undefined } as never);
              return {
                step: "workspace",
                note: `${workspaceName(state, state.tenantId ?? "")} has no room for this machine. ${said} To use it here, revoke that runtime in Customize → Runtimes or move the workspace to a plan with more runtimes in Settings → Plan. Or choose another workspace.`,
                ask: { question: "Which workspace should this machine join?", kind: "choice", choices: (state.workspaces ?? []).map(entry => entry.displayName) },
              };
            }
            await save({ step: "email", intentRef: undefined, emailMasked: undefined, decision: undefined, attemptsRemaining: undefined, resendTo: state.email } as never);
            return {
              step: "start",
              done: {
                summary: `${said} To move Konteks to this laptop, revoke that runtime in Customize → Runtimes, then run onboard again here; a new code will be sent to ${state.emailMasked ?? "your address"}. To keep both, move the workspace to a plan with more runtimes in Settings → Plan.`,
                links: { site: `${siteUrl}/customize/connected-runtimes` },
              },
            };
          }
          if (wireCode(error) === "limit_reached") {
            await save({ step: "done" });
            return {
              step: "start",
              done: {
                summary: "No new workspace can be created right now. Sign in on the site or try again later.",
                links: { site: siteUrl },
              },
            };
          }
          throw error;
        }
        await writeOwnerToken(supervisorData, {
          token: bound.ownerToken.token,
          expiresAt: bound.ownerToken.expiresAt,
          userRef: bound.ownerToken.userRef,
          tenantId: bound.ownerToken.tenantId,
          instanceId: bound.identity.instanceId,
        });
        identity = bound.identity;
      }
      const joinedName = workspaceName(state, identity.workspaceId);
      const workspaceNote =
        state.decision === "create"
          ? `Your workspace is ready: ${identity.workspaceId}. You can rename it in Settings.`
          : `This machine is joining ${joinedName}.`;
      const announce = state.workspaceAnnounced ? "" : `${workspaceNote} `;
      // The agent packages unpack in the background from `install --enroll`
      // (WS1-012). Wait a while for them here, and if they are still going,
      // say how far they have got and come back, rather than sit silent.
      const staging = context.deps?.staging ?? {
        status: (root: string) =>
          enrollmentStagingStatus(root, async r => releaseStaged(r, (await readNativeEnrollment(r).catch(() => null))?.releaseId)),
        spawn: spawnEnrollmentStaging,
      };
      const deadline = Date.now() + (staging.waitMs ?? STAGING_WAIT_MS);
      let unpacked = await staging.status(context.root);
      while (unpacked.state === "running" && Date.now() < deadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, Math.min(2_000, staging.waitMs ?? 2_000)));
        unpacked = await staging.status(context.root);
      }
      if (unpacked.state !== "done") {
        let progress: string;
        if (unpacked.state === "running") {
          const names = { "claude-code": "Claude Code", codex: "Codex" } as Record<string, string>;
          progress =
            unpacked.total > 0
              ? `This machine is still unpacking its agent packages: ${unpacked.agent ? `${names[unpacked.agent] ?? unpacked.agent}, ` : ""}${Math.min(unpacked.done + 1, unpacked.total)} of ${unpacked.total}. This usually finishes within two minutes of the install.`
              : "This machine is still unpacking its agent packages. This usually finishes within two minutes of the install.";
        } else {
          await staging.spawn(context.root);
          progress =
            unpacked.state === "failed"
              ? `Unpacking the agent packages stopped (${unpacked.message.replace(/[.]$/, "")}), so it has been started again.`
              : "Unpacking the agent packages has started.";
        }
        await save({ step: "start", workspaceAnnounced: true });
        return { step: "start", note: `${announce}${progress}`, run: AGAIN };
      }
      await (context.deps?.complete ?? completeNativeEnrollment)(context.root, identity);
      await save({
        step: "inspect",
        instanceId: identity.instanceId,
        tenantId: identity.workspaceId,
        email: undefined,
        ...(state.email ? { ownerEmail: state.email } : {}),
      } as never);
      return {
        step: "start",
        note: `${announce}This machine is now ${state.decision === "create" ? "its" : `${joinedName}'s`} runtime; starting it next; this takes about a minute.`,
        // Registering and starting the service is the launcher's own command,
        // so the agent runs it rather than this process forking a service.
        run: { argv: ["konteks-remote", "start"] },
      };
    }

    case "inspect": {
      // The service was just started; give it the first heartbeat before
      // anything is said about what runs here (OS14). A machine that was
      // already connected answers at once.
      const ready = await (context.deps?.waitForReady ?? waitForServiceReady)(context.root).catch(() => null);
      // The previous step asked for `konteks-remote start`. If nothing answers
      // here, that step did not happen — and carrying on regardless is how a
      // missed start surfaced two questions later as "the supervisor has not
      // started yet", about a folder the person had already agreed to push.
      // Ask for it again, in the same words, and stay on this step.
      if (!ready) {
        // Two different situations, and telling them apart is the whole point:
        // a machine with no service record never ran the start step, and one
        // that has a record is starting — its control port simply is not open
        // yet, and asking for `start` again would loop on a service that is
        // already coming up (it takes about a minute after a fresh install).
        const started = await readNativeRecord(context.root).catch(() => null);
        if (!started) {
          return {
            step: "inspect",
            note: "This machine's Konteks service is not running yet, so nothing can be set up here. Starting it is the step before this one.",
            run: { argv: ["konteks-remote", "start"] },
          };
        }
        // A record is also written before `start` is ever run, so "starting"
        // cannot wait for ever (WS1-036): after two waits (over two minutes)
        // hand out `start` again — it is harmless for a service that is
        // already up, and it is the step that was missed if it is not.
        const waits = (state.startWaits ?? 0) + 1;
        if (waits >= 2) {
          await save({ startWaits: 0 });
          return {
            step: "inspect",
            note: "The Konteks service on this machine has not answered for over two minutes. Starting it again; that is safe if it is already running.",
            run: { argv: ["konteks-remote", "start"] },
          };
        }
        await save({ startWaits: waits });
        return {
          step: "inspect",
          note: "The Konteks service on this machine is still starting. It usually opens for work about a minute after a fresh install; the next step waits for it again.",
          run: AGAIN,
        };
      }
      if (state.startWaits) await save({ startWaits: 0 });
      const notReady = ready.administrativeStatus !== "active" ? "The runtime service is still coming up; it will finish in the background. " : "";
      const facts = await (context.deps?.inspect ?? inspectRepository)(context.cwd ?? process.cwd());
      // A new conversation in the folder that is already this machine's
      // System: there is nothing to register again. Say so, and where the
      // work is, instead of offering to make it a System a second time.
      if (
        state.revisit &&
        state.systemEntityRef &&
        state.repositoryPath &&
        resolve(facts.path ?? context.cwd ?? process.cwd()) === resolve(state.repositoryPath)
      ) {
        // "Nothing needs setting up" is only true while Core still accepts
        // this machine; a revoked one is asked to connect again instead.
        await currentWorkspaceName(state.tenantId ?? "");
        await save({ step: "done", revisit: false });
        return {
          step: "inspect",
          done: {
            summary: [
              // The greeting just said who and where this machine is connected.
              `${state.repositoryName ?? "This folder"} is already your System${state.repositoryKind === "managed" ? " on Konteks managed git" : ""}; nothing here needs setting up again.`,
              state.initiativeId ? `Your first initiative "${state.initiativeTitle}" and its planning session are on the site.` : null,
              "Run onboard from another project folder to add it as a System.",
            ]
              .filter(Boolean)
              .join(" "),
            links: links(),
          },
        };
      }
      if (!facts.path) {
        const directory = resolve(context.cwd ?? process.cwd());
        if (directory === resolve(homedir()) || directory === resolve("/")) {
          // A home or root directory is not a project; making it a repository
          // would sweep in everything the person owns.
          await save({ step: "first_task", advertisedRoles: ready.roles });
          return {
            step: "inspect",
            note: `${notReady}This is your ${directory === resolve("/") ? "root" : "home"} folder, not a project, so no System is made here. Run onboard again from inside a project folder to add one.`,
            run: AGAIN,
          };
        }
        // An ordinary folder that is not a repository yet (W1-A5): offer it
        // as the first System on managed git. Nothing happens to it until the
        // person has said yes twice.
        await save({
          step: "system",
          repositoryPath: directory,
          repositoryName: basename(directory),
          defaultBranch: "main",
          repositoryKind: "managed",
          repositoryNeedsInit: true,
          advertisedRoles: ready.roles,
        });
        return {
          step: "inspect",
          note: `${notReady}${basename(directory)} isn\u2019t a git repository yet.`,
          run: AGAIN,
        };
      }
      const kind = facts.remoteUrl && facts.remoteReachable ? "existing" : "managed";
      await save({
        step: "system",
        repositoryPath: facts.path,
        repositoryName: facts.name,
        defaultBranch: facts.defaultBranch,
        repositoryKind: kind,
        ...(facts.remoteUrl ? { remoteUrl: facts.remoteUrl } : {}),
        ...(facts.onManagedGit ? { repositoryOnManagedGit: true } : {}),
        ...(facts.unpushedCommits !== undefined ? { repositoryUnpushed: facts.unpushedCommits } : {}),
        advertisedRoles: ready.roles,
      });
      // A folder already on Konteks managed git says so in its question.
      const where =
        kind === "existing"
          ? `You are in ${facts.name}, with remote ${facts.remoteUrl}.`
          : facts.onManagedGit
            ? ""
            : `You are in ${facts.name}, which has no remote this machine can push to.`;
      return {
        step: "inspect",
        ...(`${notReady}${where}` ? { note: `${notReady}${where}` } : {}),
        run: AGAIN,
      };
    }

    case "system": {
      const question =
        state.repositoryKind === "existing"
          ? `Make ${state.repositoryName} your first System in Konteks?`
          : state.repositoryNeedsInit
            ? `Make ${state.repositoryName} your first System, kept on Konteks managed git? Nothing is pushed until you say so.`
            : state.repositoryOnManagedGit
              ? `Use ${state.repositoryName} as your System here? It is already on Konteks managed git, so if your workspace has it, nothing is made twice.`
              : `Make ${state.repositoryName} your first System, on Konteks managed git?`;
      if (context.answer === undefined) {
        // The repository is the one captured at the first inspect. A run from
        // somewhere else while this is pending asks which of the two is meant,
        // instead of silently registering the wrong one (OS9).
        const here = await (context.deps?.inspect ?? inspectRepository)(context.cwd ?? process.cwd()).catch(() => null);
        if (here?.path && state.repositoryPath && resolve(here.path) !== resolve(state.repositoryPath)) {
          return {
            step: "system",
            note: `Onboarding started in ${state.repositoryName}, but this is ${here.name}.`,
            ask: { question: "Which repository should become your first System?", kind: "choice", choices: [state.repositoryName!, here.name] },
          };
        }
        return { step: "system", ask: { question, kind: "confirm" } };
      }
      const answer = context.answer.trim();
      if (isNo(answer)) {
        // A first initiative needs a System. With none, asking what to build
        // first only leads to "an initiative needs a System" (pass 27): close
        // instead, and say how to come back to it.
        if (!state.systemId) {
          await save({ step: "done", closing: true });
          return {
            step: "system",
            note: "Leaving the catalog as it is; nothing was registered or pushed. To make this folder a System later, run onboard here again. A first initiative needs a System, so that waits too.",
            run: AGAIN,
          };
        }
        await save({ step: "first_task" });
        return { step: "system", note: "Leaving the catalog as it is.", run: AGAIN };
      }
      if (!isYes(answer)) {
        // Neither yes nor no: the answer to "which repository?" names one.
        if (answer.toLowerCase() === state.repositoryName?.toLowerCase()) {
          return { step: "system", ask: { question, kind: "confirm" } };
        }
        const here = await (context.deps?.inspect ?? inspectRepository)(context.cwd ?? process.cwd()).catch(() => null);
        if (here?.path && state.repositoryPath && resolve(here.path) !== resolve(state.repositoryPath) && answer.toLowerCase() === here.name.toLowerCase()) {
          await save({ step: "inspect" });
          return { step: "system", note: `Switching to ${here.name}.`, run: AGAIN };
        }
        return { step: "system", note: "A yes or no is what this step needs.", ask: { question, kind: "confirm" } };
      }
      const api = await ownerApi(supervisorData, coreUrl, enrollment, context);
      const register = () => api.registerFirstSystem({
        name: state.repositoryName!,
        hostLabel: hostLabel(),
        repository: {
          kind: state.repositoryKind!,
          ...(state.remoteUrl && state.repositoryKind === "existing" ? { remoteUrl: state.remoteUrl } : {}),
          defaultBranch: state.defaultBranch!,
        },
      });
      // A new workspace's managed git can still be on its way, and Konteks
      // has just asked for it again (WS1-048). That is a wait, not a failure:
      // wait here, briefly, rather than hand the person a "retry".
      const settingUpUntil = Date.now() + (context.deps?.managedGitWaitMs ?? 90_000);
      let registered: Awaited<ReturnType<typeof register>>;
      for (;;) {
        try {
          registered = await register();
          break;
        } catch (error) {
          const settingUp = error instanceof RemoteInstanceError && /still setting up managed git/i.test(error.message);
          if (!settingUp || Date.now() >= settingUpUntil) throw error;
          await new Promise(done => setTimeout(done, context.deps?.managedGitPollMs ?? 10_000));
        }
      }
      await save({
        step: state.repositoryKind === "managed" ? "push" : "graft",
        ...(registered.existing ? { systemExisting: true } : {}),
        systemId: registered.systemId,
        systemEntityRef: registered.systemEntityRef,
        ...(registered.repository.remoteUrl ? { managedRemoteUrl: registered.repository.remoteUrl } : {}),
        ...(registered.repository.sshUrl ? { managedSshUrl: registered.repository.sshUrl } : {}),
      });
      return {
        step: "system",
        note: registered.existing
          ? `${state.repositoryName} was already a System in your workspace, so this machine works on that one; nothing was made twice.`
          : state.repositoryKind === "managed"
            ? `${state.repositoryName} is now a System in Konteks, with a managed git repository ready for it.`
            : `${state.repositoryName} is now a System in Konteks.`,
        run: AGAIN,
      };
    }

    case "push": {
      // A folder with the person's files in it gets them committed, and is
      // shown exactly which, and what stays out, before anything happens (W1-B2).
      const plan: FirstCommitPlan = state.repositoryNeedsInit
        ? await (context.deps?.planCommit ?? planFirstCommit)(state.repositoryPath!)
        : { include: [], leftOut: [] };
      const withFiles = plan.include.length > 0;
      const question = !state.repositoryNeedsInit
        ? `Push ${state.defaultBranch} to the Konteks repository now?`
        : withFiles
          ? `Push ${state.repositoryName} to Konteks managed git now? The folder becomes a git repository on ${state.defaultBranch}, joined to the repository Konteks made for it, with one commit of your ${plan.include.length} file${plan.include.length === 1 ? "" : "s"}.`
          : `Push ${state.repositoryName} to Konteks managed git now? The folder becomes a git repository on ${state.defaultBranch}, joined to the repository Konteks made for it; none of your files are added or changed.`;
      if (context.answer === undefined) {
        // A System this machine rejoined, whose branch Konteks already has:
        // there is nothing to agree to. The push only registers this machine's
        // key and changes nothing on the repository.
        if (state.systemExisting && state.repositoryOnManagedGit && state.repositoryUnpushed === 0) {
          await save({ step: "pushing" });
          return { step: "push", note: `Konteks already has ${state.defaultBranch}; joining this machine to the repository.`, run: AGAIN };
        }
        if (!withFiles) return { step: "push", ask: { question, kind: "confirm" } };
        const shown = plan.include.slice(0, 8);
        const more = plan.include.length - shown.length;
        const left = plan.leftOut.length > 0
          ? ` Left out: ${listed(plan.leftOut.map(entry => `${entry.path} (${entry.why})`))}. A .gitignore listing ${plan.leftOut.length === 1 ? "it" : "them"} is added so ${plan.leftOut.length === 1 ? "it stays" : "they stay"} out.`
          : "";
        return {
          step: "push",
          note: `The commit would hold ${listed(more > 0 ? [...shown, `${more} more`] : shown)}.${left}`,
          ask: { question, kind: "confirm" },
        };
      }
      if (!isYes(context.answer)) {
        await save({ step: "first_task" });
        return { step: "push", note: "Nothing was pushed; the Konteks remote is recorded on the System and can be pushed to later.", run: AGAIN };
      }
      await save({ step: "pushing" });
      return {
        step: "push",
        note: `Pushing ${state.defaultBranch} to Konteks managed git. This usually takes a few seconds.`,
        run: AGAIN,
      };
    }

    case "pushing": {
      // Managed git accepts only a key this runtime registered (OS11), over
      // SSH (WS1-021). `git key add` is idempotent for a key that exists. A
      // key that cannot be registered is said plainly, not swallowed into a
      // push that then fails for a reason the person cannot see.
      let sshCommand: string | undefined;
      if (state.managedSshUrl) {
        let key: { identityFile?: string; user?: string };
        try {
          // A service that was just (re)started answers within the wait; one
          // that is up answers at once.
          await (context.deps?.waitForReady ?? waitForServiceReady)(context.root).catch(() => null);
          key = await (context.deps?.registerGitKey ?? registerGitKey)(context.root);
        } catch (error) {
          // The service on this machine is not running (WS1-027): say that,
          // and start it, instead of a control-socket error and "try again".
          // The person already said yes; the push goes on once it answers.
          if (error instanceof RemoteInstanceError && error.code === "control_socket_unavailable") {
            await save({ step: "pushing" });
            return {
              step: "pushing",
              note: "The Konteks service on this machine is not running, so nothing was pushed yet. Starting it; the push goes on once it answers.",
              run: { argv: ["konteks-remote", "start"] },
            };
          }
          await save({ step: "push" });
          const why = error instanceof Error && error.message ? ` (${error.message.replace(/[.]$/, "")})` : "";
          return {
            step: "pushing",
            note: `This machine could not register its key with Konteks managed git${why}. Nothing was pushed.`,
            ask: { question: "Try the push again?", kind: "confirm" },
          };
        }
        if (key.identityFile) {
          sshCommand = `ssh -i '${key.identityFile.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
        }
      }
      if (state.repositoryNeedsInit) {
        const remoteUrl = sshCommand ? state.managedSshUrl : state.managedRemoteUrl;
        const plan = await (context.deps?.planCommit ?? planFirstCommit)(state.repositoryPath!);
        const author = { authorName: (state.ownerEmail ?? "Konteks").split("@")[0]!, authorEmail: state.ownerEmail ?? "onboarding@konteks.invalid" };
        const initialized = await (context.deps?.initialize ?? initializeRepository)({
          path: state.repositoryPath!,
          branch: state.defaultBranch!,
          ...author,
          ...(remoteUrl ? { remote: { url: remoteUrl, ...(sshCommand ? { sshCommand } : {}) } } : {}),
          ...(plan.include.length > 0 ? { keepFiles: true } : {}),
        });
        if (!initialized.ok) {
          await save({ step: "push" });
          return { step: "pushing", note: `${initialized.message} Nothing was pushed.`, ask: { question: "Try the push again?", kind: "confirm" } };
        }
        if (plan.include.length > 0) {
          const committed = await (context.deps?.commitFiles ?? commitFirstFiles)({
            path: state.repositoryPath!,
            plan,
            ...author,
            message: `Add ${state.repositoryName}`,
          });
          if (!committed.ok) {
            await save({ step: "push" });
            return { step: "pushing", note: `${committed.message} Nothing was pushed.`, ask: { question: "Try the push again?", kind: "confirm" } };
          }
          // Falls through to the push below, with the person's files on it.
        } else if (initialized.adopted) {
          // The Konteks repository already had its first commit, so there is
          // nothing of the person's to push: the folder is on it now.
          await save({ step: "graft" });
          return {
            step: "pushing",
            note: `${initialized.message} Your code lives on Konteks managed git, on the ${state.repositoryName} System: ${siteUrl}/systems/${state.systemId}. Push your work with git as usual (remote "konteks").`,
            run: AGAIN,
          };
        }
      }
      const result = await (context.deps?.push ?? pushToManagedRemote)({
        repositoryPath: state.repositoryPath!,
        remoteUrl: sshCommand ? state.managedSshUrl! : state.managedRemoteUrl!,
        branch: state.defaultBranch!,
        ...(sshCommand ? { sshCommand } : {}),
      });
      if (!result.pushed) {
        await save({ step: "push" });
        return { step: "pushing", note: `${result.message} Your folder is unchanged apart from git's own files.`, ask: { question: "Try the push again?", kind: "confirm" } };
      }
      await save({ step: "graft" });
      return {
        step: "pushing",
        note: `${result.message} Your code now lives on Konteks managed git, on the ${state.repositoryName} System: ${siteUrl}/systems/${state.systemId}. This folder's ${state.defaultBranch} branch tracks it (remote "konteks").`,
        run: AGAIN,
      };
    }

    case "graft": {
      // Graft is offered once the folder is a repository, once per repository
      // (W1-G1, W1-G2). A release without it, or a repository that already
      // decided, goes straight on.
      const repo = state.repositoryPath;
      const decided = state.graftDecision !== undefined && state.graftRepository === repo;
      const available = await (context.deps?.graft?.available ?? (async (root: string) => (await readGraftRecord(root)) !== null))(context.root).catch(() => false);
      if (!repo || decided || !available) {
        await save({ step: "first_task", ...(!repo || decided ? {} : { graftDecision: "unavailable", graftRepository: repo }) });
        return { step: "graft", run: AGAIN };
      }
      // A machine that reconnected in a folder it already wired (a lost key
      // resets onboarding) is not asked again (WS1-090).
      if (await (context.deps?.graft?.wired ?? graftAlreadyWired)(repo).catch(() => false)) {
        await save({ step: "first_task", graftDecision: "accepted", graftRepository: repo });
        return { step: "graft", note: `Graft is already set up in ${state.repositoryName ?? "this repository"}.`, run: AGAIN };
      }
      const plan = await (context.deps?.graft?.plan ?? planGraft)(repo, await families());
      if (plan.agents.length === 0) {
        await save({ step: "first_task", graftDecision: "unavailable", graftRepository: repo });
        return { step: "graft", run: AGAIN };
      }
      const names = plan.agents.map(id => (id === "claude" ? "Claude Code" : "Codex")).join(" and ");
      const question = `Set up Graft in ${state.repositoryName ?? "this repository"}? It adds ${listed(plan.adds)} here, kept out of your commits.`;
      if (context.answer === undefined) {
        const tracked = plan.tracked.length > 0
          ? ` ${listed(plan.tracked)} ${plan.tracked.length === 1 ? "is" : "are"} already tracked by git, so Graft's section there will show as a change until you commit or drop it.`
          : "";
        return {
          step: "graft",
          note:
            `Graft maps this repository's code so ${names} can find their way around it before they search. ` +
            "It runs only on this machine, sends nothing to a paid model, and its usage statistics stay off. " +
            `Outside this folder it writes only in ~/.graft: its settings and its own copy of Graft, which keeps working if Konteks is ever removed.${tracked}`,
          ask: { question, kind: "confirm" },
        };
      }
      if (isNo(context.answer)) {
        await save({ step: "first_task", graftDecision: "declined", graftRepository: repo });
        return { step: "graft", note: "Graft was not set up; nothing was added, and it will not be offered again for this folder.", run: AGAIN };
      }
      if (!isYes(context.answer)) {
        return { step: "graft", note: "A yes or no is what this step needs.", ask: { question, kind: "confirm" } };
      }
      await save({ step: "graft_setup", graftDecision: "accepted", graftRepository: repo });
      return {
        step: "graft",
        note: `Setting up Graft: downloading it, then building its map of ${state.repositoryName ?? "this repository"} (${plan.files} file${plan.files === 1 ? "" : "s"}). That usually takes under ${graftBuildSeconds(plan.files) + 30} seconds.`,
        run: AGAIN,
      };
    }

    case "graft_setup": {
      const repo = state.repositoryPath!;
      try {
        const tool = await (context.deps?.graft?.ensure ?? ((root: string) => ensureGraft(root, context.deps?.fetchFn ? { fetchFn: context.deps.fetchFn } : {})))(context.root);
        const wired = await (context.deps?.graft?.wire ?? wireGraft)(context.root, repo, await families(), tool);
        await save({ step: "first_task" });
        const changed = wired.changedTracked.length > 0 ? ` It also changed ${listed(wired.changedTracked)}, which git tracks.` : "";
        return {
          step: "graft_setup",
          note:
            `Graft is set up in ${state.repositoryName ?? "this repository"}${wired.mappedFiles !== null ? `: its map covers ${wired.mappedFiles} file${wired.mappedFiles === 1 ? "" : "s"}` : ""}. ` +
            `It added ${listed(wired.added)}, which git leaves out of your commits on this machine.${changed} A graft command sits next to konteks-remote for your agents.`,
          run: AGAIN,
        };
      } catch (error) {
        await save({ step: "first_task", graftDecision: "failed", graftRepository: repo });
        const why = error instanceof Error ? error.message.replace(/[.]$/, "") : "it stopped unexpectedly";
        return { step: "graft_setup", note: `Graft could not be set up (${why}). Nothing else changed, and onboarding carries on.`, run: AGAIN };
      }
    }

    case "first_task": {
      // A machine back in a System the workspace already had (a lost key)
      // is not asked for a first initiative it already has (WS1-090).
      if (context.answer === undefined && state.systemExisting && state.systemId && !state.initiativeId) {
        const api = await ownerApi(supervisorData, coreUrl, enrollment, context);
        const existing = (await api.listInitiatives(state.systemId).catch(() => []))[0];
        if (existing) {
          const url = `${siteUrl}/work/${encodeURIComponent(existing.id)}`;
          await save({ step: "done", closing: true, initiativeId: existing.id, initiativeTitle: existing.title, initiativeUrl: url } as never);
          Object.assign(state, { initiativeId: existing.id, initiativeTitle: existing.title, initiativeUrl: url });
          return { step: "first_task", note: `${state.repositoryName ?? "This System"} already has an initiative, "${existing.title}", so no new one is started: ${url}`, run: AGAIN };
        }
      }
      if (context.answer === undefined) {
        return {
          step: "first_task",
          ask: { question: "What do you want to build first? Your first planning turn is included.", kind: "text" },
        };
      }
      const wanted = context.answer.trim();
      // "nothing for now", "skip", "no thanks": a refusal, not an initiative's title.
      if (!wanted || isNo(wanted) || /^(nothing|none|not now|skip|later|maybe later)\b/i.test(wanted)) {
        await save({ step: "done", closing: true });
        return { step: "first_task", note: wanted ? "No initiative was started; start one from the site with New initiative whenever you like." : "Ending here.", run: AGAIN };
      }
      if (!state.systemId) {
        await save({ step: "done", closing: true });
        return {
          step: "first_task",
          note: "An initiative needs a System, and none was made here. Start it from the site with New initiative once you have a System.",
          run: AGAIN,
        };
      }
      const title = initiativeTitle(wanted);
      await save({ step: "agents", firstTask: wanted, initiativeTitle: title });
      return {
        step: "first_task",
        note: `Setting up your first initiative, "${title}", on ${state.repositoryName ?? "your System"}. Konteks is getting this machine's agents ready and opening the initiative's planning session; this takes up to a minute.`,
        run: AGAIN,
      };
    }

    case "agents": {
      // A workspace made from a coding agent has never chosen what runs its
      // work, so its first planning session would be refused for want of a
      // profile (W1-A6). This machine's own agents are the answer, and they
      // are the person's own logins: nothing to ask, nothing to configure.
      const api = await ownerApi(supervisorData, coreUrl, enrollment, context);
      if (!(await api.hasExecutionProfile())) {
        const ready = await api.setUpAgentsFromThisMachine(hostLabel());
        if (!ready) {
          // What the machine can run is discovered by the runtime and accepted
          // on a later heartbeat, a minute or so after it starts, so an empty
          // answer this early means "not yet", not "never" (W1-A6).
          const waited = (state.agentsWaited ?? 0) + 1;
          if (waited <= AGENTS_WAIT_ATTEMPTS) {
            await save({ agentsWaited: waited });
            await new Promise(resolveWait => setTimeout(resolveWait, context.deps?.agentsWaitMs ?? AGENTS_WAIT_MS));
            return {
              step: "agents",
              note: "Konteks is still learning what this machine's agents can do; this finishes about a minute after the machine starts.",
              run: AGAIN,
            };
          }
          await save({ step: "initiative", agentsWaited: undefined } as never);
          return {
            step: "agents",
            note: "This machine has not told Konteks what its agents can run yet; your initiative is still being created, and you can choose an agent in Settings once it has.",
            run: AGAIN,
          };
        }
      }
      await save({ agentsWaited: undefined } as never);
      await save({ step: "initiative" });
      return { step: "agents", note: "This machine's agents will run the work in this workspace.", run: AGAIN };
    }

    case "initiative": {
      const api = await ownerApi(supervisorData, coreUrl, enrollment, context);
      const wanted = state.firstTask ?? "";
      let initiativeId = state.initiativeId;
      let title = state.initiativeTitle ?? initiativeTitle(wanted);
      let pmSessionId = state.pmSessionId;
      let setupFailure = state.setupFailure;
      if (!initiativeId) {
        const created = await api.createInitiative({ systemId: state.systemId!, title });
        initiativeId = created.initiativeId;
        title = created.title;
        pmSessionId = created.pmSessionId;
        setupFailure = created.setupFailure;
        // Recorded before the first turn, so a retry never makes a second initiative.
        await save({
          initiativeId,
          initiativeTitle: title,
          initiativeUrl: `${siteUrl}/work/${encodeURIComponent(initiativeId)}`,
          ...(pmSessionId ? { pmSessionId } : {}),
          ...(setupFailure ? { setupFailure } : {}),
        });
        Object.assign(state, { initiativeId, initiativeTitle: title, pmSessionId, setupFailure });
      }
      const url = `${siteUrl}/work/${encodeURIComponent(initiativeId)}`;
      if (pmSessionId && !state.firstTurnSent) {
        await api.postFirstTurn(pmSessionId, wanted);
        await save({ firstTurnSent: true });
      }
      await save({ step: "done", closing: true, initiativeUrl: url, firstTask: undefined } as never);
      if (!pmSessionId) {
        return {
          step: "initiative",
          note: `Your first initiative, "${title}", is created, but its planning session could not be opened${setupFailure ? `: ${setupFailure}` : ""}. Open the initiative and choose Retry setup: ${url}`,
          run: AGAIN,
        };
      }
      return {
        step: "initiative",
        note: `Your first initiative, "${title}", is ready. Its planning session on this machine has your words as its first message and is replying now; follow it and answer it from the initiative: ${url}`,
        run: AGAIN,
      };
    }

    case "done":
    default: {
      // W1-A8: the person pasted the block into a new conversation on a
      // machine that already finished onboarding. Replaying the old closing
      // summary made the new agent suspicious ("it was already set up before I
      // asked a single question — if you didn't choose those, check them") and
      // said a planning session "is working on it here" hours later. Say who
      // and where this machine is connected, then look at the folder it is in.
      // The run right after the last step is this conversation closing, not
      // a new one; only a later run is a revisit.
      if (state.closing) await save({ closing: false });
      if (state.step === "done" && context.answer === undefined && !state.closing) {
        const identity = await new SupervisorStore(supervisorData).identity().catch(() => null);
        if (identity?.instanceId && identity.instanceId !== "pending") {
          // Named before anything is saved: a revoked machine stops here, and
          // the next paste meets the same question instead of a false "all set".
          const tenant = state.tenantId ?? identity.workspaceId;
          const where = tenant ? ((await currentWorkspaceName(tenant)) ?? workspaceName(state, tenant)) : "your workspace";
          await save({ step: "inspect", revisit: true });
          return {
            step: "identity",
            note: `This machine is already connected to ${where}${state.ownerEmail ? ` as ${state.ownerEmail}` : ""}; no sign-in is needed.`,
            run: AGAIN,
          };
        }
      }
      const installed = await families();
      // Installed is not logged in: name only the agents that can run work (pass 28).
      const readiness = await (context.deps?.agentReadiness ?? readAgentReadiness)(context.root).catch(() => null);
      const notLoggedIn = installed.filter(family => readiness?.[family] !== undefined && !UNSETTLED_READINESS.has(readiness[family]!));
      const present = installed.filter(family => !notLoggedIn.includes(family));
      const remedies: string[] = [];
      for (const family of ["claude-code", "codex"]) {
        if (notLoggedIn.includes(family)) remedies.push(`${agentName(family)} is installed but not logged in here, so it will not run Konteks work yet. To log it in: konteks-remote auth login ${family}`);
        else if (!present.includes(family)) remedies.push(`To also run ${agentName(family)} work here: konteks-remote auth login ${family}`);
      }
      // People know their agents by name, not by id (WS1-083).
      const presentNames = present.map(agentName);
      if (nativePlatform().os === "debian") {
        remedies.push("To keep the runtime available after logout: loginctl enable-linger $USER");
      }
      const advertised = state.advertisedRoles;
      const currentName = await currentWorkspaceName(state.tenantId ?? "");
      const agentsLine =
        present.length === 0
          ? installed.length > 0
            ? `No coding agent is logged in here yet, so no Konteks work can run on this machine until one is (see below).`
            : "No coding agent was found on this machine; install Claude Code or Codex and run konteks-remote auth login."
          : advertised && advertised.length === 0
            ? `Your ${presentNames.join(" and ")} login is set up; the runtime will advertise it once its first heartbeat lands.`
            : `Your ${presentNames.join(" and ")} login will run Konteks work here.`;
      return {
        step: "done",
        done: {
          summary: [
            joinedWorkspace(state) || (currentName !== undefined && currentName !== state.tenantId)
              ? `This machine is connected to your workspace ${currentName ?? workspaceName(state, state.tenantId ?? "")}.`
              : `This machine is connected to your workspace ${state.tenantId ?? ""}`.trim() + " (you can rename it in Settings).",
            state.systemEntityRef
              ? `${state.repositoryName} is your first System${state.repositoryKind === "managed" ? ", kept on Konteks managed git" : ""}.`
              : null,
            state.initiativeId
              ? state.systemExisting
                ? `Your first initiative "${state.initiativeTitle}" and its planning session are on the site.`
                : `Your first initiative is "${state.initiativeTitle}"${state.setupFailure ? "; its planning session still needs Retry setup on the initiative page" : ", and its planning session is working on it here"}.`
              : null,
            agentsLine,
          ]
            .filter(Boolean)
            .join(" "),
          links: links(),
          ...(present.length > 0 ? { agents: present } : {}),
          ...(remedies.length > 0 ? { remedies } : {}),
        },
      };
    }
  }
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
  // dangling "and" (WS1-083). Only when no phrase ends in reach, cut at a word.
  const phrase = /,\s|;\s|\s(?:and|so|but|which|because|where|with)\s/g;
  let end = -1;
  for (let match = phrase.exec(first); match && match.index <= 90; match = phrase.exec(first)) {
    if (match.index >= 30) end = match.index;
  }
  if (end > 0) return first.slice(0, end).replace(/[,;]$/, "").trim();
  const cut = first.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * A workspace this machine joined is named the way its owner named it (W1-E1);
 * only one it made has just its derived id, with the note that it can be renamed.
 */
function joinedWorkspace(state: { decision?: string | undefined }): boolean {
  return state.decision === "join" || state.decision === "choose";
}

function workspaceName(state: { workspaces?: Array<{ tenantId: string; displayName: string }> | undefined }, tenantId: string): string {
  return state.workspaces?.find(entry => entry.tenantId === tenantId)?.displayName ?? tenantId;
}

/** An agent family as people name it. */
export function agentName(family: string): string {
  return ({ "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi" } as Record<string, string>)[family] ?? family;
}

/**
 * The step to show when a step could not finish (WS1-003).
 *
 * The block teaches the agent three shapes and nothing else, so a failure is
 * said inside the protocol: what did not work, in plain words, and the same
 * question again, or an offer to try the step again. Revoked access ends that
 * runtime, and the person is asked whether to connect the machine again.
 */
export async function onboardFailureStep(context: OnboardContext, error: unknown): Promise<OnboardStep> {
  const state = await readOnboardState(context.root).catch(() => null);
  const step = state?.step ?? "identity";
  const message = error instanceof Error ? error.message.trim() : "";
  const said = message ? (/[.!?]$/.test(message) ? message : `${message}.`) : "Something unexpected went wrong.";
  const siteUrl = (context.siteUrl ?? process.env.KONTEKS_SITE_URL ?? "https://app.konteks.io").replace(/\/+$/, "");
  // Konteks does not connect the release this machine installed (WS1-077).
  // Asking the email again would only meet the same refusal, so the flow stops
  // with Konteks's own words, which say what to do.
  if (wireCode(error) === "update_required") {
    await writeOnboardState(context.root, {
      ...(state ?? { schemaVersion: 1 as const, updatedAt: new Date().toISOString() }),
      step: "identity",
      intentRef: undefined,
    } as never).catch(() => undefined);
    return { step, done: { summary: said, links: { site: siteUrl } } };
  }
  // Revoked is final for that runtime, not for the machine: offer to connect
  // it again rather than end on a refusal the next paste would only repeat.
  if (error instanceof RemoteInstanceError && error.code === "permission_denied" && message === OWNER_ACCESS_REVOKED) {
    await writeOnboardState(context.root, {
      ...(state ?? { schemaVersion: 1 as const, updatedAt: new Date().toISOString() }),
      step: "reconnect",
    } as never).catch(() => undefined);
    return { step: "identity", note: OWNER_ACCESS_REVOKED, ask: RECONNECT_ASK };
  }
  if (error instanceof RemoteInstanceError && error.code === "permission_denied") {
    return { step, done: { summary: `Konteks stopped this setup: ${said} Sign in on the site to see this machine and your workspace.`, links: { site: siteUrl } } };
  }
  // A workspace takes about a minute to make, and a call that arrives while it
  // is still being made comes back as a bare server error. Saying "the request
  // could not be completed" about a step that will simply work shortly sends
  // the person looking for a fault that is not there — say what is happening
  // and carry on with the answer they already gave.
  // Only a nameless answer is read this way — Core's own unnamed envelope, or
  // a bare gateway status while Core is restarting (pass 19 met "HTTP 502"
  // here, and Core was back within a minute). A refusal that says what it is
  // keeps its own words.
  const stillBeingMade =
    (step === "code" || step === "start" || step === "workspace") &&
    (/the request could not be completed/i.test(message) || /^HTTP 50[234]$/.test(message));
  if (stillBeingMade) {
    return {
      step,
      note: "Konteks is still setting up your workspace. That takes about a minute; nothing you answered was lost and it will be used as soon as it is ready.",
      run: AGAIN,
    };
  }
  const note = /nothing you answered was lost/i.test(said)
    ? `Konteks could not finish that step: ${said}`
    : `Konteks could not finish that step: ${said} Nothing you answered was lost.`;
  if (step === "email" || step === "code" || step === "workspace" || step === "first_task") {
    const { answer: _answer, ...unanswered } = context;
    const again = await runOnboardStep(unanswered).catch(() => null);
    if (again?.ask) return { step, note: `${note} Answer again when you are ready.`, ask: again.ask };
  }
  return { step, note, ask: { question: "Try that step again now?", kind: "confirm" } };
}

async function registerGitKey(root: string): Promise<{ identityFile?: string; user?: string }> {
  const record = await readNativeRecord(root).catch(() => null);
  if (!record) throw new RemoteInstanceError("temporarily_unavailable", "The Konteks service on this machine is not installed yet");
  const control = new SupervisorControl({ supervisorData: join(root, "supervisor") }, record.controlPort);
  const answer = await control.call(
    { op: "git.key.add" },
    z.object({ identityFile: z.string().optional(), user: z.string().optional() }).passthrough(),
    { timeoutMs: 30_000 },
  );
  return {
    ...(answer.identityFile ? { identityFile: answer.identityFile } : {}),
    ...(answer.user ? { user: answer.user } : {}),
  };
}

function hostLabel(): string {
  return `${homedir().split("/").pop() ?? "user"}@${nativePlatform().os}`;
}

/** The identity on disk when its key is gone; null for a machine that can still prove itself. */
async function lostMachineKey(supervisorData: string): Promise<{ instanceId: string } | null> {
  const store = new SupervisorStore(supervisorData);
  const identity = await store.identity().catch(() => null);
  if (!identity?.instanceId || identity.instanceId === "pending") return null;
  const key = await store.loadInstanceKey().catch(() => null);
  return key ? null : { instanceId: identity.instanceId };
}

/**
 * Keep a lost identity's state beside the install, never delete it: it is
 * the record of what that runtime was, and it holds nothing that could act
 * for it any more. The machine then enrolls from an empty supervisor.
 */
async function setAsideLostIdentity(root: string, instanceId: string): Promise<void> {
  const aside = join(root, "retired", `${instanceId}-${Date.now()}`);
  await mkdir(aside, { recursive: true, mode: 0o700 });
  await rename(join(root, "supervisor"), join(aside, "supervisor"));
  await rename(join(root, "native-runtime.json"), join(aside, "native-runtime.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await mkdir(join(root, "supervisor"), { mode: 0o700 });
}

/** The person's token, refreshed rather than kept long (OS15). */
async function ownerApi(
  supervisorData: string,
  coreUrl: string,
  enrollment: NonNullable<OnboardContext["deps"]>["enrollment"] & object,
  context: OnboardContext,
): Promise<OwnerApiClient> {
  const stored = await readOwnerToken(supervisorData);
  if (!stored) {
    throw new RemoteInstanceError("permission_denied", "This machine holds no Konteks access for you; run onboard from the start.");
  }
  let token = stored.token;
  if (Date.parse(stored.expiresAt) - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
    let refreshed;
    try {
      refreshed = await enrollment.refreshOwnerToken(stored.instanceId);
    } catch (error) {
      if (wireCode(error) === "enrollment_invalid") {
        // Revoked in Settings, or the lease lapsed: the token is gone for good.
        await deleteOwnerToken(supervisorData);
        throw new RemoteInstanceError("permission_denied", OWNER_ACCESS_REVOKED);
      }
      throw error;
    }
    await writeOwnerToken(supervisorData, { ...refreshed, instanceId: stored.instanceId });
    token = refreshed.token;
  }
  return new OwnerApiClient({ coreUrl, token, ...(context.deps?.fetchFn ? { fetchFn: context.deps.fetchFn } : {}) });
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
