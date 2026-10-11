import { spawn } from "node:child_process";
import { homedir } from "node:os";

/**
 * macOS asks the person before a process opens their Desktop, Documents or
 * Downloads folder, iCloud Drive or another drive, and a step that does so
 * waits on that dialog with no output. On the page it read only "Waiting",
 * for minutes, while the dialog sat on the Mac (10-09, E11: `ls ~/Desktop`).
 *
 * A step that names such a folder and is still open after a few seconds is
 * checked: when listing the folder waits too, the Mac is asking, and the step
 * gets a note for the person. A folder already allowed lists at once and
 * says nothing; one refused fails the step on its own.
 */

export type FolderAccess = "open" | "waiting" | "refused";

export interface FolderAccessCueOptions {
  /** Sends the note on the step (a `tool_call_update` the person sees). */
  note: (toolCallId: string, text: string) => Promise<void>;
  /** The session's working copy: a folder that holds it is already open to this process. */
  cwd: () => string;
  platform?: NodeJS.Platform;
  home?: string;
  probe?: (folder: string) => Promise<FolderAccess>;
  /** How long a step may wait before its folder is checked. */
  delayMs?: number;
  onCue?: (toolCallId: string, folderName: string) => void;
}

export const FOLDER_ACCESS_DELAY_MS = 8_000;
const PROBE_TIMEOUT_MS = 2_000;
const TERMINAL = new Set(["completed", "failed"]);

interface ProtectedFolder { path: string; name: string }

export class FolderAccessCue {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Steps already checked or noted: one check per step. */
  private readonly settled = new Set<string>();
  private stopped = false;

  constructor(private readonly options: FolderAccessCueOptions) {}

  observe(update: unknown): void {
    if (this.stopped || (this.options.platform ?? process.platform) !== "darwin") return;
    const step = stepOf(update);
    if (!step) return;
    if (step.status !== undefined && TERMINAL.has(step.status)) this.forget(step.toolCallId);
    else this.arm(step);
  }

  /** One check per step, armed once its command or paths name a guarded folder. */
  private arm(step: { toolCallId: string; text: string }): void {
    if (this.timers.has(step.toolCallId) || this.settled.has(step.toolCallId)) return;
    const folder = protectedFolderIn(step.text, this.options.home ?? homedir(), this.options.cwd());
    if (!folder) return;
    const timer = setTimeout(() => void this.check(step.toolCallId, folder), this.options.delayMs ?? FOLDER_ACCESS_DELAY_MS);
    timer.unref?.();
    this.timers.set(step.toolCallId, timer);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private forget(toolCallId: string): void {
    const timer = this.timers.get(toolCallId);
    if (timer) clearTimeout(timer);
    this.timers.delete(toolCallId);
    this.settled.delete(toolCallId);
  }

  private async check(toolCallId: string, folder: ProtectedFolder): Promise<void> {
    if (!this.timers.delete(toolCallId) || this.stopped) return;
    this.settled.add(toolCallId);
    const access = await (this.options.probe ?? probeFolder)(folder.path);
    if (access !== "waiting" || this.stopped || !this.settled.has(toolCallId)) return;
    this.options.onCue?.(toolCallId, folder.name);
    await this.options.note(toolCallId, `Your Mac is asking whether Konteks may open ${folder.name}. Answer it on the Mac to carry on.`);
  }
}

function stepOf(update: unknown): { toolCallId: string; status?: string; text: string } | null {
  const value = update as { sessionUpdate?: unknown; toolCallId?: unknown; status?: unknown; title?: unknown; rawInput?: unknown; locations?: unknown } | null;
  if (!value || (value.sessionUpdate !== "tool_call" && value.sessionUpdate !== "tool_call_update") || typeof value.toolCallId !== "string") return null;
  const parts = [typeof value.title === "string" ? value.title : "", jsonOf(value.rawInput), jsonOf(value.locations)];
  return { toolCallId: value.toolCallId, ...(typeof value.status === "string" ? { status: value.status } : {}), text: parts.join("\n") };
}

function jsonOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return ""; }
}

/** The protected folder a step's command or paths name, unless the session's own folder is inside it. */
export function protectedFolderIn(text: string, home: string, cwd: string): ProtectedFolder | null {
  const folders: Array<ProtectedFolder & { spellings: string[] }> = [
    ...(["Desktop", "Documents", "Downloads"] as const).map(name => ({
      path: `${home}/${name}`, name: `your ${name} folder`, spellings: [`${home}/${name}`, `~/${name}`, `$HOME/${name}`, `\${HOME}/${name}`],
    })),
    { path: `${home}/Library/Mobile Documents`, name: "iCloud Drive", spellings: [`${home}/Library/Mobile Documents`, "~/Library/Mobile Documents"] },
  ];
  for (const folder of folders) {
    if (within(cwd, folder.path)) continue;
    if (folder.spellings.some(spelling => namesFolder(text, spelling))) return { path: folder.path, name: folder.name };
  }
  const drive = /\/Volumes\/([^/"'\s\\]+)/.exec(text);
  if (drive && !within(cwd, `/Volumes/${drive[1]}`)) return { path: `/Volumes/${drive[1]}`, name: "an external drive" };
  return null;
}

function namesFolder(text: string, spelling: string): boolean {
  let at = text.indexOf(spelling);
  while (at !== -1) {
    const next = text[at + spelling.length];
    if (next === undefined || /[/"'\s\\;)|&]/.test(next)) return true;
    at = text.indexOf(spelling, at + 1);
  }
  return false;
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Opens the folder and reads its first entry as this process's child: at once
 * when allowed, an error when refused, and no answer while macOS asks. One
 * entry, so a folder of 100,000 files is not listed (`ls` took 2 s there).
 * macOS ships /usr/bin/perl; without it the check says nothing.
 */
export function probeFolder(folder: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<FolderAccess> {
  return new Promise(resolve => {
    const child = spawn("/usr/bin/perl", ["-e", "opendir(my $d, $ARGV[0]) or exit 1; defined(readdir($d)) or exit 1; exit 0", folder], { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("waiting"); }, timeoutMs);
    timer.unref?.();
    const settle = (access: FolderAccess) => { clearTimeout(timer); resolve(access); };
    child.once("error", () => settle("refused"));
    child.once("exit", code => settle(code === 0 ? "open" : "refused"));
  });
}
