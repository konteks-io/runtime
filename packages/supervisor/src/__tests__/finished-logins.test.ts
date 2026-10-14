import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINISHED_LOGIN_LIMIT, FINISHED_LOGIN_WINDOW_MS, FinishedLogins } from "../native/finished-logins.js";

let dataDir: string;
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), "finished-logins-")); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

function logins(clock: { now: number }) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, logins: new FinishedLogins({ dataDir, now: () => clock.now, logger: logger as never, mutate: operation => operation() }) };
}

const succeeded = (loginId: string) => ({ loginId, agentId: "codex" as const, state: "succeeded" as const });

describe("sign-ins that ended on this computer (D134)", () => {
  it("remembers the report that ended a sign-in, across a restart, and nothing that did not end it", async () => {
    const clock = { now: Date.parse("2026-10-14T00:00:00.000Z") };
    const first = logins(clock).logins;
    first.record({ loginId: "waiting", agentId: "codex", state: "awaiting_person", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" });
    first.record(succeeded("done"));
    first.record({ loginId: "refused", agentId: "claude-code", state: "failed", failure: "unavailable" });
    expect(await first.get("done")).toEqual(succeeded("done"));
    expect(await first.get("waiting")).toBeUndefined();

    const restarted = logins(clock).logins;
    expect(await restarted.get("done")).toEqual(succeeded("done"));
    expect(await restarted.get("refused")).toEqual({ loginId: "refused", agentId: "claude-code", state: "failed", failure: "unavailable" });
  });

  it("forgets a sign-in after a day, and keeps only the most recent ones", async () => {
    const clock = { now: Date.parse("2026-10-14T00:00:00.000Z") };
    const { logins: kept } = logins(clock);
    kept.record(succeeded("old"));
    clock.now += FINISHED_LOGIN_WINDOW_MS - 1;
    expect(await kept.get("old")).toEqual(succeeded("old"));
    clock.now += 1;
    expect(await kept.get("old")).toBeUndefined();
    for (let index = 0; index < FINISHED_LOGIN_LIMIT + 1; index += 1) kept.record(succeeded(`login-${index}`));
    expect(await kept.get("old")).toBeUndefined();
    expect(await kept.get("login-0")).toBeUndefined();
    expect(await kept.get("login-1")).toEqual(succeeded("login-1"));
    expect(await kept.get(`login-${FINISHED_LOGIN_LIMIT}`)).toEqual(succeeded(`login-${FINISHED_LOGIN_LIMIT}`));
  });

  it("starts without a damaged file and says so", async () => {
    await writeFile(join(dataDir, "finished-logins.json"), "{not json", { mode: 0o600 });
    const { logins: damaged, logger } = logins({ now: Date.parse("2026-10-14T00:00:00.000Z") });
    expect(await damaged.get("done")).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
