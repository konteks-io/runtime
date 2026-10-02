import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { nativePlatform, nativePaths, nativeServiceDefinition, parseLoadedService, parseServiceExits, startNativeServiceDefinition, type NativeServiceCommand } from "../native/service.js";

describe("native install layout", () => {
  it.each([['darwin', 'macos'], ['win32', 'windows'], ['linux', 'debian']] as const)("supports %s x64 and arm64 without a container backend", (os, expected) => {
    for (const architecture of ['x64', 'arm64']) {
      expect(nativePlatform(os, architecture)).toEqual({ os: expected, architecture: architecture === 'x64' ? 'amd64' : 'arm64', containerBackend: 'none', deploymentKind: 'native_connector' });
    }
  });

  it("rejects unsupported CPU/OS combinations instead of silently installing amd64", () => {
    expect(() => nativePlatform('linux', 'ia32')).toThrow(/architecture/);
    expect(() => nativePlatform('freebsd', 'x64')).toThrow(/platform/);
  });

  it.each(['macos', 'windows', 'debian'] as const)("creates only user-scoped connector state on %s", os => {
    const home = os === 'windows' ? 'C:\\Users\\Test User' : '/home/test user';
    const paths = nativePaths({ os, home });
    expect(paths.root.startsWith(home)).toBe(true);
    expect(Object.keys(paths)).not.toEqual(expect.arrayContaining(['harnessData', 'validationData', 'composeFile', 'stores', 'browserData']));
    expect(paths.credentials('claude-code')).toContain('claude-code');
    expect(() => paths.credentials('../outside')).toThrow();
  });
});

