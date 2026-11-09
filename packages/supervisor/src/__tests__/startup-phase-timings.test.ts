import { afterEach, expect, it, vi } from "vitest";
import { type Logger, type RecoveryStatusReport, type RelayRuntimeHandshakeResult } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";
import { STARTUP_PHASES, StartupPhases } from "../reconnect/startup-phases.js";

// Composition test: no bridge, listener, filesystem mutation or cloud request.
interface StartupInternals {
  startActiveLoop(): Promise<void>;
  recoveryAuthority(): string | null;
  recoveryStatus(): RecoveryStatusReport;
  captureLeaseFence(): () => void;
  validateRelayHandshake(result: RelayRuntimeHandshakeResult): void;
  onRelayConnected(result: RelayRuntimeHandshakeResult): Promise<void>;
  stopping: boolean;
  nativeOwnership: { assertOwned(): void } | null;
  instanceId: string;
  runnerIncarnation: string;
  activeLoopPhase: "starting" | "recovery_pending" | "started";
  reconnectRefusal: string | null;
  ordinaryHeartbeatStarted: boolean;
  administrativeStatus: "active" | "provisioning";
  refreshConfiguration(): Promise<void>;
  openCoreChannels(): void;
  modelCapabilities: unknown;
  inventory: unknown;
}

interface CapturedLine { level: "info" | "warn"; fields: Record<string, unknown> }

function captureLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const push = (level: CapturedLine["level"]) => (fields: Record<string, unknown>) => { lines.push({ level, fields }); };
  return { lines, logger: { info: push("info"), warn: push("warn") } as unknown as Logger };
}

function fixture() {
  vi.useFakeTimers();
  const capture = captureLogger();
  const phases = new StartupPhases(capture.logger);
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({ SUPERVISOR_DEPLOYMENT_KIND: "native_connector", SUPERVISOR_DATA_DIR: "/unused-native-startup-timing-fixture", SUPERVISOR_CORE_URL: "https://core.example" }), { startupPhases: phases });
  const internal = supervisor as unknown as StartupInternals;
  const events: string[] = [];
  let complete = false;
  const record = { state: "applied", intent: { instanceId: "instance", runnerIncarnation: internal.runnerIncarnation }, manifest: { manifestId: "manifest", ownerRevision: 1 }, receipt: { digest: "digest" }, acceptedAt: "2026-09-06T00:00:00Z" };
  internal.instanceId = "instance";
  vi.spyOn(supervisor.store, "provisioning").mockResolvedValue(null);
  vi.spyOn(supervisor.store, "clearCompletedActivationAttempt").mockResolvedValue();
  internal.nativeOwnership = { assertOwned: vi.fn() };
  internal.openCoreChannels = vi.fn();
  internal.reloadManagedGitBinding = vi.fn(async () => undefined);
  internal.refreshConfiguration = vi.fn(async () => { events.push("configuration"); });
  const run = vi.fn(async () => { events.push("recovery"); complete = true; });
  const reconciliation = { run, get isComplete() { return complete; } };
  supervisor.reconciliation = reconciliation as never;
  vi.spyOn(supervisor.journal.recovery, "current").mockImplementation(() => record as never);
  vi.spyOn(supervisor.lease, "isValid").mockReturnValue(true);
  vi.spyOn(supervisor.lease, "mode").mockReturnValue("active");
  supervisor.heartbeat = {
    start: vi.fn(async () => { events.push("heartbeat"); }), settle: vi.fn(async () => undefined), stop: vi.fn(), roles: vi.fn(() => []),
    publishPending: vi.fn(async () => { events.push("pending"); }), publish: vi.fn(async () => { events.push("publish"); }),
    liveness: () => ({ running: true, pendingFlight: false, stage: null, inFlightSince: null, lastAttemptAt: Date.now(), lastSettledAt: Date.now() }),
    livenessBudgetMs: () => 60_000,
  } as never;
  supervisor.transport = { start: vi.fn(() => { events.push("transport"); }), resumeAfterRecovery: vi.fn(() => { events.push("replay"); }) } as never;
  supervisor.work = { reports: { flushAll: vi.fn(async () => { events.push("reports"); }) }, pull: vi.fn() } as never;
  supervisor.relay = null;
  return { supervisor, internal, events, run, reconciliation, capture, phases, record, setComplete: (value: boolean) => { complete = value; } };
}

/**
 * The establishment callback production `Reconciliation` holds. It drives the
 * real `afterEstablishment`, so the capability-discovery phase is the
 * production fire-and-forget refresh, not a test-only copy.
 */
