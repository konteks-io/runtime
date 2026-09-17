import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrollmentStagingStatus, writeStagingProgress } from "../native/enrollment-staging.js";

/** The unpacking `onboard` waits on (WS1-012). */
describe("enrollment staging status", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "konteks-staging-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const notStaged = async () => false;

  it("is done only when the record names a staged release", async () => {
    await writeStagingProgress(root, { state: "done", done: 2, total: 2 });
    expect(await enrollmentStagingStatus(root, notStaged)).toMatchObject({ state: "failed" });
    expect(await enrollmentStagingStatus(root, async () => true)).toEqual({ state: "done" });
  });

  it("reports progress from a live unpacking, and failure from a dead one", async () => {
    await writeStagingProgress(root, { state: "running", pid: process.pid, agent: "codex", done: 1, total: 2 });
    expect(await enrollmentStagingStatus(root, notStaged)).toEqual({ state: "running", agent: "codex", done: 1, total: 2 });
    await writeStagingProgress(root, { state: "running", pid: 999_999, done: 0, total: 2 });
    expect(await enrollmentStagingStatus(root, notStaged)).toMatchObject({ state: "failed" });
  });

  it("has not started when nothing was recorded", async () => {
    expect(await enrollmentStagingStatus(root, notStaged)).toEqual({ state: "not_started" });
  });
});
