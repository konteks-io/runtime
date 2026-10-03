import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import type { OnComputerStep } from "@konteks/remote-common";
import { nativeConnectorFileNames } from "@konteks/remote-release";

/** The agents a person can set up on this computer from the site (`on-computer`). */
export const ON_COMPUTER_AGENTS = ["dsh", "opencode", "antigravity"] as const;
export type OnComputerAgent = (typeof ON_COMPUTER_AGENTS)[number];

const NAMES: Readonly<Record<OnComputerAgent, string>> = { dsh: "DeepSeek Harness", opencode: "OpenCode", antigravity: "Google Antigravity" };

/** Where an agent stands here, as the supported-agents report says it. */
interface OnComputerAgentFacts {
  agentId: OnComputerAgent;
  state: string;
  installCommand?: string;
  windowsInstallCommand?: string;
}

export interface OnComputerPlan {
  step: OnComputerStep;
  /** The commands the window runs, in order, each only after the one before succeeded. */
  commands: string[];
  /** What ends the step: the agent ready, or (when its sign-in is done on the site) only added. */
  until: "ready" | "added";
}

/**
 * What a site-started "set it up on this computer" opens, from where the agent
 * stands: install it the way its homepage says, add it to Konteks, then sign it
 * in at the connector's own prompt (a key is typed there, never on the site).
 * Each step runs only after the one before it worked; a ready agent needs
 * nothing, and an agent nobody can install here has no plan.
 */
export function planOnComputer(agent: OnComputerAgentFacts, platform: NodeJS.Platform): OnComputerPlan | null {
  const add = `konteks-remote agent add ${agent.agentId}`;
  const signIn = `konteks-remote auth login ${agent.agentId}`;
  // Google Antigravity signs in with Gemini Enterprise from the site, which
  // carries the project and location to the connector: its window only adds
  // it (the yes to Google's download is given there), and the step ends once
  // it is added. The others sign in right after, at the connector's prompt.
  const siteSignIn = agent.agentId === "antigravity";
  const after = (commands: string[]): Pick<OnComputerPlan, "commands" | "until"> =>
    siteSignIn ? { commands, until: "added" } : { commands: [...commands, signIn], until: "ready" };
  if (INSTALL_STATES.has(agent.state)) return installPlan(agent, platform, add, after);
  if (ADD_STATES.has(agent.state)) return { step: "add", ...after([add]) };
  if (SIGN_IN_STATES.has(agent.state)) return siteSignIn ? null : { step: "sign_in", commands: [signIn], until: "ready" };
  return null;
}

const INSTALL_STATES: ReadonlySet<string> = new Set(["not_installed", "unsupported_version"]);
const ADD_STATES: ReadonlySet<string> = new Set(["installed_not_added", "not_added"]);
const SIGN_IN_STATES: ReadonlySet<string> = new Set(["needs_sign_in", "sign_in_expired"]);

function installPlan(agent: OnComputerAgentFacts, platform: NodeJS.Platform, add: string, after: (commands: string[]) => Pick<OnComputerPlan, "commands" | "until">): OnComputerPlan {
  const install = platform === "win32" ? agent.windowsInstallCommand ?? agent.installCommand : agent.installCommand;
  // Google Antigravity is never installed by the person: Konteks adds it (downloads it from Google).
  if (!install || install === add) return { step: "add", ...after([add]) };
  return { step: "install", ...after([install, add]) };
}
/**
 * The running release's own `konteks-remote`, when this connector runs as one
 * (a release folder's `konteks-connector`, or `connector` before the rename).
 * The window runs its commands with it: `<root>/bin/konteks-remote` is the
 * launcher from the day Konteks was installed and is never replaced by an
 * update, so it would print an old release's words (and speak an old
 * protocol) to the person. Undefined in development, where this is node.
 */
export function releaseLauncher(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): string | undefined {
  const names = nativeConnectorFileNames(platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "debian");
  return names.includes((platform === "win32" ? win32 : posix).basename(execPath)) ? execPath : undefined;
}

/**
 * The script the window runs: its commands act on this connector only (its
 * root, run by this release's own launcher when there is one), it says in one
 * line what it is doing, and runs the steps, each only after the one before
 * worked. The sign-in at the end speaks for itself: it says the agent is
 * ready and the window can close (`KONTEKS_ON_COMPUTER`), or in one line what
 * went wrong and what to do; only an install or add that failed gets the
 * generic line. The window stays open either way.
 */
