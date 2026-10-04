import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, NATIVE_MANIFEST_URL, verifyNativeRelease } from "@konteks/remote-release";
import { ownedByAnotherConnector, SupervisorStore } from "@konteks/remote-supervisor";
import { agentName } from "./agent-name.js";
import { completeNativeEnrollment, readNativeEnrollment } from "./install.js";
import { nativePlatform } from "./service.js";
import { enrollmentStagingStatus, releaseStaged, spawnEnrollmentStaging, type StagingStatus } from "./enrollment-staging.js";
import { writeOnboardState, type OnboardState } from "./onboard-state.js";
import { OWNER_ACCESS_REVOKED, readOwnerToken, writeOwnerToken } from "./owner-api.js";
import { ASKS_NEW_CODE, ASKS_OTHER_EMAIL, isNo, isYes } from "./onboard-answers.js";
import {
  AGAIN, claimSiteAccess, connectedInstanceId, EMAIL_ASK, forgetRuntime, keptAnswers, pause, RECONNECT_ASK, setAsideLostIdentity, wireCode, workspaceName,
  type OnboardDeps, type OnboardEnrollment, type OnboardSession, type OnboardStep,
} from "./onboard-session.js";

/**
 * The steps that connect this machine: who it belongs to (email and code),
 * which workspace it joins, and the bind that makes it that workspace's
 * runtime.
 */

/** How long one `start` invocation waits on the unpacking before saying how far it got. */
const STAGING_WAIT_MS = 25_000;
const WORKSPACE_QUESTION = "Which workspace should this machine join?";

type Verified = Awaited<ReturnType<OnboardEnrollment["verifyCode"]>>;
type Identity = { instanceId: string; workspaceId: string };
type Staging = NonNullable<OnboardDeps["staging"]>;

/**
 * Revoking the access leaves the runtime connected and holding the plan's
 * runtime: proving the address again gives this same runtime the access
 * back. Enrolling a second one was refused by the plan in the name of this
 * very machine. Only when Konteks says the runtime is gone too does the email
 * step connect it as a new one.
 */
export async function reconnectStep(s: OnboardSession): Promise<OnboardStep> {
  const { answer } = s;
  if (answer === undefined || (!isYes(answer) && !isNo(answer))) {
    return { step: "identity", note: OWNER_ACCESS_REVOKED, ask: RECONNECT_ASK };
  }
  if (isNo(answer)) {
    await s.save({ step: "done", closing: true });
    return { step: "identity", done: { summary: "This machine stays disconnected from Konteks.", links: { site: s.siteUrl } } };
  }
  return reconnectAgain(s);
}

async function reconnectAgain(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  const current = await new SupervisorStore(s.supervisorData).identity().catch(() => null);
  const address = state.ownerEmail ?? state.email;
  const same = connectedInstanceId(current);
  // The same runtime keeps what it knew (its System, initiative, answers)
  // and carries on where the revoke stopped it; only the code is new.
  const { intentRef: _intent, emailMasked: _masked, attemptsRemaining: _attempts, decision: _decision, email: _email, retryAsked: _retry, closing: _closing, ...known } = state;
  await writeOnboardState(s.context.root, {
    ...(same ? known : { schemaVersion: 1, ...keptAnswers(state) }),
    step: "email",
    updatedAt: new Date().toISOString(),
    ...(address ? { resendTo: address } : {}),
    ...(same ? { restores: same } : {}),
  } as never);
  return address ? { step: "identity", run: AGAIN } : { step: "identity", ask: EMAIL_ASK };
}

/** A machine that already has an identity is not enrolling again; it is being asked what it is. */
export async function identityStep(s: OnboardSession): Promise<OnboardStep> {
  const identity = await new SupervisorStore(s.supervisorData).identity().catch(() => null);
  const instanceId = connectedInstanceId(identity);
  if (instanceId) return alreadyConnected(s, instanceId, identity?.workspaceId);
  // Not connected yet: the first response is the first question, not a
  // bare "run again" the agent has to explain.
  await s.save({ step: "email" });
  return { step: "identity", ask: EMAIL_ASK };
}

