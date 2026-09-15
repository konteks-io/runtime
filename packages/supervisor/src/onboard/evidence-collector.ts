import { createLogger, sha256Hex, type CatalogLearningEvidence, type DiscoveryEvidenceSubmission, type DiscoveryInventoryItem, type DiscoveryRunBounds, type Logger } from "@konteks/remote-common";
import { evidenceCandidates, type EvidenceCandidate } from "./evidence-paths.js";
import { extractFacts, type ReadFile } from "./facts.js";
import type { OnboardFacade, OnboardRunView } from "./facade.js";
import { MAX_EVIDENCE_FILE_BYTES, type EvidenceReadPath, type RawFileApi } from "./raw-file-api.js";
import type { GitAccess, GitGap, GitRemote, OnboardScratch } from "./git.js";

/**
 * The evidence collector (OB6 §2). It reads a bounded, named set of files per
 * repository with the machine's own git, extracts facts locally, and submits
 * `DiscoveryEvidence` — refs, hashes, facts. It never submits a body, never
 * reads a file it cannot name in `refs`, and refuses a run whose bounds are
 * absent (ON30).
 *
 * Two depths land here:
 *
 * - `grouping` reads single files and performs **no clone**, which is why the
 *   scratch's `clones/` directory staying empty is a checkable proof;
 * - `deep` is a separate post-accept **enrichment** assignment per accepted
 *   System, bounded by an allowance Core computes and enforces, whose clones are
 *   removed as soon as their facts are out.
 */

export interface OnboardEvidenceCollectorDeps {
  git: GitAccess;
  rawFiles: Pick<RawFileApi, "read">;
  scratch: OnboardScratch;
  facade: OnboardFacade;
  /** Managed git is the one place the runtime's own key is the credential (A10). */
  resolveRemote: (item: DiscoveryInventoryItem) => GitRemote;
  /** Default 4 repositories in flight, so a laptop stays usable. */
  concurrency?: number;
  /** Batch size; progress is reported per batch so a closed laptop resumes. */
  batchSize?: number;
  logger?: Logger;
}

export const DEFAULT_ONBOARD_CONCURRENCY = 4;
const DEFAULT_BATCH_SIZE = 8;

/** What one repository's read produced, including what it could not read. */
export interface RepositoryEvidence {
  submission: DiscoveryEvidenceSubmission;
  /** Which path produced each ref (OB6 gotcha); diagnostics, never submitted. */
  readPaths: Record<string, EvidenceReadPath>;
  /** Ordinary evidence gaps, never exceptions: a side we could not read. */
  gaps: GitGap[];
}

export interface GroupingOutcome {
  submitted: number;
  /** Canonical keys the machine's git could not read at all. */
  unreadable: Array<{ canonicalKey: string; gap: GitGap }>;
}

export interface EnrichmentScope {
  systemRef: string;
  /** `min(remainingRunBudget, repositoriesOfSystem)`, computed by Core (gap R6). */
  allowance: number;
  /** Only the accepted System's repositories, in the order Core authorised them. */
  canonicalKeys: string[];
}

export interface EnrichmentOutcome {
  cloned: number;
  submitted: number;
  /** `budget_exhausted` when the allowance was 0: the assignment is done. */
  disposition: "completed" | "budget_exhausted";
}

export class OnboardEvidenceCollector {
  private readonly logger: Logger;
  private readonly concurrency: number;
  private readonly batchSize: number;

