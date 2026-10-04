import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { PolicyEvaluator, ToolPolicyContext, ToolPolicyEvaluation } from "@konteks/agent-core";

/**
 * The native connector's tool policy.
 *
 * Hosted runs answer every ACP permission request by policy: the deployment
 * bash blocklist, then a workspace-boundary check for file changes, and allow
 * otherwise (`ai-agent-harness` `createHarnessToolPolicyEvaluator`, and the
 * Claude adapter's fallback in `@konteks/agent-adapters`). A connector with no
 * evaluator deferred every request to a human, so an ordinary Claude Code
 * tool call waited on a relay deferral Core never recorded. bb likewise maps
 * its runtime policy onto the agent's own permission mode instead of asking
 * for each call.
 *
 * Keep DEFAULT_BASH_BLOCKLIST in sync with `@konteks/agent-adapters`
 * (`shared/bash-blocklist.ts`); the native package does not ship adapters.
 */
export const DEFAULT_BASH_BLOCKLIST: readonly string[] = [
  "nc ", "netcat", "ssh ", "telnet", "nslookup", "dig ", "sudo ", "su ", "mkfs", "dd if=", "/dev/",
  "rm -rf /", "chmod 777 /", "git commit", "git push", "git tag", "gh pr create",
  // Windows elevation, sudo's counterpart (agent OS proof):
  // `Start-Process … -Verb RunAs`, `-Verb:RunAs`, `runas /user:…`, gsudo.
  "runas", "verb:runas", "gsudo",
];

const FILE_CHANGE_KINDS = new Set(["edit", "delete", "move"]);
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file", "destination"] as const;

/** Device paths an ordinary command writes to (`2>/dev/null`) — never a device write. */
const HARMLESS_DEVICES = /\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)(?![a-z0-9_/-])/g;

/** Same token/substring rule as the adapters' `isBashCommandBlocked`. */
export function blockedCommandPattern(command: string, blocklist: readonly string[]): string | null {
  // `2>/dev/null` and friends are how commands discard output; only a real
  // device path should still meet the `/dev/` entry.
  const lower = command.toLowerCase().replace(HARMLESS_DEVICES, "<device>");
  for (const blocked of blocklist) {
    const normalized = blocked.trim().toLowerCase();
    if (!normalized) continue;
    if (/^[a-z0-9_.-]+$/i.test(normalized)) {
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[\\s;&|()])${escaped}(?=$|[\\s;&|()])`, "i").test(lower)) return blocked;
      continue;
    }
    // "rm -rf /" must not refuse `rm -rf /abs/project/node_modules`: an entry
    // aimed at the filesystem root matches only when its target IS the root.
    if (normalized.endsWith(" /")) {
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[\\s;&|()])${escaped}\\*?(?=$|[\\s;&|()])`, "i").test(lower)) return blocked;
      continue;
    }
    if (lower.includes(normalized)) return blocked;
  }
  return null;
}

/** Resolve symlinks of the longest existing prefix, so a link cannot escape the boundary. */
function realPrefix(path: string): string {
  let current = path;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missing.unshift(current.slice(parent.length).replace(/^[/\\]/, ""));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...missing);
  } catch {
    return path;
  }
}

