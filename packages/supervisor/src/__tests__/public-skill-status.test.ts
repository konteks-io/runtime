import { expect, it } from "vitest";
import { publicSkillStatus } from "../skills/public-status.js";
it("distinguishes never-synced from successful empty inventory", () => {
  expect(publicSkillStatus({ syncing: true })).toEqual({ syncing: true, lastSuccess: null });
  expect(publicSkillStatus({ syncing: false, lastSuccess: { syncedAt: new Date(1000).toISOString(), inventory: { skills: [], profiles: [] } } }))
    .toEqual({ syncing: false, lastSuccess: { syncedAt: new Date(1000).toISOString(), skills: [] } });
});
it("exposes metadata and retains historical success during refresh without host paths", () => {
  const status = publicSkillStatus({ syncing: true, lastSuccess: { syncedAt: new Date(1000).toISOString(), inventory: {
    skills: [{ skillId: "11111111-1111-4111-8111-111111111111", name: "example", description: "Example", version: "1.0.0", treeDigest: `sha256:${"a".repeat(64)}`, sizeBytes: 1, fileCount: 1 }],
    profiles: [{ home: "/private/agent", paths: ["/private/skill"] }],
  } } });
  expect(status.lastSuccess?.skills[0]).toEqual({ skillId: "11111111-1111-4111-8111-111111111111", name: "example", description: "Example", version: "1.0.0" });
  expect(JSON.stringify(status)).not.toContain("private"); expect(JSON.stringify(status)).not.toContain("treeDigest");
});
