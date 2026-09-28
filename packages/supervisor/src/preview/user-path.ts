import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * The PATH a preview command runs with. The connector runs as a background
 * service (launchd, systemd --user, a Windows scheduled task) whose PATH is
 * the bare system one, so `npm`, `pnpm` or an nvm-installed `node` are not on
 * it. A person's terminal finds them through their login shell, so the
 * connector asks that shell once for its PATH (as editors do), then adds the
 * usual toolchain folders. Only PATH is taken from the shell; nothing else
 * from its environment reaches the preview.
 */
export interface UserPathDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Returns the shell's PATH, or null. */
  shellPath?: (shell: string) => Promise<string | null>;
}

const MARKER = "__KONTEKS_PREVIEW_PATH__";

export async function resolvePreviewPath(deps: UserPathDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const current = env.PATH ?? env.Path ?? "";
  if (platform === "win32") return current;
  const home = deps.home ?? env.HOME ?? homedir();
  const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  const fromShell = await (deps.shellPath ?? loginShellPath)(shell).catch(() => null);
  const common = [
    join(home, ".volta", "bin"), join(home, ".bun", "bin"), join(home, ".local", "share", "pnpm"), join(home, "Library", "pnpm"),
    join(home, ".local", "bin"), join(home, ".cargo", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  const entries = [...(fromShell ?? "").split(":"), ...current.split(":"), ...common]
    .filter(entry => entry.length > 0 && isAbsolute(entry) && !/[\p{Cc}]/u.test(entry));
  return [...new Set(entries)].join(":");
}

/** `$SHELL -ilc` prints PATH between markers; 5 s bound; rc-file noise is ignored. */
export function loginShellPath(shell: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(shell, ["-ilc", `printf '%s%s%s' '${MARKER}' "$PATH" '${MARKER}'`], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      env: { HOME: process.env.HOME ?? homedir(), USER: process.env.USER ?? "", LOGNAME: process.env.LOGNAME ?? "", SHELL: shell, TERM: "dumb", LANG: process.env.LANG ?? "C.UTF-8", PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }, (error, stdout) => {
      if (error && !stdout) return resolve(null);
      const text = String(stdout);
      const start = text.indexOf(MARKER);
      const end = text.indexOf(MARKER, start + MARKER.length);
      resolve(start === -1 || end === -1 ? null : text.slice(start + MARKER.length, end));
    });
  });
}
