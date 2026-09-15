import { createLogger, type Logger, type RepositoryRelocateReportInput } from "@konteks/remote-common";
import type { OnboardFacade, RelocationPlan } from "./facade.js";
import { refDigest, type GitAccess, type GitGap, type GitRemote, type OnboardScratch } from "./git.js";
import { cloneUrl, resolveRemote, type ManagedGitBinding, type RepositoryLocation } from "./remotes.js";

/**
 * The repository relocation worker (OB6 §3, graduation G6).
 *
 * The bytes move HERE, under a permit, as a mirror push: Core never sees the
 * code and the broker is never called. The worker's authority at each step is
 * Core's recorded step, which it re-reads rather than remembers — so a worker
 * that died after `sync` and before `verify` is reassigned, finds Core still at
 * `sync`, re-runs the mirror push (which is idempotent) and verifies, without
 * duplicating a single ref.
 *
 * `propose` proves access with `git ls-remote` on BOTH sides before anything is
 * frozen, and a side this machine cannot read is reported as
 * `credential_unavailable` with its remedy — never as an exception.
 */

export type RelocationStep = RelocationPlan["step"];

export interface RelocationOutcome {
  step: RelocationStep;
  disposition: "settled" | "refused" | "awaiting_core";
  /** Present when a side could not be read or a step failed. */
  gap?: GitGap;
  verification?: { refs: number; headShaByRef: string; verifiedAt: string };
}

export interface RelocationWorkerDeps {
  git: GitAccess;
  scratch: OnboardScratch;
  facade: OnboardFacade;
  managedBinding: () => ManagedGitBinding | null;
  now: () => string;
  /** Bounded wait for Core's own steps (freeze, the cutover permit). */
  wait?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  logger?: Logger;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLLS = 240;

export class RepositoryRelocationWorker {
  private readonly logger: Logger;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(private readonly deps: RelocationWorkerDeps) {
    this.logger = deps.logger ?? createLogger({ name: "onboard-relocation" });
    this.wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  }

  async run(relocationRef: string, assertCurrent: () => void = () => undefined): Promise<RelocationOutcome> {
    // Resume from Core's recorded step, never from a step we remember: the
    // reassigned worker and the one that died must agree, and only Core can
    // say. A worker that died after `sync` therefore finds `sync` and re-runs
    // it, which is safe because a mirror push is idempotent.
    let plan = await this.deps.facade.relocationStatus(relocationRef);
    if (plan.step === "propose") {
      const refused = await this.propose(plan, assertCurrent);
      if (refused) return refused;
      // `freeze` is Core's: it makes the source read-only before any byte moves.
      plan = await this.awaitStep(relocationRef, ["sync", "verify", "cutover", "settle"], assertCurrent);
    }
    if (plan.step === "freeze") plan = await this.awaitStep(relocationRef, ["sync", "verify", "cutover", "settle"], assertCurrent);
    if (plan.step === "propose" || plan.step === "freeze") return { step: plan.step, disposition: "awaiting_core" };

    if (plan.step === "sync" || plan.step === "verify") {
      const verified = await this.syncAndVerify(plan, assertCurrent);
      if (verified.disposition !== "settled") return verified;
      // The cutover permit is a named human's answer, raised in the session.
      plan = await this.awaitStep(relocationRef, ["cutover", "settle"], assertCurrent);
      if (plan.step !== "cutover" && plan.step !== "settle") return { step: plan.step, disposition: "awaiting_core" };
    }
    if (plan.step === "cutover") {
      const refused = await this.cutover(plan, assertCurrent);
      if (refused) return refused;
    }
    return this.settle(plan);
  }

