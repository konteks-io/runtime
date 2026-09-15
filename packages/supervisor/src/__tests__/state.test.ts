import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, SECRET_CANARIES, containsCanary } from "@konteks/remote-common";
import { PendingRequestSchema, SupervisorJournal, type JournalEntry } from "../state/journal.js";
import { DurableOutbox } from "../state/outbox.js";
import { SupervisorStore } from "../state/store.js";
import { LeaseState, decodeLeaseClaims, leaseRecordFromClaims } from "../lease/lease.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-sup-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  assignmentId: "asg-1",
  attempt: 1,
  claimId: "claim-1",
  kind: "delivery",
  placementId: "pl-1",
  workspaceId: "ws-1",
  agentId: "codex",
  state: "claimed",
  recoveryEpoch: 0,
  reports: { nextSequence: 1, durableWatermark: 0 },
  evidenceUpload: "structured_only",
  expiresAt: "2026-09-07T00:00:00Z",
  latestResumeAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
  ...overrides,
});

it("keeps legacy delivery transcript state but strips its obsolete execution authority", () => {
  const restored = PendingRequestSchema.parse({
    acpSessionRef: "legacy-ref", id: "legacy-turn", method: "session/prompt", direction: "issued",
    openedAt: "2026-09-06T00:00:00Z", closedAt: null, deadlineAt: null, requestDigest: null,
    authorization: { claims: { workloadKind: "harness_delivery", deliveryIdentity: {} }, receipt: "legacy", state: "admitted" },
  });
  expect(restored.authorization).toBeUndefined();
});

describe("supervisor store", () => {
  it("creates the instance key once with restricted mode and reloads the same key", async () => {
    const store = new SupervisorStore(dir);
    await store.init();
    const first = await store.loadOrCreateInstanceKey();
    const second = await store.loadOrCreateInstanceKey();
    expect(second.publicKeyJwk).toEqual(first.publicKeyJwk);
    expect((await stat(store.path("instance-key.jwk"))).mode & 0o777).toBe(0o600);
  });

  it("persists identity, provisioning, lease, manifest, cursors, heartbeat, and erases konteks data without the key", async () => {
    const store = new SupervisorStore(dir);
    await store.init();
    await store.loadOrCreateInstanceKey();
    await store.saveIdentity({ instanceId: "i", workspaceId: null, activationId: "a", activatedAt: "2026-09-06T00:00:00Z", administrativeStatus: "provisioning", exchangeNonce: "n" });
    await store.saveCursors({ control: { to_core: 3, to_runtime: 7 } });
    await store.saveHeartbeatSequence(42);
    expect((await store.identity())?.instanceId).toBe("i");
    expect(await store.cursors()).toEqual({ control: { to_core: 3, to_runtime: 7 } });
    expect(await store.heartbeatSequence()).toBe(42);
    await store.eraseAllKonteksData();
    expect(await store.heartbeatSequence()).toBe(0);
    expect((await store.identity())?.instanceId).toBe("i");
    await expect(stat(store.path("instance-key.jwk"))).resolves.toBeTruthy();
  });
});

