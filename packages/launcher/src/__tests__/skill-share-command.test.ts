import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { shareSkill } from "../native/skill-share-command.js";
import { createNativeProgram } from "../native/cli.js";
import type { ControlContext } from "../native/control-commands.js";

const selected = {
  localId: "a".repeat(64),
  treeDigest: `sha256:${"b".repeat(64)}`,
  name: "example",
  fileCount: 1,
  sizeBytes: 10,
};
function fixture(tty = false, json = false) {
  const call = vi
    .fn()
    .mockResolvedValueOnce(selected)
    .mockResolvedValueOnce({
      id: "12345678-1234-4234-8234-123456789abc",
      tenantId: "tenant-a",
      type: "skill",
      metadata: { runtimePromotionKey: "key" },
    });
  const output = { json, line: vi.fn(), result: vi.fn() };
  const context = {
    control: { call },
    output,
    input: { isTTY: tty },
    confirm: vi.fn().mockResolvedValue(true),
    promptLine: vi.fn().mockResolvedValue("organization"),
  } as unknown as ControlContext;
  return { context, call, output };
}

describe("Skill sharing CLI", () => {
  it("preserves repeated system and initiative options", async () => {
    const control = vi.fn();
    const program = createNativeProgram({ control } as never);
    await program.parseAsync(
      [
        "skills",
        "share",
        "example",
        "--system",
        "system-a",
        "--system",
        "system-b",
        "--initiative",
        "initiative-a",
        "--initiative",
        "initiative-b",
        "--confirm-ongoing-publication",
      ],
      { from: "user" },
    );
    expect(control.mock.calls[0]![0].skillShare).toEqual({
      skill: "example",
      organization: false,
      systems: ["system-a", "system-b"],
      initiatives: ["initiative-a", "initiative-b"],
      confirmOngoingPublication: true,
    });
  });
  it("fails without a noninteractive audience and rejects mixed audiences before reading a folder", async () => {
    const { context, call } = fixture();
    await expect(
      shareSkill(context, { skill: "example", confirmOngoingPublication: true }),
    ).rejects.toThrow("requires");
    await expect(
      shareSkill(context, { skill: "example", organization: true, systems: ["system-a"] }),
    ).rejects.toThrow("never both");
    expect(call).not.toHaveBeenCalled();
  });
  it("requires explicit noninteractive consent and refuses cancelled interactive sharing", async () => {
    const first = fixture();
    await expect(
      shareSkill(first.context, { skill: "example", organization: true }),
    ).rejects.toThrow("Explicit consent");
    expect(first.call).toHaveBeenCalledTimes(1);
    const second = fixture(true);
    vi.mocked(second.context.confirm!).mockResolvedValue(false);
    await expect(
      shareSkill(second.context, { skill: "example", organization: true }),
    ).rejects.toThrow("cancelled");
    expect(second.call).toHaveBeenCalledTimes(1);
  });
  it("prompts for omitted interactive audience and binds the immutable selection", async () => {
    const { context, call, output } = fixture(true);
    await shareSkill(context, { skill: "example", initiatives: ["initiative-a", "initiative-a"] });
    expect(context.promptLine).toHaveBeenCalledOnce();
    expect(context.confirm).toHaveBeenCalledOnce();
    expect(call.mock.calls[1]![0]).toMatchObject({
      op: "skills.share",
      selection: {
        localId: selected.localId,
        treeDigest: selected.treeDigest,
        audience: { kind: "organization" },
        context: { kind: "initiatives", initiativeRefs: ["initiative-a"] },
        confirmation: { ongoingPublication: true },
      },
    });
    expect(output.result).toHaveBeenCalledWith(
      expect.objectContaining({ ongoingPublication: "unverified", loaded: "unknown" }),
    );
  });
  it("resolves a relative source locally and keeps its path outside the publication selection", async () => {
    const { context, call } = fixture();
    await shareSkill(context, {
      skill: "./example",
      systems: ["system-a"],
      confirmOngoingPublication: true,
    });
    expect(call.mock.calls[0]![0]).toEqual({
      op: "skills.inspect",
      source: { kind: "path", path: resolve("./example") },
    });
    expect(call.mock.calls[1]![0].sourcePath).toBe(resolve("./example"));
    expect(JSON.stringify(call.mock.calls[1]![0].selection)).not.toContain(resolve("./example"));
  });
  it("never prompts in JSON mode even when stdin is a terminal", async () => {
    const { context, call } = fixture(true, true);
    await expect(shareSkill(context, { skill: "example" })).rejects.toThrow();
    expect(context.promptLine).not.toHaveBeenCalled();
    expect(context.confirm).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
  it("does not publish after failed source inspection or retry an uncertain publication", async () => {
    const first = fixture();
    first.call.mockReset().mockRejectedValue(new Error("ambiguous source"));
    await expect(
      shareSkill(first.context, {
        skill: "example",
        organization: true,
        confirmOngoingPublication: true,
      }),
    ).rejects.toThrow("ambiguous");
    expect(first.call).toHaveBeenCalledTimes(1);
    const second = fixture();
    second.call
      .mockReset()
      .mockResolvedValueOnce(selected)
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      shareSkill(second.context, {
        skill: "example",
        organization: true,
        confirmOngoingPublication: true,
      }),
    ).rejects.toThrow("connection lost");
    expect(second.call).toHaveBeenCalledTimes(2);
    expect(second.output.result).not.toHaveBeenCalled();
  });
});
