import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger, PreviewToCoreChunk } from "@konteks/remote-common";
import { NOTHING_TO_SERVE_REASON, type PreviewPlanResult } from "../preview/config.js";
import { PreviewChannel } from "../preview/preview-channel.js";
import { PreviewProcessManager, type PreviewChild } from "../preview/process-manager.js";
import type { PreviewProcessOwner } from "../preview/process-owner.js";
import { NO_WORKTREE_REASON, NOT_TAKING_WORK_REASON, PreviewViewerStarts, WORKTREE_GONE_REASON } from "../preview/viewer-start.js";
import { PreviewWorktreePermits } from "../preview/worktree-permits.js";
import type { OutboundMessage } from "../transport/transport.js";

class FakeChild extends EventEmitter implements PreviewChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number, readonly cwd: string, readonly env: NodeJS.ProcessEnv) { super(); }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code; this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

const SERVES: PreviewPlanResult = { ok: true, plan: { command: "npm run dev -- --port $PORT", healthPath: "/", env: {}, source: "preview_yaml", explanation: "From .konteks/preview.yaml.", notes: [] } };

function manager(options: { plan?: PreviewPlanResult; maxRunning?: number } = {}) {
  const children: FakeChild[] = [];
  let now = 1_000_000;
  const owner = (pid: number | undefined): PreviewProcessOwner => ({ version: 2, id: `owner:${pid}`, pid: pid ?? null, platform: "linux",
    process: { version: 1, platform: "linux", pid: pid!, processGroupId: pid!, startToken: `boot:${pid}`, commandDigest: "fixture" } });
  const instance = new PreviewProcessManager({
    spawn: ({ cwd, env }) => { const child = new FakeChild(2000 + children.length, cwd, env); children.push(child); return child; },
    captureOwner: owner,
    stopOwner: async stopped => { const child = children.find(value => value.pid === stopped.pid)!; if (child.exitCode === null) child.exit(null, "SIGTERM"); },
    resolvePlan: async () => options.plan ?? SERVES,
    probe: async () => true,
    allocatePort: async inUse => { let port = 43_200; while (inUse.has(port)) port += 1; return port; },
    resolvePath: async () => "/usr/bin",
    env: { HOME: "/Users/a" },
    registry: null,
    probeIntervalMs: 5,
    readinessTimeoutMs: 60_000,
    idleMs: 30 * 60_000,
    ...(options.maxRunning !== undefined ? { maxRunning: options.maxRunning } : {}),
    now: () => now,
  });
  return { instance, children, now: () => now, advance: (ms: number) => { now += ms; } };
}

function logger() {
  const info = vi.fn();
  return { info, logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    events: (event: string) => info.mock.calls.map(call => call[0] as Record<string, unknown>).filter(fields => fields.event === event) };
}

let data = "";
beforeEach(async () => { data = await mkdtemp(join(tmpdir(), "viewer-start-")); });
afterEach(async () => { await rm(data, { recursive: true, force: true }); });