describe("assignment recovery journal", () => {
  it("does not publish a failed readiness update or mutate records through readers", async () => {
    const journal = new SupervisorJournal(dir); await journal.load();
    await journal.assignments.put(entry());
    const file = join(dir, "assignments.jsonl");
    await rename(file, `${file}.saved`); await mkdir(file);
    await expect(journal.assignments.update("asg-1:1", current => ({ ...current!, state: "running" }))).rejects.toThrow();
    expect(journal.assignments.get("asg-1:1")?.state).toBe("claimed");
    await rm(file, { recursive: true }); await rename(`${file}.saved`, file);
    const copy = journal.assignments.get("asg-1:1")!; copy.state = "completed";
    expect(journal.assignments.get("asg-1:1")?.state).toBe("claimed");
    await journal.assignments.compact();
    const restarted = new SupervisorJournal(dir); await restarted.load();
    expect(restarted.assignments.get("asg-1:1")?.state).toBe("claimed");
  });

  it("serializes updates and compaction without losing counters or durable records", async () => {
    const journal = new SupervisorJournal(dir); await journal.load(); await journal.assignments.put(entry());
    await Promise.all(Array.from({ length: 30 }, (_, i) => i % 3 === 0 ? journal.assignments.compact() : journal.assignments.update("asg-1:1", current => ({ ...current!, reports: { ...current!.reports, nextSequence: current!.reports.nextSequence + 1 } }))));
    const restarted = new SupervisorJournal(dir); await restarted.load();
    expect(restarted.assignments.get("asg-1:1")?.reports.nextSequence).toBe(21);
    expect(journal.assignments.get("asg-1:1")?.reports.nextSequence).toBe(21);
  });

  it("repairs a torn tail before appending and rejects corrupt complete records", async () => {
    const first = new SupervisorJournal(dir); await first.load(); await first.assignments.put(entry());
    const file = join(dir, "assignments.jsonl");
    const complete = await readFile(file, "utf8"); await writeFile(file, complete + '{"torn":');
    const resumed = new SupervisorJournal(dir); await resumed.load(); await resumed.assignments.put(entry({ state: "running" }));
    const restarted = new SupervisorJournal(dir); await restarted.load();
    expect(restarted.assignments.get("asg-1:1")?.state).toBe("running");
    await writeFile(file, complete + '{"corrupt":}\n');
    await expect(new SupervisorJournal(dir).load()).rejects.toThrow();
  });

  it("survives restart and a torn trailing line", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    await journal.assignments.put(entry());
    await journal.assignments.put(entry({ state: "running", acpSessionRef: "acp-1" }));
    await writeFile(join(dir, "assignments.jsonl"), `${await readFile(join(dir, "assignments.jsonl"), "utf8")}{"torn":`);
    const reloaded = new SupervisorJournal(dir);
    await reloaded.load();
    expect(reloaded.assignments.get("asg-1:1")).toMatchObject({ state: "running", acpSessionRef: "acp-1" });
    expect(reloaded.activeAssignments()).toHaveLength(1);
  });

  it("rejects checkpoint content or paths on the journal boundary", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    await expect(journal.assignments.put({ ...entry(), checkpoint: { ref: "ckpt-1", hash: "h".repeat(43), createdAt: "2026-09-06T00:00:00Z", content: "x" } } as never)).rejects.toThrow();
    await expect(journal.assignments.put({ ...entry(), stdio: "agent output" } as never)).rejects.toThrow();
  });

  it("prunes terminal entries oldest-first beyond the bound", async () => {
    // Seed a recovered backlog once; this test exercises pruning, not 2,005
    // individual power-loss-safe flushes on the development host.
    await writeFile(join(dir, "assignments.jsonl"), Array.from({ length: 2_005 }, (_, index) => JSON.stringify(entry({ assignmentId: `asg-${index}`, state: "completed", updatedAt: `2026-09-06T00:00:${String(index % 60).padStart(2, "0")}Z` }))).join("\n") + "\n");
    const journal = new SupervisorJournal(dir);
    await journal.load();
    await journal.prune();
    expect(journal.assignments.all().length).toBeLessThanOrEqual(2_000);
  });

  it("tracks pending requests per acpSessionRef (D114)", async () => {
    const journal = new SupervisorJournal(dir);
    await journal.load();
    await journal.pendingRequests.put({ acpSessionRef: "acp-1", id: "r1", method: "session/prompt", direction: "received", openedAt: "2026-09-06T00:00:00Z", closedAt: null, deadlineAt: null, requestDigest: null });
    expect(journal.openRequests("acp-1")).toHaveLength(1);
    await journal.pendingRequests.put({ acpSessionRef: "acp-1", id: "r1", method: "session/prompt", direction: "received", openedAt: "2026-09-06T00:00:00Z", closedAt: "t2", deadlineAt: null, requestDigest: null });
    expect(journal.openRequests("acp-1")).toHaveLength(0);
  });
});

