import { describe, expect, it, vi } from "vitest";
import { LocalSkillExchange } from "../native/local-skill-exchange.js";
import { prepareLocalSkillExport } from "../native/local-skill-export.js";

vi.mock("../skills/local-skills.js", () => ({ discoverLocalSkills: vi.fn(async () => []) }));
vi.mock("../native/local-skill-export.js", () => ({ prepareLocalSkillExport: vi.fn(async () => ({ requestId: "one", tree: null })) }));

describe("local Skill exchange", () => {
  it("sends only inventory until Core provides an export command and prevents overlapping pulses", async () => {
    let accessible = true;
    const core = {
      reportLocalSkillInventory: vi.fn(async () => ({ accepted: true as const })),
      pollLocalSkillExport: vi.fn().mockResolvedValueOnce({ command: null }).mockResolvedValueOnce({ command: { intent: { requestId: "one" } } }),
      reportLocalSkillExport: vi.fn(async () => ({ accepted: true as const })),
    };
    const exchange = new LocalSkillExchange({
      core,
      homes: () => [],
      verifier: { verifyLocalSkillExport: () => false },
      now: () => 100_000,
      identity: () => accessible ? { workspaceId: "workspace", instanceId: "runtime" } : null,
    });
    exchange.kick();
    exchange.kick();
    await vi.waitFor(() => expect(core.pollLocalSkillExport).toHaveBeenCalledTimes(1));
    expect(core.reportLocalSkillInventory).toHaveBeenCalledTimes(1);
    expect(prepareLocalSkillExport).not.toHaveBeenCalled();

    exchange.kick();
    await vi.waitFor(() => expect(core.reportLocalSkillExport).toHaveBeenCalledWith(
      "runtime", { requestId: "one", tree: null }, expect.any(AbortSignal),
    ));
    expect(core.reportLocalSkillInventory).toHaveBeenCalledTimes(1);
    accessible = false;
    exchange.kick();
    expect(core.pollLocalSkillExport).toHaveBeenCalledTimes(2);
    exchange.stop();
  });
});
