import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/**
 * How this computer runs the connector's own command, for the hints the
 * launcher prints ("run `konteks-remote doctor`"). The macOS and Linux
 * user-local install puts the command in `<root>/bin` and writes nothing to a
 * shell profile, so where that folder is not on PATH the short name is
 * "command not found": the hint then names the running executable itself.
 */
export const CLI_NAME = "konteks-remote";

/** The connector's top-level commands: a hint is the name followed by one of them. */
const COMMANDS = ["agent", "agents", "auth", "doctor", "git", "install", "onboard", "preview", "serve", "start", "status", "stop", "support", "uninstall", "update"];
const HINT = new RegExp(`(?<![\\w./\\\\"'-])${CLI_NAME}(?= (?:--[a-z-]+ )*(?:${COMMANDS.join("|")})\\b)`, "g");

export interface CliCommandInput {
  platform: NodeJS.Platform;
  execPath: string;
  /** `process.argv[1]`: the script in a source run, the executable itself when packaged. */
  argv1: string | undefined;
  path: string | undefined;
  realpath?: (path: string) => string;
  isExecutable?: (path: string) => boolean;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A POSIX shell word: as it is when it needs no quoting, otherwise double-quoted. */
export function shellWord(value: string): string {
  return /^[\w./,:@%+=-]+$/.test(value) ? value : `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

/**
 * `konteks-remote` when the first one on PATH is this very executable,
 * otherwise this executable's path. Windows and source runs keep the name:
 * the MSI puts its launcher on PATH and runs the release's own executable as
 * a child, and a source run has no installed command to name.
 */
export function resolveCliExecutable(input: CliCommandInput): string {
  if (input.platform === "win32") return CLI_NAME;
  if (input.argv1 && resolve(input.argv1) !== resolve(input.execPath)) return CLI_NAME;
  const realpath = input.realpath ?? realpathSync;
  const self = tryRealpath(realpath, input.execPath);
  if (self === undefined) return CLI_NAME;
  const found = firstOnPath(input.path, input.isExecutable ?? isExecutableFile, realpath);
  return found === self ? CLI_NAME : input.execPath;
}

/** The same command as a shell word, for text a person or an agent types into a shell. */
export function resolveCliCommand(input: CliCommandInput): string {
  return shellWord(resolveCliExecutable(input));
}

function tryRealpath(realpath: (path: string) => string, path: string): string | undefined {
  try {
    return realpath(path);
  } catch {
    return undefined;
  }
}

/** The real path of the `konteks-remote` the shell would run: the first one it finds. */
function firstOnPath(path: string | undefined, isExecutable: (path: string) => boolean, realpath: (path: string) => string): string | undefined {
  for (const directory of (path ?? "").split(delimiter)) {
    const candidate = directory ? join(directory, CLI_NAME) : undefined;
    const real = candidate && isExecutable(candidate) ? tryRealpath(realpath, candidate) : undefined;
    if (real !== undefined) return real;
  }
  return undefined;
}

let cached: string | undefined;

/** This process's executable as an argv entry, resolved once. */
export function cliExecutable(): string {
  cached ??= resolveCliExecutable({ platform: process.platform, execPath: process.execPath, argv1: process.argv[1], path: process.env.PATH });
  return cached;
}

/** This process's command as a shell word. */
export function cliCommand(): string {
  return shellWord(cliExecutable());
}

/** Human text with each `konteks-remote <command>` hint in the form that runs on this computer. */
export function commandHintText(text: string, command: string | (() => string) = cliCommand): string {
  if (!text.includes(CLI_NAME)) return text;
  let form: string | undefined;
  return text.replace(HINT, () => (form ??= typeof command === "string" ? command : command()));
}