export function onComputerScript(plan: OnComputerPlan, context: { agentId: OnComputerAgent; root: string; platform: NodeJS.Platform; prelude?: string; launcher?: string }): string {
  const name = NAMES[context.agentId];
  const intro = `Konteks is setting up ${name} on this computer.`;
  const done = `${name} is added. You can close this window and sign it in on the Konteks site.`;
  const failed = "That did not finish. You can close this window and try again from Konteks.";
  const signsIn = plan.until === "ready";
  if (context.platform === "win32") {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const own = (command: string) => command.startsWith("konteks-remote ")
      ? `& ${context.launcher ? quote(context.launcher) : "konteks-remote"} --root ${quote(context.root)} ${command.slice("konteks-remote ".length)}`
      : command;
    const commands = plan.commands.map(own);
    const before = signsIn ? commands.slice(0, -1) : commands;
    return [
      `$env:KONTEKS_ROOT = ${quote(context.root)}`,
      "$env:KONTEKS_ON_COMPUTER = '1'",
      `$env:PATH = ${quote(join(context.root, "bin"))} + ';' + $env:PATH`,
      `Write-Host ${quote(intro)}`,
      "$ok = $true",
      ...before.map(command => `if ($ok) { ${command}; $ok = $? }`),
      signsIn ? `if ($ok) { ${commands.at(-1)} } else { Write-Host ${quote(failed)} }` : `if ($ok) { Write-Host ${quote(done)} } else { Write-Host ${quote(failed)} }`,
      "",
    ].join("\r\n");
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const own = (command: string) => command.startsWith("konteks-remote ")
    ? `${context.launcher ? quote(context.launcher) : "konteks-remote"} --root ${quote(context.root)} ${command.slice("konteks-remote ".length)}`
    : command;
  const commands = plan.commands.map(own);
  const before = signsIn ? commands.slice(0, -1) : commands;
  const run = !signsIn ? `if ${before.join(" && ")}; then echo ${quote(done)}; else echo ${quote(failed)}; fi`
    : before.length === 0 ? commands.at(-1)!
      : `if ${before.join(" && ")}; then ${commands.at(-1)}; else echo ${quote(failed)}; fi`;
  return [
    "#!/bin/sh",
    ...(context.prelude ? [`. ${quote(context.prelude)}`] : []),
    `export KONTEKS_ROOT=${quote(context.root)}`,
    "export KONTEKS_ON_COMPUTER=1",
    `PATH=${quote(join(context.root, "bin"))}:"$PATH"; export PATH`,
    `echo ${quote(intro)}`,
    run,
    "",
  ].join("\n");
}

interface OnComputerOpenDeps {
  spawn?: (command: string, args: string[]) => void;
}

/**
 * A stand-in laptop's own terminal settings (its HOME, CA and PATH): the
 * `env.sh` beside its home, when its connector lives in the macOS default
 * place under that home. A window that loads it acts on the stand-in only,
 * never on the real computer it runs on.
 */
export function standInTerminalEnv(root: string, exists: (file: string) => boolean = existsSync): string | undefined {
  const suffix = join("Library", "Application Support", "konteks-remote");
  if (!root.endsWith(suffix)) return undefined;
  const file = join(dirname(root.slice(0, -suffix.length).replace(/\/+$/, "")), "env.sh");
  return exists(file) ? file : undefined;
}

/**
 * Brings the step to the front on this computer: macOS opens it in Terminal,
 * Linux in the desktop's terminal, Windows in PowerShell. A stand-in laptop
 * (`KONTEKS_E2E_NATIVE_CONNECTOR`) only leaves the script in its spool
 * (`KONTEKS_E2E_ON_COMPUTER_SPOOL`, else its own folder) for the tester, who
 * plays the person at it. Returns the script's path.
 */
export async function openOnComputer(input: { loginId: string; script: string; dataDir: string; platform: NodeJS.Platform; env?: NodeJS.ProcessEnv; confined?: boolean }, deps: OnComputerOpenDeps = {}): Promise<OnComputerOpened> {
  const spool = standInSpool(input);
  const directory = spool ?? join(input.dataDir, "on-computer");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${input.loginId}.${input.platform === "win32" ? "ps1" : "command"}`);
  await writeFile(file, input.script, { mode: 0o700 });
  await chmod(file, 0o700);
  if (spool) return { file, opened: false };
  openInTerminal(input.platform, file, deps.spawn ?? detachedSpawn);
  return { file, opened: true };
}

/**
 * A stand-in laptop opens a real window only when the script loads the
 * stand-in's own terminal settings (`confined`), so nothing it runs touches
 * the real computer's home. With a spool (the controller's serve) or without
 * those settings it leaves the script for the tester instead.
 */
function standInSpool(input: { dataDir: string; env?: NodeJS.ProcessEnv; confined?: boolean }): string | undefined {
  const env = input.env ?? process.env;
  const standIn = env.KONTEKS_E2E_NATIVE_CONNECTOR === "1";
  if (!standIn || !(env.KONTEKS_E2E_ON_COMPUTER_SPOOL || !input.confined)) return undefined;
  return env.KONTEKS_E2E_ON_COMPUTER_SPOOL || join(input.dataDir, "on-computer");
}

function openInTerminal(platform: NodeJS.Platform, file: string, run: (command: string, args: string[]) => void): void {
  if (platform === "darwin") run("open", ["-a", "Terminal", file]);
  else if (platform === "win32") run("cmd.exe", ["/c", "start", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", file]);
  else run("x-terminal-emulator", ["-e", "sh", file]);
}

function detachedSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
interface OnComputerOpened {
  file: string;
  /** Whether a window came up; false when the script was only left for a stand-in's tester. */
  opened: boolean;
}

/** Whether this computer can bring a window to the front for the person (a desktop), or a stand-in spools it. */
export function canOpenOnComputer(hasDesktop: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return hasDesktop || env.KONTEKS_E2E_NATIVE_CONNECTOR === "1";
}

const NOT_YET_ADDED = new Set(["not_installed", "unsupported_version", "installed_not_added", "not_added"]);

/** Whether the agent's state ends the step: ready, or for an add-only step, added at all. */
export function onComputerDone(state: string | undefined, until: OnComputerPlan["until"] = "ready"): boolean {
  if (state === undefined) return false;
  return until === "added" ? !NOT_YET_ADDED.has(state) : state === "ready";
}

/** A site-started step still waiting on the person, kept across a restart of the connector. */
export interface OnComputerWatch {
  instanceId: string;
  loginId: string;
  agentId: OnComputerAgent;
  until: OnComputerPlan["until"];
  /** Epoch milliseconds after which the step has run out of time. */
  deadline: number;
}

const watchDir = (dataDir: string) => join(dataDir, "on-computer");
const watchFile = (dataDir: string, loginId: string) => join(watchDir(dataDir), `${loginId}.watch.json`);

export async function writeOnComputerWatch(dataDir: string, watch: OnComputerWatch): Promise<void> {
  await mkdir(watchDir(dataDir), { recursive: true, mode: 0o700 });
  await writeFile(watchFile(dataDir, watch.loginId), JSON.stringify(watch), { mode: 0o600 });
}

/** Ends a step here: its record and the script its window ran (an open window has already read it). */
export async function removeOnComputerWatch(dataDir: string, loginId: string): Promise<void> {
  await Promise.all([watchFile(dataDir, loginId), ...["command", "ps1"].map(ext => join(watchDir(dataDir), `${loginId}.${ext}`))]
    .map(file => rm(file, { force: true })));
}

/** Every kept step that is still well-formed; a damaged file is dropped. */
export async function readOnComputerWatches(dataDir: string): Promise<OnComputerWatch[]> {
  const names = await readdir(watchDir(dataDir)).catch(() => [] as string[]);
  const watches: OnComputerWatch[] = [];
  for (const name of names.filter(entry => entry.endsWith(".watch.json"))) {
    try {
      const value = JSON.parse(await readFile(join(watchDir(dataDir), name), "utf8")) as Partial<OnComputerWatch>;
      if (wellFormedWatch(value)) {
        watches.push(value);
        continue;
      }
    } catch { /* dropped below */ }
    await rm(join(watchDir(dataDir), name), { force: true });
  }
  return watches;
}

function wellFormedWatch(value: Partial<OnComputerWatch>): value is OnComputerWatch {
  return typeof value.instanceId === "string" && typeof value.loginId === "string" && (ON_COMPUTER_AGENTS as readonly string[]).includes(value.agentId as string)
    && (value.until === "ready" || value.until === "added") && typeof value.deadline === "number";
}