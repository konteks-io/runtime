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
  prepareOrganizationSkillSession,
  type PreparedSessionInputs,
} from "../skills/session-inputs.js";
import type { NativeInputClient } from "./input-client.js";
import type { NativeOutputClient } from "./output-client.js";
import { captureNativeDeliveryOutput } from "./output-capture.js";
import { NativeOutputSessionHeadStore } from "./output-store.js";
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
  outputClient?: () => NativeOutputClient;
  logger?: Pick<Logger, "warn">;
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
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw unavailable();
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) || stat.uid !== process.getuid?.())
  )
    throw unavailable();
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
    let count = 0;
    while (count < buffer.length) {
      const next = await handle.read(buffer, count, buffer.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    if (count !== stat.size) throw unavailable();
    return ReceiptSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))),
    );
  } finally {
    await handle.close();
  }
}

/** Mutable work is separate from its immutable selection receipt and pinned skill trees. */
async function sourceWorkspace(
  root: string,
  envelope: RemoteAssignmentInputsEnvelope,
  fetchSource: () => ReturnType<NativeInputClient["read"]>,
  needsGit: boolean,
  gitTool?: NativeGitTool,
) {
  if (needsGit && !gitTool) throw unavailable();
  const rootStat = await sameDirectory(root);
  const selection = envelope.selection;
  const { binding } = selection;
  // A conversation's workspace is the SESSION's, so its path is stable across
  // turns: the local agent's own per-directory memory survives, and a
  // continued ACP session keeps the cwd it was created with. A delivery keeps
  // a per-assignment checkout, because the agent commits into it.
  const destination = join(
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
  const expected = {
    version: 1 as const,
    selectionDigest: envelope.selectionDigest,
    source: selection.source,
    claimId: selection.claimId,
  };
  const cwd = join(destination, "source");
  let exists = true;
  try {
    await lstat(destination);
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) exists = false;
    else throw error;
  }
  if (exists && !needsGit) {
    // Same session, newer inputs: refresh the contents under the same path
    // rather than refusing. The snapshot is Core's, not the agent's work.
    // Materialization is temp-dir + atomic rename, so a directory that exists
    // is complete; a receipt that will not parse is tampering or corruption,
    // and that still refuses rather than being quietly rebuilt over.
    await sameDirectory(destination);
    const receipt = await readReceipt(join(destination, "receipt.json"));
    if (receipt.selectionDigest !== expected.selectionDigest) {
      // A different selection under the SAME claim is a substitution inside
      // one turn, not newer inputs: refuse, and leave local work untouched.
      if (receipt.claimId === selection.claimId) throw unavailable();
      await sameDirectory(root, rootStat);
      await rm(destination, { recursive: true, force: true });
      exists = false;
    }
  }
  if (!exists) {
    const tree = await fetchSource();
    // Never import a repository's configuration, hooks, worktree pointer or NTFS alias.
    if (
      tree.entries.some((entry) =>
        entry.path.split("/").some((part) => /^(?:\.git|git~[0-9]+)$/i.test(part)),
      )
    )
      throw unavailable();
    await sameDirectory(root, rootStat);
    let temporary: string | undefined = await mkdtemp(join(root, ".input-"));
    await chmod(temporary, 0o700);
    const temporaryStat = await sameDirectory(temporary);
    try {
      const source = join(temporary, "source");
      await mkdir(source, { mode: 0o700 });
      const directories = new Set([source]);
      for (const entry of tree.entries) {
        const path = join(source, ...entry.path.split("/"));
        await writePrivate(path, Buffer.from(entry.contentBase64, "base64"), entry.mode);
        for (let directory = dirname(path); directory !== source; directory = dirname(directory))
          directories.add(directory);
      }
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
      await sameDirectory(root, rootStat);
      await sameDirectory(temporary, temporaryStat);
      try {
        await rename(temporary, destination);
        temporary = undefined;
      } catch (error) {
        if (!isFsErrorWithCode(error, "EEXIST") && !isFsErrorWithCode(error, "ENOTEMPTY"))
          throw error;
      }
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
  const published = await readReceipt(join(destination, "receipt.json"));
  return {
    cwd,
    container: destination,
    verify,
    ...(published.git ? { baselineCommit: published.git.baseCommit } : {}),
  };
}

/** Compose real signed/bounded input transport with source publication and full skill staging. */
export function createNativeInputPreparer(
  options: NativeInputPreparerOptions,
): (assignment: RemoteWorkAssignment) => Promise<PreparedSessionInputs> {
  const busy = new Set<string>();
  const mutate = options.mutate ?? unrestrictedStateMutation;
  return (assignment) =>
    mutate(async () => {
      const key = assignment.id + ":" + assignment.attempt;
      if (busy.has(key)) throw unavailable();
      busy.add(key);
      let stage = "claim";
      try {
        const current = RemoteWorkAssignmentSchema.parse(assignment);
        const claimId = options.claimId(current);
        if (!claimId) throw unavailable();
        const client = options.client();
        stage = "selection";
        let envelope = await client.prepare(current, claimId);
        const selection = structuredClone(envelope.selection),
          digest = envelope.selectionDigest;
        const authorize = async () => {
          if (options.claimId(current) !== claimId) throw unavailable();
          envelope = await client.prepare(current, claimId, digest);
          if (options.claimId(current) !== claimId) throw unavailable();
        };
        stage = "private_root";
        const root = await privateRoot(options.root);
        stage = "source_workspace";
        const selectedRepository = selection.repository;
        const repositoryWorkspace = selection.repositoryWorkspace;
        const source = selectedRepository && options.repositoryCacheRoot && options.git
          ? await new NativeRepositoryCache({
              root: options.repositoryCacheRoot!,
              tool: options.git,
              fetchRevision: async ({ gitDir, revision, haveRevisions }) => {
                const bundle = await client.fetchRepository(current, claimId, envelope, haveRevisions);
                const bundleDir = await mkdtemp(join(root, ".repository-bundle-"));
                await chmod(bundleDir, 0o700);
                const bundlePath = join(bundleDir, "source.bundle");
                await writePrivate(bundlePath, Buffer.from(bundle));
                try {
                  await new Promise<void>((resolvePromise, rejectPromise) => {
                    execFile(options.git!.executable, ["--git-dir", gitDir, "fetch", "--no-tags", "--no-write-fetch-head", bundlePath,
                      `+refs/konteks/source:refs/konteks/fetched/${revision}`], {
                      env: { PATH: dirname(options.git!.executable), GIT_CONFIG_NOSYSTEM: "1",
                        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" },
                      timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true,
                    }, error => error ? rejectPromise(unavailable()) : resolvePromise());
                  });
                } finally {
                  await rm(bundleDir, { recursive: true, force: true });
                }
              },
            }).prepare({
              repositoryId: selectedRepository.repositoryId,
              revision: selectedRepository.revision,
              agentWorkspaceRoot: root,
              // One agent-owned worktree follows the durable ACP session, not
              // an individual correction/review assignment. Generator and QA
              // have distinct session ids, while repeated turns reuse their
              // own edits and only fetch missing objects into the shared bare
              // repository cache.
              worktreeId: selection.binding.sessionId,
              ...(repositoryWorkspace ? { mode: repositoryWorkspace.mode } : {}),
            }).then(worktree => ({ cwd: worktree.cwd, container: worktree.cwd,
              baselineCommit: worktree.baselineCommit, verify: worktree.verify }))
          : await sourceWorkspace(
              root,
              envelope,
              () => client.read(current, claimId, envelope, selection.source.transferId),
              current.source.kind !== "conversation",
              options.git,
            );
        stage = "organization_skills";
        const prepared = await prepareOrganizationSkillSession({
          cwd: source.cwd,
          scratchRoot: join(root, "skills"),
          catalog: selection.skills,
          authority: { binding: selection.binding, catalogDigest: selection.skills.catalogDigest },
          now: () => options.clock.coreNow(),
          // Staging is local I/O between two authorizations: the envelope that
          // admitted these trees, and the recheck in `beforePrompt` that no
          // prompt can precede. Re-asking Core between file writes protected
          // nothing that recheck does not, and cost a full authority round trip
          // (several locked reads plus owner callbacks) per stage — ten per
          // turn, ~100 s before the agent even started.
          assertAuthorized: async () => undefined,
          fetchTree: (manifest) => client.read(current, claimId, envelope, manifest.transferId),
        });
        stage = "source_verification";
        await source.verify();
        const harnessTurn = current.kind === "delivery" && current.source.kind === "harness_delivery"
          ? current.source.turn
          : undefined;
        const outputHead = harnessTurn
          ? new NativeOutputSessionHeadStore(root, selection.binding.sessionId)
          : undefined;
        if (repositoryWorkspace?.mode === "preserve" && repositoryWorkspace.expectedAcceptedResult) {
          const expected = repositoryWorkspace.expectedAcceptedResult;
          if (!outputHead) throw unavailable();
          if (!harnessTurn) throw unavailable();
          await outputHead.verifyExpected(expected, { invocationId: harnessTurn.invocationId, claimId });
        }
        let prompting = false;
        let outputBusy = false;
        const deliverOutput =
          current.kind === "delivery" && current.source.kind === "harness_delivery" &&
          source.baselineCommit &&
          options.git &&
          options.outputClient
            ? async (
                authority: { claimId: string; invocationRef: string },
                completion?: SessionToCoreMessage,
              ): Promise<{
                receipt: RemoteDeliveryAcceptanceReceipt;
                completion: SessionToCoreMessage;
              } | null> => {
                if (outputBusy) throw unavailable();
                outputBusy = true;
                try {
                  if (authority.claimId !== claimId) throw unavailable();
                  await authorize();
                  const store = outputHead!.record({
                    invocationId: authority.invocationRef,
                    claimId,
                  });
                  let prior = await mutate(() => store.read());
                  const matches = (candidate: {
                    claimId: string;
                    invocationRef: string;
                    inputSelectionDigest: string;
                    baseRevision: string;
                  }) =>
                    candidate.claimId === claimId &&
                    candidate.invocationRef === authority.invocationRef &&
                    candidate.inputSelectionDigest === digest &&
                    candidate.baseRevision === selection.source.revision &&
                    canonicalize((candidate as { binding?: unknown }).binding as never) ===
                      canonicalize(selection.binding as never);
                  if (prior && !matches(prior.candidate)) throw unavailable();
                  if (prior?.state === "accepted") {
                    await mutate(() => outputHead!.promote({ invocationId: authority.invocationRef, claimId }));
                    return { receipt: prior.receipt, completion: prior.completion };
                  }
                  if (!prior && !completion) return null;
                  if (!prior) {
                    await mutate(() => outputHead!.begin({ invocationId: authority.invocationRef, claimId }));
                    await source.verify();
                    const captured = await captureNativeDeliveryOutput({
                      cwd: source.cwd,
                      gitExecutable: options.git!.executable,
                      baselineCommit: source.baselineCommit!,
                      binding: selection.binding,
                      claimId,
                      invocationRef: authority.invocationRef,
                      inputSelectionDigest: digest,
                      baseRevision: selection.source.revision,
                    });
                    await source.verify();
                    await authorize();
                    await mutate(() => store.savePending(captured, completion!));
                    prior = await mutate(() => store.read());
                  }
                  if (!prior || !matches(prior.candidate)) throw unavailable();
                  await authorize();
                  const receipt = await options.outputClient!().accept(current, prior.candidate);
                  await mutate(() => store.saveAccepted(prior!.candidate, receipt));
                  await mutate(() => outputHead!.promote({ invocationId: authority.invocationRef, claimId }));
                  if (options.claimId(current) !== claimId) throw unavailable();
                  return { receipt, completion: prior.completion };
                } finally {
                  outputBusy = false;
                }
              }
            : undefined;
        const acceptDeliveryOutput = deliverOutput
          ? async (authority: {
              claimId: string;
              invocationRef: string;
              completion: SessionToCoreMessage;
            }) => {
              const result = await deliverOutput(authority, authority.completion);
              if (!result) throw unavailable();
              return result.receipt;
            }
          : undefined;
        const resumeDeliveryOutput = deliverOutput
          ? async (authority: { claimId: string; invocationRef: string }) =>
              deliverOutput(authority)
          : undefined;
        return {
          ...prepared,
          skillInstructions:
            current.source.kind === "conversation"
              ? prepared.skillInstructions
              : [
                  selectedRepository
                    ? "This is an isolated agent worktree backed by the connector's shared repository object cache at the exact Core-authorized revision. Do not change connector-owned Git configuration, remotes, attributes or hooks."
                    : "This private Git repository starts from a generated local input baseline during the file-tree transition. Cloud retains the authoritative source revision, result acceptance and PR publication. Do not change connector-owned Git configuration, attributes or hooks.",
                  prepared.skillInstructions,
                ]
                  .filter(Boolean)
                  .join("\n"),
          beforePrompt: () =>
            mutate(async () => {
              if (prompting) throw unavailable();
              prompting = true;
              try {
                await source.verify();
                await prepared.beforePrompt();
                // The one Core recheck between the envelope and the prompt.
                // After local verification, so a local failure costs no call.
                await authorize();
                await source.verify();
              } catch {
                throw unavailable();
              } finally {
                prompting = false;
              }
            }),
          ...(acceptDeliveryOutput && resumeDeliveryOutput
            ? { acceptDeliveryOutput, resumeDeliveryOutput }
            : {}),
        };
      } catch (error) {
        options.logger?.warn(
          {
            event: "native.inputs.prepare_failed",
            stage,
            assignmentId: assignment.id,
            attempt: assignment.attempt,
            instanceId: assignment.instanceId,
            code: error instanceof RemoteInstanceError ? error.code : "local_preparation_failed",
            ...(error instanceof RemoteInstanceError && error.diagnostic
              ? { diagnostic: error.diagnostic }
              : {}),
          },
          "native input preparation failed",
        );
        throw unavailable();
      } finally {
        busy.delete(key);
      }
    });
}