  /**
   * `propose`: count the source's refs, confirm the target is empty, and prove
   * both sides are readable from this machine. Some providers pre-create a
   * target with a README, which is NOT empty — the check is `refs == 0`, never
   * an assumption about a freshly created repository.
   */
  private async propose(plan: RelocationPlan, assertCurrent: () => void): Promise<RelocationOutcome | null> {
    assertCurrent();
    const source = await this.deps.git.lsRemote(this.remote(plan.from));
    if (!source.ok) return this.refuse(plan, "propose", source.gap, "relocation_source_unreadable");
    const target = await this.deps.git.lsRemote(this.remote(plan.to));
    if (!target.ok) return this.refuse(plan, "propose", target.gap, "relocation_target_unreadable");
    if (target.value.length !== 0) {
      return this.refuse(
        plan,
        "propose",
        { code: "unavailable", remedy: "empty the target repository, or create an empty one, before moving into it" },
        "relocation_target_not_empty",
      );
    }
    // No `verification` here on purpose: the report carries one from `verify`
    // onward and nowhere earlier, so a digest can never be mistaken for proof
    // that the bytes moved. What `propose` proves is access and emptiness.
    this.logger.info({ relocationRef: plan.relocationRef, sourceRefs: source.value.length }, "both sides are readable and the target is empty");
    await this.report({ relocationRef: plan.relocationRef, step: "propose" });
    return null;
  }

  /**
   * `sync` then `verify`. A partial sync keeps the scratch: the retry is a
   * second `git push --mirror` from the mirror we already have, which is why it
   * must survive the failure.
   */
  private async syncAndVerify(plan: RelocationPlan, assertCurrent: () => void): Promise<RelocationOutcome> {
    const synced = await this.sync(plan, assertCurrent);
    if (synced) return synced;
    const verified = await this.verify(plan, assertCurrent);
    if (verified.disposition === "settled") return verified;
    // A mismatch re-runs sync exactly once, then fails open to the person.
    this.logger.warn({ relocationRef: plan.relocationRef }, "verification did not match; re-running the mirror push once");
    const resynced = await this.sync(plan, assertCurrent);
    if (resynced) return resynced;
    return this.verify(plan, assertCurrent);
  }

  private async sync(plan: RelocationPlan, assertCurrent: () => void): Promise<RelocationOutcome | null> {
    assertCurrent();
    const name = scratchName(plan.relocationRef);
    const existing = await this.deps.scratch.clones();
    if (!existing.includes(name)) {
      const directory = await this.deps.scratch.reserveClone(name);
      const mirror = await this.deps.git.cloneMirror(this.remote(plan.from), directory);
      if (!mirror.ok) return this.refuse(plan, "sync", mirror.gap, "relocation_source_mirror_failed");
    }
    assertCurrent();
    const push = await this.deps.git.pushMirror(`${this.deps.scratch.clonesRoot}/${name}`, this.remote(plan.to));
    if (!push.ok) {
      // The scratch stays: the retry pushes the mirror again rather than
      // cloning the source a second time.
      return this.refuse(plan, "sync", push.gap, "relocation_mirror_push_failed");
    }
    await this.report({ relocationRef: plan.relocationRef, step: "sync" });
    return null;
  }

  private async verify(plan: RelocationPlan, assertCurrent: () => void): Promise<RelocationOutcome> {
    assertCurrent();
    const source = await this.deps.git.lsRemote(this.remote(plan.from));
    if (!source.ok) return this.refuse(plan, "verify", source.gap, "relocation_source_unreadable");
    const target = await this.deps.git.lsRemote(this.remote(plan.to));
    if (!target.ok) return this.refuse(plan, "verify", target.gap, "relocation_target_unreadable");
    const verification = { refs: source.value.length, headShaByRef: refDigest(source.value), verifiedAt: this.deps.now() };
    if (target.value.length !== source.value.length || refDigest(target.value) !== verification.headShaByRef) {
      return { step: "verify", disposition: "refused", gap: { code: "unavailable", remedy: "the two sides do not carry the same refs yet" } };
    }
    await this.report({ relocationRef: plan.relocationRef, step: "verify", verification });
    return { step: "verify", disposition: "settled", verification };
  }

