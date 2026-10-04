import { execFileSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { RemoteInstanceError } from "@konteks/remote-common";
import { SupervisorControl } from "../control.js";
import { readNativeRecord } from "./install.js";
import { nativePlatform } from "./service.js";
import { commitFirstFiles, initializeRepository, planFirstCommit, pushToManagedRemote, type FirstCommitPlan, type inspectRepository } from "./repository-inspect.js";
import { ensureGraft, graftAlreadyWired, planGraft, readGraftRecord, wireGraft, type GraftTool } from "./graft.js";
import type { OnboardState } from "./onboard-state.js";
import type { OwnerApiClient } from "./owner-api.js";
import { isNo, isYes } from "./onboard-answers.js";
import { AGAIN, listed, pause, type OnboardSession, type OnboardStep } from "./onboard-session.js";

/**
 * The steps that make the folder this machine's first System: inspect it,
 * register it, push it to Konteks managed git, and offer Graft.
 */

type RepositoryFacts = Awaited<ReturnType<typeof inspectRepository>>;
type GraftPlan = Awaited<ReturnType<typeof planGraft>>;
type Author = { authorName: string; authorEmail: string };

const TRY_PUSH_AGAIN = { question: "Try the push again?", kind: "confirm" } as const;

function repositoryLabel(state: OnboardState): string {
  return state.repositoryName ?? "this repository";
}

/**
 * The service was just started. The folder questions need only that it
 * answers: its agents keep starting while the person reads and replies, and
 * the agents step waits for the first heartbeat before anything is said
 * about what runs here.
 */
export async function inspectStep(s: OnboardSession): Promise<OnboardStep> {
  const ready = await s.waitForReady("answering").catch(() => null);
  if (!ready) return serviceNotAnswering(s);
  if (s.state.startWaits) await s.save({ startWaits: 0 });
  const facts = await s.inspect();
  if (isSystemFolder(s, facts)) return alreadySystem(s);
  if (!facts.path) return plainFolder(s, ready.roles);
  return repositoryFound(s, facts, ready.roles);
}

/**
 * The previous step asked for `konteks-remote start`; nothing answering here
 * means it did not happen, or the service is still coming up. A machine with
 * no service record never ran the start step; one that has a record is
 * starting, and asking for `start` again would loop on a service that is
 * already coming up (it takes about a minute after a fresh install).
 */
async function serviceNotAnswering(s: OnboardSession): Promise<OnboardStep> {
  const started = await readNativeRecord(s.context.root).catch(() => null);
  if (!started) {
    return {
      step: "inspect",
      note: "This machine's Konteks service is not running yet, so nothing can be set up here. Starting it is the step before this one.",
      run: { argv: ["konteks-remote", "start"] },
    };
  }
  // A record is also written before `start` is ever run, so "starting"
  // cannot wait for ever: after two waits (over two minutes) hand out
  // `start` again. It is harmless for a service that is already up, and it
  // is the step that was missed if it is not.
  const waits = (s.state.startWaits ?? 0) + 1;
  if (waits >= 2) {
    await s.save({ startWaits: 0 });
    return {
      step: "inspect",
      note: "The Konteks service on this machine has not answered for over two minutes. Starting it again; that is safe if it is already running.",
      run: { argv: ["konteks-remote", "start"] },
    };
  }
  await s.save({ startWaits: waits });
  return {
    step: "inspect",
    note: "The Konteks service on this machine is still starting. It usually opens for work about a minute after a fresh install; the next step waits for it again.",
    run: AGAIN,
  };
}

/** A new conversation in the folder that is already this machine's System. */
function isSystemFolder(s: OnboardSession, facts: RepositoryFacts): boolean {
  const { state } = s;
  return Boolean(state.revisit && state.systemEntityRef && state.repositoryPath && resolve(facts.path ?? s.cwd()) === resolve(state.repositoryPath));
}

/** There is nothing to register again: say so, and where the work is, instead of offering to make it a System a second time. */
async function alreadySystem(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  // "Nothing needs setting up" is only true while Core still accepts this
  // machine; a revoked one is asked to connect again instead.
  await s.currentWorkspaceName(state.tenantId ?? "");
  await s.save({ step: "done", revisit: false });
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
      links: s.links(),
    },
  };
}

