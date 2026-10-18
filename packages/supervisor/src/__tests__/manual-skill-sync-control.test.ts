import { describe, expect, it } from "vitest";
import { ControlRequestSchema } from "@konteks/remote-common";

describe("native Skill CLI control operations", () => {
  it("accepts sync and list as explicit supervisor operations", () => {
    expect(ControlRequestSchema.parse({ op: "skills.sync" })).toEqual({ op: "skills.sync" });
    expect(ControlRequestSchema.parse({ op: "skills.list" })).toEqual({ op: "skills.list" });
  });

  it("requires explicit confirmation and a Skill identity for unsharing", () => {
    expect(ControlRequestSchema.parse({ op: "skills.unshare", skill: "./my-skill", confirm: true })).toEqual({
      op: "skills.unshare", skill: "./my-skill", confirm: true,
    });
    expect(ControlRequestSchema.safeParse({ op: "skills.unshare", skill: "./my-skill" }).success).toBe(false);
  });

  it("requires one non-empty audience and confirmation for ongoing sharing", () => {
    expect(
      ControlRequestSchema.parse({
        op: "skills.share",
        skill: "./my-skill",
        audience: { level: "systems", systemIds: ["system-a", "system-b"] },
        initiativeIds: ["initiative-a"],
        confirmOngoing: true,
      }),
    ).toMatchObject({
      op: "skills.share",
      audience: { level: "systems", systemIds: ["system-a", "system-b"] },
    });
    expect(
      ControlRequestSchema.safeParse({
        op: "skills.share",
        skill: "my-skill",
        audience: { level: "systems", systemIds: [] },
        initiativeIds: [],
        confirmOngoing: true,
      }).success,
    ).toBe(false);
    expect(
      ControlRequestSchema.safeParse({
        op: "skills.share",
        skill: "my-skill",
        audience: { level: "organization" },
        initiativeIds: [],
        confirmOngoing: false,
      }).success,
    ).toBe(false);
  });
});
