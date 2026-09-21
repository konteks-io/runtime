import type { GitGap } from "./git.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DiscoveryEvidenceSubmissionSchema,
  DiscoveryInventoryItemSchema,
  DiscoveryRunBoundsSchema,
  DiscoveryDepthSchema,
  EnrichmentProgressInputSchema,
  REPOSITORY_RELOCATE_REPORT_TOOL,
  REPOSITORY_RELOCATE_STATUS_TOOL,
  RemoteInstanceError,
  type DiscoveryEvidenceSubmission,
  type DiscoveryRunBounds,
  type EnrichmentProgressInput,
  type FetchFn,
  type RepositoryRelocateReportInput,
} from "@konteks/remote-common";

/**
 * What the runtime sends for one repository: the shared submission, plus why
 * the repository read nothing when it did (W2-O3).
 */
export type OnboardEvidenceSubmission = DiscoveryEvidenceSubmission & { gap?: GitGap };

/**
 * The onboard MCP facade as this runtime sees it (OB6 §2, §3; OB2 §5).
 *
 * The runtime holds exactly one credential for Core's onboard surface: the
 * capability token the supervisor redeems per claim, presented as the platform
 * MCP entry. So the collector and the relocation worker talk to Core the same
 * way the session's agent would — through the facade tools — and there is no
 * second authority path to review.
 *
 * The facade is a PORT here. Every method is named for the tool it calls, so a
 * reader can check the call site against OB2 §5 without following an HTTP
 * client, and the workers are testable without a Core.
 */

/**
 * CONTRACT-GAP: OB1 published the relocation and managed-repository tool names
 * as constants; the discovery-run tools are named only in OB2 §5 prose. They are
 * spelled here verbatim, and belong in the shared package the moment OB2 lands
 * so neither side re-derives them.
 */
export const DISCOVERY_RUN_GET_TOOL = "platform__catalog__discovery_run_get" as const;
export const DISCOVERY_RUN_INVENTORY_LIST_TOOL = "platform__catalog__discovery_run_inventory_list" as const;
export const DISCOVERY_RUN_EVIDENCE_SUBMIT_TOOL = "platform__catalog__discovery_run_evidence_submit" as const;
export const DISCOVERY_RUN_ENRICHMENT_SUBMIT_TOOL = "platform__catalog__discovery_run_enrichment_submit" as const;
/**
 * CONTRACT-GAP: OB2 §3b requires the report but names no tool. `cloning` is
 * reported BEFORE the clone and `extracted` with the submission, so Core's
 * per-repository ledger is never behind what is already on disk.
 */
export const DISCOVERY_RUN_ENRICHMENT_PROGRESS_TOOL = "platform__catalog__discovery_run_enrichment_progress" as const;

/** What the collector needs off a run: its depth, its bounds, its connector. */
export const OnboardRunViewSchema = z
  .object({
    runRef: z.string().min(1),
    kind: z.literal("discovery"),
    depth: DiscoveryDepthSchema,
    /**
     * ON30: a run states its bounds before anything is read. Optional HERE so a
     * run that omits them is refused by name rather than as a parse failure —
     * the collector must never invent a ceiling, and a reader of the log should
     * see which rule refused.
     */
    bounds: DiscoveryRunBoundsSchema.optional(),
  });
export type OnboardRunView = z.infer<typeof OnboardRunViewSchema> & { bounds: DiscoveryRunBounds };

export const OnboardInventoryPageSchema = z
  .object({
    items: z
      .array(
        DiscoveryInventoryItemSchema.extend({
          /**
           * Whether Core already holds evidence for this repository.
           *
           * This is how a grouping pass resumes: the cursor belongs to Core, so
           * the runtime re-reads the pages and does nothing for the ones already
           * accepted, rather than keeping a position of its own that can drift
           * from the inventory it is paging. Optional because a Core that has
           * not shipped the flag simply re-reads, which is the old behaviour.
           */
          collected: z.boolean().optional(),
        }),
      )
      .max(500),
    nextCursor: z.string().min(1).max(2048).nullish(),
  });