async function plainFolder(s: OnboardSession, roles: string[]): Promise<OnboardStep> {
  const directory = resolve(s.cwd());
  if (directory === resolve(homedir()) || directory === resolve("/")) {
    // A home or root directory is not a project; making it a repository
    // would sweep in everything the person owns.
    await s.save({ step: "first_task", advertisedRoles: roles });
    return {
      step: "inspect",
      note: `This is your ${directory === resolve("/") ? "root" : "home"} folder, not a project, so no System is made here. Run onboard again from inside a project folder to add one.`,
      run: AGAIN,
    };
  }
  // An ordinary folder that is not a repository yet: offer it as the first
  // System on managed git. Nothing happens to it until the person has said
  // yes twice.
  await s.save({
    step: "system",
    repositoryPath: directory,
    repositoryName: basename(directory),
    defaultBranch: "main",
    repositoryKind: "managed",
    repositoryNeedsInit: true,
    advertisedRoles: roles,
  });
  return { step: "inspect", note: `${basename(directory)} isn’t a git repository yet.`, run: AGAIN };
}

async function repositoryFound(s: OnboardSession, facts: RepositoryFacts, roles: string[]): Promise<OnboardStep> {
  // A remote only this machine can open (a folder, a file:// URL) is not
  // one Konteks can register; the folder is offered managed git instead.
  const kind = facts.remoteUrl && facts.remoteReachable && !facts.remoteLocal ? "existing" : "managed";
  await s.save({
    step: "system",
    repositoryPath: facts.path!,
    repositoryName: facts.name,
    defaultBranch: facts.defaultBranch,
    repositoryKind: kind,
    ...optionalFacts(facts),
    advertisedRoles: roles,
  });
  const where = folderNote(facts, kind);
  return { step: "inspect", ...(where ? { note: where } : {}), run: AGAIN };
}

function optionalFacts(facts: RepositoryFacts): Partial<OnboardState> {
  return {
    ...(facts.remoteUrl ? { remoteUrl: facts.remoteUrl } : {}),
    ...(facts.onManagedGit ? { repositoryOnManagedGit: true } : {}),
    ...(facts.unpushedCommits !== undefined ? { repositoryUnpushed: facts.unpushedCommits } : {}),
  };
}

/** A folder already on Konteks managed git says so in its question. */
function folderNote(facts: RepositoryFacts, kind: "existing" | "managed"): string {
  if (kind === "existing") return `You are in ${facts.name}, with remote ${facts.remoteUrl}.`;
  if (facts.onManagedGit) return "";
  return facts.remoteLocal
    ? `You are in ${facts.name}. Its remote is a folder on this machine, which Konteks can’t reach.`
    : `You are in ${facts.name}, which has no remote this machine can push to.`;
}

export async function systemStep(s: OnboardSession): Promise<OnboardStep> {
  const question = systemQuestion(s.state);
  if (s.answer === undefined) return askSystem(s, question);
  const answer = s.answer.trim();
  if (isNo(answer)) return systemDeclined(s);
  // Neither yes nor no: the answer to "which repository?" names one.
  if (!isYes(answer)) return systemNamed(s, answer, question);
  return registerSystem(s);
}

function systemQuestion(state: OnboardState): string {
  if (state.repositoryKind === "existing") return `Make ${state.repositoryName} your first System in Konteks?`;
  if (state.repositoryNeedsInit) return `Make ${state.repositoryName} your first System, kept on Konteks managed git? Nothing is pushed until you say so.`;
  return state.repositoryOnManagedGit
    ? `Use ${state.repositoryName} as your System here? It is already on Konteks managed git, so if your workspace has it, nothing is made twice.`
    : `Make ${state.repositoryName} your first System, on Konteks managed git?`;
}

/** Whether a run from somewhere else found a repository other than the one captured at the first inspect. */
function otherRepository(here: RepositoryFacts | null, state: OnboardState): here is RepositoryFacts {
  return Boolean(here?.path && state.repositoryPath && resolve(here.path) !== resolve(state.repositoryPath));
}

/**
 * The repository is the one captured at the first inspect. A run from
 * somewhere else while this is pending asks which of the two is meant,
 * instead of silently registering the wrong one.
 */
async function askSystem(s: OnboardSession, question: string): Promise<OnboardStep> {
  const here = await s.inspect().catch(() => null);
  if (otherRepository(here, s.state)) {
    return {
      step: "system",
      note: `Onboarding started in ${s.state.repositoryName}, but this is ${here.name}.`,
      ask: { question: "Which repository should become your first System?", kind: "choice", choices: [s.state.repositoryName!, here.name] },
    };
  }
  return { step: "system", ask: { question, kind: "confirm" } };
}