export function isWithinWorkspace(rawPath: string, workspaceRoot: string): boolean {
  const target = realPrefix(resolve(workspaceRoot, rawPath));
  const rel = relative(realPrefix(resolve(workspaceRoot)), target);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The first words of the note on every tool call this policy refuses. Harness
 * finds the note by them and repeats it in the prompt that continues the
 * stopped turn (ai-agent-harness `turn-stop.ts`); keep the two in sync.
 */
export const POLICY_REFUSAL_PREFIX = "Konteks refused this";

/** One path of a refused file change, in a form safe to log and to show. */
export interface RefusedPath {
  /** Workspace-relative (`../x`), or the agent's own root-anchored text (`/src/app/x`). */
  path: string;
  /** Written from the filesystem root, but naming a path the working copy has. */
  rootAnchored: boolean;
  /** For a root-anchored path: the same path inside the working copy. */
  suggestion?: string;
}

/** Why a tool call was refused: what the connector logs (no secrets, no host paths). */
export interface PolicyRefusal {
  reason: "outside_workspace" | "bash_blocklist";
  /** File changes: how many paths the call named, and the ones outside. */
  pathCount?: number;
  outside?: RefusedPath[];
  /** Commands: the blocklist entry the command met. */
  pattern?: string;
}

/** A refusal, as `@konteks/agent-core`'s evaluation plus the connector's detail. */
export type WorkspaceToolPolicyEvaluation = ToolPolicyEvaluation & { refusal?: PolicyRefusal };

const MAX_SHOWN_PATHS = 10;
const MAX_SHOWN_PATH_LENGTH = 200;

function bounded(path: string): string {
  return path.length > MAX_SHOWN_PATH_LENGTH ? `${path.slice(0, MAX_SHOWN_PATH_LENGTH - 3)}...` : path;
}

/**
 * Describe a path outside the boundary without naming this computer's folders.
 *
 * An agent sometimes writes a repository path from the filesystem root
 * (`/src/app/x` for the working copy's `src/app/x`). That path
 * is still refused: an ACP permission answer can only allow or refuse the call,
 * never rewrite it (`updatedInput` has no ACP carrier), so allowing it would
 * let the agent write at the filesystem root, not in the working copy. It is
 * named root-anchored, with the working-copy path to use instead, only when
 * that reading is unambiguous and safe: no `..`, its top folder exists in the
 * working copy but not at the filesystem root, and the resolved path (symlinks
 * included) stays inside the boundary.
 */
export function describeRefusedPath(rawPath: string, workspaceRoot: string, cwd: string): RefusedPath {
  const posixAbsolute = /^[/\\](?![/\\])/.test(rawPath);
  if (posixAbsolute) {
    const anchored = rawPath.replace(/^[/\\]+/, "");
    const segments = anchored.split(/[/\\]+/).filter(Boolean);
    const top = segments[0];
    if (
      top !== undefined &&
      !segments.includes("..") &&
      existsSync(join(cwd, top)) &&
      !existsSync(join(parse(resolve(cwd)).root, top)) &&
      isWithinWorkspace(join(cwd, anchored), workspaceRoot)
    ) {
      return { path: bounded(rawPath), rootAnchored: true, suggestion: bounded(segments.join("/")) };
    }
  }
  const shown = isAbsolute(rawPath) ? relative(cwd, rawPath) : rawPath;
  return { path: bounded(shown.split("\\").join("/")), rootAnchored: false };
}

/** The note the agent and Konteks see for a refused file change. */
function outsideWorkspaceMessage(outside: readonly RefusedPath[], pathCount: number, cwd: string): string {
  const shown = outside.slice(0, MAX_SHOWN_PATHS).map(entry => entry.rootAnchored
    ? `\`${entry.path}\` starts at the filesystem root; inside the workspace it is \`${entry.suggestion}\``
    : `\`${entry.path}\` is outside it`);
  if (outside.length > MAX_SHOWN_PATHS) shown.push(`${outside.length - MAX_SHOWN_PATHS} more`);
  const count = pathCount > 1 ? `${outside.length} of ${pathCount} paths ${outside.length === 1 ? "is" : "are"}` : "its path is";
  // With its trailing separator, the working copy reads `[workspace]/` once
  // the update is redacted on its way to Konteks: never this computer's path.
  const root = `${cwd.replace(/[/\\]+$/, "")}/`;
  return `${POLICY_REFUSAL_PREFIX} file change: ${count} outside the workspace \`${root}\`. ${shown.join("; ")}. ` +
    "Nothing in it was applied. Use paths inside the workspace, relative to it, and try again.";
}

function changedPaths(input: Record<string, unknown>): string[] {
  const named = PATH_KEYS.map(key => input[key]).filter(nonBlankString);
  const locations = Array.isArray(input.locations)
    ? input.locations.map(location => (location as { path?: unknown } | null)?.path).filter(nonBlankString)
    : [];
  return [...named, ...locations];
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createWorkspaceToolPolicy(options: { bashBlocklist?: readonly string[] } = {}): PolicyEvaluator {
  const blocklist = options.bashBlocklist ?? DEFAULT_BASH_BLOCKLIST;
  return {
    evaluateToolUse(context: ToolPolicyContext): WorkspaceToolPolicyEvaluation {
      if (context.toolName === "execute") {
        const command = typeof context.input.command === "string" ? context.input.command : "";
        const hit = blockedCommandPattern(command, blocklist);
        return hit
          ? { allowed: false, denyMessage: `bash_blocklist: "${hit.trim()}" is not allowed on this connector`,
              refusal: { reason: "bash_blocklist", pattern: hit.trim() } }
          : { allowed: true };
      }
      if (FILE_CHANGE_KINDS.has(context.toolName)) {
        // One call can name several paths (an "Edit files" patch). It is
        // allowed or refused as a whole, so name every path that is outside,
        // and the working copy, so the agent can retry correctly.
        const paths = changedPaths(context.input);
        // `repoPath` is the session's working copy; the boundary may be wider.
        const cwd = context.repoPath || context.workspaceRoot;
        const outside = paths
          .filter(path => !isWithinWorkspace(path, context.workspaceRoot))
          .map(path => describeRefusedPath(path, context.workspaceRoot, cwd));
        if (outside.length > 0) {
          return {
            allowed: false,
            denyMessage: outsideWorkspaceMessage(outside, paths.length, cwd),
            refusal: { reason: "outside_workspace", pathCount: paths.length, outside: outside.slice(0, MAX_SHOWN_PATHS) },
          };
        }
      }
      return { allowed: true };
    },
  };
}