async function alreadyConnected(s: OnboardSession, instanceId: string, workspaceId: string | null | undefined): Promise<OnboardStep> {
  const stored = (await readOwnerToken(s.supervisorData)) ?? (await claimSiteAccess(s.supervisorData, s.enrollment));
  const tenant = workspaceId ? { tenantId: workspaceId } : {};
  if (!stored) {
    // Connected from the site by someone else, or for the whole
    // organization: this machine acts for no one person here, so it
    // offers nothing it could not do. The site is where Systems go.
    await s.save({ step: "done", closing: true, instanceId, ...tenant });
    return {
      step: "identity",
      done: {
        summary: `This computer is connected to ${workspaceId ?? "a workspace"} from the site, not for one person, so it cannot add this folder itself. Add Systems on the site.`,
        links: { site: s.siteUrl },
      },
    };
  }
  await s.save({ step: "inspect", instanceId, ...tenant });
  return { step: "identity", note: `This machine is already connected to ${workspaceId ?? "a workspace"}.`, run: AGAIN };
}

/** After a lost bind the address is already known; asking for it again would make the person repeat themselves for our failure. */
export async function emailStep(s: OnboardSession): Promise<OnboardStep> {
  const email = s.answer?.trim() || s.state.resendTo;
  if (!email) return { step: "email", ask: EMAIL_ASK };
  const intentRef = s.state.intentRef || await openIntent(s);
  const sent = await s.enrollment.sendChallenge(intentRef, email);
  await s.save({ step: "code", intentRef, email, emailMasked: sent.sentToMasked, attemptsRemaining: sent.attemptsRemaining, resendTo: undefined, resendReason: undefined } as never);
  const reason = s.state.resendReason;
  return {
    step: "email",
    note: `${reason ? `${reason} ` : ""}A ${reason ? "new " : ""}six-digit code is on its way. If it does not arrive in a minute or two, say "send a new code", or "use a different email".`,
    run: AGAIN,
  };
}

async function openIntent(s: OnboardSession): Promise<string> {
  const platform = nativePlatform();
  const release = await enrollmentRelease(s);
  const open = () =>
    s.enrollment.openIntent({
      platform,
      // `assistant` is what a project-management turn places as, and
      // `onboard` is what the catalog work needs. Which agent families exist
      // here is recorded locally, not requested as a role.
      requestedRoles: ["assistant", "onboard", "planner", "generator", "qa"],
      bundleVersion: release.manifest.bundleVersion,
      manifestDigest: release.manifest.digest,
    });
  let opened = await open();
  if (s.state.restores && opened.restoresInstanceId !== s.state.restores) {
    // The runtime itself was revoked or removed as well: it can never
    // act again. Keep its record beside the install and connect this
    // machine as a new runtime, with a new key.
    await setAsideLostIdentity(s.context.root, s.state.restores);
    forgetRuntime(s.state);
    await s.save({});
    opened = await open();
  }
  return opened.intentRef;
}

async function enrollmentRelease(s: OnboardSession): Promise<{ manifest: { bundleVersion: string; digest: string } }> {
  const prepared = await readNativeEnrollment(s.context.root).catch(() => null);
  if (prepared) return { manifest: { bundleVersion: prepared.bundleVersion, digest: prepared.manifestDigest } };
  return verifyNativeRelease(
    await fetchNativeReleaseManifest(s.deps.fetchFn ?? fetch, process.env.KONTEKS_RELEASE_MANIFEST_URL ?? NATIVE_MANIFEST_URL),
    EMBEDDED_RELEASE_ROOTS,
    s.clock.now(),
  );
}

