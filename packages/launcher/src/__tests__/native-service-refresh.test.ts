import { describe, expect, it, vi } from "vitest";
import { keepServiceOnOwnDefinition, SERVICE_RELOAD_WINDOW_MS, type OwnServiceDefinitionDeps } from "../native/commands.js";
import { encodeServiceDefinition, nativeServiceDefinition, type NativeServiceCommand, type NativeServiceDefinition } from "../native/service.js";

const root = "/Users/ada/Library/Application Support/konteks-remote";
const executable = `${root}/releases/release-new/konteks-connector`;
const macos = nativeServiceDefinition({ os: "macos", home: "/Users/ada", root, executable, uid: 501 });
const debian = nativeServiceDefinition({ os: "debian", home: "/home/ada", root: "/home/ada/.local/share/konteks-remote", executable: "/home/ada/.local/share/konteks-remote/releases/release-new/konteks-connector" });
/** What the install launcher (an older renderer) writes: no log file, no HOME. */
const olderPlist = macos.contents
  .replace(/<key>StandardOutPath<\/key><string>[^<]*<\/string>\n<key>StandardErrorPath<\/key><string>[^<]*<\/string>\n/, "")
  .replace(/<key>EnvironmentVariables<\/key><dict>.*<\/dict>\n/, "");

/** `launchctl print` of the job, as launchd showed the person's connector. */
function launchdPrint(input: { pid?: number; program?: string; logFile?: string | null }): string {
  const logFile = input.logFile === undefined ? `${root}/logs/connector.log` : input.logFile;
  return [
    `gui/501/${macos.label} = {`,
    "\tactive count = 1",
    `\tpath = /Users/ada/Library/LaunchAgents/${macos.label}.plist`,
    "\ttype = LaunchAgent",
    "\tstate = running",
    "",
    `\tprogram = ${input.program ?? executable}`,
    "\targuments = {",
    `\t\t${input.program ?? executable}`,
    "\t\tserve",
    "\t}",
    ...(logFile ? ["", `\tstdout path = ${logFile}`, `\tstderr path = ${logFile}`] : []),
    "\tumask = 77",
    "\truns = 1",
    ...(input.pid ? [`\tpid = ${input.pid}`] : []),
    "\tlast exit code = (never exited)",
    "}",
  ].join("\n");
}

