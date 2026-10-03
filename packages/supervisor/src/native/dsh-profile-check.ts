import { execFile } from "node:child_process";
import { RemoteInstanceError } from "@konteks/remote-common";
import { compareAgentVersions } from "@konteks/remote-release";
import { DSH_PROFILE_EXPECTATIONS, writeDshKonteksProfile } from "@konteks/remote-agent-runner";
import type { NativeDshInstallation } from "./dsh-installation.js";

/**
 * Before DeepSeek Harness is offered, prove the Konteks overlay is in force in
 * the exact installation that will run: dsh composes its profile from its own
 * bundles plus our `--patch` layers, and a dsh upgrade may rename or reshape a
 * row so that a patch silently stops applying (the ask hook included). The
 * `--dump-config` boot is config-only and runs nothing the profile loads.
 */

interface DshDumpRow {
  name?: string;
  /** Raw `disabled` value: `true`, `false` or an unevaluated `!!js` expression. */
  disabled?: string;
  /** Scalar config values; nested structures are not read. */
  config: Record<string, string>;
}

type DshDumpRunner = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

interface DshProfileCheckOptions {
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
  const drift = result.code === 0 ? dshProfileDrift(result.stdout, options.konteksDir, platform, options.installation.version) : [`profile dump exited with ${result.code ?? "a signal"}`];
  if (drift.length > 0) {
    throw new RemoteInstanceError("prerequisite_missing",
      `DeepSeek Harness ${options.installation.version} does not accept the Konteks settings (${drift.slice(0, 4).join("; ")}${drift.length > 4 ? "; …" : ""}). Install a supported version, then retry.`,
      { diagnostic: "dsh_profile_drift", recoveryActions: [{ kind: "install_backend", agentId: "dsh" }] });
  }
}

/**
 * Human-readable mismatches between a composed profile and the Konteks overlay;
 * empty when in force. `version` is the installed dsh: a row newer than it may
 * be absent (a row that is absent cannot run).
 */
export function dshProfileDrift(dump: string, konteksDir: string, platform: NodeJS.Platform, version?: string): string[] {
  const rows = parseDshDumpConfig(dump);
  return DSH_PROFILE_EXPECTATIONS(konteksDir, platform).flatMap(expected => expectationDrift(expected, rows.get(expected.id), version));
}

type DshProfileExpectation = ReturnType<typeof DSH_PROFILE_EXPECTATIONS>[number];

function expectationDrift(expected: DshProfileExpectation, row: DshDumpRow | undefined, version: string | undefined): string[] {
  if (!row) return absentAllowed(expected, version) ? [] : [`${expected.id}: missing`];
  return [...nameDrift(expected, row), ...disabledDrift(expected, row), ...configDrift(expected, row)];
}

/** A row newer than the installed dsh may be absent. */
function absentAllowed(expected: DshProfileExpectation, version: string | undefined): boolean {
  return expected.absentBelow !== undefined && version !== undefined && olderThan(version, expected.absentBelow);
}

function nameDrift(expected: DshProfileExpectation, row: DshDumpRow): string[] {
  if (expected.name === undefined || row.name === expected.name) return [];
  return [`${expected.id}: module is ${JSON.stringify(row.name ?? null)}, expected ${JSON.stringify(expected.name)}`];
}

function disabledDrift(expected: DshProfileExpectation, row: DshDumpRow): string[] {
  if (expected.disabled === true && row.disabled !== "true") return [`${expected.id}: expected disabled`];
  if (expected.disabled === false && row.disabled === "true") return [`${expected.id}: expected enabled`];
  return [];
}

function configDrift(expected: DshProfileExpectation, row: DshDumpRow): string[] {
  return Object.entries(expected.config ?? {})
    .filter(([key, value]) => row.config[key] !== value)
    .map(([key, value]) => `${expected.id}: config ${key} is ${JSON.stringify(row.config[key] ?? null)}, expected ${JSON.stringify(value)}`);
}

function olderThan(version: string, than: string): boolean {
  try { return compareAgentVersions(version, than) < 0; } catch { return false; }
}

/**
 * Read the rows of a dsh `--dump-config` tree: top-level `- id:` entries with
 * two-space fields and four-space scalar `config` entries, as dsh prints them.
 * Anything else is skipped; a row this reader cannot see counts as missing, so
 * an unexpected format fails the check instead of passing it.
 */
export function parseDshDumpConfig(dump: string): Map<string, DshDumpRow> {
  return new DumpConfigReader(dump.split(/\r?\n/)).read();
}

class DumpConfigReader {
  private readonly rows = new Map<string, DshDumpRow>();
  private row: DshDumpRow | null = null;
  private inConfig = false;
  private index = 0;

  constructor(private readonly lines: string[]) {}

  read(): Map<string, DshDumpRow> {
    for (this.index = 0; this.index < this.lines.length; this.index += 1) this.readLine(this.lines[this.index]!);
    return this.rows;
  }

  private readLine(line: string): void {
    const top = /^- id: (.+)$/.exec(line);
    if (top) return this.startRow(scalar(top[1]!));
    const row = this.row;
    if (!row || line.startsWith("#") || line.trim() === "") return;
    if (!line.startsWith(" ")) {
      this.row = null;
      return;
    }
    if (!this.readField(row, line)) this.readConfigEntry(row, line);
  }

  private startRow(id: string): void {
    this.row = { config: {} };
    this.rows.set(id, this.row);
    this.inConfig = false;
  }

  /** A two-space row field; false when the line is not one. */
  private readField(row: DshDumpRow, line: string): boolean {
    const field = /^ {2}([A-Za-z][\w-]*):(?: (.*))?$/.exec(line);
    if (!field) return false;
    this.inConfig = field[1] === "config" && field[2] === undefined;
    if (field[1] === "name" && field[2] !== undefined) row.name = scalar(field[2]);
    if (field[1] === "disabled" && field[2] !== undefined) row.disabled = field[2].trim();
    return true;
  }

  /** A four-space scalar `config` entry, or a block scalar whose body follows. */
  private readConfigEntry(row: DshDumpRow, line: string): void {
    const entry = this.inConfig ? /^ {4}([A-Za-z][\w-]*):(?: (.*))?$/.exec(line) : null;
    if (!entry || entry[2] === undefined) return;
    const block = /^([>|])([-+]?)$/.exec(entry[2].trim());
    row.config[entry[1]!] = block ? this.blockBody(block[1]!) : scalar(entry[2]);
  }

  private blockBody(style: string): string {
    const body: string[] = [];
    while (this.index + 1 < this.lines.length && (this.lines[this.index + 1]!.startsWith("      ") || this.lines[this.index + 1]!.trim() === "")) body.push(this.lines[++this.index]!.slice(6));
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    return style === ">" ? body.join(" ") : body.join("\n");
  }
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
