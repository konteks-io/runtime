import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EMBEDDED_RELEASE_ROOTS, fetchNativeReleaseManifest, NATIVE_MANIFEST_URL, verifyNativeRelease } from "@konteks/remote-release";
import { RemoteInstanceError, SystemClock } from "@konteks/remote-common";
import { NativeEnrollment, SupervisorStore } from "@konteks/remote-supervisor";
import type { Output } from "../output.js";
import { readNativeRecord } from "./install.js";
import { nativePlatform } from "./service.js";
import { inspectRepository, pushToManagedRemote } from "./repository-inspect.js";
import { readOnboardState, writeOnboardState, type OnboardState } from "./onboard-state.js";
import { OwnerApiClient, readOwnerToken, writeOwnerToken } from "./owner-api.js";

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
    links: { site: string; system?: string; session?: string };
    agents?: string[];
    remedies?: string[];
  };
}

export interface OnboardContext {
  root: string;
  output: Output;
  answer?: string;
  cwd?: string;
  coreUrl?: string;
  siteUrl?: string;
  deps?: {
    fetchFn?: typeof fetch;
    inspect?: typeof inspectRepository;
    push?: typeof pushToManagedRemote;
  };
}

const AFFIRMATIVE = new Set(["y", "yes", "yeah", "yep", "ok", "okay", "sure", "do it", "please"]);
const NEGATIVE = new Set(["n", "no", "nope", "not now", "skip", "later"]);

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

