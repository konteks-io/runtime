import { describe, expect, it, vi } from "vitest";
import type { RemoteWorkAssignment } from "@konteks/remote-common";
import { OnboardWorkCarrier, isOnboardWorkAssignment, onboardTerminalResult, type OnboardWorkAssignment } from "../onboard/carrier.js";
import { requireBounds, type OnboardFacade } from "../onboard/facade.js";
import { gitGap, gitOk } from "../onboard/git.js";

const bounds = { maxFilesPerRepository: 4, maxRepositoriesDeep: 5, enrichmentTimeoutMinutes: 120 };

function assignment(overrides: Partial<RemoteWorkAssignment>): OnboardWorkAssignment {
  return {
    id: "assignment-1",
    kind: "onboarding",
    placementId: "placement-1",
    instanceId: "instance-1",
    workspaceId: "workspace-1",
    taskId: "task-1",
    correlationId: "correlation-1",
    attempt: 1,
    expiresAt: "2026-09-14T01:00:00.000Z",
    requiredCapabilities: [],
    agentRoute: { requiredRole: "onboard", agentId: "codex" },
    source: { kind: "discovery_run", portability: "portable_before_claim", runRef: "run-1" },
    policy: {
      maxDurationSeconds: 3_600,
      maxArtifactBytes: 0,
      evidenceUpload: "structured_only",
      allowedArtifactKinds: [],
      recoveryMode: "restart_new_attempt_same_instance",
      latestResumeAt: "2026-09-14T01:00:00.000Z",
      permissionResponderDeadlineSeconds: 600,
      humanDeferralAllowed: false,
    },
    ...overrides,
  } as OnboardWorkAssignment;
}

const conversationTurn = assignment({ source: { kind: "conversation", portability: "portable_before_claim", sessionId: "session-1", turnRef: "turn-1" } });
const relocation = assignment({
  kind: "repository_relocation",
  agentRoute: { requiredRole: "onboard", agentId: "codex" },
  source: { kind: "repository_relocation", portability: "instance_bound", ownerInstanceId: "instance-1", relocationRef: "relocation-1" },
});

describe("routing keys on the source, not the kind", () => {
  it("sends an onboarding session turn down the ordinary ACP path", () => {
    // Keying on the kind would hand a person's conversation to the collector.
    expect(isOnboardWorkAssignment(conversationTurn)).toBe(false);
  });

  it("takes the run's own evidence assignment and every relocation", () => {
    expect(isOnboardWorkAssignment(assignment({}))).toBe(true);
    expect(isOnboardWorkAssignment(relocation)).toBe(true);
  });
});

function facade(overrides: Partial<OnboardFacade> = {}): OnboardFacade {
  return {
    runGet: async () => requireBounds({ runRef: "run-1", kind: "discovery", depth: "grouping", bounds }),
    inventoryList: async () => ({ items: [] }),
    evidenceSubmit: async () => undefined,
    enrichmentProgress: async () => undefined,
    enrichmentSubmit: async () => undefined,
    relocationStatus: async () => ({
      relocationRef: "relocation-1",
      step: "settle" as const,
      from: { vcsConnectorId: "a", provider: "gitea", baseUrl: "https://a.test", repoOwner: "acme", repoName: "api" },
      to: { vcsConnectorId: "b", provider: "gitea", baseUrl: "https://b.test", repoOwner: "acme", repoName: "api" },
    }),
    relocationReport: async () => ({
      relocationRef: "relocation-1",
      step: "settle" as const,
      from: { vcsConnectorId: "a", provider: "gitea", baseUrl: "https://a.test", repoOwner: "acme", repoName: "api" },
      to: { vcsConnectorId: "b", provider: "gitea", baseUrl: "https://b.test", repoOwner: "acme", repoName: "api" },
    }),
    ...overrides,
  };
}

