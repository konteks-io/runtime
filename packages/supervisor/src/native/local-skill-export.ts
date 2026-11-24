import {
  LocalSkillExportCommandSchema,
  LocalSkillExportResultSchema,
  type LocalSkillExportCommand,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import type { CoreSignatureVerifier } from "../control/core-signature.js";
import { exportLocalSkill } from "../skills/local-skills.js";

type ExportRuntime = {
  verifier: Pick<CoreSignatureVerifier, "verifyLocalSkillExport">;
  identity: () => { workspaceId: string; instanceId: string } | null;
  homes: readonly string[];
  now: () => number;
};

function assertCurrent(command: LocalSkillExportCommand, runtime: ExportRuntime, signal: AbortSignal) {
  const { intent } = command;
  const identity = runtime.identity();
  const now = runtime.now();
  if (signal.aborted || !Number.isFinite(now) || !identity ||
    intent.workspaceId !== identity.workspaceId || intent.instanceId !== identity.instanceId ||
    Date.parse(intent.issuedAt) > now + 1_000 || Date.parse(intent.expiresAt) <= now) {
    throw new Error("Local Skill export authority is unavailable");
  }
}

export async function prepareLocalSkillExport(value: unknown, runtime: ExportRuntime, signal: AbortSignal) {
  const command = LocalSkillExportCommandSchema.parse(value);
  if (!runtime.verifier.verifyLocalSkillExport(command)) {
    throw new Error("Local Skill export signature is invalid");
  }
  assertCurrent(command, runtime, signal);
  const tree = await exportLocalSkill(runtime.homes, command.intent).catch(() => null);
  assertCurrent(command, runtime, signal);
  return LocalSkillExportResultSchema.parse({ requestId: command.intent.requestId, tree });
}
