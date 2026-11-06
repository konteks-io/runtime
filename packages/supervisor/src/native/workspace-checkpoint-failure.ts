import { RemoteInstanceError } from "@konteks/remote-common";
import type { RuntimeFailureFact } from "../runtime-failure-types.js";
import { NativeInputResponseError } from "./input-client.js";
import { diagnosticIdentifier, filesystemFailure, NamedRefusal, refusalEvidence } from "./named-refusal.js";

/**
 * Names for every refusal on the recovery-checkpoint path (10-31): one shared
 * computer failed its checkpoint at the end of every delivery attempt, and
 * Core only ever saw a bare `workspace_capture` runtime exception.
 */

/** The Git call a checkpoint refusal came from. */
export type CheckpointGitStep =
  | "rev_parse" | "for_each_ref" | "ls_files_stage" | "ls_files_ignored" | "cat_file" | "init_bare" | "update_ref" | "mktree"
  | "commit_tree" | "bundle_create" | "init" | "bundle_verify" | "fetch" | "symbolic_ref" | "config" | "fsck";

/** The named check behind a checkpoint failure, down to the Git step; an OS error by syscall and errno. */
export function checkpointCause(error: unknown): string | undefined {
  if (error instanceof NativeInputResponseError) return diagnosticIdentifier(`response_status_${error.status}`);
  if (!(error instanceof RemoteInstanceError)) return filesystemFailure(error)?.diagnostic ?? schemaCause(error);
  const gitStep = error instanceof NamedRefusal ? error.facts.gitStep : undefined;
  return diagnosticIdentifier(gitStep ? `${error.diagnostic}_${gitStep}` : error.diagnostic);
}

type SchemaIssue = { message?: string; path?: PropertyKey[]; errors?: SchemaIssue[][] };

/** The contract's own refusals, by name; any other refusal is named by its field. Never the refused value. */
const SCHEMA_RULES: ReadonlyMap<string, string> = new Map([
  ["Checkpoint link leaves its workspace", "link_leaves_workspace"],
  ["Invalid workspace manifest limits or paths", "manifest_limits_or_paths"],
  ["Invalid workspace manifest identity", "manifest_identity"],
  ["Workspace manifest is too large", "manifest_too_large"],
]);

/** A checkpoint is one format, so the other format's refusal of `format` says nothing about it. */
function formatIssues(issues: SchemaIssue[]): SchemaIssue[] {
  return issues.flatMap(issue => {
    const arm = issue.errors?.find(candidate => !candidate.some(item => item.path?.[0] === "format"));
    return arm ? formatIssues(arm) : [issue];
  });
}

function schemaRule(issue: SchemaIssue | undefined): string | undefined {
  const field = issue?.path?.[0];
  return SCHEMA_RULES.get(issue?.message ?? "") ?? (typeof field === "string" ? field.toLowerCase() : undefined);
}

function schemaCause(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "ZodError") return undefined;
  const rule = schemaRule(formatIssues((error as Error & { issues: SchemaIssue[] }).issues)[0]);
  return (rule && diagnosticIdentifier(`schema_invalid_${rule}`)) || "schema_invalid";
}

/** Which rule of the transfer contract a path breaks, by name and never by spelling. */
export function transferPathRule(path: string): string {
  if (path !== path.normalize("NFC")) return "not_nfc";
  if (Buffer.byteLength(path, "utf8") > 1024) return "too_long";
  if (/[\\:<>"|?*\p{Cc}\p{Cf}\p{Cs}]/u.test(path)) return "character";
  const parts = path.split("/");
  if (parts.length > 24) return "too_deep";
  return parts.some(part => /[ .]$/.test(part)) ? "trailing_dot_or_space" : "reserved_name";
}

/** A failed checkpoint step as Konteks reads it: the stage carries the cause, the evidence only what was observed. */
export function checkpointFailure(error: unknown, operation: { stage: string; code: string }): RuntimeFailureFact {
  const cause = checkpointCause(error);
  const stage = (cause === undefined ? undefined : diagnosticIdentifier(`${operation.stage}_${cause}`, 96)) ?? operation.stage;
  return { phase: "checkpoint", stage, code: operation.code, evidence: refusalEvidence(error) };
}