/**
 * A first initiative needs a System. With none, asking what to build first
 * only leads to "an initiative needs a System": close instead, and say how
 * to come back to it.
 */
async function systemDeclined(s: OnboardSession): Promise<OnboardStep> {
  if (!s.state.systemId) {
    await s.save({ step: "done", closing: true });
    return {
      step: "system",
      note: "Leaving the catalog as it is; nothing was registered or pushed. To make this folder a System later, run onboard here again. A first initiative needs a System, so that waits too.",
      run: AGAIN,
    };
  }
  await s.save({ step: "first_task" });
  return { step: "system", note: "Leaving the catalog as it is.", run: AGAIN };
}

async function systemNamed(s: OnboardSession, answer: string, question: string): Promise<OnboardStep> {
  if (answer.toLowerCase() === s.state.repositoryName?.toLowerCase()) {
    return { step: "system", ask: { question, kind: "confirm" } };
  }
  const here = await s.inspect().catch(() => null);
  if (otherRepository(here, s.state) && answer.toLowerCase() === here.name.toLowerCase()) {
    await s.save({ step: "inspect" });
    return { step: "system", note: `Switching to ${here.name}.`, run: AGAIN };
  }
  return { step: "system", note: "A yes or no is what this step needs.", ask: { question, kind: "confirm" } };
}

async function registerSystem(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  const api = await s.ownerApi();
  const registered = await registerWhileManagedGitSetsUp(s, api);
  await s.save({
    step: state.repositoryKind === "managed" ? "push" : "graft",
    ...(registered.existing ? { systemExisting: true } : {}),
    systemId: registered.systemId,
    systemEntityRef: registered.systemEntityRef,
    ...(registered.repository.remoteUrl ? { managedRemoteUrl: registered.repository.remoteUrl } : {}),
    ...(registered.repository.sshUrl ? { managedSshUrl: registered.repository.sshUrl } : {}),
  });
  return { step: "system", note: registeredNote(state, registered.existing), run: AGAIN };
}

function registeredNote(state: OnboardState, existing: boolean | undefined): string {
  if (existing) return `${state.repositoryName} was already a System in your workspace, so this machine works on that one; nothing was made twice.`;
  return state.repositoryKind === "managed"
    ? `${state.repositoryName} is now a System in Konteks, with a managed git repository ready for it.`
    : `${state.repositoryName} is now a System in Konteks.`;
}

/**
 * A new workspace's managed git can still be on its way, and Konteks has
 * just asked for it again. That is a wait, not a failure: wait here, briefly,
 * rather than hand the person a "retry".
 */
async function registerWhileManagedGitSetsUp(s: OnboardSession, api: OwnerApiClient): ReturnType<OwnerApiClient["registerFirstSystem"]> {
  const { state } = s;
  const register = () => api.registerFirstSystem({
    name: state.repositoryName!,
    hostLabel: hostLabel(),
    repository: {
      kind: state.repositoryKind!,
      ...(state.remoteUrl && state.repositoryKind === "existing" ? { remoteUrl: state.remoteUrl } : {}),
      defaultBranch: state.defaultBranch!,
    },
  });
  const settingUpUntil = Date.now() + (s.deps.managedGitWaitMs ?? 90_000);
  for (;;) {
    try {
      return await register();
    } catch (error) {
      if (!managedGitSettingUp(error) || Date.now() >= settingUpUntil) throw error;
      await pause(s.deps.managedGitPollMs ?? 10_000);
    }
  }
}

function managedGitSettingUp(error: unknown): boolean {
  return error instanceof RemoteInstanceError && /still setting up managed git/i.test(error.message);
}

/**
 * The computer's name as its person knows it, for "connected from …" on the
 * site: macOS's Computer Name ("Sam's MacBook Air"), else the host name
 * without ".local". The home folder and OS ("home@macos") meant nothing there.
 */
export function hostLabel(deps: { os?: string; computerName?: () => string; hostname?: () => string } = {}): string {
  const os = deps.os ?? nativePlatform().os;
  if (os === "macos") {
    const named = computerName(deps.computerName);
    if (named) return named.slice(0, 128);
  }
  const host = (deps.hostname ?? hostname)().trim().replace(/\.local$/i, "");
  return (host || `${homedir().split("/").pop() ?? "user"}'s computer`).slice(0, 128);
}

function computerName(read: (() => string) | undefined): string {
  try {
    return (read ?? (() => execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })))().trim();
  } catch {
    return "";
  }
}

