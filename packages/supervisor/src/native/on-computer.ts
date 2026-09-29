import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OnComputerStep } from "@konteks/remote-common";

/** The agents a person can set up on this computer from the site (`on-computer`). */
export const ON_COMPUTER_AGENTS = ["dsh", "opencode", "antigravity"] as const;
export type OnComputerAgent = (typeof ON_COMPUTER_AGENTS)[number];

const NAMES: Readonly<Record<OnComputerAgent, string>> = { dsh: "DeepSeek Harness", opencode: "OpenCode", antigravity: "Google Antigravity" };

/** Where an agent stands here, as the supported-agents report says it. */
export interface OnComputerAgentFacts {
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
  switch (agent.state) {
    case "not_installed":
    case "unsupported_version": {
      const install = platform === "win32" ? agent.windowsInstallCommand ?? agent.installCommand : agent.installCommand;
      // Google Antigravity is never installed by the person: Konteks adds it (downloads it from Google).
      if (!install || install === add) return { step: "add", ...after([add]) };
      return { step: "install", ...after([install, add]) };
    }
    case "installed_not_added":
    case "not_added":
      return { step: "add", ...after([add]) };
    case "needs_sign_in":
    case "sign_in_expired":
      return siteSignIn ? null : { step: "sign_in", commands: [signIn], until: "ready" };
    default:
      return null;
  }
}

/**
 * The script the window runs: it names this installation (so the commands act
 * on this connector, never another on the same computer), says in one line
 * what it is doing, runs the steps, and ends with what to do next.
 */
export function onComputerScript(plan: OnComputerPlan, context: { agentId: OnComputerAgent; root: string; platform: NodeJS.Platform }): string {
  const name = NAMES[context.agentId];
  const intro = `Konteks is setting up ${name} on this computer. Answer below; your answers stay on this computer.`;
  const done = plan.until === "added"
    ? `${name} is added. You can close this window and sign it in on the Konteks site.`
    : `${name} is set up. You can close this window; Konteks shows it on the site.`;
  const failed = "That did not finish. You can close this window and try again from Konteks.";
  if (context.platform === "win32") {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return [
      `$env:KONTEKS_ROOT = ${quote(context.root)}`,
      `$env:PATH = ${quote(join(context.root, "bin"))} + ';' + $env:PATH`,
      `Write-Host ${quote(intro)}`,
      "$ok = $true",
      ...plan.commands.map(command => `if ($ok) { ${command}; $ok = $? }`),
      `if ($ok) { Write-Host ${quote(done)} } else { Write-Host ${quote(failed)} }`,
      "",
    ].join("\r\n");
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    `export KONTEKS_ROOT=${quote(context.root)}`,
    `PATH=${quote(join(context.root, "bin"))}:"$PATH"; export PATH`,
    `echo ${quote(intro)}`,
    `if ${plan.commands.join(" && ")}; then echo; echo ${quote(done)}; else echo; echo ${quote(failed)}; fi`,
    "",
  ].join("\n");
}

export interface OnComputerOpenDeps {
  spawn?: (command: string, args: string[]) => void;
}

/**
 * Brings the step to the front on this computer: macOS opens it in Terminal,
 * Linux in the desktop's terminal, Windows in PowerShell. A stand-in laptop
 * (`KONTEKS_E2E_NATIVE_CONNECTOR`) only leaves the script in its spool
 * (`KONTEKS_E2E_ON_COMPUTER_SPOOL`, else its own folder) for the tester, who
 * plays the person at it. Returns the script's path.
 */
export async function openOnComputer(input: { loginId: string; script: string; dataDir: string; platform: NodeJS.Platform; env?: NodeJS.ProcessEnv }, deps: OnComputerOpenDeps = {}): Promise<string> {
  const env = input.env ?? process.env;
  // A stand-in laptop never brings a window up on the real desktop of the
  // computer it runs on (its tester's own screen, 09-29): it leaves the script
  // in its spool, or in its own folder, for the tester to run as the person.
  const standIn = env.KONTEKS_E2E_NATIVE_CONNECTOR === "1";
  const spool = standIn ? env.KONTEKS_E2E_ON_COMPUTER_SPOOL ?? join(input.dataDir, "on-computer") : undefined;
  const directory = spool ?? join(input.dataDir, "on-computer");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${input.loginId}.${input.platform === "win32" ? "ps1" : "command"}`);
  await writeFile(file, input.script, { mode: 0o700 });
  await chmod(file, 0o700);
  if (spool) return file;
  const run = deps.spawn ?? ((command: string, args: string[]) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  });
  if (input.platform === "darwin") run("open", ["-a", "Terminal", file]);
  else if (input.platform === "win32") run("cmd.exe", ["/c", "start", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", file]);
  else run("x-terminal-emulator", ["-e", "sh", file]);
  return file;
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
      if (typeof value.instanceId === "string" && typeof value.loginId === "string" && (ON_COMPUTER_AGENTS as readonly string[]).includes(value.agentId as string)
        && (value.until === "ready" || value.until === "added") && typeof value.deadline === "number") {
        watches.push(value as OnComputerWatch);
        continue;
      }
    } catch { /* dropped below */ }
    await rm(join(watchDir(dataDir), name), { force: true });
  }
  return watches;
}