describe("a viewer starting a session's preview (D96)", () => {
  it.each([undefined, true] as const)("keeps preview policy %s after idle and connector restart", async managedRepository => {
    const worktree = join(data, "worktree-qa"); await mkdir(worktree);
    const file = join(data, "preview-worktrees.json");
    new PreviewWorktreePermits(file).set("qa", worktree, managedRepository);

    const first = manager();
    const log = logger();
    const starts = new PreviewViewerStarts({ previews: first.instance, permits: new PreviewWorktreePermits(file), takingWork: () => true, retryMs: 60_000, now: first.now, logger: log.logger });
    expect(await starts.start("qa")).toBe(true);
    expect(await first.instance.waitForSettled("qa", 2_000)).toMatchObject({ state: "running", startedBy: "viewer" });
    first.advance(31 * 60_000);
    await first.instance.sweepIdle();
    expect(first.instance.status("qa").state).toBe("stopped");
    // Idle-stopped, opened again: it starts, no "nothing yet".
    expect(await starts.start("qa")).toBe(true);
    await vi.waitFor(() => expect(first.children.map(child => child.cwd)).toEqual([worktree, worktree]));
    await first.instance.close();

    // The connector restarted (an update): the kept permit still starts it.
    const second = manager();
    const restarted = new PreviewViewerStarts({ previews: second.instance, permits: new PreviewWorktreePermits(file), takingWork: () => true, retryMs: 60_000, logger: log.logger });
    expect(await restarted.start("qa")).toBe(true);
    await vi.waitFor(() => expect(second.children.map(child => child.cwd)).toEqual([worktree]));
    expect([...first.children, ...second.children].map(child => child.env.HUSKY)).toEqual(Array(3).fill(managedRepository ? "0" : undefined));
    expect(log.events("preview.viewer_started")).toEqual([
      expect.objectContaining({ sessionId: "qa" }), expect.objectContaining({ sessionId: "qa" }), expect.objectContaining({ sessionId: "qa" })]);
    expect(log.events("preview.viewer_start_declined")).toEqual([]);
    await second.instance.close();
  });

  it("starts a new delivery cycle's session in the worktree that cycle prepared", async () => {
    const before = join(data, "worktree-cycle-1"); await mkdir(before);
    const after = join(data, "worktree-cycle-2"); await mkdir(after);
    const permits = new PreviewWorktreePermits(join(data, "preview-worktrees.json"));
    permits.set("qa", before);
    permits.set("qa", after);
    const f = manager();
    const starts = new PreviewViewerStarts({ previews: f.instance, permits, takingWork: () => true, retryMs: 60_000, logger: logger().logger });
    expect(await starts.start("qa")).toBe(true);
    await vi.waitFor(() => expect(f.children.map(child => child.cwd)).toEqual([after]));
    await f.instance.close();
  });

  it("says why, and logs why, whenever it does not start one", async () => {
    const kept = join(data, "worktree-kept"); await mkdir(kept);
    const gone = join(data, "worktree-gone"); await mkdir(gone);
    const permits = new PreviewWorktreePermits(join(data, "preview-worktrees.json"));
    permits.set("kept", kept);
    permits.set("gone", gone);
    await rm(gone, { recursive: true });
    let taking = true;
    const f = manager();
    const log = logger();
    const starts = new PreviewViewerStarts({ previews: f.instance, permits, takingWork: () => taking, retryMs: 60_000, logger: log.logger });

    expect(await starts.start("never-here")).toEqual({ reason: NO_WORKTREE_REASON });
    expect(await starts.start("gone")).toEqual({ reason: WORKTREE_GONE_REASON });
    taking = false;
    expect(await starts.start("kept")).toEqual({ reason: NOT_TAKING_WORK_REASON });
    expect(f.children).toHaveLength(0);
    expect(log.events("preview.viewer_start_declined")).toEqual([
      expect.objectContaining({ sessionId: "never-here", cause: "no_worktree", reason: NO_WORKTREE_REASON }),
      expect.objectContaining({ sessionId: "gone", cause: "worktree_missing", reason: WORKTREE_GONE_REASON }),
      expect.objectContaining({ sessionId: "kept", cause: "not_taking_work", reason: NOT_TAKING_WORK_REASON }),
    ]);

    // Refused at once (the computer's preview limit): its reason.
    const full = manager({ maxRunning: 1 });
    await full.instance.start("other", kept);
    const capped = new PreviewViewerStarts({ previews: full.instance, permits, takingWork: () => true, retryMs: 60_000, logger: log.logger });
    const refused = await capped.start("kept");
    expect(refused).toEqual({ reason: expect.stringContaining("its limit") });
    expect(log.events("preview.viewer_start_declined").at(-1)).toMatchObject({ sessionId: "kept", cause: "refused", state: "failed" });
    await full.instance.close();
    await f.instance.close();
  });

  it("does not restart a failed start on every refresh: it says why until the retry", async () => {
    const worktree = join(data, "worktree-static"); await mkdir(worktree);
    const permits = new PreviewWorktreePermits(join(data, "preview-worktrees.json"));
    permits.set("s", worktree);
    const f = manager({ plan: { ok: false, message: "Nothing to serve.", notes: [] } });
    const log = logger();
    const starts = new PreviewViewerStarts({ previews: f.instance, permits, takingWork: () => true, retryMs: 60_000, now: f.now, logger: log.logger });
    expect(await starts.start("s")).toBe(true);
    expect(await f.instance.waitForSettled("s", 2_000)).toMatchObject({ state: "failed" });
    expect(await starts.start("s")).toEqual({ reason: NOTHING_TO_SERVE_REASON });
    expect(log.events("preview.viewer_start_declined")).toEqual([expect.objectContaining({ sessionId: "s", cause: "retry_pending" })]);
    // After the retry window, a viewer may start it again.
    f.advance(60_000);
    expect(await starts.start("s")).toBe(true);
  });

  it("answers Konteks with the reason (start_failed), never \"No preview is running\", and the same when a start throws", async () => {
    const permits = new PreviewWorktreePermits(join(data, "preview-worktrees.json"));
    const f = manager();
    const starts = new PreviewViewerStarts({ previews: f.instance, permits, takingWork: () => true, retryMs: 60_000, logger: logger().logger });
    const sent: OutboundMessage[] = [];
    let autoStart: (sessionId: string) => Promise<boolean | { reason: string }> = sessionId => starts.start(sessionId);
    const channel = new PreviewChannel({
      transport: { send: message => void sent.push(message), openChannel: () => undefined, closeChannel: () => undefined },
      lease: { canOpenChannel: () => true },
      previews: { originFor: () => null, touch: () => undefined, autoStart: sessionId => autoStart(sessionId) },
      logger: logger().logger,
    });
    const text = (index: number) => Buffer.from((sent[index]!.body as Extract<PreviewToCoreChunk, { kind: "response" }>).body ?? "", "base64url").toString();

    channel.onToRuntime("preview:e497bc8b", { streamId: "a", kind: "request", method: "GET", path: "/", headers: { accept: "text/html" }, final: true });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(text(0)).toBe(`Preview could not start: ${NO_WORKTREE_REASON}`);

    autoStart = async () => { throw new Error("boom"); };
    channel.onToRuntime("preview:e497bc8b", { streamId: "b", kind: "request", method: "GET", path: "/", headers: { accept: "text/html" }, final: true });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(text(1)).toMatch(/^Preview could not start: This computer could not start the preview/);
    expect(channel.counters).toMatchObject({ autoStarted: 0, couldNotStart: 2 });
    channel.dispose();
  });
});