function establishmentCallback(f: ReturnType<typeof fixture>): (assertCurrent: () => void) => Promise<void> {
  const internals = f.supervisor as unknown as { composeRecovery(verifier: unknown): void };
  internals.composeRecovery({ verifyPlanningTerminal: () => undefined });
  const callback = (f.supervisor.reconciliation as unknown as {
    deps: { afterEstablishment: (assertCurrent: () => void) => Promise<void> };
  }).deps.afterEstablishment;
  f.supervisor.reconciliation = f.reconciliation as never;
  return callback;
}

function phaseLines(f: ReturnType<typeof fixture>): CapturedLine[] {
  return f.capture.lines.filter(line => line.fields.event === "startup.phase");
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("emits every startup phase once, ordered, with the started summary and a non-decreasing clock", async () => {
  const f = fixture();
  const supervisorInfo = vi.spyOn(f.supervisor.logger, "info");
  f.phases.complete("process_start");
  await vi.advanceTimersByTimeAsync(20);
  f.phases.complete("control_channel");

  const discovery = Promise.withResolvers<void>();
  f.internal.inventory = { agents: () => [] };
  f.internal.modelCapabilities = { invalidateForAgents: vi.fn(), refresh: vi.fn(() => discovery.promise) };
  const afterEstablishment = establishmentCallback(f);
  f.run.mockImplementation(async () => { await afterEstablishment(() => undefined); f.events.push("recovery"); f.setComplete(true); });

  await f.internal.startActiveLoop();
  // Discovery is still open after startup promoted and printed its summary.
  expect(phaseLines(f).map(line => line.fields.phase)).toEqual(["process_start", "control_channel", "recovery", "started"]);

  await vi.advanceTimersByTimeAsync(4_000);
  discovery.resolve();
  await vi.advanceTimersByTimeAsync(0);

  const result = { connectionEpoch: 2, resume: {}, reset: [], runtimeReconciliation: { state: "confirmed", manifestId: "manifest", receiptDigest: "digest", acceptedAt: f.record.acceptedAt } } as RelayRuntimeHandshakeResult;
  await vi.advanceTimersByTimeAsync(2_000);
  await f.internal.onRelayConnected(result);

  const emitted = phaseLines(f);
  expect(new Set(emitted.map(line => line.fields.phase))).toEqual(new Set(STARTUP_PHASES));
  // Actual occurrence order: relay connects after "started", and discovery
  // was still open when the promotion printed its summary.
  expect(emitted.map(line => line.fields.phase)).toEqual(["process_start", "control_channel", "recovery", "started", "capability_discovery", "relay_connected"]);
  for (const line of emitted) {
    expect(line.fields.phaseMs).toBeTypeOf("number");
    expect(line.fields.sinceStartMs).toBeTypeOf("number");
  }
  const starts = emitted.map(line => line.fields.sinceStartMs as number);
  expect(starts).toEqual([...starts].sort((first, second) => first - second));

  const summary = supervisorInfo.mock.calls.find(call => (call[0] as Record<string, unknown> | undefined)?.event === "startup.timings");
  expect(summary?.[0]).toMatchObject({
    processStartedAt: expect.any(String),
    phasesMs: expect.objectContaining({ process_start: expect.any(Number), control_channel: expect.any(Number), recovery: expect.any(Number) }),
    stepsMs: expect.objectContaining({ "recovery:reconciliation": expect.any(Number) }),
    totalMs: expect.any(Number),
  });
  const summaryFields = summary?.[0] as Record<string, unknown>;
  expect(summaryFields.phasesMs).not.toHaveProperty("relay_connected");
  expect(summaryFields.phasesMs).not.toHaveProperty("capability_discovery");
});

it("names an open slow recovery step every 30 s before it completes, then reports its duration", async () => {
  vi.useFakeTimers();
  const capture = captureLogger();
  const phases = new StartupPhases(capture.logger);
  const gate = Promise.withResolvers<void>();
  let settled = false;
  const running = phases.step("recovery", "retain_stopped_workspace", () => gate.promise).then(() => { settled = true; });

  await vi.advanceTimersByTimeAsync(30_000);
  expect(settled).toBe(false);
  const waiting = capture.lines.filter(line => line.fields.event === "startup.phase_running");
  expect(waiting).toHaveLength(1);
  expect(waiting[0]).toMatchObject({ level: "warn", fields: { phase: "recovery", step: "retain_stopped_workspace", phaseElapsedMs: 30_000, stepElapsedMs: 30_000 } });

  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toBe(false);
  expect(capture.lines.filter(line => line.fields.event === "startup.phase_running").at(-1)?.fields).toMatchObject({ phaseElapsedMs: 90_000, stepElapsedMs: 90_000 });

  gate.resolve();
  await running;
  const completed = capture.lines.filter(line => line.fields.event === "startup.phase").at(-1);
  expect(completed?.fields).toMatchObject({ phase: "recovery", step: "retain_stopped_workspace" });
  expect(completed?.fields.phaseMs).toBeGreaterThanOrEqual(90_000);
});
