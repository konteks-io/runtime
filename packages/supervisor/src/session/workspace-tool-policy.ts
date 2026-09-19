import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PolicyEvaluator, ToolPolicyContext, ToolPolicyEvaluation } from "@konteks/agent-core";

/**
 * The native connector's tool policy (D87 step 1).
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

function changedPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) paths.push(value);
  }
  const locations = input.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = (location as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path.trim()) paths.push(path);
    }
  }
  return paths;
}

export function createWorkspaceToolPolicy(options: { bashBlocklist?: readonly string[] } = {}): PolicyEvaluator {
  const blocklist = options.bashBlocklist ?? DEFAULT_BASH_BLOCKLIST;
  return {
    evaluateToolUse(context: ToolPolicyContext): ToolPolicyEvaluation {
      if (context.toolName === "execute") {
        const command = typeof context.input.command === "string" ? context.input.command : "";
        const hit = blockedCommandPattern(command, blocklist);
        return hit ? { allowed: false, denyMessage: `bash_blocklist: "${hit.trim()}" is not allowed on this connector` } : { allowed: true };
      }
      if (FILE_CHANGE_KINDS.has(context.toolName)) {
        const outside = changedPaths(context.input).find(path => !isWithinWorkspace(path, context.workspaceRoot));
        if (outside !== undefined) return { allowed: false, denyMessage: "file changes outside the assignment workspace are not allowed" };
      }
      return { allowed: true };
    },
  };
}
