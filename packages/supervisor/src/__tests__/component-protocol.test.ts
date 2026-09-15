import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixedClock, type AssignmentReport, type RemoteWorkAssignment } from "@konteks/remote-common";
import { HarnessProtocolAdapter, HARNESS_COMPONENT_MOUNT } from "../work/harness-protocol.js";
import { ValidationProtocolAdapter, VALIDATION_COMPONENT_MOUNT, DISPATCH_SIGNATURE_HEADER, DISPATCH_TIMESTAMP_HEADER, signDispatch } from "../work/validation-protocol.js";
import { componentInboundRoutes, type DeferralForCore } from "../internal/component-routes.js";
import { componentForKind, type ComponentDispatch } from "../work/components.js";
import type { ComponentInventory } from "../inventory/collector.js";

const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
const SECRET = "component-secret";

describe("assignment component ownership", () => {
  it("keeps search generation off the generic component router", () => {
    expect(() => componentForKind("search_generation")).toThrow("dedicated carrier owner");
  });
});

const assignment: RemoteWorkAssignment = {
  id: "a-1",
  kind: "delivery",
  placementId: "p-1",
  instanceId: "inst-1",
  workspaceId: "ws-1",
  taskId: "t-1",
  correlationId: "corr-1",
  attempt: 1,
  expiresAt: "2026-09-07T00:00:00Z",
  requiredCapabilities: [],
  agentRoute: { requiredRole: "coder", agentId: "claude-code" },
  source: { kind: "repository_snapshot", portability: "portable_before_claim", repositoryRef: "r", revision: "v" },
  policy: {
    maxDurationSeconds: 600,
    maxArtifactBytes: 1_024,
    evidenceUpload: "structured_only",
    allowedArtifactKinds: [],
    recoveryMode: "report_interrupted",
    latestResumeAt: "2026-09-07T00:00:00Z",
    permissionResponderDeadlineSeconds: 60,
    humanDeferralAllowed: true,
  },
} as RemoteWorkAssignment;

function dispatch(overrides: Partial<ComponentDispatch> = {}): ComponentDispatch {
  return {
    assignment,
    claimId: "claim-1",
    claimedAt: "2026-09-06T00:00:00Z",
    effectiveEvidenceUpload: "structured_only",
    recoveryEpoch: 0,
    lease: { mode: "active", expiresAt: "2026-09-06T01:00:00Z" },
    policy: { permissionResponderDeadlineSeconds: 60, humanDeferralAllowed: true },
    agent: { agentId: "claude-code", connectionState: "connected", readiness: "ready", roles: ["coder"], capabilities: [], authMode: "agent_local_subscription", bridgeVersion: "0.75.1", observedAt: "2026-09-06T00:00:00Z" } as ComponentDispatch["agent"],
    browserToolHealthy: true,
    workload: { assignmentId: "a-1", attempt: 1, kind: "delivery", workload: { plan: "do the thing" } },
    ...overrides,
  };
}