/**
 * A folder with the person's files in it gets them committed, and is shown
 * exactly which, and what stays out, before anything happens.
 */
export async function pushStep(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  const plan: FirstCommitPlan = state.repositoryNeedsInit
    ? await (s.deps.planCommit ?? planFirstCommit)(state.repositoryPath!)
    : { include: [], leftOut: [] };
  const withFiles = plan.include.length > 0;
  const question = pushQuestion(state, withFiles);
  if (s.answer === undefined) return askPush(s, plan, question);
  if (!isYes(s.answer)) {
    await s.save({ step: "first_task" });
    return { step: "push", note: "Nothing was pushed; the Konteks remote is recorded on the System and can be pushed to later.", run: AGAIN };
  }
  await s.save({ step: "pushing" });
  return {
    step: "push",
    // An empty folder has nothing of the person's to push; it only joins
    // the repository Konteks made.
    note: state.repositoryNeedsInit && !withFiles
      ? `Joining ${state.repositoryName} to its Konteks repository. This usually takes a few seconds.`
      : `Pushing ${state.defaultBranch} to Konteks managed git. This usually takes a few seconds.`,
    run: AGAIN,
  };
}

function pushQuestion(state: OnboardState, withFiles: boolean): string {
  if (!state.repositoryNeedsInit) return `Push ${state.defaultBranch} to the Konteks repository now?`;
  return withFiles
    ? `Push ${state.repositoryName} to Konteks managed git now? It becomes a git repository on ${state.defaultBranch} with one commit of the files above.`
    : `Push ${state.repositoryName} to Konteks managed git now? It becomes a git repository on ${state.defaultBranch}; none of your files are added or changed.`;
}

async function askPush(s: OnboardSession, plan: FirstCommitPlan, question: string): Promise<OnboardStep> {
  const { state } = s;
  // A System this machine rejoined, whose branch Konteks already has: there
  // is nothing to agree to. The push only registers this machine's key and
  // changes nothing on the repository.
  if (state.systemExisting && state.repositoryOnManagedGit && state.repositoryUnpushed === 0) {
    await s.save({ step: "pushing" });
    return { step: "push", note: `Konteks already has ${state.defaultBranch}; joining this machine to the repository.`, run: AGAIN };
  }
  if (plan.include.length === 0) return { step: "push", ask: { question, kind: "confirm" } };
  return { step: "push", note: commitPreview(plan), ask: { question, kind: "confirm" } };
}

function commitPreview(plan: FirstCommitPlan): string {
  const shown = plan.include.slice(0, 8);
  const more = plan.include.length - shown.length;
  const left = plan.leftOut.length > 0
    ? ` Left out: ${listed(plan.leftOut.map(entry => `${entry.path} (${entry.why})`))}; a new .gitignore in the commit keeps ${plan.leftOut.length === 1 ? "it" : "them"} out.`
    : "";
  return `The commit would hold ${listed(more > 0 ? [...shown, `${more} more`] : shown)}.${left}`;
}

export async function pushingStep(s: OnboardSession): Promise<OnboardStep> {
  const key = await registeredKey(s);
  if (key.reply) return key.reply;
  if (s.state.repositoryNeedsInit) {
    const prepared = await prepareRepository(s, key.sshCommand);
    if (prepared) return prepared;
  }
  return pushFolder(s, key.sshCommand);
}

/**
 * Managed git accepts only a key this runtime registered, over SSH. `git key
 * add` is idempotent for a key that exists. A key that cannot be registered
 * is said plainly, not swallowed into a push that then fails for a reason the
 * person cannot see.
 */
async function registeredKey(s: OnboardSession): Promise<{ reply: OnboardStep; sshCommand?: undefined } | { reply?: undefined; sshCommand?: string }> {
  if (!s.state.managedSshUrl) return {};
  let key: { identityFile?: string; user?: string };
  try {
    // A service that was just (re)started answers within the wait; one that
    // is up answers at once.
    await s.waitForReady().catch(() => null);
    key = await (s.deps.registerGitKey ?? registerGitKey)(s.context.root);
  } catch (error) {
    return { reply: await keyRefused(s, error) };
  }
  return key.identityFile ? { sshCommand: `ssh -i '${key.identityFile.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` } : {};
}