describe("native background service definitions", () => {
  const root = '/Users/Test User/Library/Application Support/konteks-remote';
  it("keeps the Windows scheduled action windowless and waits for the connector's exit", async () => {
    const root = "C:\\Users\\Test User\\literal %PATH% & O'Brien\\remote";
    const executable = `${root}\\releases\\next\\konteks-connector.exe`;
    const service = nativeServiceDefinition({ os: 'windows', home: 'C:\\Users\\Test User', root, executable, userId: 'S-1-5-21-123-456-789-1001' });
    expect(service.contents).toContain('<Command>%SystemRoot%\\System32\\wscript.exe</Command>');
    expect(service.contents).not.toContain(`<Command>${executable}</Command>`);
    expect(service.contents).toContain('//B //NoLogo');
    const helper = service.supportFiles?.[0];
    expect(helper?.path).toBe(`${root}\\service.js`);
    expect(helper?.contents).toContain('WScript.Quit(shell.Run(');
    expect(helper?.contents).toContain(', 0, true)');
    const encoded = helper!.contents.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1]!;
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    // Single-quoted PowerShell literals keep percent variables, metacharacters
    // and apostrophes in the installation paths literal, not executable input.
    expect(script).toContain(`& '${executable.replace(/'/g, "''")}' 'serve' '--root' '${root.replace(/'/g, "''")}'`);
    expect(script).toContain('exit $LASTEXITCODE');
    const run = vi.fn(() => 17), quit = vi.fn();
    runInNewContext(helper!.contents, { WScript: { CreateObject: () => ({ Run: run }), Quit: quit } });
    expect(run).toHaveBeenCalledWith(expect.stringContaining('-EncodedCommand'), 0, true);
    expect(quit).toHaveBeenCalledWith(17);
    const writes: string[] = [];
    await startNativeServiceDefinition(service, {
      execute: async command => command === service.status ? 1 : 0,
      write: async path => { writes.push(path); },
    });
    expect(writes).toEqual([helper!.path, service.path]);
    const execute = vi.fn(async () => 1);
    await expect(startNativeServiceDefinition(service, { execute, write: async () => { throw new Error('helper cannot be written'); } })).rejects.toThrow('helper cannot be written');
    expect(execute).toHaveBeenCalledTimes(1); // No registration or start beside a missing helper.
  });
  it("uses launchd argument arrays and keeps credentials out of the service definition", () => {
    const service = nativeServiceDefinition({ os: 'macos', home: '/Users/Test User', root, executable: `${root}/bin/konteks-remote`, uid: 501 });
    expect(service.contents).toContain(`<string>${root}/bin/konteks-remote</string>`);
    expect(service.contents).toContain('<string>serve</string>');
    expect(service.contents).toContain('<string>--root</string>');
    expect(service.start.command).toBe('launchctl');
    expect(service.start.args).toEqual(['bootstrap', 'gui/501', service.path]);
    // launchd keeps nothing the connector prints unless the plist names a file (WS1-163).
    expect(service.contents).toContain(`<key>StandardOutPath</key><string>${root}/logs/connector.log</string>`);
    expect(service.contents).toContain(`<key>StandardErrorPath</key><string>${root}/logs/connector.log</string>`);
    // The home it was started from, not the login's (09-30).
    expect(service.contents).toContain('<key>EnvironmentVariables</key><dict><key>HOME</key><string>/Users/Test User</string></dict>');
    expect(service.contents).not.toMatch(/Docker|docker|postgres|harness|validation-runtime|activationCode|TOKEN|PRIVATE KEY/);
  });

  it("escapes XML paths rather than interpolating them as markup", () => {
    const service = nativeServiceDefinition({ os: 'macos', home: '/Users/a', root: '/Users/a/x&y', executable: '/Users/a/x&y/bin/remote', uid: 501 });
    expect(service.contents).toContain('x&amp;y');
    expect(service.contents).not.toContain('<string>/Users/a/x&y');
  });

  it("uses systemd user services and literal path arguments, not a shell", () => {
    const service = nativeServiceDefinition({ os: 'debian', home: '/home/a', root: '/home/a/space $HOME %n', executable: '/home/a/space $HOME %n/bin/remote' });
    expect(service.contents).toContain('ExecStart="/home/a/space $$HOME %%n/bin/remote" "serve" "--root" "/home/a/space $$HOME %%n"');
    expect(service.contents).toContain('Environment="HOME=/home/a"');
    expect(service.start).toEqual({ command: 'systemctl', args: ['--user', 'enable', '--now', `${service.label}.service`] });
    expect(service.contents).not.toMatch(/sudo|bash|docker|User=root/);
  });

  it("uses a least-privilege Windows logon task without a stored password", () => {
    const root = 'C:\\Users\\Test User\\AppData\\Local\\konteks-remote';
    const service = nativeServiceDefinition({ os: 'windows', home: 'C:\\Users\\Test User', root, executable: `${root}\\bin\\konteks-remote.exe`, userId: 'S-1-5-21-123-456-789-1001' });
    expect(service.contents).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(service.contents).toContain('encoding="UTF-16"');
    expect(service.contents).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(service.contents).toContain('<UserId>S-1-5-21-123-456-789-1001</UserId>');
    expect(service.contents).toContain('<Arguments>//B //NoLogo //E:JScript &quot;C:\\Users\\Test User\\AppData\\Local\\konteks-remote\\service.js&quot;</Arguments>');
    expect(service.install).toEqual([{ command: 'schtasks.exe', args: ['/Create', '/TN', service.label, '/XML', service.path, '/F'] }]);
    // Status means running, not registered: `schtasks /Query` succeeds for a stopped task too.
    expect(service.status.command).toBe('powershell.exe');
    expect(service.status.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(service.status.args[3]).toBe(`$task = Get-ScheduledTask -TaskPath '\\' -TaskName '${service.label}' -ErrorAction SilentlyContinue; if ($task -and $task.State -eq 'Running') { exit 0 }; exit 1`);
  });

  it("starts by rewriting and re-registering the definition, so a start after an update runs the new release", async () => {
    const root = 'C:\\Users\\a\\AppData\\Local\\konteks-remote';
    const next = nativeServiceDefinition({ os: 'windows', home: 'C:\\Users\\a', root, executable: `${root}\\releases\\release-next\\konteks-connector.exe`, userId: 'S-1-5-21-1-2-3-1001' });
    // The task exists (registered for the previous release) but is stopped.
    const calls: NativeServiceCommand[] = [];
    const execute = vi.fn(async (command: NativeServiceCommand) => { calls.push(command); return command === next.status ? 1 : 0; });
    const write = vi.fn(async () => undefined);
    await expect(startNativeServiceDefinition(next, { execute, write })).resolves.toBe('started');
    expect(write).toHaveBeenCalledWith(next.supportFiles![0]!.path, next.supportFiles![0]!.contents);
    const bytes = write.mock.calls[1]?.[1];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes!).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(Buffer.from(bytes!).subarray(2).toString('utf16le')).toContain("<Command>%SystemRoot%\\System32\\wscript.exe</Command>");
    expect(calls).toEqual([next.status, ...next.install, next.start]);
    // Only a running service is left alone.
    const running = vi.fn(async () => 0), untouched = vi.fn(async () => undefined);
    await expect(startNativeServiceDefinition(next, { execute: running, write: untouched })).resolves.toBe('already_running');
    expect(untouched).not.toHaveBeenCalled();
    // A registration the OS refuses is an error, not a silent start.
    await expect(startNativeServiceDefinition(next, { execute: async command => command === next.status ? 1 : command === next.install[0] ? 1 : 0, write })).rejects.toThrow(/schtasks/);
  });

  it("keeps different install roots isolated and requires explicit user identity", () => {
    const input = { os: 'macos' as const, home: '/Users/a', root: '/Users/a/one', executable: '/Users/a/bin/remote', uid: 501 };
    expect(nativeServiceDefinition(input).label).not.toBe(nativeServiceDefinition({ ...input, root: '/Users/a/two' }).label);
    expect(() => nativeServiceDefinition({ ...input, uid: undefined })).toThrow(/uid/);
    expect(() => nativeServiceDefinition({ os: 'windows', home: 'C:\\Users\\a', root: 'C:\\Users\\a\\remote', executable: 'C:\\remote.exe' })).toThrow(/user/);
  });

  it("refuses relative paths and line-break injection", () => {
    const input = { os: 'debian' as const, home: '/home/a', root: '/home/a/remote', executable: '/home/a/remote/bin/remote' };
    expect(() => nativeServiceDefinition({ ...input, executable: 'relative' })).toThrow(/absolute/);
    expect(() => nativeServiceDefinition({ ...input, root: '/home/a/remote\nExecStart=evil' })).toThrow();
  });
});

