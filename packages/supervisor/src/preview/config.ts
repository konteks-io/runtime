import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePreviewPath } from "@konteks/remote-common";

/**
 * How a session's preview is served: from the repository's own
 * `.konteks/preview.yaml` when it says, otherwise inferred from the working
 * copy (zero setup). The `serve` fields are the same as validation-runtime's
 * `PreviewEnvironmentSpecSchema.serve` (command, install, prepare, healthPath,
 * env), plus `openPath`, the page a viewer lands on; `port` is not honoured because the connector always picks the port
 * and passes it as `$PORT` with `HOST=127.0.0.1`.
 *
 * Commands may use `$PORT`/`${PORT}` and `$HOST`/`${HOST}`; they are replaced
 * with the assigned values before the command runs, on every OS.
 */
export interface PreviewPlan {
  /** Long-running dev server command. */
  command: string;
  /** Run once before `command` (dependency install); omitted when not needed. */
  install?: string;
  /** Run once after `install` and before `command` (migrations, codegen). */
  prepare?: string;
  /** Path the health probe asks; any HTTP answer means the server is up. */
  healthPath: string;
  /** The page a viewer lands on (an API's docs page, say); `/` when omitted. */
  openPath?: string;
  /** Extra literal environment from preview.yaml (never the connector's own). */
  env: Record<string, string>;
  readinessTimeoutMs?: number;
  source: "preview_yaml" | "inferred";
  /** One plain sentence saying where the plan came from, for preview_status. */
  explanation: string;
  /** Things the person should know (ignored fields, a malformed file). */
  notes: string[];
}

/**
 * `reason` is the person's sentence when there is nothing to serve: what is
 * wrong and what to do, shown where they opened the preview.
 */
export type PreviewPlanResult = { ok: true; plan: PreviewPlan } | { ok: false; message: string; reason?: string; notes: string[] };

/** What a viewer reads when the working copy has no command a browser can open. */
export const NOTHING_TO_SERVE_REASON = "This change has nothing a browser can open (no serve command). Ask the agent to make it runnable.";
const MAX_OPEN_PATH = 200;

const PREVIEW_YAML = join(".konteks", "preview.yaml");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** The connector owns these; a repository file cannot override them. */
const RESERVED_ENV = new Set(["PATH", "HOST", "PORT", "HOME", "USERPROFILE"]);
const MAX_COMMAND = 2_000;