async function keyRefused(s: OnboardSession, error: unknown): Promise<OnboardStep> {
  // The service on this machine is not running: say that, and start it,
  // instead of a control-socket error and "try again". The person already
  // said yes; the push goes on once it answers.
  if (error instanceof RemoteInstanceError && error.code === "control_socket_unavailable") {
    await s.save({ step: "pushing" });
    return {
      step: "pushing",
      note: "The Konteks service on this machine is not running, so nothing was pushed yet. Starting it; the push goes on once it answers.",
      run: { argv: ["konteks-remote", "start"] },
    };
  }
  await s.save({ step: "push" });
  const why = error instanceof Error && error.message ? ` (${error.message.replace(/[.]$/, "")})` : "";
  return { step: "pushing", note: `This machine could not register its key with Konteks managed git${why}. Nothing was pushed.`, ask: TRY_PUSH_AGAIN };
}

async function pushRefused(s: OnboardSession, note: string): Promise<OnboardStep> {
  await s.save({ step: "push" });
  return { step: "pushing", note, ask: TRY_PUSH_AGAIN };
}

/** Make the folder a repository, with the person's files committed; null when the push goes on. */
async function prepareRepository(s: OnboardSession, sshCommand: string | undefined): Promise<OnboardStep | null> {
  const { state } = s;
  const plan = await (s.deps.planCommit ?? planFirstCommit)(state.repositoryPath!);
  const author = firstCommitAuthor(state.ownerEmail);
  const initialized = await initializeFolder(s, sshCommand, plan, author);
  if (!initialized.ok) return pushRefused(s, `${initialized.message} Nothing was pushed.`);
  if (plan.include.length > 0) return commitFiles(s, plan, author);
  if (initialized.adopted) {
    // The Konteks repository already had its first commit, so there is
    // nothing of the person's to push: the folder is on it now.
    await s.save({ step: "graft" });
    return {
      step: "pushing",
      note: `${initialized.message} It is on the ${state.repositoryName} System: ${s.siteUrl}/systems/${state.systemId}; push your work with git as usual (remote "konteks").`,
      run: AGAIN,
    };
  }
  return null;
}

function firstCommitAuthor(ownerEmail: string | undefined): Author {
  return { authorName: (ownerEmail ?? "Konteks").split("@")[0]!, authorEmail: ownerEmail ?? "onboarding@konteks.invalid" };
}

function initializeFolder(s: OnboardSession, sshCommand: string | undefined, plan: FirstCommitPlan, author: Author): ReturnType<typeof initializeRepository> {
  const { state } = s;
  const remoteUrl = sshCommand ? state.managedSshUrl : state.managedRemoteUrl;
  return (s.deps.initialize ?? initializeRepository)({
    path: state.repositoryPath!,
    branch: state.defaultBranch!,
    ...author,
    ...(remoteUrl ? { remote: { url: remoteUrl, ...(sshCommand ? { sshCommand } : {}) } } : {}),
    ...(plan.include.length > 0 ? { keepFiles: true } : {}),
  });
}

/** The person's files, committed; null when the push goes on with them on it. */
async function commitFiles(s: OnboardSession, plan: FirstCommitPlan, author: Author): Promise<OnboardStep | null> {
  const committed = await (s.deps.commitFiles ?? commitFirstFiles)({
    path: s.state.repositoryPath!,
    plan,
    ...author,
    message: `Add ${s.state.repositoryName}`,
  });
  return committed.ok ? null : pushRefused(s, `${committed.message} Nothing was pushed.`);
}