export type OnboardInventoryPage = z.infer<typeof OnboardInventoryPageSchema>;

/**
 * One endpoint of a relocation as the revision records it (G2). It carries no
 * clone URL and no managed flag, so the worker composes the remote itself from
 * `baseUrl`/`repoOwner`/`repoName` and decides the credential by host.
 */
export const RelocationEndpointSchema = z
  .object({
    vcsConnectorId: z.string().min(1).max(200),
    provider: z.string().min(1).max(64),
    baseUrl: z.string().min(1).max(2048),
    repoOwner: z.string().min(1).max(256),
    repoName: z.string().min(1).max(256),
  });

export const RelocationPlanSchema = z
  .object({
    relocationRef: z.string().min(1).max(200),
    /** Core's recorded step; a resumed worker re-runs from exactly this one. */
    step: z.enum(["propose", "freeze", "sync", "verify", "cutover", "settle"]),
    from: RelocationEndpointSchema,
    to: RelocationEndpointSchema,
    /** Present from `verify` onward; the digest a cutover is re-checked against. */
    verification: z
      .object({ refs: z.number().int().nonnegative(), headShaByRef: z.string().regex(/^[a-f0-9]{64}$/), verifiedAt: z.string().min(1) })
      .optional(),
  });
export type RelocationPlan = z.infer<typeof RelocationPlanSchema>;

/** ON30 / OB6 §2: a run whose bounds are absent is refused, never defaulted. */
export function requireBounds(run: z.infer<typeof OnboardRunViewSchema>): OnboardRunView {
  if (!run.bounds) {
    throw new RemoteInstanceError("schema_invalid", "A discovery run states its bounds before anything is read.", { diagnostic: "onboard_bounds_absent" });
  }
  return run as OnboardRunView;
}

export interface OnboardFacade {
  runGet(runRef: string): Promise<OnboardRunView>;
  inventoryList(runRef: string, cursor?: string): Promise<OnboardInventoryPage>;
  evidenceSubmit(runRef: string, evidence: readonly OnboardEvidenceSubmission[]): Promise<void>;
  enrichmentProgress(runRef: string, progress: EnrichmentProgressInput): Promise<void>;
  enrichmentSubmit(runRef: string, systemRef: string, evidence: readonly DiscoveryEvidenceSubmission[]): Promise<void>;
  relocationStatus(relocationRef: string): Promise<RelocationPlan>;
  relocationReport(report: RepositoryRelocateReportInput): Promise<RelocationPlan>;
}

export interface McpOnboardFacadeOptions {
  /** The redeemed platform MCP entry for this claim. Never journaled. */
  endpoint: { url: string; headers: ReadonlyArray<{ name: string; value: string }> };
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

/**
 * A minimal MCP `tools/call` client. It exists because the runtime's only
 * credential for the onboard surface is the capability token in this entry, and
 * the entry is an MCP endpoint. Nothing here interprets a tool's meaning: each
 * caller parses its own result with its own schema.
 */
export class McpOnboardFacade implements OnboardFacade {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly options: McpOnboardFacadeOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async runGet(runRef: string): Promise<OnboardRunView> {
    const run = OnboardRunViewSchema.parse(await this.call(DISCOVERY_RUN_GET_TOOL, { runRef }));
    return requireBounds(run);
  }

  async inventoryList(runRef: string, cursor?: string): Promise<OnboardInventoryPage> {
    return OnboardInventoryPageSchema.parse(await this.call(DISCOVERY_RUN_INVENTORY_LIST_TOOL, { runRef, ...(cursor ? { cursor } : {}) }));
  }

