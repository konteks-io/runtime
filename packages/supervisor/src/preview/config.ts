import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * How a session's preview is served: from the repository's own
 * `.konteks/preview.yaml` when it says, otherwise inferred from the working
 * copy (zero setup). The `serve` fields are the same as validation-runtime's
 * `PreviewEnvironmentSpecSchema.serve` (command, install, prepare, healthPath,
 * env); `port` is not honoured because the connector always picks the port
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
  /** Extra literal environment from preview.yaml (never the connector's own). */
  env: Record<string, string>;
  readinessTimeoutMs?: number;
  source: "preview_yaml" | "inferred";
  /** One plain sentence saying where the plan came from, for preview_status. */
  explanation: string;
  /** Things the person should know (ignored fields, a malformed file). */
  notes: string[];
}

export type PreviewPlanResult = { ok: true; plan: PreviewPlan } | { ok: false; message: string; notes: string[] };

export const PREVIEW_YAML = join(".konteks", "preview.yaml");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** The connector owns these; a repository file cannot override them. */
const RESERVED_ENV = new Set(["PATH", "HOST", "PORT", "HOME", "USERPROFILE"]);
const MAX_COMMAND = 2_000;

export interface PlanReadDeps {
  readText?: (path: string) => Promise<string | null>;
  exists?: (path: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

export async function resolvePreviewPlan(cwd: string, deps: PlanReadDeps = {}): Promise<PreviewPlanResult> {
  const readText = deps.readText ?? (path => readFile(path, "utf8").catch(() => null));
  const exists = deps.exists ?? (path => access(path).then(() => true, () => false));
  const notes: string[] = [];
  const raw = await readText(join(cwd, PREVIEW_YAML));
  let declared: Partial<PreviewPlan> = {};
  if (raw !== null) {
    const parsed = parsePreviewYaml(raw);
    if (!parsed.ok) notes.push(`.konteks/preview.yaml could not be read (${parsed.error}); the serve command was inferred instead.`);
    else {
      declared = parsed.plan;
      notes.push(...parsed.notes);
      if (declared.command) {
        return { ok: true, plan: {
          command: declared.command,
          ...(declared.install ? { install: declared.install } : {}),
          ...(declared.prepare ? { prepare: declared.prepare } : {}),
          healthPath: declared.healthPath ?? "/",
          env: declared.env ?? {},
          ...(declared.readinessTimeoutMs ? { readinessTimeoutMs: declared.readinessTimeoutMs } : {}),
          source: "preview_yaml",
          explanation: "Using serve.command from .konteks/preview.yaml.",
          notes,
        } };
      }
      notes.push(".konteks/preview.yaml has no serve.command; the serve command was inferred.");
    }
  }
  const inferred = await inferPreviewPlan(cwd, { readText, exists, platform: deps.platform ?? process.platform });
  if (!inferred.ok) return { ok: false, message: inferred.message, notes };
  // Declared install/prepare/healthPath/env still apply over an inferred command.
  return { ok: true, plan: {
    ...inferred.plan,
    ...(declared.install ? { install: declared.install } : {}),
    ...(declared.prepare ? { prepare: declared.prepare } : {}),
    ...(declared.healthPath ? { healthPath: declared.healthPath } : {}),
    env: declared.env ?? {},
    ...(declared.readinessTimeoutMs ? { readinessTimeoutMs: declared.readinessTimeoutMs } : {}),
    notes: [...notes, ...inferred.plan.notes],
  } };
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
  if (packageText !== null) {
    let pkg: PackageJson;
    try { pkg = JSON.parse(packageText) as PackageJson; } catch { return { ok: false, message: "package.json is not valid JSON, so the dev server command cannot be inferred. Fix it, or add serve.command to .konteks/preview.yaml.", notes: [] }; }
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const script = (["dev", "start", "serve"] as const).find(name => typeof scripts[name] === "string" && (scripts[name] as string).trim().length > 0);
    if (!script) {
      return { ok: false, message: "package.json has no dev, start or serve script. Add one, or add serve.command to .konteks/preview.yaml.", notes: [] };
    }
    const { manager, evidence } = await detectPackageManager(cwd, pkg, deps);
    const framework = frameworkFlags(scripts[script] as string);
    const run = runScript(manager, script, framework?.flags);
    const installed = await deps.exists(join(cwd, "node_modules")) || await deps.exists(join(cwd, ".pnp.cjs"));
    const notes: string[] = [];
    if (!framework) notes.push(`The "${script}" script is expected to read $PORT and $HOST; if it listens elsewhere, set serve.command in .konteks/preview.yaml.`);
    return { ok: true, plan: {
      command: run,
      ...(installed ? {} : { install: `${manager} install` }),
      healthPath: "/",
      env: {},
      source: "inferred",
      explanation: `Inferred from package.json: the "${script}" script${framework ? ` (${framework.name})` : ""}, run with ${manager} (${evidence})${installed ? "" : "; dependencies are installed first because node_modules is missing"}.`,
      notes,
    } };
  }
  if (await deps.exists(join(cwd, "manage.py"))) {
    const python = deps.platform === "win32" ? "python" : "python3";
    return { ok: true, plan: { command: `${python} manage.py runserver $HOST:$PORT --noreload`, healthPath: "/", env: {}, source: "inferred", explanation: "Inferred a Django project from manage.py.", notes: [] } };
  }
  if (await deps.exists(join(cwd, "bin", "rails"))) {
    const rails = deps.platform === "win32" ? "ruby bin/rails" : "bin/rails";
    return { ok: true, plan: { command: `${rails} server -b $HOST -p $PORT`, healthPath: "/", env: {}, source: "inferred", explanation: "Inferred a Rails project from bin/rails.", notes: [] } };
  }
  return { ok: false, message: "Could not tell how to serve this working copy (no package.json, manage.py or bin/rails). Add .konteks/preview.yaml with a serve.command that listens on $HOST:$PORT.", notes: [] };
}

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
 * `serve:` with scalar `command`, `install`, `prepare`, `healthPath`, `port`
 * and a nested `env:` map, plus top-level `readinessTimeoutMs`. Unknown keys
 * are noted and ignored. Scalars may be plain, 'single' or "double" quoted.
 */
export function parsePreviewYaml(text: string): { ok: true; plan: Partial<PreviewPlan>; notes: string[] } | { ok: false; error: string } {
  const plan: Partial<PreviewPlan> = {};
  const notes: string[] = [];
  const env: Record<string, string> = {};
  let section: "root" | "serve" | "env" | "skip" = "root";
  let serveIndent = -1;
  let envIndent = -1;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\s*-/.test(line)) {
      if (section === "skip") continue;
      return { ok: false, error: `line ${index + 1}: lists are not supported here` };
    }
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*?))?\s*$/.exec(line);
    if (!match) return { ok: false, error: `line ${index + 1}: expected "key: value"` };
    const indent = match[1]!.length;
    const key = match[2]!;
    const rawValue = match[3] === undefined ? undefined : stripComment(match[3]);
    if (indent === 0) {
      section = "root";
      if (key === "serve") {
        if (rawValue !== undefined && rawValue !== "") return { ok: false, error: `line ${index + 1}: serve must be a mapping` };
        section = "serve"; serveIndent = -1; continue;
      }
      if (key === "readinessTimeoutMs") {
        const value = Number(scalar(rawValue ?? ""));
        if (Number.isInteger(value) && value > 0) plan.readinessTimeoutMs = Math.min(value, 15 * 60_000);
        continue;
      }
      notes.push(`.konteks/preview.yaml: "${key}" is not used by local previews and was ignored.`);
      section = rawValue === undefined || rawValue === "" ? "skip" : "root";
      continue;
    }
    if (section === "skip" || section === "root") {
      if (section === "root") return { ok: false, error: `line ${index + 1}: unexpected indentation` };
      continue;
    }
    if (section === "env" && indent > serveIndent && (envIndent === -1 || indent === envIndent)) {
      envIndent = indent;
      const value = scalar(rawValue ?? "");
      if (!ENV_NAME.test(key) || RESERVED_ENV.has(key.toUpperCase())) notes.push(`.konteks/preview.yaml: serve.env.${key} is reserved or invalid and was ignored.`);
      else if (Object.keys(env).length < 64 && Buffer.byteLength(value) <= 4_096) env[key] = value;
      continue;
    }
    if (serveIndent === -1) serveIndent = indent;
    if (indent !== serveIndent) return { ok: false, error: `line ${index + 1}: inconsistent indentation under serve` };
    section = "serve";
    const value = rawValue === undefined ? "" : scalar(rawValue);
    switch (key) {
      case "command": case "install": case "prepare":
        if (value.length === 0 || value.length > MAX_COMMAND) return { ok: false, error: `line ${index + 1}: serve.${key} must be 1–${MAX_COMMAND} characters` };
        plan[key] = value;
        break;
      case "healthPath":
        if (!value.startsWith("/") || value.startsWith("//") || value.length > 500) return { ok: false, error: `line ${index + 1}: serve.healthPath must be a path starting with /` };
        plan.healthPath = value;
        break;
      case "port":
        notes.push(".konteks/preview.yaml: serve.port is ignored; the connector assigns the port and passes it as $PORT.");
        break;
      case "env":
        if (value !== "") return { ok: false, error: `line ${index + 1}: serve.env must be a mapping` };
        section = "env"; envIndent = -1;
        break;
      default:
        notes.push(`.konteks/preview.yaml: serve.${key} is not used by local previews and was ignored.`);
    }
  }
  if (Object.keys(env).length > 0) plan.env = env;
  return { ok: true, plan, notes };
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