async function pushFolder(s: OnboardSession, sshCommand: string | undefined): Promise<OnboardStep> {
  const { state } = s;
  const result = await (s.deps.push ?? pushToManagedRemote)({
    repositoryPath: state.repositoryPath!,
    remoteUrl: sshCommand ? state.managedSshUrl! : state.managedRemoteUrl!,
    branch: state.defaultBranch!,
    ...(sshCommand ? { sshCommand } : {}),
  });
  if (!result.pushed) return pushRefused(s, `${result.message} Your folder is unchanged apart from git's own files.`);
  await s.save({ step: "graft" });
  return {
    step: "pushing",
    note: `${result.message} It is on the ${state.repositoryName} System: ${s.siteUrl}/systems/${state.systemId}, and this folder's ${state.defaultBranch} branch tracks it (remote "konteks").`,
    run: AGAIN,
  };
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

/**
 * Graft is offered once the folder is a repository, once per repository. A
 * release without it, or a repository that already decided, goes straight on.
 */
export async function graftStep(s: OnboardSession): Promise<OnboardStep> {
  const { state } = s;
  const repo = state.repositoryPath;
  const decided = state.graftDecision !== undefined && state.graftRepository === repo;
  const available = await graftAvailable(s);
  if (!repo || decided || !available) {
    await s.save({ step: "first_task", ...(!repo || decided ? {} : { graftDecision: "unavailable", graftRepository: repo }) });
    return { step: "graft", run: AGAIN };
  }
  return offerGraft(s, repo);
}

function graftAvailable(s: OnboardSession): Promise<boolean> {
  return (s.deps.graft?.available ?? (async (root: string) => (await readGraftRecord(root)) !== null))(s.context.root).catch(() => false);
}

async function offerGraft(s: OnboardSession, repo: string): Promise<OnboardStep> {
  // A machine that reconnected in a folder it already wired (a lost key
  // resets onboarding) is not asked again.
  if (await (s.deps.graft?.wired ?? graftAlreadyWired)(repo).catch(() => false)) {
    await s.save({ step: "first_task", graftDecision: "accepted", graftRepository: repo });
    return { step: "graft", note: `Graft is already set up in ${repositoryLabel(s.state)}.`, run: AGAIN };
  }
  const plan = await (s.deps.graft?.plan ?? planGraft)(repo, await s.families());
  if (plan.agents.length === 0) {
    await s.save({ step: "first_task", graftDecision: "unavailable", graftRepository: repo });
    return { step: "graft", run: AGAIN };
  }
  return graftAnswer(s, repo, plan);
}

async function graftAnswer(s: OnboardSession, repo: string, plan: GraftPlan): Promise<OnboardStep> {
  const question = `Set up Graft in ${repositoryLabel(s.state)}? It adds ${listed(plan.adds)} here, kept out of your commits.`;
  if (s.answer === undefined) return { step: "graft", note: graftIntroduction(plan), ask: { question, kind: "confirm" } };
  if (isNo(s.answer)) {
    await s.save({ step: "first_task", graftDecision: "declined", graftRepository: repo });
    return { step: "graft", note: "Graft was not set up; nothing was added, and it will not be offered again for this folder.", run: AGAIN };
  }
  if (!isYes(s.answer)) {
    return { step: "graft", note: "A yes or no is what this step needs.", ask: { question, kind: "confirm" } };
  }
  await s.save({ step: "graft_setup", graftDecision: "accepted", graftRepository: repo });
  return {
    step: "graft",
    note: `Setting up Graft: downloading it, then mapping ${repositoryLabel(s.state)}. This can take a minute or more; leave the command running and come back for the result.`,
    run: AGAIN,
  };
}

function graftIntroduction(plan: GraftPlan): string {
  const names = plan.agents.map(id => (id === "claude" ? "Claude Code" : "Codex")).join(" and ");
  const tracked = plan.tracked.length > 0
    ? ` ${listed(plan.tracked)} ${plan.tracked.length === 1 ? "is" : "are"} already tracked by git, so Graft's section there will show as a change until you commit or drop it.`
    : "";
  return `Graft maps this repository's code so ${names} can find their way around it before they search. ` +
    "It runs only on this machine, sends nothing to a paid model, and its usage statistics stay off. " +
    `Outside this folder it writes only its settings and its own copy in ~/.graft.${tracked}`;
}

export async function graftSetupStep(s: OnboardSession): Promise<OnboardStep> {
  const repo = s.state.repositoryPath!;
  try {
    const tool = await ensureGraftTool(s);
    const wired = await (s.deps.graft?.wire ?? wireGraft)(s.context.root, repo, await s.families(), tool);
    await s.save({ step: "first_task" });
    const changed = wired.changedTracked.length > 0 ? ` It also changed ${listed(wired.changedTracked)}, which git tracks.` : "";
    return { step: "graft_setup", note: `Graft is set up in ${repositoryLabel(s.state)} and kept out of your commits.${changed}`, run: AGAIN };
  } catch (error) {
    await s.save({ step: "first_task", graftDecision: "failed", graftRepository: repo });
    const why = error instanceof Error ? error.message.replace(/[.]$/, "") : "it stopped unexpectedly";
    return { step: "graft_setup", note: `Graft could not be set up (${why}). Nothing else changed, and onboarding carries on.`, run: AGAIN };
  }
}

function ensureGraftTool(s: OnboardSession): Promise<GraftTool> {
  const fetchFn = s.deps.fetchFn;
  return (s.deps.graft?.ensure ?? ((root: string) => ensureGraft(root, fetchFn ? { fetchFn } : {})))(s.context.root);
}
