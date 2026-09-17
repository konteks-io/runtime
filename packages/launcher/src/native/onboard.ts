import { readFile } from "node:fs/promises";
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
import { initializeRepository, inspectRepository, pushToManagedRemote } from "./repository-inspect.js";
import { readOnboardState, writeOnboardState, type OnboardState } from "./onboard-state.js";
import { deleteOwnerToken, OwnerApiClient, readOwnerToken, writeOwnerToken } from "./owner-api.js";

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
    enrollment?: Pick<NativeEnrollment, "openIntent" | "sendChallenge" | "verifyCode" | "bind" | "refreshOwnerToken">;
    complete?: typeof completeNativeEnrollment;
    families?: () => Promise<string[]>;
    /** Wait for the started service to become active; resolves to the roles it advertises, or null. */
    waitForReady?: (root: string) => Promise<{ administrativeStatus: string; roles: string[] } | null>;
  };
}

const AFFIRMATIVE = new Set(["y", "yes", "yeah", "yep", "ok", "okay", "sure", "do it", "please"]);
const NEGATIVE = new Set(["n", "no", "nope", "not now", "skip", "later"]);
const AGAIN = { argv: ["konteks-remote", "onboard", "--json"] };
/** How long `inspect` waits for the freshly started service before moving on without it. */
const READY_WAIT_MS = 45_000;
/** The owner token is refreshed this long before it expires (OS15). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** The wire code Core answered with, for refusals the shared code list does not name. */
function wireCode(error: unknown): string {
  if (error instanceof CoreResponseError) return error.wireCode;
  return error instanceof RemoteInstanceError ? error.code : "";
}

