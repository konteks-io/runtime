import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { FolderAccessCue, probeFolder, protectedFolderIn, type FolderAccess } from "../session/folder-access-cue.js";

const HOME = "/Users/person";
const CWD = `${HOME}/Library/Application Support/konteks-remote/workspaces/claude-code/session-1/source`;

function cue(access: FolderAccess, platform: NodeJS.Platform = "darwin") {
  const note = vi.fn(async (_toolCallId: string, _text: string) => {});
  const probe = vi.fn(async (_folder: string) => access);
  const watch = new FolderAccessCue({ note, probe, platform, home: HOME, cwd: () => CWD, delayMs: 8_000 });
  return { watch, note, probe };
}

const lsDesktop = { sessionUpdate: "tool_call", toolCallId: "t1", status: "pending", title: "ls -la ~/Desktop", rawInput: { command: "ls -la ~/Desktop" } };

describe("folder access cue (macOS asks before opening Desktop, Documents, Downloads)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 10-09 (E11): `ls -la ~/Desktop … Waiting` for minutes while macOS asked on the Mac.
  it("tells the person when a step on Desktop waits and the Mac is asking", async () => {
    const { watch, note, probe } = cue("waiting");
    watch.observe(lsDesktop);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledWith(`${HOME}/Desktop`);
    expect(note).toHaveBeenCalledWith("t1", "Your Mac is asking whether Konteks may open your Desktop folder. Answer it on the Mac to carry on.");
  });

  it("says nothing when the folder is already open to Konteks or the Mac refused it", async () => {
    for (const access of ["open", "refused"] as const) {
      const { watch, note, probe } = cue(access);
      watch.observe(lsDesktop);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(note).not.toHaveBeenCalled();
    }
  });

  it("checks nothing for a step that ends in time, and only once per step", async () => {
    const { watch, probe } = cue("waiting");
    watch.observe(lsDesktop);
    watch.observe({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe).not.toHaveBeenCalled();

    watch.observe({ ...lsDesktop, toolCallId: "t2" });
    await vi.advanceTimersByTimeAsync(8_000);
    watch.observe({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "in_progress", rawInput: { command: "ls -la ~/Desktop" } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("finds the folder in a later update's input (Claude Code sends the command after the step opens)", async () => {
    const { watch, note } = cue("waiting");
    watch.observe({ sessionUpdate: "tool_call", toolCallId: "t3", status: "pending", title: "Write", rawInput: {} });
    watch.observe({ sessionUpdate: "tool_call_update", toolCallId: "t3", rawInput: { file_path: `${HOME}/Documents/notes.md` } });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(note).toHaveBeenCalledWith("t3", expect.stringContaining("your Documents folder"));
  });

  it("does nothing off macOS, or after the session stopped", async () => {
    const linux = cue("waiting", "linux");
    linux.watch.observe(lsDesktop);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(linux.probe).not.toHaveBeenCalled();

    const mac = cue("waiting");
    mac.watch.observe(lsDesktop);
    mac.watch.stop();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(mac.probe).not.toHaveBeenCalled();
  });

  it("names only folders macOS guards, outside the session's own folder", () => {
    expect(protectedFolderIn("cp out.txt ~/Downloads/", HOME, CWD)?.name).toBe("your Downloads folder");
    expect(protectedFolderIn(`{"path":"${HOME}/Library/Mobile Documents/com~apple~CloudDocs/a.txt"}`, HOME, CWD)?.name).toBe("iCloud Drive");
    expect(protectedFolderIn("ls /Volumes/Backup", HOME, CWD)).toEqual({ path: "/Volumes/Backup", name: "an external drive" });
    expect(protectedFolderIn("ls ~/DesktopApps ~/Documentation", HOME, CWD)).toBeNull();
    expect(protectedFolderIn("pytest -q", HOME, CWD)).toBeNull();
    expect(protectedFolderIn(`ls ${HOME}/Documents/repo/src`, HOME, `${HOME}/Documents/repo`)).toBeNull();
  });
});

describe("probeFolder", () => {
  // The first entry only: `ls` took 2 s on a folder of 100,000 files and would have read as asking.
  it("reads an open folder as open and a missing one as refused", async () => {
    await expect(probeFolder(tmpdir())).resolves.toBe("open");
    await expect(probeFolder(`${tmpdir()}/konteks-no-such-folder-${process.pid}`)).resolves.toBe("refused");
  });
});
