import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

/**
 * The Konteks overlay for DeepSeek Harness (`dsh --profile acp`), proven in
 * dsh-runtime-support CP0. `dsh` is the person's own installation (plan D9),
 * so these files ship with the runtime and are written into the runtime-owned
 * directory before each spawn; the hook config needs an absolute path.
 *
 * - `konteks-dsh.patch.yml` turns off what runs outside a Konteks turn or
 *   outside Konteks' view: the DeepSeek-account route (API key only, D1),
 *   background shell runs, subagents (their tool calls never reach ACP),
 *   plugin_manager (self-modification), the goal round driver, ralph and
 *   workflow; and pins `deepseek-flash`, the catalog model a session can
 *   switch back to.
 * - `konteks-dsh-ask.patch.yml` + `konteks-hooks.json` insert dsh's Claude
 *   Code hook bridge with a PreToolUse hook answering `ask` for every tool
 *   outside a read-only allowlist, so each such call reaches the runtime's
 *   ACP permission policy. Stock dsh asks only on sandbox escalation and its
 *   sandbox does not cover the network.
 *
 * The hook fails open when it cannot run (dsh treats that as non-blocking), so
 * the hook command is a shell built-in printing a fixed decision, and the
 * supervisor keeps a tripwire for a gated call that never asked (plan CP3).
 */

/** Tools that never change anything; every other tool asks first. */
export const DSH_READ_ONLY_TOOLS: readonly string[] = Object.freeze([
  "read", "read_image", "grep", "glob", "todo_write", "skill", "web_fetch", "web_search",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "list_subagent_models", "job_list", "job_output",
]);

const DECISION = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Konteks reviews this tool call" } });

/** Rows the Konteks patch turns off; the self-check asserts each stays off. */
const DISABLED_ROWS = [
  "deepseek-account", "llm-deepseek-account",
  "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents",
  "tool-plugin-manager",
  "goal-round-driver", "tool-goal", "command-goal", "tool-ralph", "tool-workflow",
] as const;

/**
 * Rows dsh added in 0.1.7: 0.1.5-rc.3 (npm `latest`, what `npx @deepseek-ai/dsh`
 * installs) has no DeepSeek-account route and no plugin_manager tool. The patch
 * still names them (dsh warns and goes on), so any version that has them turns
 * them off; the self-check lets them be absent only below this version.
 */
const ROWS_SINCE_0_1_7: ReadonlySet<string> = new Set(["deepseek-account", "llm-deepseek-account", "tool-plugin-manager"]);
const ROWS_SINCE_0_1_7_VERSION = "0.1.7-rc.2";

export const DSH_KONTEKS_MODEL = { provider: "deepseek-official", model: "deepseek-flash" } as const;

export interface DshProfileRowExpectation {
  id: string;
  /** Expected module; checked only when set. */
  name?: string;
  disabled?: boolean;
  /** Expected scalar config values, compared as strings. */
  config?: Record<string, string>;
  /** The row may be absent in versions below this one (it did not exist yet). */
  absentBelow?: string;
}

const paths = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Where a dsh runner keeps its private state, all inside its credential directory. */
export function dshRuntimePaths(credentialDir: string, platform: NodeJS.Platform = process.platform): { dshHome: string; konteksDir: string; credentialsFile: string } {
  const path = paths(platform);
  const dshHome = path.join(credentialDir, ".dsh");
  return { dshHome, konteksDir: path.join(credentialDir, "konteks-dsh"), credentialsFile: path.join(dshHome, ".credentials.yaml") };
}

/** What a composed profile must contain for the overlay to be in force. */
export function DSH_PROFILE_EXPECTATIONS(dir: string, platform: NodeJS.Platform): DshProfileRowExpectation[] {
  const path = paths(platform);
  return [
    ...DISABLED_ROWS.map(id => ({ id, disabled: true, ...(ROWS_SINCE_0_1_7.has(id) ? { absentBelow: ROWS_SINCE_0_1_7_VERSION } : {}) })),
    { id: "acp", disabled: false, config: { ...DSH_KONTEKS_MODEL } },
    { id: platform === "win32" ? "tool-pwsh" : "tool-bash", disabled: false, config: { enableRunInBackground: "false" } },
    { id: "konteks-ask-hook", name: "@deepseek-ai/dsh-hooks-claude-code", disabled: false, config: { configPath: path.join(dir, "konteks-hooks.json") } },
  ];
}

export function renderDshKonteksProfile(dir: string, platform: NodeJS.Platform): { files: Array<{ name: string; content: string }>; patches: [string, string] } {
  const path = paths(platform);
  const hookCommand = platform === "win32" ? `Write-Output '${DECISION}'` : `printf '%s' '${DECISION}'`;
  const escaped = DSH_READ_ONLY_TOOLS.map(tool => tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const hooks = { hooks: { PreToolUse: [{ matcher: `^(?!(?:${escaped})$).+$`, hooks: [{ type: "command", command: hookCommand }] }] } };
  const main = [
    "# Konteks overlay for `dsh --profile acp`. Written by the Konteks runtime; do not edit.",
    ...DISABLED_ROWS.flatMap(id => [`- id: ${id}`, "  disabled: true"]),
    "- id: acp",
    "  config:",
    `    provider: ${DSH_KONTEKS_MODEL.provider}`,
    `    model: ${DSH_KONTEKS_MODEL.model}`,
    "- id: tool-bash",
    "  config:",
    "    enableRunInBackground: false",
    "- id: tool-pwsh",
    "  config:",
    "    enableRunInBackground: false",
    "",
  ].join("\n");
  const ask = [
    "# Konteks: every tool outside the read-only allowlist asks the runtime first. Written by the Konteks runtime; do not edit.",
    "- insert:",
    "    - id: konteks-ask-hook",
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    "      config:",
    // A JSON string is a valid YAML double-quoted scalar: spaces and Windows backslashes survive.
    `        configPath: ${JSON.stringify(path.join(dir, "konteks-hooks.json"))}`,
    "",
  ].join("\n");
  return {
    files: [
      { name: "konteks-dsh.patch.yml", content: main },
      { name: "konteks-dsh-ask.patch.yml", content: ask },
      { name: "konteks-hooks.json", content: `${JSON.stringify(hooks, null, 2)}\n` },
    ],
    patches: [path.join(dir, "konteks-dsh.patch.yml"), path.join(dir, "konteks-dsh-ask.patch.yml")],
  };
}

/** Write the overlay into a private directory, each file replaced atomically. */
export async function writeDshKonteksProfile(dir: string, platform: NodeJS.Platform = process.platform): Promise<[string, string]> {
  const rendered = renderDshKonteksProfile(dir, platform);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(dir, 0o700);
  for (const file of rendered.files) {
    const target = paths(platform).join(dir, file.name);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, file.content, { mode: 0o600 });
    if (platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, target);
  }
  return rendered.patches;
}