interface PlanReadDeps {
  readText?: (path: string) => Promise<string | null>;
  exists?: (path: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

export async function resolvePreviewPlan(cwd: string, deps: PlanReadDeps = {}): Promise<PreviewPlanResult> {
  const readText = deps.readText ?? (path => readFile(path, "utf8").catch(() => null));
  const exists = deps.exists ?? (path => access(path).then(() => true, () => false));
  const notes: string[] = [];
  const declared = await declaredPlan(cwd, readText, notes);
  if (declared.command) return { ok: true, plan: declaredOnly(declared.command, declared, notes) };
  const inferred = await inferPreviewPlan(cwd, { readText, exists, platform: deps.platform ?? process.platform });
  if (!inferred.ok) return { ...inferred, notes };
  return { ok: true, plan: declaredOverInferred(inferred.plan, declared, notes) };
}

/** What `.konteks/preview.yaml` declares, with a note when it cannot be read or names no command. */
async function declaredPlan(cwd: string, readText: (path: string) => Promise<string | null>, notes: string[]): Promise<Partial<PreviewPlan>> {
  const raw = await readText(join(cwd, PREVIEW_YAML));
  if (raw === null) return {};
  const parsed = parsePreviewYaml(raw);
  if (!parsed.ok) {
    notes.push(`.konteks/preview.yaml could not be read (${parsed.error}); the serve command was inferred instead.`);
    return {};
  }
  notes.push(...parsed.notes);
  if (!parsed.plan.command) notes.push(".konteks/preview.yaml has no serve.command; the serve command was inferred.");
  return parsed.plan;
}

function declaredOnly(command: string, declared: Partial<PreviewPlan>, notes: string[]): PreviewPlan {
  return {
    command,
    ...(declared.install ? { install: declared.install } : {}),
    ...(declared.prepare ? { prepare: declared.prepare } : {}),
    healthPath: declared.healthPath ?? "/",
    ...(declared.openPath ? { openPath: declared.openPath } : {}),
    env: declared.env ?? {},
    ...(declared.readinessTimeoutMs ? { readinessTimeoutMs: declared.readinessTimeoutMs } : {}),
    source: "preview_yaml",
    explanation: "Using serve.command from .konteks/preview.yaml.",
    notes,
  };
}

/** Declared install/prepare/healthPath/env still apply over an inferred command. */
function declaredOverInferred(inferred: PreviewPlan, declared: Partial<PreviewPlan>, notes: string[]): PreviewPlan {
  return {
    ...inferred,
    ...(declared.install ? { install: declared.install } : {}),
    ...(declared.prepare ? { prepare: declared.prepare } : {}),
    ...(declared.healthPath ? { healthPath: declared.healthPath } : {}),
    ...(declared.openPath ? { openPath: declared.openPath } : {}),
    env: declared.env ?? {},
    ...(declared.readinessTimeoutMs ? { readinessTimeoutMs: declared.readinessTimeoutMs } : {}),
    notes: [...notes, ...inferred.notes],
  };
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface PackageJson { scripts?: Record<string, unknown>; packageManager?: unknown }

/**
 * The dev server a working copy implies. Conservative: a Node project with a
 * `dev`, `start` or `serve` script (in that order: a preview is for looking at
 * work in progress, so the dev server wins), a Django `manage.py`, or a Rails
 * `bin/rails`. A single-command script for a known framework also gets that
 * framework's host/port flags, because several (Vite, Next, Astro…) ignore
 * `$PORT`.
 */
export async function inferPreviewPlan(cwd: string, deps: Required<PlanReadDeps>): Promise<PreviewPlanResult> {
  const packageText = await deps.readText(join(cwd, "package.json"));
  if (packageText !== null) return inferNodePlan(cwd, packageText, deps);
  if (await deps.exists(join(cwd, "manage.py"))) {
    const python = deps.platform === "win32" ? "python" : "python3";
    return { ok: true, plan: { command: `${python} manage.py runserver $HOST:$PORT --noreload`, healthPath: "/", env: {}, source: "inferred", explanation: "Inferred a Django project from manage.py.", notes: [] } };
  }
  if (await deps.exists(join(cwd, "bin", "rails"))) {
    const rails = deps.platform === "win32" ? "ruby bin/rails" : "bin/rails";
    return { ok: true, plan: { command: `${rails} server -b $HOST -p $PORT`, healthPath: "/", env: {}, source: "inferred", explanation: "Inferred a Rails project from bin/rails.", notes: [] } };
  }
  // A conversation's working folder carries the session's own files, never a
  // checkout of the project: there is nothing to run here, and a delivery's
  // app is what the person's Open preview shows.
  if (await deps.exists(join(cwd, ".assistant"))) {
    return { ok: false, message: CONVERSATION_HAS_NO_APP, reason: CONVERSATION_HAS_NO_APP_REASON, notes: [] };
  }
  return { ok: false, message: "Could not tell how to serve this working copy (no package.json, manage.py or bin/rails). Add .konteks/preview.yaml with a serve.command that listens on $HOST:$PORT.", reason: NOTHING_TO_SERVE_REASON, notes: [] };
}

const DEV_SCRIPTS = ["dev", "start", "serve"] as const;

function parsedPackage(text: string): PackageJson | null {
  try { return JSON.parse(text) as PackageJson; } catch { return null; }
}

async function inferNodePlan(cwd: string, packageText: string, deps: Required<PlanReadDeps>): Promise<PreviewPlanResult> {
  const pkg = parsedPackage(packageText);
  if (pkg === null) return { ok: false, message: "package.json is not valid JSON, so the dev server command cannot be inferred. Fix it, or add serve.command to .konteks/preview.yaml.", reason: "The project's package.json is not valid JSON, so there is nothing to run. Ask the agent to fix it.", notes: [] };
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const script = DEV_SCRIPTS.find(name => typeof scripts[name] === "string" && (scripts[name] as string).trim().length > 0);
  if (!script) {
    return { ok: false, message: "package.json has no dev, start or serve script. Add one, or add serve.command to .konteks/preview.yaml.", reason: NOTHING_TO_SERVE_REASON, notes: [] };
  }
  const { manager, evidence } = await detectPackageManager(cwd, pkg, deps);
  const framework = frameworkFlags(scripts[script] as string);
  const installed = await deps.exists(join(cwd, "node_modules")) || await deps.exists(join(cwd, ".pnp.cjs"));
  return { ok: true, plan: nodePlan({ script, manager, evidence, framework, installed }) };
}

function nodePlan(found: { script: string; manager: PackageManager; evidence: string; framework: { name: string; flags: string } | null; installed: boolean }): PreviewPlan {
  const { script, manager, evidence, framework, installed } = found;
  const notes = framework ? [] : [`The "${script}" script is expected to read $PORT and $HOST; if it listens elsewhere, set serve.command in .konteks/preview.yaml.`];
  return {
    command: runScript(manager, script, framework?.flags),
    ...(installed ? {} : { install: `${manager} install` }),
    healthPath: "/",
    env: {},
    source: "inferred",
    explanation: `Inferred from package.json: the "${script}" script${framework ? ` (${framework.name})` : ""}, run with ${manager} (${evidence})${installed ? "" : "; dependencies are installed first because node_modules is missing"}.`,
    notes,
  };
}

/** What a conversation's agent is told when asked for a preview it cannot run itself. */
export const CONVERSATION_HAS_NO_APP = "This conversation has no copy of the project's code, so nothing runs here. "
  + "When a delivery on this ticket built the app, Open preview at the top of the session shows it and starts it on this computer by itself.";

/** What a viewer of a conversation's preview reads: nothing runs here, and where the app is. */
export const CONVERSATION_HAS_NO_APP_REASON = "This conversation has no app of its own to run. Open the preview of the delivery that built it.";

/** Added only to the agent's tool answer: what to tell the person. */
export const CONVERSATION_HAS_NO_APP_AGENT_NOTE = "Tell the person that, in one sentence, instead of saying you cannot.";

async function detectPackageManager(cwd: string, pkg: PackageJson, deps: Required<PlanReadDeps>): Promise<{ manager: PackageManager; evidence: string }> {
  if (typeof pkg.packageManager === "string") {
    const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager)?.[1] as PackageManager | undefined;
    if (declared) return { manager: declared, evidence: "packageManager in package.json" };
  }
  const lockfiles: Array<[string, PackageManager]> = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"]];
  for (const [file, manager] of lockfiles) if (await deps.exists(join(cwd, file))) return { manager, evidence: file };
  return { manager: "npm", evidence: "no lockfile, so npm" };
}

function runScript(manager: PackageManager, script: string, flags: string | undefined): string {
  if (!flags) return `${manager} run ${script}`;
  // npm needs `--` to pass flags to the script; pnpm, yarn and bun pass them
  // through as-is (and pnpm would hand a literal `--` to the tool).
  return manager === "npm" ? `npm run ${script} -- ${flags}` : `${manager} run ${script} ${flags}`;
}

/** Frameworks whose dev server needs flags, not env, to bind the assigned address. */
const FRAMEWORKS: Array<{ name: string; match: RegExp; flags: string }> = [
  { name: "Vite", match: /^vite(\s+(dev|serve))?(\s|$)/, flags: "--host $HOST --port $PORT --strictPort" },
  { name: "Next.js", match: /^next\s+dev(\s|$)/, flags: "-H $HOST -p $PORT" },
  { name: "Astro", match: /^astro\s+dev(\s|$)/, flags: "--host $HOST --port $PORT" },
  { name: "Nuxt", match: /^(nuxt|nuxi)\s+dev(\s|$)/, flags: "--host $HOST --port $PORT" },
  { name: "Angular", match: /^ng\s+serve(\s|$)/, flags: "--host $HOST --port $PORT" },
  { name: "Gatsby", match: /^gatsby\s+develop(\s|$)/, flags: "-H $HOST -p $PORT" },
  { name: "Remix", match: /^remix\s+vite:dev(\s|$)/, flags: "--host $HOST --port $PORT" },
  { name: "Vue CLI", match: /^vue-cli-service\s+serve(\s|$)/, flags: "--host $HOST --port $PORT" },
  { name: "webpack dev server", match: /^(webpack\s+serve|webpack-dev-server)(\s|$)/, flags: "--host $HOST --port $PORT" },
  { name: "Docusaurus", match: /^docusaurus\s+start(\s|$)/, flags: "--host $HOST --port $PORT --no-open" },
  { name: "SvelteKit", match: /^svelte-kit\s+dev(\s|$)/, flags: "--host $HOST --port $PORT" },
];

/** Flags only for a script that is exactly one framework invocation without its own port. */
export function frameworkFlags(script: string): { name: string; flags: string } | null {
  const text = script.trim().replace(/^(npx|pnpm exec|yarn|bunx)\s+/, "");
  if (/&&|\|\||[;|&]|`|\$\(/.test(text)) return null;
  if (/(^|\s)(--port|-p)(\s|=|$)/.test(text) || /(^|\s)(--host|-H)(\s|=|$)/.test(text)) return null;
  // Create React App and plain Node servers read PORT/HOST from the environment.
  const found = FRAMEWORKS.find(candidate => candidate.match.test(text));
  return found ? { name: found.name, flags: found.flags } : null;
}

/** `$PORT`, `${PORT}`, `$HOST`, `${HOST}` (and `%PORT%`/`%HOST%`) → the assigned values. */
export function substitutePreviewVariables(command: string, values: { host: string; port: number }): string {
  return command
    .replace(/\$\{PORT\}|\$PORT\b|%PORT%/g, String(values.port))
    .replace(/\$\{HOST\}|\$HOST\b|%HOST%/g, values.host);
}

/**
 * A deliberately small YAML reader for `.konteks/preview.yaml`: top-level
 * `serve:` with scalar `command`, `install`, `prepare`, `healthPath`, `openPath`, `port`
 * and a nested `env:` map, plus top-level `readinessTimeoutMs`. Unknown keys
 * are noted and ignored. Scalars may be plain, 'single' or "double" quoted.
 */
export function parsePreviewYaml(text: string): { ok: true; plan: Partial<PreviewPlan>; notes: string[] } | { ok: false; error: string } {
  const reader = new PreviewYamlReader();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const error = reader.read(lines[index]!);
    if (error !== undefined) return { ok: false, error: `line ${index + 1}: ${error}` };
  }
  return { ok: true, ...reader.result() };
}

const KEY_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*?))?\s*$/;

function blank(value: string | undefined): boolean {
  return value === undefined || value === "";
}

/** Reads preview.yaml line by line; each method returns why a line cannot be read, if it cannot. */
class PreviewYamlReader {
  private readonly plan: Partial<PreviewPlan> = {};
  private readonly notes: string[] = [];
  private readonly env: Record<string, string> = {};
  private section: "root" | "serve" | "env" | "skip" = "root";
  private serveIndent = -1;
  private envIndent = -1;

  read(line: string): string | undefined {
    if (/^\s*(#.*)?$/.test(line)) return undefined;
    if (/^\s*-/.test(line)) return this.section === "skip" ? undefined : "lists are not supported here";
    const match = KEY_LINE.exec(line);
    if (!match) return 'expected "key: value"';
    const indent = match[1]!.length;
    const key = match[2]!;
    const rawValue = match[3] === undefined ? undefined : stripComment(match[3]);
    if (indent === 0) return this.rootKey(key, rawValue);
    return this.nestedKey(indent, key, rawValue);
  }

  result(): { plan: Partial<PreviewPlan>; notes: string[] } {
    if (Object.keys(this.env).length > 0) this.plan.env = this.env;
    return { plan: this.plan, notes: this.notes };
  }

  private rootKey(key: string, rawValue: string | undefined): string | undefined {
    this.section = "root";
    if (key === "serve") {
      if (!blank(rawValue)) return "serve must be a mapping";
      this.section = "serve"; this.serveIndent = -1;
      return undefined;
    }
    if (key === "readinessTimeoutMs") {
      const value = Number(scalar(rawValue ?? ""));
      if (Number.isInteger(value) && value > 0) this.plan.readinessTimeoutMs = Math.min(value, 15 * 60_000);
      return undefined;
    }
    this.notes.push(`.konteks/preview.yaml: "${key}" is not used by local previews and was ignored.`);
    this.section = blank(rawValue) ? "skip" : "root";
    return undefined;
  }

  private nestedKey(indent: number, key: string, rawValue: string | undefined): string | undefined {
    if (this.section === "root") return "unexpected indentation";
    if (this.section === "skip") return undefined;
    if (this.inEnv(indent)) {
      this.envKey(indent, key, rawValue);
      return undefined;
    }
    if (this.serveIndent === -1) this.serveIndent = indent;
    if (indent !== this.serveIndent) return "inconsistent indentation under serve";
    this.section = "serve";
    return this.serveKey(key, rawValue === undefined ? "" : scalar(rawValue));
  }

  private inEnv(indent: number): boolean {
    return this.section === "env" && indent > this.serveIndent && (this.envIndent === -1 || indent === this.envIndent);
  }

  private envKey(indent: number, key: string, rawValue: string | undefined): void {
    this.envIndent = indent;
    const value = scalar(rawValue ?? "");
    if (!ENV_NAME.test(key) || RESERVED_ENV.has(key.toUpperCase())) this.notes.push(`.konteks/preview.yaml: serve.env.${key} is reserved or invalid and was ignored.`);
    else if (Object.keys(this.env).length < 64 && Buffer.byteLength(value) <= 4_096) this.env[key] = value;
  }

  private serveKey(key: string, value: string): string | undefined {
    switch (key) {
      case "command": case "install": case "prepare":
        return this.commandField(key, value);
      case "healthPath":
        return this.healthPath(value);
      case "openPath":
        return this.openPath(value);
      case "port":
        this.notes.push(".konteks/preview.yaml: serve.port is ignored; the connector assigns the port and passes it as $PORT.");
        return undefined;
      case "env":
        return this.envSection(value);
      default:
        this.notes.push(`.konteks/preview.yaml: serve.${key} is not used by local previews and was ignored.`);
        return undefined;
    }
  }

  private commandField(key: "command" | "install" | "prepare", value: string): string | undefined {
    if (value.length === 0 || value.length > MAX_COMMAND) return `serve.${key} must be 1–${MAX_COMMAND} characters`;
    this.plan[key] = value;
    return undefined;
  }

  private healthPath(value: string): string | undefined {
    if (!value.startsWith("/") || value.startsWith("//") || value.length > 500) return "serve.healthPath must be a path starting with /";
    this.plan.healthPath = value;
    return undefined;
  }

  /**
   * A path on the preview itself: starts with `/`, no scheme or host, no dot
   * segments, at most 200 characters. A bad one is noted and the preview
   * opens at `/`; the rest of the file still applies.
   */
  private openPath(value: string): undefined {
    const checked = value.length > 0 && value.length <= MAX_OPEN_PATH && !/\s/.test(value) ? validatePreviewPath(value) : null;
    if (checked?.ok) this.plan.openPath = checked.path;
    else this.notes.push(`.konteks/preview.yaml: serve.openPath must be a path on the preview starting with / (at most ${MAX_OPEN_PATH} characters, no scheme or host); the preview opens at / instead.`);
    return undefined;
  }

  private envSection(value: string): string | undefined {
    if (value !== "") return "serve.env must be a mapping";
    this.section = "env"; this.envIndent = -1;
    return undefined;
  }
}

function stripComment(value: string): string {
  if (value.startsWith("'") || value.startsWith("\"")) return value;
  const at = value.search(/\s#/);
  return (at === -1 ? value : value.slice(0, at)).trim();
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  return trimmed;
}