  async evidenceSubmit(runRef: string, evidence: readonly OnboardEvidenceSubmission[]): Promise<void> {
    // Parsing our own submission before it leaves is not ceremony: it is what
    // stops a fact extractor from ever putting a file body on the wire. The
    // gap is checked here and re-attached, because the vendored shared schema
    // predates it (Core checks it the same way on arrival).
    const body = evidence.map(({ gap, ...entry }) => ({
      ...DiscoveryEvidenceSubmissionSchema.parse(entry),
      ...(gap ? { gap: { code: gap.code, remedy: gap.remedy.slice(0, 500) } } : {}),
    }));
    await this.call(DISCOVERY_RUN_EVIDENCE_SUBMIT_TOOL, { runRef, evidence: body });
  }

  async enrichmentProgress(runRef: string, progress: EnrichmentProgressInput): Promise<void> {
    await this.call(DISCOVERY_RUN_ENRICHMENT_PROGRESS_TOOL, { runRef, ...EnrichmentProgressInputSchema.parse(progress) });
  }

  async enrichmentSubmit(runRef: string, systemRef: string, evidence: readonly DiscoveryEvidenceSubmission[]): Promise<void> {
    const body = evidence.map(entry => DiscoveryEvidenceSubmissionSchema.parse(entry));
    await this.call(DISCOVERY_RUN_ENRICHMENT_SUBMIT_TOOL, { runRef, systemRef, evidence: body });
  }

  async relocationStatus(relocationRef: string): Promise<RelocationPlan> {
    return RelocationPlanSchema.parse(await this.call(REPOSITORY_RELOCATE_STATUS_TOOL, { relocationRef }));
  }

  async relocationReport(report: RepositoryRelocateReportInput): Promise<RelocationPlan> {
    return RelocationPlanSchema.parse(await this.call(REPOSITORY_RELOCATE_REPORT_TOOL, report));
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    for (const header of this.options.endpoint.headers) headers[header.name] = header.value;
    let response: Response;
    try {
      response = await this.fetchFn(this.options.endpoint.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RemoteInstanceError("temporarily_unavailable", "The onboard facade is not reachable from this runtime.", { retryable: true, cause: error, diagnostic: "onboard_facade_unreachable" });
    }
    if (response.status === 401 || response.status === 403) {
      throw new RemoteInstanceError("permission_denied", "This runtime's capability token does not carry the onboard facade.", { diagnostic: "onboard_facade_forbidden" });
    }
    if (!response.ok) {
      throw new RemoteInstanceError("temporarily_unavailable", `The onboard facade refused ${tool}.`, { retryable: true, diagnostic: "onboard_facade_http" });
    }
    const envelope = McpResponseSchema.safeParse(await response.json());
    if (!envelope.success) throw new RemoteInstanceError("schema_invalid", `The onboard facade answered ${tool} off contract.`, { diagnostic: "onboard_facade_envelope" });
    if (envelope.data.error) {
      // A tool-level refusal is Core's decision (budget exhausted, run out of
      // scope, submission beyond the allowance). It is surfaced with its own
      // code so the worker can tell "refused" from "unreachable".
      throw new RemoteInstanceError("conflict", `The onboard facade refused ${tool}: ${envelope.data.error.code}.`, { diagnostic: "onboard_facade_refused" });
    }
    const result = envelope.data.result;
    if (result?.isError) throw new RemoteInstanceError("conflict", `The onboard facade refused ${tool}.`, { diagnostic: "onboard_tool_error" });
    if (result?.structuredContent !== undefined) return result.structuredContent;
    const text = result?.content?.find(entry => entry.type === "text")?.text;
    if (text === undefined) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RemoteInstanceError("schema_invalid", `The onboard facade answered ${tool} with unparseable content.`, { diagnostic: "onboard_facade_content" });
    }
  }
}

const McpResponseSchema = z
  .object({
    error: z.object({ code: z.union([z.number(), z.string()]), message: z.string().max(2_048).optional() }).passthrough().optional(),
    result: z
      .object({
        isError: z.boolean().optional(),
        structuredContent: z.unknown().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