/** Records exactly what the adapter put on the wire. */
function recordingFetch(answer: (url: URL, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchFn = async (input: string | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(input);
    calls.push({ url, init: init ?? {} });
    const { status, body } = answer(url, init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchFn };
}

describe("supervisor → Harness component protocol", () => {
  it("presents the Harness's own token and its dispatch envelope, never the supervisor's own shape", async () => {
    const { calls, fetchFn } = recordingFetch(() => ({ status: 200, body: { status: "accepted", planId: "plan-1", assignmentId: "a-1", attempt: 1 } }));
    const adapter = new HarnessProtocolAdapter({ baseUrl: "http://harness:3000", token: async () => SECRET, clock, fetchFn });
    await adapter.dispatch(dispatch());
    const call = calls[0]!;
    expect(call.url.pathname).toBe(`${HARNESS_COMPONENT_MOUNT}/assignments`);
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      assignment: { id: "a-1" },
      claim: { claimId: "claim-1", claimedAt: "2026-09-06T00:00:00Z" },
      effectivePolicy: { evidenceUpload: "structured_only" },
      workload: { plan: "do the thing" },
    });
  });

  it("refuses to dispatch delivery with no work definition rather than sending empty work", async () => {
    const { calls, fetchFn } = recordingFetch(() => ({ status: 200, body: {} }));
    const adapter = new HarnessProtocolAdapter({ baseUrl: "http://harness:3000", token: async () => SECRET, clock, fetchFn });
    await expect(adapter.dispatch(dispatch({ workload: undefined }))).rejects.toMatchObject({ code: "assignment_conflict" });
    expect(calls).toHaveLength(0);
  });

  it("names every assignment as failed when asked to erase, because the Harness mounts no erase route", async () => {
    const { fetchFn } = recordingFetch(() => ({ status: 200, body: {} }));
    const adapter = new HarnessProtocolAdapter({ baseUrl: "http://harness:3000", token: async () => SECRET, clock, fetchFn });
    await expect(adapter.erase("d-1", ["a-1", "a-2"])).resolves.toEqual({ failed: ["a-1", "a-2"], reason: "unsupported_scope" });
    await expect(adapter.erase("d-1", [])).resolves.toEqual({ failed: [] });
  });

  it("maps an unknown assignment to `unknown` and a refusal to the closed taxonomy", async () => {
    const notFound = recordingFetch(() => ({ status: 404, body: { code: "unknown_assignment" } }));
    const adapter = new HarnessProtocolAdapter({ baseUrl: "http://harness:3000", token: async () => SECRET, clock, fetchFn: notFound.fetchFn });
    await expect(adapter.cancel("a-1", 1, "revoked")).resolves.toBe("unknown");

    const denied = recordingFetch(() => ({ status: 409, body: { code: "agent_auth_required" } }));
    const failing = new HarnessProtocolAdapter({ baseUrl: "http://harness:3000", token: async () => SECRET, clock, fetchFn: denied.fetchFn });
    await expect(failing.dispatch(dispatch())).rejects.toMatchObject({ code: "agent_auth_required" });
  });

  it("reports the component unreachable as retryable rather than as a refusal", async () => {
    const adapter = new HarnessProtocolAdapter({
      baseUrl: "http://harness:3000",
      token: async () => SECRET,
      clock,
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(adapter.dispatch(dispatch())).rejects.toMatchObject({ code: "temporarily_unavailable", retryable: true });
    await expect(adapter.health()).resolves.toBeNull();
  });
});

describe("supervisor → Validation Runtime component protocol", () => {
  it("signs the exact bytes it sends, the way the component verifies them", async () => {
    const { calls, fetchFn } = recordingFetch(() => ({ status: 200, body: { accepted: true, assignmentId: "a-1", attempt: 1, state: "queued", localJobId: null } }));
    const adapter = new ValidationProtocolAdapter({ baseUrl: "http://validation:3100", secret: async () => SECRET, clock, fetchFn });
    await adapter.dispatch(dispatch({ assignment: { ...assignment, kind: "validation", agentRoute: { requiredRole: "validator", agentId: "claude-code" } } as RemoteWorkAssignment }));
    const call = calls[0]!;
    const headers = call.init.headers as Record<string, string>;
    expect(call.url.pathname).toBe(`${VALIDATION_COMPONENT_MOUNT}/assignments`);
    expect(headers[DISPATCH_TIMESTAMP_HEADER]).toBe("1788652800");
    expect(headers[DISPATCH_SIGNATURE_HEADER]).toBe(createHmac("sha256", SECRET).update(`1788652800.${String(call.init.body)}`).digest("hex"));
    expect(signDispatch(SECRET, "1788652800", String(call.init.body))).toBe(headers[DISPATCH_SIGNATURE_HEADER]);
    expect(JSON.parse(String(call.init.body))).toMatchObject({ dispatchId: "claim-1:e0", lease: { mode: "active" }, browserToolHealthy: true, effectivePolicy: { evidenceUpload: "structured_only", humanDeferralAllowed: true } });
  });

  it("signs an empty body on a GET and reads the component's own status projection", async () => {
    const { calls, fetchFn } = recordingFetch(() => ({
      status: 200,
      body: { component: { kind: "validation_runtime", version: "1.2.3", healthStatus: "healthy", capabilities: ["qa"], lastProbeAt: "2026-09-06T00:00:00Z" }, health: {}, utilizationContribution: 0.5, roles: { qa: true }, previews: [] },
    }));
    const adapter = new ValidationProtocolAdapter({ baseUrl: "http://validation:3100", secret: async () => SECRET, clock, fetchFn });
    await expect(adapter.health()).resolves.toMatchObject({ kind: "validation_runtime", version: "1.2.3", healthStatus: "healthy" });
    expect(calls[0]!.init.body).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>)[DISPATCH_SIGNATURE_HEADER]).toBe(signDispatch(SECRET, "1788652800", ""));
  });

  it("erases through the component's own route and answers what it actually failed to erase", async () => {
    const { fetchFn } = recordingFetch(() => ({ status: 200, body: { status: "partially_completed", failedAssignmentIds: ["a-2"], residue: [] } }));
    const adapter = new ValidationProtocolAdapter({ baseUrl: "http://validation:3100", secret: async () => SECRET, clock, fetchFn });
    await expect(adapter.erase("d-1", ["a-1", "a-2"])).resolves.toEqual({ failed: ["a-2"], reason: "local_io_failure" });
  });
});

