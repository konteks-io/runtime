import { expect, it, vi } from "vitest";
import { syncSkills } from "../native/control-commands.js";
import { AlreadyToldError, type Output } from "../output.js";

it.each([true, false])("reports profile outcomes before returning complete=%s", async complete => {
  const report = { complete, loaded: "unknown", skills: [], profiles: [
    { home: "/private/agent-a", paths: [], status: complete ? "installed" : "failed",
      ...(complete ? {} : { reason: "profile_publication_failed" }) },
  ] };
  const output: Output = { json: false, line: vi.fn(), table: vi.fn(), result: vi.fn(), error: vi.fn() };
  const call = vi.fn(async () => report);
  const operation = syncSkills({ output, control: { call } as never });
  if (complete) await expect(operation).resolves.toBeUndefined();
  else await expect(operation).rejects.toBeInstanceOf(AlreadyToldError);
  expect(output.result).toHaveBeenCalledWith(report);
  expect(output.line).toHaveBeenCalledWith("Skill load status is not yet verified.");
  expect(call).toHaveBeenCalledWith({ op: "skills.sync" }, expect.anything(), { timeoutMs: 95_000 });
});

it("reports a configured agent without a discovery profile as a failed sync", async () => {
  const report = { complete: false, loaded: "unknown", skills: [], profiles: [
    { agentId: "codex", home: "", paths: [], status: "failed", reason: "native_profile_unconfigured" },
  ] };
  const output: Output = { json: true, line: vi.fn(), table: vi.fn(), result: vi.fn(), error: vi.fn() };
  const call = vi.fn(async () => report);
  await expect(syncSkills({ output, control: { call } as never })).rejects.toBeInstanceOf(AlreadyToldError);
  expect(output.result).toHaveBeenCalledWith(report);
  expect(output.line).toHaveBeenCalledWith("codex: failed (native_profile_unconfigured)");
});