function isYes(answer: string): boolean {
  return AFFIRMATIVE.has(answer.trim().toLowerCase());
}
function isNo(answer: string): boolean {
  return NEGATIVE.has(answer.trim().toLowerCase());
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

  switch (state.step) {
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
      await save({ step: "email" });
      return { step: "identity", note: "This machine is not connected to Konteks yet.", run: AGAIN };
    }

    case "email": {
      if (context.answer === undefined || !context.answer.trim()) {
        return { step: "email", ask: { question: "What email address should this machine belong to?", kind: "email" } };
      }
      const email = context.answer.trim();
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
      await save({ step: "code", intentRef, email, emailMasked: sent.sentToMasked, attemptsRemaining: sent.attemptsRemaining });
      return { step: "email", note: `A six-digit code is on its way to ${sent.sentToMasked}.`, run: AGAIN };
    }

    case "code": {
      if (context.answer === undefined || !context.answer.trim()) {
        return {
          step: "code",
          ask: { question: `Paste the six-digit code sent to ${state.emailMasked ?? "your email"}.`, kind: "code" },
        };
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
            note: `That code was not accepted${left > 0 ? `; ${left} attempt${left === 1 ? "" : "s"} left` : ""}.`,
            ask: { question: `Paste the six-digit code sent to ${state.emailMasked ?? "your email"}.`, kind: "code" },
          };
        }
        if (["enrollment_invalid", "challenge_expired"].includes(wireCode(error))) {
          // Attempts spent or the intent expired: start the enrollment again
          // with the same key. It costs the person one more email (OS9).
          await save({ step: "email", intentRef: undefined, emailMasked: undefined, attemptsRemaining: undefined } as never);
          return { step: "code", note: "That code can no longer be used; a new one will be sent.", run: AGAIN };
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
            expectedManifestDigest: prepared.manifestDigest,
          });
        } catch (error) {
          if (["limit_exceeded", "limit_reached"].includes(wireCode(error))) {
            // R18: the plan allows one connected runtime. Say so, say how to
            // move it, and stop here rather than retrying on every run.
            await save({ step: "done" });
            return {
              step: "start",
              done: {
                summary:
                  wireCode(error) === "limit_exceeded"
                    ? "This workspace's plan allows one connected runtime, and it already has one. Revoke the existing runtime in Settings → Connected runtimes, then run onboard again on this machine."
                    : "No new workspace can be created right now. Sign in on the site or try again later.",
                links: { site: `${siteUrl}/settings/runtimes` },
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
        note:
          state.decision === "create"
            ? `Your workspace is ready: ${identity.workspaceId}. You can rename it in Settings. This machine is now its runtime; starting it next.`
            : `This machine is now ${identity.workspaceId}'s runtime; starting it next.`,
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
      const notReady = ready && ready.administrativeStatus !== "active" ? "The runtime service is still coming up; it will finish in the background. " : "";
      const facts = await (context.deps?.inspect ?? inspectRepository)(context.cwd ?? process.cwd());
      if (!facts.path) {
        const directory = resolve(context.cwd ?? process.cwd());
        if (directory === resolve(homedir()) || directory === resolve("/")) {
          // A home or root directory is not a project; making it a repository
          // would sweep in everything the person owns.
          await save({ step: "first_task", ...(ready ? { advertisedRoles: ready.roles } : {}) });
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
          ...(ready ? { advertisedRoles: ready.roles } : {}),
        });
        return {
          step: "inspect",
          note: `${notReady}You are in ${basename(directory)}, a folder that is not a git repository yet. Konteks can make it one and keep it on Konteks managed git.`,
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
        ...(ready ? { advertisedRoles: ready.roles } : {}),
      });
      return {
        step: "inspect",
        note: `${notReady}${kind === "existing" ? `You are in ${facts.name}, with remote ${facts.remoteUrl}.` : `You are in ${facts.name}, which has no remote this machine can push to.`}`,
        run: AGAIN,
      };
    }

    case "system": {
      const question =
        state.repositoryKind === "existing"
          ? `Make ${state.repositoryName} your first System in Konteks?`
          : state.repositoryNeedsInit
            ? `Make ${state.repositoryName} your first System, kept on Konteks managed git? Nothing is pushed until you say so.`
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
      const registered = await api.registerFirstSystem({
        name: state.repositoryName!,
        hostLabel: hostLabel(),
        repository: {
          kind: state.repositoryKind!,
          ...(state.remoteUrl && state.repositoryKind === "existing" ? { remoteUrl: state.remoteUrl } : {}),
          defaultBranch: state.defaultBranch!,
        },
      });
      await save({
        step: state.repositoryKind === "managed" ? "push" : "first_task",
        systemId: registered.systemId,
        systemEntityRef: registered.systemEntityRef,
        ...(registered.repository.remoteUrl ? { managedRemoteUrl: registered.repository.remoteUrl } : {}),
      });
      return {
        step: "system",
        note:
          state.repositoryKind === "managed"
            ? `${state.repositoryName} is now a System in Konteks, with a managed git repository ready for it.`
            : `${state.repositoryName} is now a System in Konteks.`,
        run: AGAIN,
      };
    }

    case "push": {
      const question = state.repositoryNeedsInit
        ? `Push ${state.repositoryName} to Konteks managed git now? The folder becomes a git repository on ${state.defaultBranch} with one empty first commit; no files are added or changed.`
        : `Push ${state.defaultBranch} to the Konteks repository now?`;
      if (context.answer === undefined) {
        return { step: "push", ask: { question, kind: "confirm" } };
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
      // The managed-git key is registered before the push, since managed git
      // accepts only a key this runtime registered (OS11). `git key add` is
      // idempotent for a key that already exists.
      const record = await readNativeRecord(context.root).catch(() => null);
      if (record) {
        const control = new SupervisorControl({ supervisorData }, record.controlPort);
        await control.call({ op: "git.key.add" }, z.unknown(), { timeoutMs: 30_000 }).catch(() => undefined);
      }
      if (state.repositoryNeedsInit) {
        const initialized = await (context.deps?.initialize ?? initializeRepository)({
          path: state.repositoryPath!,
          branch: state.defaultBranch!,
          authorName: (state.ownerEmail ?? "Konteks").split("@")[0]!,
          authorEmail: state.ownerEmail ?? "onboarding@konteks.invalid",
        });
        if (!initialized.ok) {
          await save({ step: "push" });
          return { step: "pushing", note: `${initialized.message} Nothing was pushed.`, ask: { question: "Try the push again?", kind: "confirm" } };
        }
      }
      const result = await (context.deps?.push ?? pushToManagedRemote)({
        repositoryPath: state.repositoryPath!,
        remoteUrl: state.managedRemoteUrl!,
        branch: state.defaultBranch!,
      });
      if (!result.pushed) {
        await save({ step: "push" });
        return { step: "pushing", note: `${result.message} Your folder is unchanged apart from git's own files.`, ask: { question: "Try the push again?", kind: "confirm" } };
      }
      await save({ step: "first_task" });
      return {
        step: "pushing",
        note: `${result.message} Your code now lives on Konteks managed git, on the ${state.repositoryName} System: ${siteUrl}/systems/${state.systemId}. This folder's ${state.defaultBranch} branch tracks it (remote "konteks").`,
        run: AGAIN,
      };
    }

    case "first_task": {
      if (context.answer === undefined) {
        return {
          step: "first_task",
          ask: { question: "What do you want to build first? (this first turn uses your starter grant)", kind: "text" },
        };
      }
      const wanted = context.answer.trim();
      if (!wanted) {
        await save({ step: "done" });
        return { step: "first_task", note: "Ending here.", run: AGAIN };
      }
      if (!state.systemId) {
        await save({ step: "done" });
        return {
          step: "first_task",
          note: "An initiative needs a System, and none was made here. Start it from the site with New initiative once you have a System.",
          run: AGAIN,
        };
      }
      const title = initiativeTitle(wanted);
      await save({ step: "initiative", firstTask: wanted, initiativeTitle: title });
      return {
        step: "first_task",
        note: `Setting up your first initiative, "${title}", on ${state.repositoryName ?? "your System"}. Konteks is opening its planning session on this machine; this takes a few seconds.`,
        run: AGAIN,
      };
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
      await save({ step: "done", initiativeUrl: url, firstTask: undefined } as never);
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
      const present = await families();
      const remedies: string[] = [];
      for (const family of ["claude-code", "codex"]) {
        if (!present.includes(family)) remedies.push(`To also run ${family} work here: konteks-remote auth login ${family}`);
      }
      if (nativePlatform().os === "debian") {
        remedies.push("To keep the runtime available after logout: loginctl enable-linger $USER");
      }
      const advertised = state.advertisedRoles;
      const agentsLine =
        present.length === 0
          ? "No coding agent was found on this machine; install Claude Code or Codex and run konteks-remote auth login."
          : advertised && advertised.length === 0
            ? `Your ${present.join(" and ")} login is set up; the runtime will advertise it once its first heartbeat lands.`
            : `Your ${present.join(" and ")} login will run Konteks work here.`;
      return {
        step: "done",
        done: {
          summary: [
            `This machine is connected to your workspace ${state.tenantId ?? ""}`.trim() + " (you can rename it in Settings).",
            state.systemEntityRef
              ? `${state.repositoryName} is your first System${state.repositoryKind === "managed" ? ", kept on Konteks managed git" : ""}.`
              : null,
            state.initiativeId
              ? `Your first initiative is "${state.initiativeTitle}"${state.setupFailure ? "; its planning session still needs Retry setup on the initiative page" : ", and its planning session is working on it here"}.`
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
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * The step to show when a step could not finish (WS1-003).
 *
 * The block teaches the agent three shapes and nothing else, so a failure is
 * said inside the protocol: what did not work, in plain words, and the same
 * question again, or an offer to try the step again. Revoked access is final
 * and ends the flow with where to go instead.
 */
export async function onboardFailureStep(context: OnboardContext, error: unknown): Promise<OnboardStep> {
  const state = await readOnboardState(context.root).catch(() => null);
  const step = state?.step ?? "identity";
  const message = error instanceof Error ? error.message.trim() : "";
  const said = message ? (/[.!?]$/.test(message) ? message : `${message}.`) : "Something unexpected went wrong.";
  const siteUrl = (context.siteUrl ?? process.env.KONTEKS_SITE_URL ?? "https://app.konteks.io").replace(/\/+$/, "");
  if (error instanceof RemoteInstanceError && error.code === "permission_denied") {
    return { step, done: { summary: `Konteks stopped this setup: ${said} Sign in on the site to see this machine and your workspace.`, links: { site: siteUrl } } };
  }
  const note = `Konteks could not finish that step: ${said} Nothing you answered was lost.`;
  if (step === "email" || step === "code" || step === "workspace" || step === "first_task") {
    const { answer: _answer, ...unanswered } = context;
    const again = await runOnboardStep(unanswered).catch(() => null);
    if (again?.ask) return { step, note: `${note} Answer again when you are ready.`, ask: again.ask };
  }
  return { step, note, ask: { question: "Try that step again now?", kind: "confirm" } };
}

function hostLabel(): string {
  return `${homedir().split("/").pop() ?? "user"}@${nativePlatform().os}`;
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
        throw new RemoteInstanceError("permission_denied", "This machine's Konteks access for you was revoked; sign in on the site or enroll again.");
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
