import { z } from "zod";
import { RemoteInstanceError, createLogger, jcsDigest, type BoundedJsonValue, type JsonValue, type Logger, type RemoteWorkAssignment } from "@konteks/remote-common";
import type { PlatformMcpEntry, WorkloadDefinition } from "../work/workload.js";
import { McpOnboardFacade, requireBounds, type OnboardFacade, type OnboardRunView } from "./facade.js";
import { OnboardEvidenceCollector, type EnrichmentScope, type OnboardEvidenceCollectorDeps } from "./evidence-collector.js";
import { RepositoryRelocationWorker, type RelocationWorkerDeps } from "./relocation-worker.js";

/**
 * Where an onboard assignment goes (OB6 §2, §3).
 *
 * `onboarding` is the one work kind that carries two sources. A `conversation`
 * source is a session turn and takes the ordinary relayed ACP path, exactly as
 * an ops turn does. A `discovery_run` source is the run's own evidence or deep
 * enrichment, and a `repository_relocation` assignment is the mirror: both are
 * deterministic local git work with no model in the loop, so they run HERE and
 * never open an ACP session.
 *
 * Routing therefore keys on the SOURCE, not on the kind. Keying on the kind
 * would send a session turn to the collector.
 */
export type OnboardWorkAssignment = RemoteWorkAssignment & { kind: "onboarding" | "repository_relocation" };

export function isOnboardWorkAssignment(assignment: RemoteWorkAssignment): assignment is OnboardWorkAssignment {
  if (assignment.kind === "repository_relocation") return true;
  return assignment.kind === "onboarding" && assignment.source.kind === "discovery_run";
}

/**
 * CONTRACT-GAP: OB2 §3b puts `enrichment: {systemRef, allowance}` "on the
 * assignment", but OB1's `discovery_run` source carries only `runRef` — a
 * source is the thing that survives re-placement, and an allowance is not. The
 * scope is read instead from Core's existing definition-of-claimed-work route
 * (`GET …/assignments/:id/workload`), which is where every other kind reads the
 * definition an assignment does not carry.
 */
export const OnboardWorkloadSchema = z
  .object({
    depth: z.enum(["inventory", "grouping", "deep"]).optional(),
    enrichment: z
      .object({
        systemRef: z.string().min(1).max(512),
        allowance: z.number().int().nonnegative().max(200),
        canonicalKeys: z.array(z.string().min(1).max(512)).max(200),
      })
      .strict()
      .optional(),
  });
export type OnboardWorkload = z.infer<typeof OnboardWorkloadSchema>;

export interface OnboardCarrierDeps {
  /** Everything the collector needs except the facade, which is per-claim. */
  collector: Omit<OnboardEvidenceCollectorDeps, "facade">;
  relocation: Omit<RelocationWorkerDeps, "facade">;
  /** The redeemed platform MCP entry for this claim; the only Core credential. */
  redeemFacade: (assignment: OnboardWorkAssignment) => Promise<PlatformMcpEntry | undefined>;
  /** Core's definition of the claimed work; carries the enrichment scope. */
  fetchWorkload: (assignment: OnboardWorkAssignment) => Promise<WorkloadDefinition>;
  /** Injected in tests; production composes an MCP client over the entry. */
  createFacade?: (entry: PlatformMcpEntry) => OnboardFacade;
  logger?: Logger;
}

/** What the orchestrator turns into a terminal report. */
export interface OnboardWorkOutcome {
  structuredOutput: BoundedJsonValue;
}

export class OnboardWorkCarrier {
  private readonly logger: Logger;

  constructor(private readonly deps: OnboardCarrierDeps) {
    this.logger = deps.logger ?? createLogger({ name: "onboard-carrier" });
  }

  async execute(assignment: OnboardWorkAssignment, assertCurrent: () => void = () => undefined): Promise<OnboardWorkOutcome> {
    const entry = await this.deps.redeemFacade(assignment);
    if (!entry) {
      throw new RemoteInstanceError("capability_unavailable", "An onboard assignment arrived without its capability token.", { diagnostic: "onboard_facade_absent" });
    }
    const facade = (this.deps.createFacade ?? ((value: PlatformMcpEntry) => new McpOnboardFacade({ endpoint: value })))(entry);
    assertCurrent();
    if (assignment.kind === "repository_relocation") {
      const source = assignment.source;
      if (source.kind !== "repository_relocation") {
        throw new RemoteInstanceError("schema_invalid", "A relocation assignment carries the relocation source.", { diagnostic: "onboard_source_mismatch" });
      }
      const worker = new RepositoryRelocationWorker({ ...this.deps.relocation, facade });
      const outcome = await worker.run(source.relocationRef, assertCurrent);
      this.logger.info({ relocationRef: source.relocationRef, step: outcome.step, disposition: outcome.disposition }, "relocation step reported");
      return { structuredOutput: { relocation: { step: outcome.step, disposition: outcome.disposition, ...(outcome.gap ? { gap: outcome.gap.code } : {}) } } };
    }

    const source = assignment.source;
    if (source.kind !== "discovery_run") {
      throw new RemoteInstanceError("schema_invalid", "An onboard evidence assignment carries the discovery-run source.", { diagnostic: "onboard_source_mismatch" });
    }
    const collector = new OnboardEvidenceCollector({ ...this.deps.collector, facade });
    const run = await facade.runGet(source.runRef);
    const scope = await this.enrichmentScope(assignment);
    assertCurrent();
    if (scope) {
      const outcome = await collector.runEnrichment(withDepth(run, "deep"), scope, assertCurrent);
      return { structuredOutput: { enrichment: { ...outcome, systemRef: scope.systemRef } } };
    }
    if (run.depth === "inventory") {
      // Inventory is Core's, through the connector (ON4). A runtime asked to
      // collect at that depth has nothing to do and says so rather than
      // inventing a pass nobody authorised.
      return { structuredOutput: { grouping: { submitted: 0, unreadable: 0, skipped: "inventory_depth" } } };
    }
    const outcome = await collector.collectGrouping(run, assertCurrent);
    return { structuredOutput: { grouping: { submitted: outcome.submitted, unreadable: outcome.unreadable.length } } };
  }

  private async enrichmentScope(assignment: OnboardWorkAssignment): Promise<EnrichmentScope | null> {
    const workload = await this.deps.fetchWorkload(assignment);
    const parsed = OnboardWorkloadSchema.safeParse(workload.workload);
    return parsed.success && parsed.data.enrichment ? parsed.data.enrichment : null;
  }
}

function withDepth(run: OnboardRunView, depth: OnboardRunView["depth"]): OnboardRunView {
  return requireBounds({ ...run, depth });
}

/** The digest a terminal result carries; one shape for both onboard kinds. */
export function onboardTerminalResult(outcome: OnboardWorkOutcome): { class: "succeeded"; structuredOutput: BoundedJsonValue; terminalResultHash: string } {
  return { class: "succeeded", structuredOutput: outcome.structuredOutput, terminalResultHash: jcsDigest(outcome.structuredOutput as JsonValue) };
}