export async function codeStep(s: OnboardSession): Promise<OnboardStep> {
  const ask = { question: `Paste the six-digit code sent to ${s.state.emailMasked ?? "your email"}.`, kind: "code" as const };
  const answer = s.answer;
  if (answer === undefined || !answer.trim()) return { step: "code", ask };
  // A mistyped address: go back and ask for it.
  if (ASKS_OTHER_EMAIL.test(answer)) return otherEmail(s);
  // No mail, or a code lost: the person asks for another one.
  if (ASKS_NEW_CODE.test(answer)) return newCode(s, ask);
  const checked = await verifyOrRecover(s, answer.trim(), ask);
  return "reply" in checked ? checked.reply : codeVerified(s, checked.verified);
}

async function otherEmail(s: OnboardSession): Promise<OnboardStep> {
  await s.save({ step: "email", intentRef: undefined, email: undefined, emailMasked: undefined, attemptsRemaining: undefined, resendTo: undefined, resendReason: undefined } as never);
  return { step: "code", note: "The code sent before will not be used.", ask: EMAIL_ASK };
}

async function newCode(s: OnboardSession, ask: NonNullable<OnboardStep["ask"]>): Promise<OnboardStep> {
  try {
    const sent = await s.enrollment.sendChallenge(s.state.intentRef!, s.state.email!);
    await s.save({ emailMasked: sent.sentToMasked, attemptsRemaining: sent.attemptsRemaining });
    return { step: "code", note: `A new code is on its way to ${sent.sentToMasked}; the one before it no longer works.`, ask };
  } catch (error) {
    if (wireCode(error) === "challenge_active") {
      return { step: "code", note: `The last code was sent less than a minute ago and is probably still on its way. If it has not arrived in a minute, say "send a new code" again.`, ask };
    }
    if (wireCode(error) === "rate_limited") {
      return { step: "code", note: "Too many codes were sent to this address in the last hour, so no new one can be sent yet. The last code still works until it expires.", ask };
    }
    throw error;
  }
}

async function verifyOrRecover(s: OnboardSession, code: string, ask: NonNullable<OnboardStep["ask"]>): Promise<{ verified: Verified } | { reply: OnboardStep }> {
  try {
    return { verified: await s.enrollment.verifyCode(s.state.intentRef!, code) };
  } catch (error) {
    if (wireCode(error) === "code_invalid") return { reply: await wrongCode(s, ask) };
    if (["enrollment_invalid", "challenge_expired"].includes(wireCode(error))) return { reply: await codeSpent(s, error) };
    throw error;
  }
}

async function wrongCode(s: OnboardSession, ask: NonNullable<OnboardStep["ask"]>): Promise<OnboardStep> {
  const left = Math.max((s.state.attemptsRemaining ?? 1) - 1, 0);
  await s.save({ attemptsRemaining: left });
  return {
    step: "code",
    note: `That code was not accepted${left > 0 ? `; ${left} attempt${left === 1 ? "" : "s"} left` : ""}. If the email did not arrive or the code is lost, say "send a new code".`,
    ask,
  };
}

/**
 * Attempts spent or the intent expired: start the enrollment again with the
 * same key, which costs the person one more email. The address is kept: the
 * note promises a new code, and the email step sends one to it rather than
 * asking for the address again. The reason is said before the new code goes
 * out, and the email step the chain ends on says it again.
 */
async function codeSpent(s: OnboardSession, error: unknown): Promise<OnboardStep> {
  const resendReason =
    wireCode(error) === "challenge_expired"
      ? "That code has expired; codes last ten minutes."
      : "That code was not accepted either, and after five wrong codes a code stops working, to keep your account safe.";
  await s.save({ step: "email", intentRef: undefined, emailMasked: undefined, attemptsRemaining: undefined, resendReason, ...(s.state.email ? { resendTo: s.state.email } : {}) } as never);
  return { step: "code", note: `${resendReason} A new one will be sent.`, run: AGAIN, passing: true };
}

