import { constants, type Stats } from "node:fs";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import {
  canonicalize,
  sha256Hex,
  RemoteInstanceError,
  RemoteTransferManifestSchema,
  RemoteWorkAssignmentSchema,
  isFsErrorWithCode,
  type Clock,
  type Logger,
  type RemoteAssignmentInputsEnvelope,
  type RemoteDeliveryAcceptanceReceipt,
  type SessionToCoreMessage,
  type RemoteWorkAssignment,
} from "@konteks/remote-common";
import {
  prepareDirectSessionInputs,
  prepareOrganizationSkillSession,
  type PreparedSessionInputs,
} from "../skills/session-inputs.js";
import { continuedSession, isDirectAssignment } from "../work/continued-session.js";
import type { NativeInputClient } from "./input-client.js";
import type { NativeOutputClient } from "./output-client.js";
import { captureNativeDeliveryOutput } from "./output-capture.js";
import { NativeOutputSessionHeadStore, type NativeOutputRecord, type NativeOutputStore } from "./output-store.js";
import { readFully } from "./read-fully.js";
import { unrestrictedStateMutation, type StateMutation } from "../state/mutation-gate.js";
import {
  initializeNativeGitWorkspace,
  NativeGitReceiptSchema,
  verifyNativeGitWorkspace,
  type NativeGitTool,
} from "./git-workspace.js";
import { NativeRepositoryCache } from "./repository-cache.js";

interface NativeInputPreparerOptions {
  /** Private, runner-specific connector workspace root, never a user checkout. */
  root: string;
  clock: Clock;
  client: () => NativeInputClient;
  /** Current locally accepted claim; returning null denies preparation/continuation. */
  claimId: (assignment: RemoteWorkAssignment) => string | null;
  /** Production supplies the supervisor gate, which settles writes before releasing ownership. */
  mutate?: StateMutation;
  git?: NativeGitTool;
  /** Connector-wide object cache; agent worktrees remain below `root`. */
  repositoryCacheRoot?: string;
  /** Optional local developer tool wiring for a newly materialized private
   * worktree. Failure is observable but never withholds delivery inputs. It
   * runs alongside the rest of bootstrap and is awaited before the agent
   * starts (`PreparedSessionInputs.toolWiring`). */
  prepareRepositoryWorktree?: (cwd: string, agentId: string) => Promise<void | "unavailable" | "skipped" | "wired">;
  outputClient?: () => NativeOutputClient;
  logger?: Pick<Logger, "warn"> & Partial<Pick<Logger, "info">>;
}
const ReceiptSchema = z
  .object({
    version: z.literal(1),
    selectionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    source: RemoteTransferManifestSchema,
    /** Which claim materialized this workspace; a new claim on the same session may refresh it. */
    claimId: z.string().min(1),
    git: NativeGitReceiptSchema.optional(),
  })
  .strict();
const unavailable = () =>
  new RemoteInstanceError(
    "capability_unavailable",
    "Required assignment inputs are unavailable or no longer authorized.",
  );

function privateNode(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || !expectedKind(stat, directory)) throw unavailable();
  if (process.platform !== "win32" && !privateMode(stat, directory)) throw unavailable();
}
function expectedKind(stat: Stats, directory: boolean): boolean {
  return directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1;
}
function privateMode(stat: Stats, directory: boolean): boolean {
  return (stat.mode & 0o7777) === (directory ? 0o700 : 0o600) && stat.uid === process.getuid?.();
}
async function sameDirectory(path: string, before?: Stats): Promise<Stats> {
  const stat = await lstat(path);
  privateNode(stat, true);
  if (before && (before.ino !== stat.ino || before.dev !== stat.dev)) throw unavailable();
  return stat;
}
async function privateRoot(value: string): Promise<string> {
  if (!isAbsolute(value) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw unavailable();
  const path = resolve(value);
  if (path === parse(path).root || path === resolve(homedir())) throw unavailable();
  await mkdir(path, { recursive: true, mode: 0o700 });
  await sameDirectory(path);
  return realpath(path);
}
async function writePrivate(path: string, bytes: Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/**
 * Writes one of Core's input files into a folder the agent also writes to:
 * every directory on the way must be a real directory (never a link the
 * agent planted), and the file itself is replaced by a rename, so a link at
 * its path is replaced rather than followed.
 */
async function overlayPrivate(base: string, parts: string[], bytes: Buffer, mode = 0o600): Promise<void> {
  const directory = await realDirectories(base, parts.slice(0, -1));
  const name = parts.at(-1);
  if (!name || name === "." || name === "..") throw unavailable();
  const target = join(directory, name);
  const existing = await lstat(target).catch((error: unknown) => { if (isFsErrorWithCode(error, "ENOENT")) return null; throw error; });
  if (existing?.isDirectory()) throw unavailable();
  await replacePrivate(target, bytes, mode);
}

/** The folder `parts` names under `base`, each step a real directory (made when missing). */
async function realDirectories(base: string, parts: string[]): Promise<string> {
  let directory = base;
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw unavailable();
    directory = join(directory, part);
    await realDirectory(directory);
  }
  return directory;
}

async function realDirectory(directory: string): Promise<void> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory()) throw unavailable();
  } catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) throw error;
    await mkdir(directory, { mode: 0o700 });
  }
}

