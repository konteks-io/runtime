import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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
  switch (agent.state) {
    case "not_installed":
    case "unsupported_version": {
      const install = platform === "win32" ? agent.windowsInstallCommand ?? agent.installCommand : agent.installCommand;
      // Google Antigravity is never installed by the person: Konteks adds it (downloads it from Google).
      if (!install || install === add) return { step: "add", commands: [add, signIn] };
      return { step: "install", commands: [install, add, signIn] };
    }
    case "installed_not_added":
    case "not_added":
      return { step: "add", commands: [add, signIn] };
    case "needs_sign_in":
    case "sign_in_expired":
      return { step: "sign_in", commands: [signIn] };
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
  const done = `${name} is set up. You can close this window; Konteks shows it on the site.`;
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
 * (`KONTEKS_E2E_ON_COMPUTER_SPOOL`) only leaves the script in its spool for
 * the tester, who plays the person at it. Returns the script's path.
 */
export async function openOnComputer(input: { loginId: string; script: string; dataDir: string; platform: NodeJS.Platform; env?: NodeJS.ProcessEnv }, deps: OnComputerOpenDeps = {}): Promise<string> {
  const env = input.env ?? process.env;
  const spool = env.KONTEKS_E2E_NATIVE_CONNECTOR === "1" ? env.KONTEKS_E2E_ON_COMPUTER_SPOOL : undefined;
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
  return hasDesktop || (env.KONTEKS_E2E_NATIVE_CONNECTOR === "1" && Boolean(env.KONTEKS_E2E_ON_COMPUTER_SPOOL));
}

/** The agent's state that ends a step: signed in and ready. */
export function onComputerDone(state: string | undefined): boolean {
  return state === "ready";
}