async function codeVerified(s: OnboardSession, verified: Verified): Promise<OnboardStep> {
  if (s.state.restores) {
    // The runtime already belongs to its workspace; there is nothing to choose.
    await s.save({ step: "start", decision: verified.decision });
    return { step: "code", note: "Your address is confirmed; giving this machine your access back.", run: AGAIN };
  }
  if (verified.decision === "choose") {
    await s.save({ step: "workspace", decision: verified.decision, ...offeredWorkspaces(verified) });
    return { step: "code", note: "That address belongs to more than one workspace.", run: AGAIN };
  }
  await s.save({
    step: "start",
    decision: verified.decision,
    ...offeredWorkspaces(verified),
    ...(verified.proposedTenantId ? { proposedTenantId: verified.proposedTenantId } : {}),
  });
  return { step: "code", note: confirmedNote(verified), run: AGAIN };
}

function offeredWorkspaces(verified: Verified): { workspaces?: NonNullable<Verified["workspaces"]> } {
  return verified.workspaces ? { workspaces: verified.workspaces } : {};
}

function confirmedNote(verified: Verified): string {
  // The id is only settled when the workspace is made (a taken one gets a
  // suffix), so none is promised here; the next step names it.
  if (verified.decision === "create") return "Your address is confirmed. Konteks is creating your workspace and connecting this machine to it; this can take up to a minute.";
  return `This machine will join ${verified.workspaces?.[0]?.displayName ?? "your workspace"}.`;
}

function workspaceChoices(state: OnboardState): string[] {
  return (state.workspaces ?? []).map(entry => entry.displayName);
}

export async function workspaceStep(s: OnboardSession): Promise<OnboardStep> {
  const choices = workspaceChoices(s.state);
  if (s.answer === undefined) {
    return { step: "workspace", ask: { question: WORKSPACE_QUESTION, kind: "choice", choices } };
  }
  const chosen = chosenWorkspace(s.state.workspaces ?? [], s.answer.trim().toLowerCase());
  if (!chosen) {
    return {
      step: "workspace",
      note: "That is not one of the workspaces on offer.",
      ask: { question: WORKSPACE_QUESTION, kind: "choice", choices },
    };
  }
  await s.save({ step: "start", tenantId: chosen.tenantId });
  return { step: "workspace", note: `Joining ${chosen.displayName}.`, run: AGAIN };
}

/**
 * A person answers in a sentence ("konteks-2 again please"): take the one
 * offered name it mentions, and ask again only when it names none or two.
 */
function chosenWorkspace<T extends { tenantId: string; displayName: string }>(offered: readonly T[], wanted: string): T | undefined {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = (name: string) => new RegExp(`(^|[^\\p{L}\\p{N}-])${escape(name.toLowerCase())}($|[^\\p{L}\\p{N}-])`, "u").test(wanted);
  const named = offered.filter(entry => mentions(entry.displayName) || mentions(entry.tenantId));
  return offered.find(entry => entry.displayName.toLowerCase() === wanted || entry.tenantId.toLowerCase() === wanted) ??
    (named.length === 1 ? named[0] : undefined);
}

/** How long each part of the start step took, for the timing log. */
class PhaseTiming {
  readonly phases: Record<string, number> = {};
  private mark = Date.now();

  phase(name: string): void {
    const now = Date.now();
    this.phases[name] = now - this.mark;
    this.mark = now;
  }
}

export async function startStep(s: OnboardSession): Promise<OnboardStep> {
  const timing = new PhaseTiming();
  // A bind that answered but whose record never got written is resumed
  // from the identity on disk rather than asked of Core again.
  const existing = await new SupervisorStore(s.supervisorData).identity().catch(() => null);
  if (s.state.restores && existing?.instanceId === s.state.restores && existing.workspaceId) return restoreAccess(s);
  const bound = await boundIdentity(s, existing);
  if ("reply" in bound) return bound.reply;
  timing.phase("bind");
  return afterBind(s, bound.identity, timing);
}