function deps(definition: NativeServiceDefinition, input: { onDisk?: string | null; loaded?: string | null; last?: { digest: string; at: number } | null; os?: "macos" | "debian" | "windows"; now?: number; executeCode?: number } = {}) {
  const calls = {
    write: vi.fn(async (_path: string, _contents: string | Uint8Array) => undefined),
    detach: vi.fn(async (_command: NativeServiceCommand, _logFile: string) => undefined),
    execute: vi.fn(async (_command: NativeServiceCommand) => input.executeCode ?? 0),
    recordReload: vi.fn(async (_reload: { digest: string; at: number }) => undefined),
    log: vi.fn((_line: string) => undefined),
  };
  const value: OwnServiceDefinitionDeps = {
    definition: async () => definition,
    read: async () => {
      const onDisk = input.onDisk === undefined ? definition.contents : input.onDisk;
      if (onDisk === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return onDisk;
    },
    write: calls.write,
    os: input.os ?? "macos",
    pid: 34625,
    inspect: async () => input.loaded === undefined ? null : input.loaded,
    execute: calls.execute,
    detach: calls.detach,
    lastReload: async () => input.last ?? null,
    recordReload: calls.recordReload,
    now: () => input.now ?? 1_790_858_632_000,
    log: calls.log,
  };
  return { value, calls };
}

/** A launcher that is never replaced must not leave the plist without the log file, nor a rewritten file unapplied. */
describe("the serving release keeps its service on its own definition", () => {
  it("rewrites a definition an older launcher wrote and has launchd reload it, outside this process", async () => {
    const { value, calls } = deps(macos, { onDisk: olderPlist, loaded: launchdPrint({ pid: 34625, logFile: null }) });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("restarting");
    expect(calls.write).toHaveBeenCalledWith(macos.path, macos.contents);
    expect(calls.recordReload).toHaveBeenCalledTimes(1);
    expect(calls.detach).toHaveBeenCalledTimes(1);
    const [command, logFile] = calls.detach.mock.calls[0]!;
    expect(command).toEqual(macos.reload?.kind === "detached" ? macos.reload.command : null);
    // The reload's own output lands where the connector logs.
    expect(logFile).toBe(`${root}/logs/connector.log`);
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("heals a launch agent loaded without the log file even when the file on disk is already current", async () => {
    const { value, calls } = deps(macos, { loaded: launchdPrint({ pid: 34625, logFile: null }) });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("restarting");
    expect(calls.write).not.toHaveBeenCalled();
    expect(calls.detach).toHaveBeenCalledTimes(1);
  });

  it("reloads a launch agent that still runs another release's executable", async () => {
    const { value, calls } = deps(macos, { loaded: launchdPrint({ pid: 34625, program: `${root}/releases/release-old/konteks-connector` }) });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("restarting");
    expect(calls.detach).toHaveBeenCalledTimes(1);
  });

  it("leaves a service that already runs this definition alone", async () => {
    const { value, calls } = deps(macos, { loaded: launchdPrint({ pid: 34625 }) });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("current");
    expect(calls.write).not.toHaveBeenCalled();
    expect(calls.detach).not.toHaveBeenCalled();
    expect(calls.recordReload).not.toHaveBeenCalled();
  });

  it("leaves a service that was never installed untouched", async () => {
    const { value, calls } = deps(macos, { onDisk: null, loaded: launchdPrint({ pid: 34625, logFile: null }) });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("not_installed");
    expect(calls.write).not.toHaveBeenCalled();
    expect(calls.detach).not.toHaveBeenCalled();
  });

  it.each([
    ["a foreground serve while launchd runs another process", launchdPrint({ pid: 999, logFile: null })],
    ["a service launchd runs no process for", launchdPrint({ logFile: null })],
    ["launchd cannot say", null],
  ])("never restarts %s; the rewritten file applies from the next start", async (_case, loaded) => {
    const { value, calls } = deps(macos, { onDisk: olderPlist, loaded });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("next_start");
    expect(calls.write).toHaveBeenCalledWith(macos.path, macos.contents);
    expect(calls.detach).not.toHaveBeenCalled();
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("asks only once per definition within the window, so a reload that does not take is no restart loop", async () => {
    const now = 1_790_858_632_000;
    const first = deps(macos, { loaded: launchdPrint({ pid: 34625, logFile: null }), now });
    expect(await keepServiceOnOwnDefinition(root, first.value)).toBe("restarting");
    const recorded = first.calls.recordReload.mock.calls[0]![0];
    expect(recorded.at).toBe(now);

    const again = deps(macos, { loaded: launchdPrint({ pid: 34625, logFile: null }), last: recorded, now: now + 30_000 });
    expect(await keepServiceOnOwnDefinition(root, again.value)).toBe("next_start");
    expect(again.calls.detach).not.toHaveBeenCalled();
    expect(again.calls.log).toHaveBeenCalledWith(expect.stringContaining("already asked"));

    const later = deps(macos, { loaded: launchdPrint({ pid: 34625, logFile: null }), last: recorded, now: now + SERVICE_RELOAD_WINDOW_MS });
    expect(await keepServiceOnOwnDefinition(root, later.value)).toBe("restarting");
    expect(later.calls.detach).toHaveBeenCalledTimes(1);
  });

  it("has systemd reload the unit and queue its own restart", async () => {
    const { value, calls } = deps(debian, { os: "debian", onDisk: debian.contents.replace(/^Environment=.*\n/m, ""), loaded: "MainPID=34625\nNeedDaemonReload=yes\n" });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("restarting");
    expect(calls.execute.mock.calls.map(([command]) => command)).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "--no-block", "restart", `${debian.label}.service`] },
    ]);
    expect(calls.detach).not.toHaveBeenCalled();
  });

  it("leaves a systemd unit that is loaded and current alone, and says when a reload fails", async () => {
    const current = deps(debian, { os: "debian", loaded: "MainPID=34625\nNeedDaemonReload=no\n" });
    expect(await keepServiceOnOwnDefinition(root, current.value)).toBe("current");
    expect(current.calls.execute).not.toHaveBeenCalled();

    const failing = deps(debian, { os: "debian", loaded: "MainPID=34625\nNeedDaemonReload=yes\n", executeCode: 1 });
    await expect(keepServiceOnOwnDefinition(root, failing.value)).rejects.toThrow(/daemon-reload exited unsuccessfully/);
  });

  it("refreshes the Windows login shortcut for the next start", async () => {
    const windows = nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Ada", root: "C:\\Users\\Ada\\AppData\\Local\\konteks-remote", executable: "C:\\Users\\Ada\\AppData\\Local\\konteks-remote\\releases\\release-new\\konteks-connector.exe", userId: "S-1-5-21-1-2-3-1001" });
    const { value, calls } = deps(windows, { os: "windows", onDisk: "<Task/>" });
    expect(await keepServiceOnOwnDefinition(root, value)).toBe("next_start");
    // The startup manifest is UTF-8 JSON.
    expect(calls.write).toHaveBeenCalledWith(windows.path, windows.contents);
    expect(calls.execute).toHaveBeenCalledWith(windows.install[0]);
    expect(calls.detach).not.toHaveBeenCalled();
  });
});


describe("Windows login startup refresh", () => {
  function setup() {
    const definition = nativeServiceDefinition({ os: "windows", home: "C:\\Users\\ada", root: "C:\\Users\\ada\\remote", executable: "C:\\Users\\ada\\remote\\releases\\new\\konteks-connector.exe", userId: "S-1-5-21-1-2-3-1001" });
    const base = deps(definition).value;
    const files = new Map<string, string | Uint8Array>([[definition.path, "older task"]]);
    const execute = vi.fn(async () => 0);
    const value: OwnServiceDefinitionDeps = {
      ...base, os: "windows", execute,
      read: async path => { const value = files.get(path); if (value === undefined) throw new Error("missing"); return value; },
      write: async (path, contents) => { files.set(path, contents); },
    };
    return { definition, files, value, execute };
  }
  it("writes the helper and refreshes startup without starting another connector, then is idempotent", async () => {
    const { definition, files, value, execute } = setup();
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("next_start");
    expect(files.get(definition.supportFiles![0]!.path)).toBe(definition.supportFiles![0]!.contents);
    expect(execute.mock.calls).toEqual(definition.install.map(command => [command]));
    expect(execute).not.toHaveBeenCalledWith(definition.start);
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("current");
    // Only asked whether the shortcut exists; not registered again.
    expect(execute.mock.calls.filter(call => (call as unknown[])[0] === definition.install[0])).toHaveLength(definition.install.length);
  });
  it("restores failed registration so the next start retries it", async () => {
    const { definition, files, value, execute } = setup();
    execute.mockResolvedValueOnce(1);
    await expect(keepServiceOnOwnDefinition("root", value)).rejects.toThrow("powershell.exe exited 1");
    // The exact bytes it found, never a re-encoded copy.
    expect(Buffer.from(files.get(definition.path)!).toString("utf8")).toBe("older task");
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("next_start");
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("current");
  });
  it("repairs a missing helper but leaves an uninstalled foreground connector untouched", async () => {
    const { definition, files, value, execute } = setup();
    files.set(definition.path, encodeServiceDefinition(definition));
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("next_start");
    expect(execute).not.toHaveBeenCalledWith(definition.install[0]);
    files.clear();
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("not_installed");
    expect(files.size).toBe(0);
  });
});


describe("Windows legacy task migration", () => {
  function migration(fail: boolean) {
    const definition = nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Ada", root: "C:\\Users\\Ada\\remote", executable: "C:\\Users\\Ada\\remote\\releases\\new\\konteks-connector.exe", userId: "S-1-5-21-1-2-3-1001" });
    const { value, calls } = deps(definition, { os: "windows", executeCode: fail ? 1 : 0 });
    value.read = async path => { if (path === definition.legacyPath) return "<Task/>"; throw new Error("missing"); };
    return { definition, value, calls };
  }
  it("registers login startup before writing its manifest and hands over after this process exits", async () => {
    const { definition, value, calls } = migration(false);
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("handoff");
    expect(calls.execute.mock.calls).toEqual([[definition.install[0]], [definition.handoff!(value.pid)]]);
    const manifestCall = calls.write.mock.calls.findIndex(([path]) => path === definition.path);
    expect(calls.execute.mock.invocationCallOrder[0]).toBeLessThan(calls.write.mock.invocationCallOrder[manifestCall]!);
    expect(calls.execute.mock.invocationCallOrder[1]).toBeGreaterThan(calls.write.mock.invocationCallOrder[manifestCall]!);
  });
  it("keeps migration retryable when legacy task ownership or shortcut registration is refused", async () => {
    const { definition, value, calls } = migration(true);
    await expect(keepServiceOnOwnDefinition("root", value)).rejects.toThrow("powershell.exe exited 1");
    expect(calls.write.mock.calls.some(([path]) => path === definition.path)).toBe(false);
    expect(calls.execute).toHaveBeenCalledTimes(1);
  });
});