describe("service exits (W1-Z7)", () => {
  it("reads launchd's run count and last exit code", () => {
    const print = (runs: number, last: string) => `gui/501/dev.konteks.remote.x = {\n\tactive count = 1\n\tstate = running\n\truns = ${runs}\n\tpid = 81413\n\tlast exit code = ${last}\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n`;
    expect(parseServiceExits("macos", print(1, "(never exited)"))).toEqual({ runs: 1, lastExitCode: null });
    expect(parseServiceExits("macos", print(4, "1"))).toEqual({ runs: 4, lastExitCode: 1 });
    expect(parseServiceExits("macos", "Could not find service")).toBeNull();
  });
  it("reads systemd's restarts and main exit status", () => {
    expect(parseServiceExits("debian", "NRestarts=2\nExecMainStatus=1\n")).toEqual({ runs: 3, lastExitCode: 1 });
    expect(parseServiceExits("debian", "NRestarts=0\nExecMainStatus=0\n")).toEqual({ runs: 1, lastExitCode: null });
    expect(parseServiceExits("windows", "anything")).toBeNull();
  });
});

/** RCA 2026-10-01: launchd reads a plist only at bootstrap, so a rewritten one needs a reload, not `kickstart -k`. */
describe("reloading a service onto a rewritten definition", () => {
  const root = '/Users/Test User/Library/Application Support/konteks-remote';
  const executable = `${root}/releases/release-new/konteks-connector`;
  const logFile = `${root}/logs/connector.log`;

  it("reloads a launch agent with bootout and bootstrap from its own session, paths as arguments", () => {
    const service = nativeServiceDefinition({ os: 'macos', home: '/Users/Test User', root, executable, uid: 501 });
    expect(service.inspect).toEqual({ command: 'launchctl', args: ['print', `gui/501/${service.label}`] });
    expect(service.expected).toEqual({ program: executable, logFile });
    expect(service.reload?.kind).toBe('detached');
    if (service.reload?.kind !== 'detached') return;
    expect(service.reload.logFile).toBe(logFile);
    const [flag, script, name, ...args] = service.reload.command.args;
    expect(service.reload.command.command).toBe('/bin/sh');
    expect([flag, name]).toEqual(['-c', 'konteks-reload']);
    expect(args).toEqual([`gui/501/${service.label}`, 'gui/501', service.path]);
    expect(script).toContain('launchctl bootout "$1"');
    expect(script).toContain('launchctl bootstrap "$2" "$3"');
    expect(script).not.toContain('kickstart');
    expect(script).not.toContain(root);
  });

  it("reloads a systemd unit and queues its restart; a Windows task has no reload", () => {
    const linux = nativeServiceDefinition({ os: 'debian', home: '/home/a', root: '/home/a/remote', executable: '/home/a/remote/releases/r/konteks-connector' });
    expect(linux.inspect).toEqual({ command: 'systemctl', args: ['--user', 'show', `${linux.label}.service`, '-p', 'MainPID', '-p', 'NeedDaemonReload'] });
    expect(linux.reload).toEqual({ kind: 'inline', commands: [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', '--no-block', 'restart', `${linux.label}.service`] },
    ] });
    const windows = nativeServiceDefinition({ os: 'windows', home: 'C:\\Users\\a', root: 'C:\\Users\\a\\remote', executable: 'C:\\Users\\a\\remote\\konteks-connector.exe', userId: 'S-1-5-21-1-2-3-1001' });
    expect(windows.reload).toBeUndefined();
  });

  it("tells a launch agent loaded without the log file from one that logs", () => {
    const print = (lines: string[]) => [`gui/501/dev.konteks.remote.e2e6327af4de = {`, '\tstate = running', `\tprogram = ${executable}`, '\targuments = {', `\t\t${executable}`, '\t}', ...lines, '\truns = 1', '\tpid = 34625', '}'].join('\n');
    const expected = { program: executable, logFile };
    // The person's connector after the 0.10.2 update: stdout and stderr on /dev/null.
    expect(parseLoadedService('macos', print([]), expected)).toEqual({ pid: 34625, current: false });
    expect(parseLoadedService('macos', print([`\tstdout path = ${logFile}`, `\tstderr path = ${logFile}`]), expected)).toEqual({ pid: 34625, current: true });
    expect(parseLoadedService('macos', print([`\tstdout path = ${logFile}`, `\tstderr path = ${logFile}`]), { ...expected, program: `${root}/releases/release-old/konteks-connector` })).toEqual({ pid: 34625, current: false });
    expect(parseLoadedService('macos', 'Bad request.\nCould not find service "x" in domain for user gui: 501', expected)).toBeNull();
  });

  it("reads systemd's main pid and whether the unit file changed since it was loaded", () => {
    const expected = { program: '/x', logFile: null };
    expect(parseLoadedService('debian', 'MainPID=812\nNeedDaemonReload=no\n', expected)).toEqual({ pid: 812, current: true });
    expect(parseLoadedService('debian', 'MainPID=0\nNeedDaemonReload=yes\n', expected)).toEqual({ pid: null, current: false });
    expect(parseLoadedService('windows', 'anything', expected)).toBeNull();
  });
});