async function restoreAccess(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  let restored;
  try {
    restored = await s.enrollment.restoreAccess(state.intentRef!, { email: state.email! });
  } catch (error) {
    if (wireCode(error) !== "enrollment_invalid") throw error;
    return restoreRevoked(s);
  }
  await writeOwnerToken(s.supervisorData, { ...restored.ownerToken, instanceId: restored.identity.instanceId });
  // Back to the step the revoke interrupted; a finished machine looks at
  // this folder again, as a new conversation there would.
  const resume = resumedStep(state);
  await s.save({
    step: resume,
    ...(resume === "inspect" && state.systemEntityRef ? { revisit: true } : {}),
    instanceId: restored.identity.instanceId,
    tenantId: restored.identity.workspaceId,
    restores: undefined,
    resumeStep: undefined,
    email: undefined,
    ...(state.email ? { ownerEmail: state.email } : {}),
  } as never);
  return {
    step: "start",
    note: `Your access is back: this machine works for you in ${workspaceName(state, restored.identity.workspaceId)} again, as the same runtime.`,
    run: AGAIN,
  };
}

function resumedStep(state: OnboardState): OnboardState["step"] {
  return !state.resumeStep || state.resumeStep === "done" || state.resumeStep === "reconnect" ? "inspect" : state.resumeStep;
}

/** The runtime was revoked while the code was on its way: connect this machine as a new one, which costs one more code. */
async function restoreRevoked(s: OnboardSession): Promise<OnboardStep> {
  await setAsideLostIdentity(s.context.root, s.state.restores!);
  const address = s.state.email;
  forgetRuntime(s.state);
  await s.save({ step: "email", ...(address ? { resendTo: address } : {}) } as never);
  return {
    step: "start",
    note: "This machine's runtime was revoked in Customize → Runtimes too, so it connects again as a new runtime. Konteks will send a new code.",
    run: AGAIN,
  };
}

async function boundIdentity(s: OnboardSession, existing: Awaited<ReturnType<SupervisorStore["identity"]>> | null): Promise<{ identity: Identity } | { reply: OnboardStep }> {
  if (existing && existing.instanceId !== "pending" && existing.workspaceId) {
    return { identity: { instanceId: existing.instanceId, workspaceId: existing.workspaceId } };
  }
  const { state } = s;
  const prepared = await readNativeEnrollment(s.context.root);
  let bound;
  try {
    bound = await s.enrollment.bind(state.intentRef!, {
      email: state.email!,
      ...(state.tenantId ? { tenantId: state.tenantId } : {}),
      ...(state.replaces ? { replacesInstanceId: state.replaces } : {}),
      expectedManifestDigest: prepared.manifestDigest,
    });
  } catch (error) {
    return { reply: await bindRefused(s, error) };
  }
  await writeOwnerToken(s.supervisorData, {
    token: bound.ownerToken.token,
    expiresAt: bound.ownerToken.expiresAt,
    userRef: bound.ownerToken.userRef,
    tenantId: bound.ownerToken.tenantId,
    instanceId: bound.identity.instanceId,
  });
  return { identity: bound.identity };
}

async function bindRefused(s: OnboardSession, error: unknown): Promise<OnboardStep> {
  if (wireCode(error) === "enrollment_invalid" && s.state.email) return bindAnswerLost(s);
  if (wireCode(error) === "limit_exceeded") return runtimeLimit(s, error);
  if (wireCode(error) === "limit_reached") {
    await s.save({ step: "done" });
    return {
      step: "start",
      done: {
        summary: "No new workspace can be created right now. Sign in on the site or try again later.",
        links: { site: s.siteUrl },
      },
    };
  }
  throw error;
}

/**
 * The bind finished on Konteks but its answer never arrived, so this intent
 * is spent. A new code for the same address joins the machine to the
 * workspace that bind made.
 */
