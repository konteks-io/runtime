import { execFile } from "node:child_process";
import { RemoteInstanceError } from "@konteks/remote-common";
import { DSH_PROFILE_EXPECTATIONS, writeDshKonteksProfile } from "@konteks/remote-agent-runner";
import type { NativeDshInstallation } from "./dsh-installation.js";

/**
 * Before DeepSeek Harness is offered, prove the Konteks overlay is in force in
 * the exact installation that will run: dsh composes its profile from its own
 * bundles plus our `--patch` layers, and a dsh upgrade may rename or reshape a
 * row so that a patch silently stops applying (the ask hook included). The
 * `--dump-config` boot is config-only and runs nothing the profile loads.
 */

export interface DshDumpRow {
  name?: string;
  /** Raw `disabled` value: `true`, `false` or an unevaluated `!!js` expression. */
  disabled?: string;
  /** Scalar config values; nested structures are not read. */
  config: Record<string, string>;
}

export type DshDumpRunner = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface DshProfileCheckOptions {
  /** The runtime's own bundled Node, never the person's. */
  node: string;
  installation: NativeDshInstallation;
  /** Runtime-owned DSH_HOME. */
  dshHome: string;
  /** Runtime-owned directory the overlay is written into. */
  konteksDir: string;
  platform?: NodeJS.Platform;
  run?: DshDumpRunner;
  timeoutMs?: number;
}

export async function checkDshKonteksProfile(options: DshProfileCheckOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const patches = await writeDshKonteksProfile(options.konteksDir, platform);
  const args = [options.installation.entry, "--profile", "acp", ...patches.flatMap(patch => ["--patch", patch]), "--dump-config"];
  const result = await (options.run ?? runDump)(options.node, args, { env: dumpEnvironment(options.dshHome), timeoutMs: options.timeoutMs ?? 30_000 });
  const drift = result.code === 0 ? dshProfileDrift(result.stdout, options.konteksDir, platform) : [`profile dump exited with ${result.code ?? "a signal"}`];
  if (drift.length > 0) {
    throw new RemoteInstanceError("prerequisite_missing",
      `DeepSeek Harness ${options.installation.version} does not accept the Konteks settings (${drift.slice(0, 4).join("; ")}${drift.length > 4 ? "; …" : ""}). Install a supported version, then retry.`,
      { diagnostic: "dsh_profile_drift", recoveryActions: [{ kind: "install_backend", agentId: "dsh" }] });
  }
}

/** Human-readable mismatches between a composed profile and the Konteks overlay; empty when in force. */
export function dshProfileDrift(dump: string, konteksDir: string, platform: NodeJS.Platform): string[] {
  const rows = parseDshDumpConfig(dump);
  const drift: string[] = [];
  for (const expected of DSH_PROFILE_EXPECTATIONS(konteksDir, platform)) {
    const row = rows.get(expected.id);
    if (!row) { drift.push(`${expected.id}: missing`); continue; }
    if (expected.name !== undefined && row.name !== expected.name) drift.push(`${expected.id}: module is ${JSON.stringify(row.name ?? null)}, expected ${JSON.stringify(expected.name)}`);
    if (expected.disabled === true && row.disabled !== "true") drift.push(`${expected.id}: expected disabled`);
    if (expected.disabled === false && row.disabled === "true") drift.push(`${expected.id}: expected enabled`);
    for (const [key, value] of Object.entries(expected.config ?? {})) {
      if (row.config[key] !== value) drift.push(`${expected.id}: config ${key} is ${JSON.stringify(row.config[key] ?? null)}, expected ${JSON.stringify(value)}`);
    }
  }
  return drift;
}

/**
 * Read the rows of a dsh `--dump-config` tree: top-level `- id:` entries with
 * two-space fields and four-space scalar `config` entries, as dsh prints them.
 * Anything else is skipped; a row this reader cannot see counts as missing, so
 * an unexpected format fails the check instead of passing it.
 */
export function parseDshDumpConfig(dump: string): Map<string, DshDumpRow> {
  const rows = new Map<string, DshDumpRow>();
  const lines = dump.split(/\r?\n/);
  let row: DshDumpRow | null = null;
  let inConfig = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const top = /^- id: (.+)$/.exec(line);
    if (top) {
      row = { config: {} };
      rows.set(scalar(top[1]!), row);
      inConfig = false;
      continue;
    }
    if (!row || line.startsWith("#") || line.trim() === "") continue;
    if (!line.startsWith(" ")) { row = null; continue; }
    const field = /^ {2}([A-Za-z][\w-]*):(?: (.*))?$/.exec(line);
    if (field) {
      inConfig = field[1] === "config" && field[2] === undefined;
      if (field[1] === "name" && field[2] !== undefined) row.name = scalar(field[2]);
      if (field[1] === "disabled" && field[2] !== undefined) row.disabled = field[2].trim();
      continue;
    }
    const entry = inConfig ? /^ {4}([A-Za-z][\w-]*):(?: (.*))?$/.exec(line) : null;
    if (entry && entry[2] !== undefined) {
      const block = /^([>|])([-+]?)$/.exec(entry[2].trim());
      if (block) {
        const body: string[] = [];
        while (index + 1 < lines.length && (lines[index + 1]!.startsWith("      ") || lines[index + 1]!.trim() === "")) body.push(lines[++index]!.slice(6));
        while (body.length > 0 && body[body.length - 1] === "") body.pop();
        row.config[entry[1]!] = block[1] === ">" ? body.join(" ") : body.join("\n");
      } else {
        row.config[entry[1]!] = scalar(entry[2]);
      }
    }
  }
  return rows;
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try { return JSON.parse(value) as string; } catch { return value; }
  }
  return value;
}

/** Only what Node and dsh need to boot a config dump; no credentials, no inherited DSH_*. */
function dumpEnvironment(dshHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1" };
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const runDump: DshDumpRunner = (command, args, options) => new Promise(resolve => {
  execFile(command, args, { env: options.env, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : null) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});