/** Replaces a file through a sibling temporary file and a rename. */
async function replacePrivate(path: string, bytes: Buffer, mode = 0o600): Promise<void> {
  const temporary = join(dirname(path), `.konteks-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writePrivate(temporary, bytes, mode);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readReceipt(path: string) {
  const before = await lstat(path);
  privateNode(before, false);
  if (before.size > 16 * 1024) throw unavailable();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    privateNode(stat, false);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size)
      throw unavailable();
    const buffer = Buffer.alloc(stat.size + 1);
    const count = await readFully(handle, buffer);
    if (count !== stat.size) throw unavailable();
    return ReceiptSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))),
    );
  } finally {
    await handle.close();
  }
}

type FetchedTree = Awaited<ReturnType<NativeInputClient["read"]>>;
type WorkspaceReceipt = { version: 1; selectionDigest: string; source: RemoteAssignmentInputsEnvelope["selection"]["source"]; claimId: string };

/** A prepared source folder: where the agent works, the container it lives in, and the check run before every prompt. */
interface SourceWorkspace {
  cwd: string;
  container: string;
  verify: () => Promise<void>;
  baselineCommit?: string;
}

/** Never import a repository's configuration, hooks, worktree pointer or NTFS alias. */
function carriesGitMetadata(tree: FetchedTree): boolean {
  return tree.entries.some((entry) => entry.path.split("/").some((part) => /^(?:\.git|git~[0-9]+)$/i.test(part)));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * A conversation's workspace is the SESSION's, so its path is stable across
 * turns: the local agent's own per-directory memory survives, and a
 * continued ACP session keeps the cwd it was created with. A delivery keeps
 * a per-assignment checkout, because the agent commits into it.
 */
function workspaceDestination(root: string, selection: RemoteAssignmentInputsEnvelope["selection"], needsGit: boolean): string {
  const { binding } = selection;
  return join(
    root,
    needsGit
      ? "assignment-" + sha256Hex(canonicalize({ binding, claimId: selection.claimId }))
      : "session-" +
          sha256Hex(
            canonicalize({
              workspaceId: binding.workspaceId,
              instanceId: binding.instanceId,
              sessionId: binding.sessionId,
            }),
          ),
  );
}

/** Mutable work is separate from its immutable selection receipt and pinned skill trees. */
async function sourceWorkspace(
  root: string,
  envelope: RemoteAssignmentInputsEnvelope,
  fetchSource: () => Promise<FetchedTree>,
  needsGit: boolean,
  gitTool?: NativeGitTool,
): Promise<SourceWorkspace> {
  if (needsGit && !gitTool) throw unavailable();
  const rootStat = await sameDirectory(root);
  const selection = envelope.selection;
  const destination = workspaceDestination(root, selection, needsGit);
  const expected: WorkspaceReceipt = {
    version: 1 as const,
    selectionDigest: envelope.selectionDigest,
    source: selection.source,
    claimId: selection.claimId,
  };
  const cwd = join(destination, "source");
  const present = await pathExists(destination);
  const folder = { root, rootStat, destination, cwd, expected };
  if (present && !needsGit) await refreshSessionWorkspace(folder, fetchSource);
  if (!present) await materializeWorkspace(folder, fetchSource, needsGit, gitTool);
  return publishedWorkspace(folder, needsGit);
}

interface WorkspaceFolder {
  root: string;
  rootStat: Stats;
  destination: string;
  cwd: string;
  expected: WorkspaceReceipt;
}

/**
 * Same session, newer inputs: refresh the contents under the same path
 * rather than refusing. The snapshot is Core's, not the agent's work.
 * Materialization is temp-dir + atomic rename, so a directory that exists is
 * complete; a receipt that will not parse is tampering or corruption, and
 * that still refuses rather than being quietly rebuilt over.
 */
async function refreshSessionWorkspace(folder: WorkspaceFolder, fetchSource: () => Promise<FetchedTree>): Promise<void> {
  const { root, rootStat, destination, cwd, expected } = folder;
  await sameDirectory(destination);
  const receipt = await readReceipt(join(destination, "receipt.json"));
  if (receipt.selectionDigest === expected.selectionDigest) return;
  // A different selection under the SAME claim is a substitution inside
  // one turn, not newer inputs: refuse, and leave local work untouched.
  if (receipt.claimId === expected.claimId) throw unavailable();
  // A later turn of the same session: Core's newer inputs are laid over the
  // folder and the agent's own files stay. Rebuilding it deleted everything
  // the agent wrote in earlier turns.
  const tree = await fetchSource();
  if (carriesGitMetadata(tree)) throw unavailable();
  await sameDirectory(root, rootStat);
  await sameDirectory(destination);
  for (const entry of tree.entries) {
    await overlayPrivate(cwd, entry.path.split("/"), Buffer.from(entry.contentBase64, "base64"), entry.mode);
  }
  await replacePrivate(join(destination, "receipt.json"), Buffer.from(JSON.stringify(expected)));
  await syncDirectory(destination);
}

/** Write the inputs into a private temporary folder, then publish it at the destination in one rename. */
async function materializeWorkspace(folder: WorkspaceFolder, fetchSource: () => Promise<FetchedTree>, needsGit: boolean, gitTool: NativeGitTool | undefined): Promise<void> {
  const { root, rootStat, destination } = folder;
  const tree = await fetchSource();
  if (carriesGitMetadata(tree)) throw unavailable();
  await sameDirectory(root, rootStat);
  let temporary: string | undefined = await mkdtemp(join(root, ".input-"));
  await chmod(temporary, 0o700);
  const temporaryStat = await sameDirectory(temporary);
  try {
    await fillWorkspace(temporary, tree, folder.expected, needsGit ? gitTool : undefined, needsGit);
    await sameDirectory(root, rootStat);
    await sameDirectory(temporary, temporaryStat);
    if (await published(temporary, destination)) temporary = undefined;
    await syncDirectory(root);
  } finally {
    // Cleanup is restricted to the exact temporary directory created by this call.
    if (temporary) {
      await sameDirectory(root, rootStat);
      await sameDirectory(temporary, temporaryStat);
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function fillWorkspace(temporary: string, tree: FetchedTree, expected: WorkspaceReceipt, gitTool: NativeGitTool | undefined, needsGit: boolean): Promise<void> {
  const source = join(temporary, "source");
  await mkdir(source, { mode: 0o700 });
  const directories = await writeSourceFiles(source, tree);
  const git = needsGit
    ? await initializeNativeGitWorkspace({ container: temporary, tool: gitTool, tree })
    : undefined;
  await writePrivate(
    join(temporary, "receipt.json"),
    Buffer.from(JSON.stringify({ ...expected, ...(git ? { git } : {}) })),
  );
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    await syncDirectory(directory);
  await syncDirectory(temporary);
}

/** Write every file of the tree; the folders created on the way, for syncing. */
async function writeSourceFiles(source: string, tree: FetchedTree): Promise<Set<string>> {
  const directories = new Set([source]);
  for (const entry of tree.entries) {
    const path = join(source, ...entry.path.split("/"));
    await writePrivate(path, Buffer.from(entry.contentBase64, "base64"), entry.mode);
    for (let directory = dirname(path); directory !== source; directory = dirname(directory))
      directories.add(directory);
  }
  return directories;
}

/** Whether the rename published the folder; false when another call already published it. */
async function published(temporary: string, destination: string): Promise<boolean> {
  try {
    await rename(temporary, destination);
    return true;
  } catch (error) {
    if (!isFsErrorWithCode(error, "EEXIST") && !isFsErrorWithCode(error, "ENOTEMPTY"))
      throw error;
    return false;
  }
}

async function publishedWorkspace(folder: WorkspaceFolder, needsGit: boolean): Promise<SourceWorkspace> {
  const { root, rootStat, destination, cwd, expected } = folder;
  await sameDirectory(root, rootStat);
  const destinationStat = await sameDirectory(destination),
    sourceStat = await sameDirectory(cwd);
  const verify = async () => {
    await sameDirectory(root, rootStat);
    await sameDirectory(destination, destinationStat);
    await sameDirectory(cwd, sourceStat);
    const { git, ...receipt } = await readReceipt(join(destination, "receipt.json"));
    if (canonicalize(receipt) !== canonicalize(expected) || Boolean(git) !== needsGit)
      throw unavailable();
    if (git) await verifyNativeGitWorkspace(destination, git);
  };
  await verify();
  const receipt = await readReceipt(join(destination, "receipt.json"));
  return {
    cwd,
    container: destination,
    verify,
    ...(receipt.git ? { baselineCommit: receipt.git.baseCommit } : {}),
  };
}

type Mutate = StateMutation;
type StageLog = (name: string, durationMs: number, extra?: Record<string, unknown>) => void;

/** One tool wiring at a time per worktree, shared by a retried bootstrap. */
class ToolWiring {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: NativeInputPreparerOptions, private readonly mutate: Mutate) {}

  start(cwd: string, agentId: string, repositoryId: string, logStage: StageLog): Promise<void> {
    const running = this.running.get(cwd);
    if (running) return running;
    const startedAt = Date.now();
    // Inside the state gate, so stopping the owner settles it too.
    const task = this.mutate(() => this.options.prepareRepositoryWorktree!(cwd, agentId)).then(
      outcome => logStage("graft_wiring", Date.now() - startedAt, { outcome: outcome ?? "finished" }),
      error => {
        this.options.logger?.warn({ event: "repository_worktree.tool_wiring_failed", repositoryId, agentId,
          durationMs: Date.now() - startedAt, errorClass: error instanceof Error ? error.name : "unknown" },
        "optional repository tool wiring failed; delivery continues");
      });
    this.running.set(cwd, task);
    void task.then(() => { if (this.running.get(cwd) === task) this.running.delete(cwd); });
    return task;
  }
}

/** The selection Core authorized for one claim, rechecked on demand; every later read uses the current envelope. */
class AuthorizedInputs {
  readonly selection: RemoteAssignmentInputsEnvelope["selection"];
  readonly digest: string;

  constructor(
    private readonly options: NativeInputPreparerOptions,
    private readonly client: NativeInputClient,
    readonly current: RemoteWorkAssignment,
    readonly claimId: string,
    public envelope: RemoteAssignmentInputsEnvelope,
  ) {
    this.selection = structuredClone(envelope.selection);
    this.digest = envelope.selectionDigest;
  }

  async authorize(): Promise<void> {
    if (this.options.claimId(this.current) !== this.claimId) throw unavailable();
    this.envelope = await this.client.prepare(this.current, this.claimId, this.digest);
    if (this.options.claimId(this.current) !== this.claimId) throw unavailable();
  }

  read(transferId: string): Promise<FetchedTree> {
    return this.client.read(this.current, this.claimId, this.envelope, transferId);
  }

  fetchRepository(haveRevisions: string[]): Promise<Uint8Array> {
    return this.client.fetchRepository(this.current, this.claimId, this.envelope, haveRevisions);
  }
}

type DeliveryAuthority = { claimId: string; invocationRef: string };
type DeliveredOutput = { receipt: RemoteDeliveryAcceptanceReceipt; completion: SessionToCoreMessage };

/** A delivery turn's generated output: captured once, frozen, accepted by Core, and promoted in the session head. */
class DeliveryOutput {
  private busy = false;

  constructor(private readonly delivery: {
    inputs: AuthorizedInputs;
    source: SourceWorkspace;
    outputHead: NativeOutputSessionHeadStore;
    git: NativeGitTool;
    outputClient: () => NativeOutputClient;
    mutate: Mutate;
    claimIdOf: (assignment: RemoteWorkAssignment) => string | null;
  }) {}

  async deliver(authority: DeliveryAuthority, completion?: SessionToCoreMessage): Promise<DeliveredOutput | null> {
    if (this.busy) throw unavailable();
    this.busy = true;
    try {
      return await this.deliverOnce(authority, completion);
    } finally {
      this.busy = false;
    }
  }

  private async deliverOnce(authority: DeliveryAuthority, completion: SessionToCoreMessage | undefined): Promise<DeliveredOutput | null> {
    const { inputs, mutate } = this.delivery;
    await this.authorizeFor(authority);
    const store = this.store(authority);
    const prior = await mutate(() => store.read());
    if (prior && !this.matches(prior.candidate, authority)) throw unavailable();
    if (prior?.state === "accepted") {
      await mutate(() => this.delivery.outputHead.promote({ invocationId: authority.invocationRef, claimId: inputs.claimId }));
      return { receipt: prior.receipt, completion: prior.completion };
    }
    if (!prior && !completion) return null;
    return this.accept(store, prior ?? await this.capture(store, authority, completion!), authority);
  }

  private async authorizeFor(authority: DeliveryAuthority): Promise<void> {
    if (authority.claimId !== this.delivery.inputs.claimId) throw unavailable();
    await this.delivery.inputs.authorize();
  }

  private store(authority: DeliveryAuthority): NativeOutputStore {
    return this.delivery.outputHead.record({ invocationId: authority.invocationRef, claimId: this.delivery.inputs.claimId });
  }

  /** Capture the worktree's output between two verifications and freeze it as pending, under a fresh authorization. */
  private async capture(store: NativeOutputStore, authority: DeliveryAuthority, completion: SessionToCoreMessage): Promise<NativeOutputRecord | null> {
    const { inputs, source, mutate } = this.delivery;
    await mutate(() => this.delivery.outputHead.begin({ invocationId: authority.invocationRef, claimId: inputs.claimId }));
    await source.verify();
    const captured = await captureNativeDeliveryOutput({
      cwd: source.cwd,
      gitExecutable: this.delivery.git.executable,
      baselineCommit: source.baselineCommit!,
      binding: inputs.selection.binding,
      claimId: inputs.claimId,
      invocationRef: authority.invocationRef,
      inputSelectionDigest: inputs.digest,
      baseRevision: inputs.selection.source.revision,
    });
    await source.verify();
    await inputs.authorize();
    await mutate(() => store.savePending(captured, completion));
    return mutate(() => store.read());
  }

  private async accept(store: NativeOutputStore, prior: NativeOutputRecord | null, authority: DeliveryAuthority): Promise<DeliveredOutput> {
    const { inputs, mutate } = this.delivery;
    if (!prior || !this.matches(prior.candidate, authority)) throw unavailable();
    await inputs.authorize();
    const receipt = await this.delivery.outputClient().accept(inputs.current, prior.candidate);
    await mutate(() => store.saveAccepted(prior.candidate, receipt));
    await mutate(() => this.delivery.outputHead.promote({ invocationId: authority.invocationRef, claimId: inputs.claimId }));
    if (this.delivery.claimIdOf(inputs.current) !== inputs.claimId) throw unavailable();
    return { receipt, completion: prior.completion };
  }

  private matches(candidate: { claimId: string; invocationRef: string; inputSelectionDigest: string; baseRevision: string }, authority: DeliveryAuthority): boolean {
    const { inputs } = this.delivery;
    return candidate.claimId === inputs.claimId &&
      candidate.invocationRef === authority.invocationRef &&
      candidate.inputSelectionDigest === inputs.digest &&
      candidate.baseRevision === inputs.selection.source.revision &&
      canonicalize((candidate as { binding?: unknown }).binding as never) === canonicalize(inputs.selection.binding as never);
  }
}

function harnessTurnOf(assignment: RemoteWorkAssignment) {
  return assignment.kind === "delivery" && assignment.source.kind === "harness_delivery" ? assignment.source.turn : undefined;
}

function skillInstructions(assignment: RemoteWorkAssignment, repository: unknown, instructions: string): string {
  if (continuedSession(assignment.source) !== null) return instructions;
  return [
    repository
      ? "This is an isolated agent worktree backed by the connector's shared repository object cache at the exact Core-authorized revision. Do not change connector-owned Git configuration, remotes, attributes or hooks."
      : "This private Git repository starts from a generated local input baseline during the file-tree transition. Cloud retains the authoritative source revision, result acceptance and PR publication. Do not change connector-owned Git configuration, attributes or hooks.",
    instructions,
  ]
    .filter(Boolean)
    .join("\n");
}

function failureFields(error: unknown, fallback: string): { code: string; diagnostic?: string } {
  return {
    code: error instanceof RemoteInstanceError ? error.code : fallback,
    ...(error instanceof RemoteInstanceError && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
  };
}

/** One assignment's input preparation, stage by stage, each stage logged as it finishes. */
class InputPreparation {
  stage = "claim";
  private stageStartedAt = Date.now();

  constructor(
    private readonly options: NativeInputPreparerOptions,
    private readonly mutate: Mutate,
    private readonly wiring: ToolWiring,
    private readonly assignment: RemoteWorkAssignment,
  ) {}

  /** One line per finished stage, so a slow bootstrap says where. */
  readonly logStage: StageLog = (name, durationMs, extra = {}) =>
    this.options.logger?.info?.({ event: "native.bootstrap.stage", parent: "input_preparation", stage: name,
      assignmentId: this.assignment.id, attempt: this.assignment.attempt, durationMs, ...extra }, "native input stage finished");

  async prepare(): Promise<PreparedSessionInputs> {
    const current = RemoteWorkAssignmentSchema.parse(this.assignment);
    const claimId = this.options.claimId(current);
    if (!claimId) throw unavailable();
    const client = this.options.client();
    this.enter("selection");
    const inputs = new AuthorizedInputs(this.options, client, current, claimId, await client.prepare(current, claimId));
    this.logStage("selection", this.elapsed());
    // A direct session works in its own empty private folder only; a
    // repository for it is a later decision.
    const direct = isDirectAssignment(current);
    if (direct && inputs.selection.repository) throw unavailable();
    this.stage = "private_root";
    const root = await privateRoot(this.options.root);
    this.enter("source_workspace");
    const wiringOf: { task?: Promise<void> } = {};
    const source = await this.sourceWorkspace(inputs, root, wiringOf);
    this.enter("organization_skills");
    const prepared = await this.skills(inputs, root, source.cwd, direct);
    this.logStage("skills", this.elapsed());
    this.enter("source_verification");
    await source.verify();
    this.logStage("verify", this.elapsed());
    const outputHead = await this.outputHead(inputs, root);
    return {
      ...prepared,
      skillInstructions: skillInstructions(current, inputs.selection.repository, prepared.skillInstructions),
      beforePrompt: this.beforePrompt(inputs, source, prepared),
      ...this.deliveryOutput(inputs, source, outputHead),
      ...(wiringOf.task ? { toolWiring: wiringOf.task } : {}),
    };
  }

  logFailure(error: unknown): void {
    this.options.logger?.warn(
      {
        event: "native.inputs.prepare_failed",
        stage: this.stage,
        assignmentId: this.assignment.id,
        attempt: this.assignment.attempt,
        instanceId: this.assignment.instanceId,
        ...failureFields(error, "local_preparation_failed"),
      },
      "native input preparation failed",
    );
  }

  private enter(stage: string): void {
    this.stage = stage;
    this.stageStartedAt = Date.now();
  }

  private elapsed(): number {
    return Date.now() - this.stageStartedAt;
  }

  private async sourceWorkspace(inputs: AuthorizedInputs, root: string, wiringOf: { task?: Promise<void> }): Promise<SourceWorkspace> {
    const selected = inputs.selection.repository;
    const { repositoryCacheRoot, git } = this.options;
    if (selected && repositoryCacheRoot && git) return this.repositoryWorktree(inputs, root, { selected, cacheRoot: repositoryCacheRoot, git }, wiringOf);
    const workspace = await sourceWorkspace(
      root,
      inputs.envelope,
      () => inputs.read(inputs.selection.source.transferId),
      continuedSession(inputs.current.source) === null,
      git,
    );
    this.logStage("worktree", this.elapsed());
    return workspace;
  }

  private async repositoryWorktree(
    inputs: AuthorizedInputs,
    root: string,
    repository: { selected: NonNullable<RemoteAssignmentInputsEnvelope["selection"]["repository"]>; cacheRoot: string; git: NativeGitTool },
    wiringOf: { task?: Promise<void> },
  ): Promise<SourceWorkspace> {
    const fetched: { record?: { bytes: number; durationMs: number } } = {};
    const repositoryWorkspace = inputs.selection.repositoryWorkspace;
    const worktree = await new NativeRepositoryCache({
      root: repository.cacheRoot,
      tool: repository.git,
      fetchRevision: context => this.fetchRevision(inputs, root, repository.git, context, fetched),
    }).prepare({
      repositoryId: repository.selected.repositoryId,
      revision: repository.selected.revision,
      agentWorkspaceRoot: root,
      // One agent-owned worktree follows the durable ACP session, not an
      // individual correction/review assignment. Generator and QA have
      // distinct session ids, while repeated turns reuse their own edits and
      // only fetch missing objects into the shared bare repository cache.
      worktreeId: inputs.selection.binding.sessionId,
      ...(repositoryWorkspace ? { mode: repositoryWorkspace.mode } : {}),
    });
    const fetchMs = fetched.record?.durationMs ?? 0;
    this.logStage("repository_fetch", fetchMs, { cacheHit: fetched.record === undefined, bytes: fetched.record?.bytes ?? 0 });
    this.logStage("worktree", this.elapsed() - fetchMs);
    // Optional and slow (a full index build): run it while skills,
    // verification, capability redemption and the facade proceed.
    if (this.options.prepareRepositoryWorktree) {
      wiringOf.task = this.wiring.start(worktree.cwd, inputs.current.agentRoute.agentId, repository.selected.repositoryId, this.logStage);
    }
    return { cwd: worktree.cwd, container: worktree.cwd, baselineCommit: worktree.baselineCommit, verify: worktree.verify };
  }

  /** Fetch the signed revision's bundle through Core into the private bare repository. */
  private async fetchRevision(
    inputs: AuthorizedInputs,
    root: string,
    git: NativeGitTool,
    context: { gitDir: string; revision: string; haveRevisions: string[] },
    fetched: { record?: { bytes: number; durationMs: number } },
  ): Promise<void> {
    const fetchStartedAt = Date.now();
    const bundle = await inputs.fetchRepository(context.haveRevisions);
    const record = { bytes: bundle.byteLength, durationMs: 0 };
    fetched.record = record;
    const bundleDir = await mkdtemp(join(root, ".repository-bundle-"));
    await chmod(bundleDir, 0o700);
    const bundlePath = join(bundleDir, "source.bundle");
    await writePrivate(bundlePath, Buffer.from(bundle));
    try {
      await fetchBundle(git, context.gitDir, bundlePath, context.revision);
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
      record.durationMs = Date.now() - fetchStartedAt;
    }
  }

  /** No skills and no instructions for a direct session: the person's text reaches the agent as typed. */
  private skills(inputs: AuthorizedInputs, root: string, cwd: string, direct: boolean): Promise<PreparedSessionInputs> {
    if (direct) return prepareDirectSessionInputs({ cwd, binding: inputs.selection.binding });
    return prepareOrganizationSkillSession({
      cwd,
      scratchRoot: join(root, "skills"),
      catalog: inputs.selection.skills,
      authority: { binding: inputs.selection.binding, catalogDigest: inputs.selection.skills.catalogDigest },
      now: () => this.options.clock.coreNow(),
      // Staging is local I/O between two authorizations: the envelope that
      // admitted these trees, and the recheck in `beforePrompt` that no
      // prompt can precede. Re-asking Core between file writes protected
      // nothing that recheck does not, and cost a full authority round trip
      // (several locked reads plus owner callbacks) per stage — ten per
      // turn, ~100 s before the agent even started.
      assertAuthorized: async () => undefined,
      fetchTree: (manifest) => inputs.read(manifest.transferId),
    });
  }

  /** A harness delivery turn's session head; a preserved worktree must still hold the accepted result Core expects. */
  private async outputHead(inputs: AuthorizedInputs, root: string): Promise<NativeOutputSessionHeadStore | undefined> {
    const harnessTurn = harnessTurnOf(inputs.current);
    const outputHead = harnessTurn ? new NativeOutputSessionHeadStore(root, inputs.selection.binding.sessionId) : undefined;
    const repositoryWorkspace = inputs.selection.repositoryWorkspace;
    if (repositoryWorkspace?.mode === "preserve" && repositoryWorkspace.expectedAcceptedResult) {
      if (!outputHead || !harnessTurn) throw unavailable();
      await outputHead.verifyExpected(repositoryWorkspace.expectedAcceptedResult, { invocationId: harnessTurn.invocationId, claimId: inputs.claimId });
    }
    return outputHead;
  }

  private deliveryOutput(inputs: AuthorizedInputs, source: SourceWorkspace, outputHead: NativeOutputSessionHeadStore | undefined): Partial<PreparedSessionInputs> {
    const { git, outputClient } = this.options;
    if (!(harnessTurnOf(inputs.current) !== undefined && source.baselineCommit && git && outputClient && outputHead)) return {};
    const output = new DeliveryOutput({ inputs, source, outputHead, git, outputClient, mutate: this.mutate, claimIdOf: this.options.claimId });
    return {
      acceptDeliveryOutput: async (authority: DeliveryAuthority & { completion: SessionToCoreMessage }) => {
        const result = await output.deliver(authority, authority.completion);
        if (!result) throw unavailable();
        return result.receipt;
      },
      resumeDeliveryOutput: async (authority: DeliveryAuthority) => output.deliver(authority),
    };
  }

  private beforePrompt(inputs: AuthorizedInputs, source: SourceWorkspace, prepared: PreparedSessionInputs): () => Promise<void> {
    let prompting = false;
    return () =>
      this.mutate(async () => {
        if (prompting) throw unavailable();
        prompting = true;
        try {
          await source.verify();
          await prepared.beforePrompt();
          // The one Core recheck between the envelope and the prompt.
          // After local verification, so a local failure costs no call.
          await inputs.authorize();
          await source.verify();
        } catch (error) {
          // The turn fails as unavailable either way; keep why.
          this.options.logger?.warn({ event: "native.inputs.recheck_failed", assignmentId: this.assignment.id,
            attempt: this.assignment.attempt, ...failureFields(error, "local_verification_failed") },
          "Inputs could not be rechecked before the prompt");
          throw unavailable();
        } finally {
          prompting = false;
        }
      });
  }
}

function fetchBundle(git: NativeGitTool, gitDir: string, bundlePath: string, revision: string): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(git.executable, ["--git-dir", gitDir, "fetch", "--no-tags", "--no-write-fetch-head", bundlePath,
      `+refs/konteks/source:refs/konteks/fetched/${revision}`], {
      env: { PATH: dirname(git.executable), GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true,
    }, error => error ? rejectPromise(unavailable()) : resolvePromise());
  });
}

/** Compose real signed/bounded input transport with source publication and full skill staging. */
export function createNativeInputPreparer(
  options: NativeInputPreparerOptions,
): (assignment: RemoteWorkAssignment) => Promise<PreparedSessionInputs> {
  const busy = new Set<string>();
  const mutate = options.mutate ?? unrestrictedStateMutation;
  const wiring = new ToolWiring(options, mutate);
  return (assignment) =>
    mutate(async () => {
      const key = assignment.id + ":" + assignment.attempt;
      if (busy.has(key)) throw unavailable();
      busy.add(key);
      const preparation = new InputPreparation(options, mutate, wiring, assignment);
      try {
        return await preparation.prepare();
      } catch (error) {
        preparation.logFailure(error);
        throw unavailable();
      } finally {
        busy.delete(key);
      }
    });
}
