import { describe, expect, it, vi } from "vitest";
import { CODEX_SANDBOX_GROUP, grantCodexSandboxRead } from "../native/codex-sandbox-read.js";

const skills = "C:\\Users\\ana\\.konteks\\work\\skills\\s1";
const context = "C:\\Users\\ana\\.konteks\\work\\session-context\\c1";

/** 11-01: Codex on a Windows PC could not read the staged SKILL.md ("access denial"). */
describe("Codex sandbox read grant", () => {
  it("grants Codex's sandbox users inheritable read, never write, on each staged directory once", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await grantCodexSandboxRead({
      platform: "win32",
      agentId: "codex",
      directories: [skills, context, skills],
      run,
    });
    expect(run.mock.calls).toEqual([
      ["icacls", [skills, "/grant", `${CODEX_SANDBOX_GROUP}:(OI)(CI)(RX)`, "/T", "/C", "/Q"]],
      ["icacls", [context, "/grant", `${CODEX_SANDBOX_GROUP}:(OI)(CI)(RX)`, "/T", "/C", "/Q"]],
    ]);
  });

  it("changes nothing for another agent or another platform", async () => {
    const run = vi.fn();
    await grantCodexSandboxRead({
      platform: "win32",
      agentId: "claude-code",
      directories: [skills],
      run,
    });
    await grantCodexSandboxRead({
      platform: "darwin",
      agentId: "codex",
      directories: [skills],
      run,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("logs a grant that cannot be made and lets the turn go on", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new Error("No mapping between account names and security IDs was done."));
    const warn = vi.fn();
    await expect(
      grantCodexSandboxRead({
        platform: "win32",
        agentId: "codex",
        directories: [skills],
        run,
        logger: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "codex_sandbox.read_grant_failed", directory: skills }),
      "codex sandbox read grant failed",
    );
  });
});