export async function runOnboardStep(context: OnboardContext): Promise<OnboardStep> {
  const supervisorData = join(context.root, "supervisor");
  const clock = new SystemClock();
  const coreUrl = context.coreUrl ?? process.env.KONTEKS_CORE_URL ?? "https://core.konteks.example";
  const siteUrl = context.siteUrl ?? process.env.KONTEKS_SITE_URL ?? "https://app.konteks.io";
  const enrollment = new NativeEnrollment({
    dataDir: supervisorData,
    coreUrl,
    clock,
    ...(context.deps?.fetchFn ? { fetchFn: context.deps.fetchFn } : {}),
  });
  const state = (await readOnboardState(context.root)) ?? {
    schemaVersion: 1 as const,
    step: "identity" as const,
    updatedAt: new Date().toISOString(),
  };
  const save = (next: Partial<OnboardState>) =>
    writeOnboardState(context.root, { ...state, ...next } as never);

  switch (state.step) {
    case "identity": {
      // A machine that already has an identity is not enrolling again; it is
      // being asked what it is (OS9).
      const identity = await new SupervisorStore(supervisorData).identity().catch(() => null);
      if (identity?.instanceId && identity.instanceId !== "pending") {
        const stored = await readOwnerToken(supervisorData);
        await save({
          step: "inspect",
          instanceId: identity.instanceId,
          ...(identity.workspaceId ? { tenantId: identity.workspaceId } : {}),
          ...(stored ? { email: state.email } : {}),
        });
        return {
          step: "identity",
          note: `This machine is already connected to ${identity.workspaceId ?? "a workspace"}.`,
          run: { argv: ["konteks-remote", "onboard", "--json"] },
        };
      }
      await save({ step: "email" });
      return {
        step: "identity",
        note: "This machine is not connected to Konteks yet.",
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "email": {
      if (!context.answer) {
        return {
          step: "email",
          ask: {
            question: "What email address should this machine belong to?",
            kind: "email",
          },
        };
      }
      const email = context.answer.trim();
      let intentRef = state.intentRef;
      if (!intentRef) {
        const platform = nativePlatform();
        const release = verifyNativeRelease(
          await fetchNativeReleaseManifest(
            context.deps?.fetchFn ?? fetch,
            process.env.KONTEKS_RELEASE_MANIFEST_URL ?? NATIVE_MANIFEST_URL,
          ),
          EMBEDDED_RELEASE_ROOTS,
          clock.now(),
        );
        const families = await detectAgentFamilies();
        if (families.length === 0) {
          throw new RemoteInstanceError(
            "prerequisite_missing",
            "Konteks runs the coding agent you already have. Install Claude Code or Codex for this user, then run onboard again.",
          );
        }
        const opened = await enrollment.openIntent({
          platform,
          // `assistant` is what a project-management turn places as, and
          // `onboard` is what the catalog work needs (OS14).
          requestedRoles: ["assistant", "onboard"],
          bundleVersion: release.manifest.bundleVersion,
          manifestDigest: release.manifest.digest,
        });
        intentRef = opened.intentRef;
      }
      const sent = await enrollment.sendChallenge(intentRef, email);
      await save({ step: "code", intentRef, email, emailMasked: sent.sentToMasked });
      return {
        step: "email",
        note: `A six-digit code is on its way to ${sent.sentToMasked}.`,
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "code": {
      if (!context.answer) {
        return {
          step: "code",
          ask: {
            question: `Paste the six-digit code sent to ${state.emailMasked ?? "your email"}.`,
            kind: "code",
          },
        };
      }
      const verified = await enrollment.verifyCode(state.intentRef!, context.answer.trim());
      if (verified.decision === "choose") {
        await save({
          step: "workspace",
          decision: verified.decision,
          ...(verified.workspaces ? { workspaces: verified.workspaces } : {}),
        });
        return {
          step: "code",
          note: "That address belongs to more than one workspace.",
          run: { argv: ["konteks-remote", "onboard", "--json"] },
        };
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
            ? `A workspace will be created: ${verified.proposedTenantId}. You can rename it later in Settings.`
            : `This machine will join ${verified.workspaces?.[0]?.displayName ?? "your workspace"}.`,
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "workspace": {
      const choices = (state.workspaces ?? []).map(entry => entry.displayName);
      if (!context.answer) {
        return {
          step: "workspace",
          ask: { question: "Which workspace should this machine join?", kind: "choice", choices },
        };
      }
      const wanted = context.answer.trim().toLowerCase();
      const chosen = (state.workspaces ?? []).find(
        entry =>
          entry.displayName.toLowerCase() === wanted || entry.tenantId.toLowerCase() === wanted,
      );
      if (!chosen) {
        return {
          step: "workspace",
          note: "That is not one of the workspaces on offer.",
          ask: { question: "Which workspace should this machine join?", kind: "choice", choices },
        };
      }
      await save({ step: "start", tenantId: chosen.tenantId });
      return {
        step: "workspace",
        note: `Joining ${chosen.displayName}.`,
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "start": {
      const bound = await enrollment.bind(state.intentRef!, {
        email: state.email!,
        ...(state.tenantId ? { tenantId: state.tenantId } : {}),
      });
      await writeOwnerToken(supervisorData, {
        token: bound.ownerToken.token,
        expiresAt: bound.ownerToken.expiresAt,
        userRef: bound.ownerToken.userRef,
        tenantId: bound.ownerToken.tenantId,
        instanceId: bound.identity.instanceId,
      });
      await save({
        step: "inspect",
        instanceId: bound.identity.instanceId,
        tenantId: bound.identity.workspaceId,
      });
      return {
        step: "start",
        note: `This machine is now ${bound.identity.workspaceId}'s runtime.`,
        // Installing and starting the service is the launcher's own command,
        // so the agent runs it rather than this process forking a service.
        run: { argv: ["konteks-remote", "start"] },
      };
    }

    case "inspect": {
      const facts = await (context.deps?.inspect ?? inspectRepository)(context.cwd ?? process.cwd());
      if (!facts.path) {
        await save({ step: "first_task" });
        return {
          step: "inspect",
          note: "This directory is not a git repository, so there is no first System to make here.",
          run: { argv: ["konteks-remote", "onboard", "--json"] },
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
      });
      return {
        step: "inspect",
        note:
          kind === "existing"
            ? `You are in ${facts.name}, with remote ${facts.remoteUrl}.`
            : `You are in ${facts.name}, which has no remote this machine can push to.`,
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "system": {
      if (!context.answer) {
        return {
          step: "system",
          ask: {
            question:
              state.repositoryKind === "existing"
                ? `Make ${state.repositoryName} your first System in Konteks?`
                : `Make ${state.repositoryName} your first System, on Konteks managed git?`,
            kind: "confirm",
          },
        };
      }
      if (isNo(context.answer)) {
        await save({ step: "first_task" });
        return {
          step: "system",
          note: "Leaving the catalog as it is.",
          run: { argv: ["konteks-remote", "onboard", "--json"] },
        };
      }
      if (!isYes(context.answer)) {
        return {
          step: "system",
          note: "A yes or no is what this step needs.",
          ask: { question: `Make ${state.repositoryName} your first System?`, kind: "confirm" },
        };
      }
      const api = await ownerApi(supervisorData, coreUrl, enrollment, context);
      const registered = await api.registerFirstSystem({
        name: state.repositoryName!,
        hostLabel: hostLabel(),
        repository: {
          kind: state.repositoryKind!,
          ...(state.remoteUrl && state.repositoryKind === "existing"
            ? { remoteUrl: state.remoteUrl }
            : {}),
          defaultBranch: state.defaultBranch!,
        },
      });
      await save({
        step: state.repositoryKind === "managed" ? "push" : "first_task",
        systemId: registered.systemId,
        systemEntityRef: registered.systemEntityRef,
        ...(registered.repository.remoteUrl
          ? { managedRemoteUrl: registered.repository.remoteUrl }
          : {}),
      });
      return {
        step: "system",
        note: `${state.repositoryName} is now a System in Konteks.`,
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "push": {
      if (!context.answer) {
        return {
          step: "push",
          ask: {
            question: `Push ${state.defaultBranch} to the Konteks repository now?`,
            kind: "confirm",
          },
        };
      }
      if (!isYes(context.answer)) {
        await save({ step: "first_task" });
        return {
          step: "push",
          note: `Nothing was pushed. The remote is ${state.managedRemoteUrl}.`,
          run: { argv: ["konteks-remote", "onboard", "--json"] },
        };
      }
      const result = await (context.deps?.push ?? pushToManagedRemote)({
        repositoryPath: state.repositoryPath!,
        remoteUrl: state.managedRemoteUrl!,
        branch: state.defaultBranch!,
      });
      await save({ step: "first_task" });
      return {
        step: "push",
        note: result.message,
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "first_task": {
      if (!context.answer) {
        return {
          step: "first_task",
          ask: {
            question:
              "What do you want to build first? (this first turn uses your starter grant; an empty answer ends here)",
            kind: "text",
          },
        };
      }
      const wanted = context.answer.trim();
      if (!wanted) {
        await save({ step: "done" });
        return {
          step: "first_task",
          note: "Ending here.",
          run: { argv: ["konteks-remote", "onboard", "--json"] },
        };
      }
      const api = await ownerApi(supervisorData, coreUrl, enrollment, context);
      const session = await api.createProjectManagementSession({
        systemId: state.systemId!,
        instanceId: state.instanceId!,
        title: wanted.slice(0, 80),
      });
      await api.postFirstTurn(session.sessionId, wanted);
      await save({
        step: "done",
        sessionUrl: `${siteUrl.replace(/\/+$/, "")}/sessions/${session.sessionId}`,
      });
      return {
        step: "first_task",
        note: "Your first session is open.",
        run: { argv: ["konteks-remote", "onboard", "--json"] },
      };
    }

    case "done":
    default: {
      const families = await detectAgentFamilies();
      const remedies: string[] = [];
      for (const family of ["claude-code", "codex"]) {
        if (!families.includes(family)) {
          remedies.push(`To also run ${family} work here: konteks-remote auth login ${family}`);
        }
      }
      if (nativePlatform().os === "debian") {
        remedies.push(
          "To keep the runtime available after logout: loginctl enable-linger $USER",
        );
      }
      return {
        step: "done",
        done: {
          summary: [
            `This machine is connected to ${state.tenantId ?? "your workspace"}.`,
            state.systemEntityRef ? `${state.repositoryName} is a System in Konteks.` : null,
            families.length > 0
              ? `Your ${families.join(" and ")} login will run Konteks work here.`
              : null,
          ]
            .filter(Boolean)
            .join(" "),
          links: {
            site: siteUrl,
            ...(state.systemId ? { system: `${siteUrl.replace(/\/+$/, "")}/systems/${state.systemId}` } : {}),
            ...(state.sessionUrl ? { session: state.sessionUrl } : {}),
          },
          ...(families.length > 0 ? { agents: families } : {}),
          ...(remedies.length > 0 ? { remedies } : {}),
        },
      };
    }
  }
}

function hostLabel(): string {
  return `${homedir().split("/").pop() ?? "user"}@${nativePlatform().os}`;
}

/** The person's token, refreshed rather than kept long (OS15). */
async function ownerApi(
  supervisorData: string,
  coreUrl: string,
  enrollment: NativeEnrollment,
  context: OnboardContext,
): Promise<OwnerApiClient> {
  const stored = await readOwnerToken(supervisorData);
  if (!stored) {
    throw new RemoteInstanceError(
      "permission_denied",
      "This machine holds no Konteks access for you; run onboard from the start.",
    );
  }
  let token = stored.token;
  if (Date.parse(stored.expiresAt) - Date.now() < 120_000) {
    const refreshed = await enrollment.refreshOwnerToken(stored.instanceId);
    await writeOwnerToken(supervisorData, { ...refreshed, instanceId: stored.instanceId });
    token = refreshed.token;
  }
  return new OwnerApiClient({
    coreUrl,
    token,
    ...(context.deps?.fetchFn ? { fetchFn: context.deps.fetchFn } : {}),
  });
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
