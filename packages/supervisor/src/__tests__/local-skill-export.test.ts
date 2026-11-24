import { sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateEd25519 } from "@konteks/remote-common";
import {
  localSkillExportSigningBytes,
  type LocalSkillExportCommand,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import { CoreSignatureVerifier } from "../control/core-signature.js";
import { prepareLocalSkillExport } from "../native/local-skill-export.js";
import { exportLocalSkill } from "../skills/local-skills.js";

vi.mock("../skills/local-skills.js", () => ({ exportLocalSkill: vi.fn(async () => { throw new Error("stale"); }) }));

describe("signed local Skill export", () => {
  it("rejects changed targets, runtime identity and expiry before reading local files", async () => {
    const key = generateEd25519();
    const root = { keyId: "release", publicKeyJwk: key.publicJwk, coreControlKeys: [{ keyId: "control", publicKeyJwk: key.publicJwk }] };
    const now = Date.parse("2026-11-23T00:00:00Z");
    const intent: LocalSkillExportCommand["intent"] = {
      requestId: "request-a", workspaceId: "workspace-a", instanceId: "runtime-a", ownerId: "owner-a",
      targetKind: "system", targetId: "system-a", localId: "1".repeat(64), treeDigest: `sha256:${"2".repeat(64)}`,
      issuedAt: new Date(now - 100).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
    };
    const command = {
      keyId: "control", intent,
      signature: sign(null, localSkillExportSigningBytes({ keyId: "control", intent }), key.privateKey).toString("base64url"),
    };
    const identity = () => ({ workspaceId: intent.workspaceId, instanceId: intent.instanceId });
    const runtime = { identity, now: () => now, homes: [], verifier: new CoreSignatureVerifier([root]) };
    const signal = new AbortController().signal;
    await expect(prepareLocalSkillExport({ ...command, intent: { ...intent, targetId: "system-b" } }, runtime, signal)).rejects.toThrow("signature");
    await expect(prepareLocalSkillExport(command, { ...runtime, identity: () => ({ ...identity(), instanceId: "runtime-b" }) }, signal)).rejects.toThrow("authority");
    await expect(prepareLocalSkillExport(command, { ...runtime, now: () => now + 30_000 }, signal)).rejects.toThrow("authority");
    expect(exportLocalSkill).not.toHaveBeenCalled();
    await expect(prepareLocalSkillExport(command, runtime, signal)).resolves.toEqual({ requestId: "request-a", tree: null });
    expect(exportLocalSkill).toHaveBeenCalledTimes(1);
  });
});