describe("durable outbox", () => {
  const message = (id: string) => ({ id, channel: "control" as const, key: `ack:${id}`, group: `ack:${id}`, order: 1, body: { revision: 1 }, createdAt: "2026-09-06T00:00:00Z" });
  it("does not publish an enqueue or forget an acknowledgement when disk writes fail", async () => {
    const outbox = new DurableOutbox(dir);
    await outbox.load();
    const path = join(dir, "outbox.jsonl");
    await mkdir(path);
    await expect(outbox.enqueue(message("1"))).rejects.toThrow();
    expect(outbox.depth).toBe(0);
    await rm(path, { recursive: true });
    await outbox.enqueue(message("1"));
    await rename(path, `${path}.saved`);
    await mkdir(path);
    await expect(outbox.ack("1")).rejects.toThrow();
    expect(outbox.depth).toBe(1);
    await rm(path, { recursive: true });
    await rename(`${path}.saved`, path);
    await outbox.ack("1");
    const restarted = new DurableOutbox(dir);
    await restarted.load();
    expect(restarted.depth).toBe(0);
  });

  it("serializes concurrent appends and compactions without losing durable entries", async () => {
    const outbox = new DurableOutbox(dir);
    await outbox.load();
    await Promise.all(Array.from({ length: 30 }, (_, i) => i % 3 === 0 ? outbox.compact() : outbox.enqueue(message(String(i)))));
    const restarted = new DurableOutbox(dir);
    await restarted.load();
    expect(outbox.depth).toBe(20);
    expect(restarted.depth).toBe(20);
  });

  it("repairs only a torn trailing record before appending and rejects complete-record corruption", async () => {
    const first = new DurableOutbox(dir);
    await first.load();
    await first.enqueue(message("1"));
    const path = join(dir, "outbox.jsonl");
    const saved = await readFile(path, "utf8");
    await writeFile(path, `${saved}{"op":`);
    const restarted = new DurableOutbox(dir);
    await restarted.load();
    await restarted.enqueue(message("2"));
    const third = new DurableOutbox(dir);
    await third.load();
    expect(third.depth).toBe(2);
    await writeFile(path, `${saved}{broken}\n`);
    await expect(new DurableOutbox(dir).load()).rejects.toThrow();
  });

  it("keeps items until acked, dedups by key, and orders groups strictly", async () => {
    const outbox = new DurableOutbox(dir);
    await outbox.load();
    await outbox.enqueue({ id: "1", channel: "assignment", key: "report:a:1:c:1", group: "a:1:c", order: 1, body: { seq: 1 }, createdAt: "t1" });
    await outbox.enqueue({ id: "2", channel: "assignment", key: "report:a:1:c:2", group: "a:1:c", order: 2, body: { seq: 2 }, createdAt: "t2" });
    await outbox.enqueue({ id: "3", channel: "assignment", key: "report:a:1:c:1", group: "a:1:c", order: 1, body: { seq: 1 }, createdAt: "t3" });
    expect(outbox.depth).toBe(2);
    expect(outbox.heads("assignment").map((item) => item.id)).toEqual(["1"]);
    await outbox.ack("1");
    expect(outbox.heads("assignment").map((item) => item.id)).toEqual(["2"]);
    const reloaded = new DurableOutbox(dir);
    await reloaded.load();
    expect(reloaded.depth).toBe(1);
    expect(reloaded.groupFrom("a:1:c", 2).map((item) => item.order)).toEqual([2]);
  });

  it("never carries a secret (canary) into the outbox file by construction of its callers", async () => {
    const outbox = new DurableOutbox(dir);
    await outbox.load();
    await outbox.enqueue({ id: "1", channel: "observation", key: "obs:1", group: "obs", order: 1, body: { provider: "anthropic", model: "m" }, createdAt: "2026-09-06T00:00:00Z" });
    expect(containsCanary(await readFile(join(dir, "outbox.jsonl"), "utf8"))).toBe(false);
    expect(SECRET_CANARIES.anthropicKey.length).toBeGreaterThan(0);
  });
});

describe("lease state", () => {
  const clock = new FixedClock(Date.parse("2026-09-06T00:00:00Z"));
  const token = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const base = { iss: "konteks:control-plane", aud: "konteks:remote-instance:lease", sub: "inst-1", workspace_id: "ws", jti: "j", iat: 1_788_652_800, exp: 1_788_652_800 + 600, protocol: "1.0", bundle_version: "1.0.0", components: ["harness", "validation_runtime", "agent_runner", "gateway"], ownership_scope: "personal", administrative_status: "active" };

  it("decodes claims and rejects a lease for another instance or audience", () => {
    const claims = decodeLeaseClaims(token({ ...base, lease_mode: "active" }), { instanceId: "inst-1", audience: base.aud });
    expect(claims.lease_mode).toBe("active");
    expect(() => decodeLeaseClaims(token({ ...base, lease_mode: "active", sub: "other" }), { instanceId: "inst-1", audience: base.aud })).toThrow(/subject/);
    expect(() => decodeLeaseClaims(token({ ...base, lease_mode: "drain_only" }), { instanceId: "inst-1", audience: base.aud })).toThrow();
  });

  it("an active lease pulls and opens every channel; drain_only opens no session/preview; expired opens only control", () => {
    const state = new LeaseState(clock);
    state.set(leaseRecordFromClaims("t", decodeLeaseClaims(token({ ...base, lease_mode: "active" }), { instanceId: "inst-1", audience: base.aud })));
    expect(state.canPullNewWork()).toBe(true);
    expect(state.canOpenChannel("session")).toBe(true);
    state.set(leaseRecordFromClaims("t", decodeLeaseClaims(token({ ...base, lease_mode: "drain_only", drain_deadline: new Date(base.exp * 1000).toISOString() }), { instanceId: "inst-1", audience: base.aud })));
    expect(state.canPullNewWork()).toBe(false);
    expect(state.canOpenChannel("session")).toBe(false);
    expect(state.canOpenChannel("preview")).toBe(false);
    expect(state.canOpenChannel("assignment")).toBe(true);
    clock.advance(700_000);
    expect(state.mode()).toBe("none");
    expect(state.canOpenChannel("heartbeat")).toBe(false);
    expect(state.canOpenChannel("control")).toBe(true);
  });
});