  constructor(private readonly deps: OnboardEvidenceCollectorDeps) {
    this.logger = deps.logger ?? createLogger({ name: "onboard-evidence" });
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_ONBOARD_CONCURRENCY);
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
  }

  /**
   * `grouping` depth over the whole inventory. Progress is the SUBMISSION of a
   * batch, not a counter we keep: a laptop that closes mid-run resumes from the
   * last batch Core accepted rather than from zero, and Core is the only place
   * that has to remember.
   */
  async collectGrouping(run: OnboardRunView, assertCurrent: () => void = () => undefined): Promise<GroupingOutcome> {
    const outcome: GroupingOutcome = { submitted: 0, unreadable: [] };
    let cursor: string | undefined;
    do {
      assertCurrent();
      const page = await this.deps.facade.inventoryList(run.runRef, cursor);
      // Skip what Core already holds. The cursor is Core's — a runtime that
      // kept its own would drift from the inventory it is paging — so resuming
      // means re-reading the pages and doing nothing for the repositories whose
      // evidence was already accepted, rather than reading them twice.
      const outstanding = page.items.filter(item => !item.collected);
      for (const batch of chunk(outstanding, this.batchSize)) {
        assertCurrent();
        const results = await mapWithConcurrency(batch, this.concurrency, item => this.readRepository(item, run.bounds));
        const submissions: DiscoveryEvidenceSubmission[] = [];
        for (const result of results) {
          if (result.submission.refs.length === 0 && result.gaps.length > 0) {
            // Nothing readable: the gap IS the evidence for this repository.
            outcome.unreadable.push({ canonicalKey: result.submission.canonicalKey, gap: result.gaps[0]! });
          }
          submissions.push(result.submission);
        }
        if (submissions.length > 0) {
          await this.deps.facade.evidenceSubmit(run.runRef, submissions);
          outcome.submitted += submissions.length;
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    // The proof the acceptance criteria ask for: a grouping pass clones nothing.
    const clones = await this.deps.scratch.clones();
    if (clones.length > 0) this.logger.warn({ clones: clones.length }, "a grouping pass left clones behind; the scratch should be empty");
    return outcome;
  }

  /**
   * `deep` enrichment for ONE accepted System (ON5, gap 4). Every clone is
   * announced to Core BEFORE it starts and reported `extracted` with its
   * submission, so Core's per-repository ledger is never behind what is on disk:
   * a clone that died before extraction is retried on the SAME budget instead of
   * being charged twice.
   */
  async runEnrichment(run: OnboardRunView, scope: EnrichmentScope, assertCurrent: () => void = () => undefined): Promise<EnrichmentOutcome> {
    if (scope.allowance <= 0) {
      // An allowance of 0 completes the assignment immediately; Core writes
      // `budget_exhausted` on the timeline. Nothing is cloned and nothing is
      // reported as failed, because nothing was ever authorised.
      return { cloned: 0, submitted: 0, disposition: "budget_exhausted" };
    }
    const keys = scope.canonicalKeys.slice(0, Math.min(scope.allowance, run.bounds.maxRepositoriesDeep));
    const byKey = new Map<string, DiscoveryInventoryItem>();
    let cursor: string | undefined;
    do {
      const page = await this.deps.facade.inventoryList(run.runRef, cursor);
      for (const item of page.items) if (keys.includes(item.canonicalKey)) byKey.set(item.canonicalKey, item);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && byKey.size < keys.length);

    const outcome: EnrichmentOutcome = { cloned: 0, submitted: 0, disposition: "completed" };
    for (const batch of chunk(keys, this.concurrency)) {
      assertCurrent();
      const submissions = await mapWithConcurrency(batch, this.concurrency, async key => {
        const item = byKey.get(key);
        if (!item) return null;
        return this.enrichOne(run, item, outcome, assertCurrent);
      });
      const ready = submissions.filter((entry): entry is DiscoveryEvidenceSubmission => entry !== null);
      if (ready.length > 0) {
        await this.deps.facade.enrichmentSubmit(run.runRef, scope.systemRef, ready);
        outcome.submitted += ready.length;
        for (const submission of ready) {
          await this.deps.facade.enrichmentProgress(run.runRef, { canonicalKey: submission.canonicalKey, state: "extracted" });
        }
      }
    }
    return outcome;
  }

  private async enrichOne(
    run: OnboardRunView,
    item: DiscoveryInventoryItem,
    outcome: EnrichmentOutcome,
    assertCurrent: () => void,
  ): Promise<DiscoveryEvidenceSubmission | null> {
    // BEFORE the clone, always. Reporting after would leave Core's ledger
    // behind a directory that already exists on this disk.
    await this.deps.facade.enrichmentProgress(run.runRef, { canonicalKey: item.canonicalKey, state: "cloning" });
    assertCurrent();
    const directory = await this.deps.scratch.reserveClone(item.canonicalKey);
    try {
      const clone = await this.deps.git.cloneShallow(this.deps.resolveRemote(item), directory);
      if (!clone.ok) {
        await this.deps.facade.enrichmentProgress(run.runRef, { canonicalKey: item.canonicalKey, state: "failed" });
        return null;
      }
      outcome.cloned += 1;
      const files: ReadFile[] = [];
      const refs: CatalogLearningEvidence[] = [];
      for (const candidate of evidenceCandidates(item.repoName, run.bounds.maxFilesPerRepository)) {
        const body = await this.deps.scratch.readCloned(item.canonicalKey, candidate.path, MAX_EVIDENCE_FILE_BYTES);
        if (!body) continue;
        files.push({ candidate, body });
        refs.push(evidenceRef(item, candidate, body));
      }
      return { canonicalKey: item.canonicalKey, refs, facts: extractFacts(files) };
    } finally {
      // Clones are removed after extraction, every path out.
      await this.deps.scratch.releaseClone(item.canonicalKey);
    }
  }

  /**
   * One repository at `grouping` depth: at most `maxFilesPerRepository` named
   * single-file reads, `git archive --remote` first and the provider's raw-file
   * API when the host refuses it — recording which path produced each ref.
   */
  private async readRepository(item: DiscoveryInventoryItem, bounds: DiscoveryRunBounds): Promise<RepositoryEvidence> {
    const remote = this.deps.resolveRemote(item);
    const files: ReadFile[] = [];
    const refs: CatalogLearningEvidence[] = [];
    const readPaths: Record<string, EvidenceReadPath> = {};
    const gaps: GitGap[] = [];
    for (const candidate of evidenceCandidates(item.repoName, bounds.maxFilesPerRepository)) {
      const archive = await this.deps.git.archiveFile(remote, item.defaultBranch, candidate.path, this.deps.scratch.archivePath(`${item.canonicalKey}-${candidate.path}`));
      let body: Buffer | null = null;
      let via: EvidenceReadPath = "git_archive";
      if (archive.ok) {
        body = archive.value;
      } else if (archive.gap.code !== "credential_unavailable") {
        // `git archive --remote` is disabled on GitHub and on plenty of
        // self-hosted installs. A refusal that is not a credential problem is a
        // reason to try the raw-file API, not a reason to give up on the file.
        const raw = await this.deps.rawFiles.read({
          provider: item.provider,
          url: item.url,
          repoOwner: item.repoOwner,
          repoName: item.repoName,
          ref: item.defaultBranch,
          path: candidate.path,
        });
        if (raw.ok) {
          body = raw.value;
          via = "raw_file_api";
        } else if (raw.gap.code !== "not_found") {
          gaps.push(raw.gap);
        }
      } else {
        gaps.push(archive.gap);
        // A machine that cannot authenticate to this host will not authenticate
        // for the next path either; stop spending reads on it.
        break;
      }
      if (!body) continue;
      files.push({ candidate, body });
      const ref = evidenceRef(item, candidate, body);
      refs.push(ref);
      readPaths[ref.ref] = via;
    }
    // Which path produced each ref is a fact about the run (OB6 gotcha): a
    // portfolio read entirely through `git archive` and one that fell back for
    // half its repositories are different things to have measured.
    this.logger.debug({
      canonicalKey: item.canonicalKey,
      refs: refs.length,
      viaArchive: Object.values(readPaths).filter(via => via === "git_archive").length,
      viaRawFileApi: Object.values(readPaths).filter(via => via === "raw_file_api").length,
      gaps: gaps.length,
    }, "read a repository's evidence");
    return { submission: { canonicalKey: item.canonicalKey, refs, facts: extractFacts(files) }, readPaths, gaps };
  }
}

/**
 * A ref names the file this fact came from and proves which bytes were read.
 * It is the ONLY thing about a file that leaves the machine besides the facts.
 */
export function evidenceRef(item: Pick<DiscoveryInventoryItem, "canonicalKey" | "defaultBranch">, candidate: EvidenceCandidate, body: Buffer): CatalogLearningEvidence {
  return {
    ref: `${item.canonicalKey}@${item.defaultBranch}:${candidate.path}`,
    kind: candidate.kind,
    path: candidate.path,
    sha256: sha256Hex(body),
  };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}

/** Bounded fan-out; the host is somebody's laptop, not a build fleet. */
async function mapWithConcurrency<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
