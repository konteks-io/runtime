import { RemoteInstanceError } from "@konteks/remote-common";
import type { RuntimeFailureFact } from "../runtime-failure-types.js";
import { diagnosticIdentifier, filesystemFailure, NamedRefusal, refusalEvidence } from "./named-refusal.js";

/**
 * Names for every refusal on the recovery-checkpoint path (10-31): one shared
 * computer failed its checkpoint at the end of every delivery attempt, and
 * Core only ever saw a bare `workspace_capture` runtime exception.
 */

/** The Git call a checkpoint refusal came from. */
export type CheckpointGitStep =
  | "rev_parse" | "for_each_ref" | "ls_files_stage" | "cat_file" | "init_bare" | "update_ref" | "mktree"
  | "commit_tree" | "bundle_create" | "init" | "bundle_verify" | "fetch" | "symbolic_ref" | "config" | "fsck";

/** The named check behind a checkpoint failure, down to the Git step; an OS error by syscall and errno. */
export function checkpointCause(error: unknown): string | undefined {
  if (!(error instanceof RemoteInstanceError)) return filesystemFailure(error)?.diagnostic ?? schemaCause(error);
  const gitStep = error instanceof NamedRefusal ? error.facts.gitStep : undefined;
  return diagnosticIdentifier(gitStep ? `${error.diagnostic}_${gitStep}` : error.diagnostic);
}

function schemaCause(error: unknown): string | undefined {
  return error instanceof Error && error.name === "ZodError" ? "schema_invalid" : undefined;
}

/** A failed checkpoint step as Konteks reads it: the stage carries the cause, the evidence only what was observed. */
export function checkpointFailure(error: unknown, operation: { stage: string; code: string }): RuntimeFailureFact {
  const cause = checkpointCause(error);
  const stage = (cause === undefined ? undefined : diagnosticIdentifier(`${operation.stage}_${cause}`, 96)) ?? operation.stage;
  return { phase: "checkpoint", stage, code: operation.code, evidence: refusalEvidence(error) };
}