  /**
   * The permit has been answered. Both sides are re-verified against the stored
   * digest within the answer's window (gap R7): a moved writable source is
   * synced and verified once more, and a moved TARGET is refused outright —
   * something else wrote to it and the move is no longer the one approved.
   */
  private async cutover(plan: RelocationPlan, assertCurrent: () => void): Promise<RelocationOutcome | null> {
    assertCurrent();
    const target = await this.deps.git.lsRemote(this.remote(plan.to));
    if (!target.ok) return this.refuse(plan, "cutover", target.gap, "relocation_target_unreadable");
    if (plan.verification && refDigest(target.value) !== plan.verification.headShaByRef) {
      return this.refuse(
        plan,
        "cutover",
        { code: "unavailable", remedy: "the target changed after it was verified; propose the move again" },
        "relocation_target_diverged",
      );
    }
    const source = await this.deps.git.lsRemote(this.remote(plan.from));
    if (!source.ok) return this.refuse(plan, "cutover", source.gap, "relocation_source_unreadable");
    if (plan.verification && refDigest(source.value) !== plan.verification.headShaByRef) {
      // A source that stayed writable moved. Sync and verify once more rather
      // than cutting over to something that is now behind.
      const resynced = await this.sync(plan, assertCurrent);
      if (resynced) return resynced;
      const reverified = await this.verify(plan, assertCurrent);
      if (reverified.disposition !== "settled") return reverified;
      await this.report({ relocationRef: plan.relocationRef, step: "cutover", ...(reverified.verification ? { verification: reverified.verification } : {}) });
      return null;
    }
    await this.report({
      relocationRef: plan.relocationRef,
      step: "cutover",
      verification: { refs: source.value.length, headShaByRef: refDigest(source.value), verifiedAt: this.deps.now() },
    });
    return null;
  }

  /** `settle` removes the scratch. The source is retained; that is Core's act. */
  private async settle(plan: RelocationPlan): Promise<RelocationOutcome> {
    await this.deps.scratch.releaseClone(scratchName(plan.relocationRef));
    await this.report({ relocationRef: plan.relocationRef, step: "settle" });
    return { step: "settle", disposition: "settled" };
  }

  private async refuse(plan: RelocationPlan, step: RelocationStep, gap: GitGap, code: string): Promise<RelocationOutcome> {
    await this.report({ relocationRef: plan.relocationRef, step, error: { code: gap.code === "credential_unavailable" ? "credential_unavailable" : code, message: gap.remedy } });
    return { step, disposition: "refused", gap };
  }

  private async report(input: RepositoryRelocateReportInput): Promise<RelocationPlan> {
    return this.deps.facade.relocationReport(input);
  }

  /**
   * Wait for a step only Core can take (`freeze`, and the cutover permit a
   * named human answers). Bounded: a permit nobody answers releases the worker
   * rather than pinning the runtime, and the reassignment resumes from Core's
   * step.
   */
  private async awaitStep(relocationRef: string, steps: readonly RelocationStep[], assertCurrent: () => void): Promise<RelocationPlan> {
    let plan = await this.deps.facade.relocationStatus(relocationRef);
    for (let poll = 0; poll < this.maxPolls && !steps.includes(plan.step); poll += 1) {
      assertCurrent();
      await this.wait(this.pollIntervalMs);
      plan = await this.deps.facade.relocationStatus(relocationRef);
    }
    return plan;
  }

  private remote(endpoint: RelocationPlan["from"]): GitRemote {
    const location: RepositoryLocation = { url: endpoint.baseUrl, repoOwner: endpoint.repoOwner, repoName: endpoint.repoName };
    return resolveRemote({ ...location, url: cloneUrl(location) }, this.deps.managedBinding());
  }
}

function scratchName(relocationRef: string): string {
  return `relocation-${relocationRef}`;
}
