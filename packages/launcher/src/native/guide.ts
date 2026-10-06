import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { RemoteInstanceError, writeSecretFile } from "@konteks/remote-common";
import { connectorCommandsManifest } from "@konteks/remote-release";

/** Offline documentation; never opens an installation or a control socket. */
export function nativeGuide(man = false): string {
  const sections: Array<[string, string[]]> = [
    ["NAME", ["konteks-remote - connect this computer and its coding agents to Konteks"]],
    ["SYNOPSIS", ["konteks-remote [--root <path>] [--json] <command>", "konteks-remote <command> --help"]],
    ["GETTING STARTED", [
      "Use the install instructions shown by Konteks for your computer. An activation code is entered securely when asked; never put it in command arguments.",
      "For agent-assisted enrollment, install with --enroll, then run konteks-remote onboard in your repository and answer each question it returns.",
      "Run konteks-remote status, agents and doctor to check readiness. Sign in with konteks-remote auth login <agent> on this computer.",
      "Agent IDs: codex, claude-code, opencode, antigravity and dsh (DeepSeek Harness). Availability depends on your platform and installed release."
    ]],
    ["COMMANDS", (connectorCommandsManifest("0.1.0")?.commands ?? []).flatMap(entry => [entry.command, `  ${entry.description}`])],
    ["EXAMPLES", [
      "konteks-remote auth login codex",
      "konteks-remote auth login opencode --provider deepseek",
      "konteks-remote update --check",
      "konteks-remote stop",
      "konteks-remote start",
      "konteks-remote guide --man > konteks-remote.1",
      "man ./konteks-remote.1"
    ]],
    ["BACKGROUND OPERATION", [
      "Use start for background operation. serve runs in the current terminal and is primarily the service manager's entry point.",
      "macOS uses a user LaunchAgent; Linux uses a systemd user service. Windows uses Task Scheduler under the signed-in user with LeastPrivilege and a windowless launch helper. It does not register an Administrator-level Windows service.",
      "The Windows background task depends on the user being signed in. Interactive installation and agent sign-in may ask questions or open a browser. The installer package can have separate operating-system permission requirements."
    ]],
    ["SKILLS", [
      "Organization sessions receive the authorized Skill selection from Konteks. Local discovery folders are managed separately from your personal Skills.",
      "Older installations can bind Codex and Claude discovery folders with: stop, skills configure, then start. This binds local paths; it does not by itself fetch a new organization catalog.",
      "Configured native profiles refresh when the runtime first becomes ready, after active relay or HTTPS reconciliation, and automatically about once a minute while connected. Promote a personal runtime Skill from Runtime Skills under On this computer in Konteks to share its selected file snapshot with your organization. Run konteks-remote skills sync for a manual refresh; skills status shows inventory and the last successful sync for this installation, including across connector restarts. Restart an already-running agent session if it does not discover new Skills."
    ]],
    ["REMOVAL", [
      "Run konteks-remote uninstall. It drains running work before unregistering the background service and removing the installation. Your repositories and your agents' own sign-ins stay.",
      "If running work has not finished after 15 minutes, removal stops and the runtime remains drained. Try again once that work finishes.",
      "If Konteks could not be told about removal, remove this computer's runtime on the site as instructed by the command."
    ]],
    ["TROUBLESHOOTING", [
      "Run doctor for checks and recovery instructions; status and agents show current readiness. Use support to collect a support bundle and review it before sharing.",
      "Use --root only to address your own installation in a different location. For command options, run konteks-remote <command> --help. The guide is available offline, including on Windows.",
      "Installation includes share/man/man1/konteks-remote.1 below the runtime root. On macOS, man discovers this manual when <runtime-root>/bin is on PATH. The installer prints the PATH command when needed; it does not edit your shell profile.",
      "On Unix, run man -M <runtime-root>/share/man konteks-remote to read the installed manual directly. If plain man konteks-remote cannot find it, add <runtime-root>/share/man to MANPATH with a trailing colon to retain system manuals. Uninstall removes the installed manual; remove any PATH or MANPATH entry you added afterward. guide --man also emits the manual offline."
    ]]
  ];
  if (!man) return sections.map(([title, lines]) => `${title}\n${lines.join("\n\n")}`).join("\n\n") + "\n";
  const escape = (text: string) => text.replace(/\\/g, "\\e").replace(/-/g, "\\-").replace(/^[.']/gm, "\\&$&");
  const wrap = (text: string) => {
    const lines: string[] = [""];
    for (const word of text.split(/\s+/)) {
      const last = lines.length - 1;
      if (lines[last] && lines[last]!.length + word.length + 1 > 70) lines.push(word);
      else lines[last] = lines[last] ? `${lines[last]} ${word}` : word;
    }
    return lines.map(escape).join("\n");
  };
  return '.TH KONTEKS-REMOTE 1 "October 3, 2026" "Konteks" "User Commands"\n' + sections.map(([title, lines]) => `.SH ${title}\n${lines.map((line, index) => `${index ? ".PP\n" : ""}${wrap(line)}\n`).join("")}`).join("");
}

/** Install only below the runtime root so ordinary uninstall removes the manual too. */
export async function installNativeManual(root: string): Promise<string> {
  if (!isAbsolute(root) || resolve(root) === parse(root).root || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(root)) throw new RemoteInstanceError("prerequisite_missing", "The manual requires a local installation folder.");
  for (const folder of [root, join(root, "share"), join(root, "share", "man"), join(root, "share", "man", "man1")]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const found = await lstat(folder);
    if (!found.isDirectory() || found.isSymbolicLink() || process.platform !== "win32" && ((found.mode & 0o077) !== 0 || found.uid !== process.getuid?.())) throw new RemoteInstanceError("prerequisite_missing", "The manual folder is unavailable.");
  }
  const target = join(root, "share", "man", "man1", "konteks-remote.1");
  await writeSecretFile(target, nativeGuide(true));
  return join(root, "share", "man");
}

export function manualReadCommand(directory: string): string {
  return `man -M '${directory.split("'").join("'\"'\"'")}' konteks-remote`;
}