async function bindAnswerLost(s: OnboardSession): Promise<OnboardStep> {
  await s.save({ step: "email", intentRef: undefined, emailMasked: undefined, decision: undefined, attemptsRemaining: undefined, resendTo: s.state.email } as never);
  return {
    step: "start",
    note: "This machine did not hear back from Konteks in time, though your workspace may already be set up. Konteks will send a new code to finish connecting this machine.",
    run: AGAIN,
  };
}

/**
 * The plan allows one connected runtime, and Konteks names the machine that
 * holds it, so the person knows which one to revoke. Onboarding stops here
 * but stays ready to try again: the next run sends a new code.
 */
async function runtimeLimit(s: OnboardSession, error: unknown): Promise<OnboardStep> {
  const { state } = s;
  const said = limitMessage(error);
  // With other workspaces on offer, the address this run proved is still
  // good for them: ask again instead of sending a new code. Core only rolled
  // the refused bind back.
  if (state.decision === "choose" && (state.workspaces?.length ?? 0) > 1) return chooseAnotherWorkspace(s, said);
  await s.save({ step: "email", intentRef: undefined, emailMasked: undefined, decision: undefined, attemptsRemaining: undefined, resendTo: state.email } as never);
  return {
    step: "start",
    done: {
      summary: `${said} To move Konteks to this laptop, revoke that runtime in Customize → Runtimes, then run onboard again here; a new code will be sent to ${state.emailMasked ?? "your address"}. To keep both, move the workspace to a plan with more runtimes in Settings → Plan.`,
      links: { site: `${s.siteUrl}/customize/connected-runtimes` },
    },
  };
}

function limitMessage(error: unknown): string {
  return error instanceof Error && /plan allows/i.test(error.message)
    ? error.message.trim().replace(/([^.!?])$/, "$1.")
    : "This workspace's plan allows one connected runtime, and it is in use.";
}

async function chooseAnotherWorkspace(s: OnboardSession, said: string): Promise<OnboardStep> {
  const { state } = s;
  await s.save({ step: "workspace", tenantId: undefined } as never);
  return {
    step: "workspace",
    note: `${workspaceName(state, state.tenantId ?? "")} has no room for this machine. ${said} To use it here, revoke that runtime in Customize → Runtimes (${s.siteUrl}/customize/connected-runtimes) or move the workspace to a plan with more runtimes in Settings → Plan. Or choose another workspace.`,
    ask: { question: WORKSPACE_QUESTION, kind: "choice", choices: workspaceChoices(state) },
  };
}

async function afterBind(s: OnboardSession, identity: Identity, timing: PhaseTiming): Promise<OnboardStep> {
  // A join was already said ("This machine will join X.", "Joining X.") and
  // "is now X's runtime" below says it once more; only a new workspace has
  // news here.
  const announce = s.state.workspaceAnnounced || s.state.decision !== "create"
    ? ""
    : `Your workspace is ready: ${identity.workspaceId}. You can rename it in Settings. `;
  // The agent packages unpack in the background from `install --enroll`.
  // Wait a while for them here, and if they are still going, say how far
  // they have got and come back, rather than sit silent.
  const staging = stagingOf(s);
  const unpacked = await waitForUnpacking(s, staging);
  timing.phase("unpacking");
  if (unpacked.state !== "done") return unpackingProgress(s, staging, unpacked, announce);
  if (!await completeOnceReleased(s, staging, identity, timing)) {
    await s.save({ step: "start", workspaceAnnounced: true });
    return { step: "start", note: `${announce}This machine is finishing unpacking its agent packages; this takes a few more seconds.`, run: AGAIN };
  }
  return machineConnected(s, identity, announce);
}

function stagingOf(s: OnboardSession): Staging {
  return s.deps.staging ?? {
    status: (root: string) =>
      enrollmentStagingStatus(root, async r => releaseStaged(r, (await readNativeEnrollment(r).catch(() => null))?.releaseId)),
    spawn: spawnEnrollmentStaging,
  };
}

