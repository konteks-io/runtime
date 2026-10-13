import { expect, it } from "vitest";
import { skillProfileFreshness } from "../native/skill-profile-freshness.js";

const oldRevision = `sha256:${"a".repeat(64)}`;
const nextRevision = `sha256:${"b".repeat(64)}`;
const inventory = (catalogDigest: string, profiles: { agentId: string; status: "installed" | "failed"; reason?: string }[]) => ({
  catalogDigest, skills: [], profiles: profiles.map(profile => ({ home: "/private/path", paths: [], ...profile })),
});

it("distinguishes the last observed catalog from installation and leaves native load unproven", () => {
  const [profile] = skillProfileFreshness({ agentIds: ["codex"], inventory: inventory(nextRevision, [{ agentId: "codex", status: "installed" }]) });
  expect(profile).toEqual({ agentId: "codex", desiredRevision: nextRevision, installedRevision: nextRevision, loadedRevision: null, state: "current" });
  expect(JSON.stringify(profile)).not.toContain("/private/path");
});

it("does not claim one installed revision after a multi-home publication partly fails", () => {
  const [profile] = skillProfileFreshness({ agentIds: ["codex"], previous: [
    { agentId: "codex", desiredRevision: oldRevision, installedRevision: oldRevision, loadedRevision: oldRevision, state: "current" },
  ], inventory: inventory(nextRevision, [{ agentId: "codex", status: "failed", reason: "profile_publication_failed" }]) });
  expect(profile).toEqual({ agentId: "codex", desiredRevision: nextRevision, installedRevision: null, loadedRevision: null, state: "failed", reason: "profile_publication_failed" });
});

it("makes unsupported profiles visibly blocked and keeps load proof unknown", () => {
  expect(skillProfileFreshness({ agentIds: ["opencode"], inventory: inventory(nextRevision, [
    { agentId: "opencode", status: "failed", reason: "native_profile_unconfigured" },
  ]) })).toEqual([{ agentId: "opencode", desiredRevision: nextRevision, installedRevision: null, loadedRevision: null, state: "failed", reason: "skill_home_unavailable" }]);
  expect(skillProfileFreshness({ agentIds: ["codex"], unavailableReason: "catalog_unavailable" })).toEqual([
    { agentId: "codex", desiredRevision: null, installedRevision: null, loadedRevision: null, state: "unknown", reason: "catalog_unavailable" },
  ]);
});