function carrier(port: OnboardFacade, workload: unknown = {}) {
  const git = {
    version: async () => "2.45.2",
    lsRemote: async () => gitOk([]),
    archiveFile: async () => gitGap<Buffer>("not_found", "absent"),
    credential: async () => gitGap<{ username: string; password: string }>("credential_unavailable", "sign in"),
    cloneShallow: async () => gitOk(undefined),
    cloneMirror: async () => gitOk(undefined),
    pushMirror: async () => gitOk(undefined),
  };
  const scratch = {
    clonesRoot: "/scratch/clones",
    archivesRoot: "/scratch/archives",
    archivePath: (name: string) => `/scratch/archives/${name}.tar`,
    reserveClone: async (name: string) => `/scratch/clones/${name}`,
    releaseClone: async () => undefined,
    clones: async () => [],
    readCloned: async () => null,
  };
  return new OnboardWorkCarrier({
    collector: { git: git as never, rawFiles: { read: async () => gitGap<Buffer>("not_found", "absent") }, scratch: scratch as never, resolveRemote: item => ({ url: item.url }) },
    relocation: { git: git as never, scratch: scratch as never, managedBinding: () => null, now: () => "2026-09-14T00:00:00.000Z", wait: async () => undefined, pollIntervalMs: 0, maxPolls: 1 },
    redeemFacade: async () => ({ name: "platform", url: "https://core.test/mcp", headers: [] }),
    fetchWorkload: async () => ({ assignmentId: "assignment-1", attempt: 1, kind: "onboarding", workload: workload as never }),
    createFacade: () => port,
  });
}

describe("the onboard carrier", () => {
  it("runs a grouping pass and reports what it submitted", async () => {
    const submit = vi.fn(async () => undefined);
    const outcome = await carrier(facade({ evidenceSubmit: submit })).execute(assignment({}));

    expect(outcome.structuredOutput).toEqual({ grouping: { submitted: 0, unreadable: 0 } });
    expect(onboardTerminalResult(outcome)).toMatchObject({ class: "succeeded" });
  });

  it("does nothing at inventory depth, because the inventory is Core's", async () => {
    const inventoryList = vi.fn(async () => ({ items: [] }));
    const port = facade({ runGet: async () => requireBounds({ runRef: "run-1", kind: "discovery", depth: "inventory", bounds }), inventoryList });
    const outcome = await carrier(port).execute(assignment({}));

    expect(outcome.structuredOutput).toMatchObject({ grouping: { skipped: "inventory_depth" } });
    expect(inventoryList).not.toHaveBeenCalled();
  });

  it("reads the enrichment scope from Core's definition of the claimed work", async () => {
    const outcome = await carrier(facade(), { enrichment: { systemRef: "system:default/payments", allowance: 0, canonicalKeys: ["a"] } }).execute(assignment({}));

    // Allowance 0 completes immediately: nothing is cloned and nothing charged.
    expect(outcome.structuredOutput).toEqual({ enrichment: { cloned: 0, submitted: 0, disposition: "budget_exhausted", systemRef: "system:default/payments" } });
  });

  it("runs the relocation worker for a relocation assignment", async () => {
    const report = vi.fn(async () => ({
      relocationRef: "relocation-1",
      step: "settle" as const,
      from: { vcsConnectorId: "a", provider: "gitea", baseUrl: "https://a.test", repoOwner: "acme", repoName: "api" },
      to: { vcsConnectorId: "b", provider: "gitea", baseUrl: "https://b.test", repoOwner: "acme", repoName: "api" },
    }));
    const outcome = await carrier(facade({ relocationReport: report })).execute(relocation);

    expect(outcome.structuredOutput).toEqual({ relocation: { step: "settle", disposition: "settled" } });
    expect(report).toHaveBeenCalledWith({ relocationRef: "relocation-1", step: "settle" });
  });

  it("refuses an assignment that arrived without its capability token", async () => {
    const subject = new OnboardWorkCarrier({
      collector: { git: {} as never, rawFiles: { read: async () => gitGap<Buffer>("not_found", "absent") }, scratch: {} as never, resolveRemote: () => ({ url: "" }) },
      relocation: { git: {} as never, scratch: {} as never, managedBinding: () => null, now: () => "2026-09-14T00:00:00.000Z" },
      redeemFacade: async () => undefined,
      fetchWorkload: async () => ({ assignmentId: "assignment-1", attempt: 1, kind: "onboarding", workload: {} as never }),
    });

    await expect(subject.execute(assignment({}))).rejects.toMatchObject({ code: "capability_unavailable" });
  });
});