async function waitForUnpacking(s: OnboardSession, staging: Staging): Promise<StagingStatus> {
  const deadline = Date.now() + (staging.waitMs ?? STAGING_WAIT_MS);
  let unpacked = await staging.status(s.context.root);
  while (unpacked.state === "running" && Date.now() < deadline) {
    await pause(Math.min(2_000, staging.waitMs ?? 2_000));
    unpacked = await staging.status(s.context.root);
  }
  return unpacked;
}

async function unpackingProgress(s: OnboardSession, staging: Staging, unpacked: Exclude<StagingStatus, { state: "done" }>, announce: string): Promise<OnboardStep> {
  const progress = unpacked.state === "running" ? unpackingNote(unpacked) : await restartUnpacking(s, staging, unpacked);
  await s.save({ step: "start", workspaceAnnounced: true });
  return { step: "start", note: `${announce}${progress}`, run: AGAIN };
}

function unpackingNote(unpacked: Extract<StagingStatus, { state: "running" }>): string {
  if (unpacked.total > 0) {
    return `This machine is still unpacking its agent packages: ${unpacked.agent ? `${agentName(unpacked.agent)}, ` : ""}${Math.min(unpacked.done + 1, unpacked.total)} of ${unpacked.total}. This usually finishes within two minutes of the install.`;
  }
  return "This machine is still unpacking its agent packages. This usually finishes within two minutes of the install.";
}

async function restartUnpacking(s: OnboardSession, staging: Staging, unpacked: Exclude<StagingStatus, { state: "done" | "running" }>): Promise<string> {
  await staging.spawn(s.context.root);
  return unpacked.state === "failed"
    ? `Unpacking the agent packages stopped (${unpacked.message.replace(/[.]$/, "")}), so it has been started again.`
    : "Unpacking the agent packages has started.";
}

/**
 * The unpacking process records the release, then still holds the
 * installer's lock for a moment while it finishes. Completing waits for it to
 * let go; false when it still has not.
 */
async function completeOnceReleased(s: OnboardSession, staging: Staging, identity: Identity, timing: PhaseTiming): Promise<boolean> {
  const complete = s.deps.complete ?? completeNativeEnrollment;
  const waitMs = staging.waitMs ?? STAGING_WAIT_MS;
  const lockDeadline = Date.now() + waitMs;
  for (;;) {
    try {
      await complete(s.context.root, identity);
      timing.phase("complete");
      await logStepTiming(s.context.root, "start", timing.phases);
      return true;
    } catch (error) {
      if (!ownedByAnotherConnector(error)) throw error;
      if (Date.now() >= lockDeadline) return false;
      await pause(Math.min(1_000, Math.max(10, waitMs / 10)));
    }
  }
}

async function machineConnected(s: OnboardSession, identity: Identity, announce: string): Promise<OnboardStep> {
  const { state } = s;
  await s.save({
    step: "inspect",
    instanceId: identity.instanceId,
    tenantId: identity.workspaceId,
    email: undefined,
    ...(state.email ? { ownerEmail: state.email } : {}),
  } as never);
  return {
    step: "start",
    note: `${announce}This machine is now ${state.decision === "create" ? "its" : `${workspaceName(state, identity.workspaceId)}'s`} runtime; starting it next, which takes about a minute.`,
    // Registering and starting the service is the launcher's own command,
    // so the agent runs it rather than this process forking a service.
    run: { argv: ["konteks-remote", "start"] },
  };
}

/** One line per slow step, in the connector's own log folder. */
async function logStepTiming(root: string, step: string, phases: Record<string, number>): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), step, ms: phases }) + "\n";
  await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await appendFile(join(root, "logs", "onboard-timing.log"), line, { mode: 0o600 }).catch(() => undefined);
}