describe("component → supervisor inbound routes", () => {
  function inbound(overrides: Partial<Parameters<typeof componentInboundRoutes>[0]> = {}) {
    const reports: AssignmentReport[] = [];
    const views: Array<{ view: ComponentInventory; draining: boolean }> = [];
    const deferrals: DeferralForCore[] = [];
    const handle = componentInboundRoutes({
      token: async (kind) => (kind === "harness" ? "harness-token" : "validation-token"),
      onComponentView: (_kind, view, draining) => void views.push({ view, draining }),
      onComponentStopped: async () => undefined,
      onReport: async (report) => {
        reports.push(report);
        return { status: "journaled" };
      },
      onCheckpoint: async () => undefined,
      onDeferral: async (_kind, deferral) => void deferrals.push(deferral),
      onTaskCheckoutMaterialized: async () => undefined,
      onUsage: async () => undefined,
      workSpec: async () => ({ journeys: [] }),
      resolveTaskCheckout: async () => ({ readOnlyPath: "checkouts/t-1" }),
      redeemCapabilityToken: async () => ({ token: "tok", platformMcpUrl: "http://core/api/app/mcp" }),
      ...overrides,
    });
    return { handle, reports, views, deferrals };
  }

  /** A minimal request/response pair: enough surface for the handler, no server. */
  function exchange(method: string, url: string, body?: unknown, token?: string) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const request = Object.assign(
      (async function* () {
        if (payload) yield Buffer.from(payload);
      })(),
      { method, url, headers: token ? { authorization: `Bearer ${token}` } : {} },
    ) as unknown as Parameters<ReturnType<typeof componentInboundRoutes>>[0];
    const result: { status: number; body: unknown } = { status: 0, body: undefined };
    const response = {
      writeHead: (status: number) => {
        result.status = status;
        return response;
      },
      end: (text?: string) => {
        result.body = text ? JSON.parse(text) : undefined;
      },
    } as unknown as Parameters<ReturnType<typeof componentInboundRoutes>>[1];
    return { request, response, result };
  }

  it("refuses a request with no token, a wrong token, or another component's token", async () => {
    const { handle } = inbound();
    for (const token of [undefined, "wrong", "validation-token"]) {
      const { request, response, result } = exchange("POST", "/component/harness/health", {}, token);
      await expect(handle(request, response)).resolves.toBe(true);
      expect(result.status).toBe(401);
    }
  });

  it("ignores a path that is not a component's, so the rest of the internal API still answers", async () => {
    const { handle } = inbound();
    const { request, response } = exchange("POST", "/internal/observations/gateway", {}, "harness-token");
    await expect(handle(request, response)).resolves.toBe(false);
  });

  it("accepts a component-minted report as a payload and answers journaled", async () => {
    const { handle, reports } = inbound();
    const report = { assignmentId: "a-1", attempt: 1, claimId: "claim-1", reportId: "r-1", reportSequence: 7, payloadDigest: "d".repeat(43), terminal: false, reportedAt: "2026-09-06T00:00:00Z" };
    const { request, response, result } = exchange("POST", "/component/harness/reports", report, "harness-token");
    await handle(request, response);
    expect(result).toEqual({ status: 200, body: { status: "journaled" } });
    // The component's own sequence arrives intact; re-minting is the sender's job.
    expect(reports[0]).toMatchObject({ reportSequence: 7, reportId: "r-1" });
  });

  it("answers a report for an assignment this supervisor never claimed with not-found", async () => {
    const { handle } = inbound({ onReport: async () => ({ status: "unknown_assignment" }) });
    const report = { assignmentId: "ghost", attempt: 1, claimId: "c", reportId: "r", reportSequence: 1, payloadDigest: "d".repeat(43), terminal: false, reportedAt: "2026-09-06T00:00:00Z" };
    const { request, response, result } = exchange("POST", "/component/harness/reports", report, "harness-token");
    await handle(request, response);
    expect(result.status).toBe(404);
  });

  it("takes the Harness's pushed health as the component view", async () => {
    const { handle, views } = inbound();
    const message = {
      instanceId: "inst-1",
      component: { kind: "harness", version: "9.9.9", healthStatus: "degraded", capabilities: ["delivery"], lastProbeAt: "2026-09-06T00:00:00Z" },
      utilization: { acceptingWork: true, activeSessions: 1, activeTurns: 1, utilizationRatio: 0.25, softMaxConcurrent: 4 },
      checks: {},
      draining: true,
    };
    const { request, response, result } = exchange("POST", "/component/harness/health", message, "harness-token");
    await handle(request, response);
    expect(result.status).toBe(200);
    expect(views[0]).toMatchObject({ draining: true, view: { kind: "harness", version: "9.9.9", healthStatus: "degraded" } });
  });

  it("turns a Harness deferral into Core's own shape", async () => {
    const { handle, deferrals } = inbound();
    const message = {
      assignmentId: "a-1",
      attempt: 1,
      agentId: "claude-code",
      deferral: { pendingRef: "pend-1", requestId: "req-1", kind: "permission", requestDigest: "h".repeat(43), deadlineAt: "2026-09-06T00:05:00Z", title: "Run tests", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], isSignIn: false },
    };
    const { request, response, result } = exchange("POST", "/component/harness/permission-deferrals", message, "harness-token");
    await handle(request, response);
    expect(result.status).toBe(202);
    expect(deferrals[0]).toMatchObject({ kind: "permission", assignmentId: "a-1", requestId: "req-1", permission: { title: "Run tests", options: [{ optionId: "allow" }] } });
  });

  it("serves the Validation Runtime its specification, its checkout projection, and a redeemed token", async () => {
    const { handle } = inbound();
    const spec = exchange("GET", "/component/validation_runtime/assignments/a-1/1/spec", undefined, "validation-token");
    await handle(spec.request, spec.response);
    expect(spec.result).toEqual({ status: 200, body: { journeys: [] } });

    const checkout = exchange("POST", "/component/validation_runtime/assignments/a-1/1/task-checkout/resolve", { workspaceRef: "kxws_1" }, "validation-token");
    await handle(checkout.request, checkout.response);
    expect(checkout.result).toEqual({ status: 200, body: { readOnlyPath: "checkouts/t-1" } });

    const redeem = exchange("POST", "/component/validation_runtime/assignments/a-1/1/capability-tokens/redeem", { tokenRef: "kxcap_1" }, "validation-token");
    await handle(redeem.request, redeem.response);
    expect(redeem.result).toEqual({ status: 200, body: { token: "tok", platformMcpUrl: "http://core/api/app/mcp" } });
  });

  it("says upload grants are unsupported instead of fabricating one", async () => {
    const { handle } = inbound();
    const { request, response, result } = exchange("POST", "/component/validation_runtime/assignments/a-1/1/artifacts/upload-grants", { artifactId: "x" }, "validation-token");
    await handle(request, response);
    expect(result).toMatchObject({ status: 501, body: { code: "unsupported_scope" } });
  });

  it("rejects a body outside the contract without touching the fact pipeline", async () => {
    const { handle, deferrals } = inbound();
    const { request, response, result } = exchange("POST", "/component/harness/permission-deferrals", { assignmentId: "a-1" }, "harness-token");
    await handle(request, response);
    expect(result.status).toBe(400);
    expect(deferrals).toHaveLength(0);
  });
});
