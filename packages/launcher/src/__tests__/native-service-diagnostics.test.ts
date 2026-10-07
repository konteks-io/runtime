import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeServiceFailure, encodeServiceDefinition, nativeServiceDefinition, NativeServiceCommandError, startNativeServiceDefinition, type NativeServiceCommand } from "../native/service.js";
import { keepServiceOnOwnDefinition, type OwnServiceDefinitionDeps } from "../native/commands.js";
import { createNativeProgram, type NativeCliActions } from "../native/cli.js";
import { isVerbose, setVerbose, verbose, verboseCommand } from "../verbose.js";
import { localServiceReport, readServiceStartFailure, recordServiceStartFailure, clearServiceStartFailure } from "../native/service-report.js";

/** A definition file's text: UTF-16LE after its byte-order mark, UTF-8 otherwise. */
function decodeServiceDefinition(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  return buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString("utf16le") : buffer.toString("utf8");
}

const windowsRoot = "C:\\Users\\Test User\\AppData\\Local\\konteks-remote";
const windows = () => nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Test User", root: windowsRoot, executable: `${windowsRoot}\\releases\\r1\\konteks-connector.exe`, userId: "S-1-5-21-1-2-3-1001" });

describe("a service command that fails says which, how and what it printed", () => {
  it("carries the failing command, its exit code and a bounded excerpt of its output", async () => {
    const service = windows();
    const failing = async (command: NativeServiceCommand) => command === service.status ? 1 : command === service.install[0]
      ? { code: 1, stdout: "", stderr: `ERROR: Access is denied.\r\n${"x".repeat(5_000)}` } : 0;
    const error = await startNativeServiceDefinition(service, { execute: failing, write: async () => undefined }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeServiceCommandError);
    const failure = error as NativeServiceCommandError;
    expect(failure.step).toBe("register");
    expect(failure.command).toEqual(service.install[0]);
    expect(failure.run.code).toBe(1);
    expect(failure.message).toContain("powershell.exe exited 1: ERROR: Access is denied.");
    expect(failure.excerpt.length).toBeLessThanOrEqual(300);
    // A plain sentence and one next step the person can take.
    const described = describeServiceFailure("windows", failure);
    expect(described).toMatch(/^Windows refused to create the Konteks task \(powershell\.exe exited 1: ERROR: Access is denied\./);
    expect(described).toMatch(/administrator PowerShell/);
  });

  it("says a command that could not run at all, and one that timed out, in words", async () => {
    const service = windows();
    const missing = await startNativeServiceDefinition(service, {
      execute: async command => command === service.status ? 1 : { code: null, error: "spawn powershell.exe ENOENT" },
      write: async () => undefined,
    }).catch((caught: unknown) => caught as NativeServiceCommandError);
    expect(missing.message).toContain("powershell.exe could not be run: spawn powershell.exe ENOENT");
    const slow = await startNativeServiceDefinition(service, {
      execute: async command => command === service.status ? 1 : command === service.start ? { code: null, timedOut: true } : 0,
      write: async () => undefined,
    }).catch((caught: unknown) => caught as NativeServiceCommandError);
    expect(slow.step).toBe("start");
    expect(describeServiceFailure("windows", slow)).toMatch(/^Windows did not run the Konteks task \(powershell\.exe did not finish in time\)/);
  });

  it("keeps a failed write's own reason and names the file", async () => {
    const service = windows();
    const error = await startNativeServiceDefinition(service, {
      execute: async () => 1,
      write: async () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); },
    }).catch((caught: unknown) => caught as NativeServiceCommandError);
    expect(error.step).toBe("write");
    expect(describeServiceFailure("windows", error)).toContain(windows().supportFiles![0]!.path);
    expect(describeServiceFailure("windows", error)).toContain("EPERM: operation not permitted");
  });

  it("names a task definition Windows rejects as one for Konteks support", () => {
    const service = windows();
    const error = new NativeServiceCommandError("register", service.install[0]!, { code: 1, stderr: "ERROR: The task XML contains a value which is incorrectly formatted or out of range.\r\n(8,4):Count:999" });
    expect(describeServiceFailure("windows", error)).toMatch(/konteks-remote support/);
  });
});

describe("the Windows background host keeps a connector log, like launchd's", () => {
  const script = (service: ReturnType<typeof windows>) => {
    const encoded = service.supportFiles![0]!.contents.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1]!;
    return Buffer.from(encoded, "base64").toString("utf16le");
  };

  it("appends the connector's stdout and stderr to <root>\\logs\\connector.log through cmd, paths only through the environment", () => {
    const root = "C:\\Users\\Test User\\literal %PATH% & O'Brien\\remote";
    const executable = `${root}\\releases\\next\\konteks-connector.exe`;
    const service = nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Test User", root, executable, userId: "S-1-5-21-1-2-3-1001" });
    const text = script(service);
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
    expect(text).toContain("$log = Join-Path $root 'logs\\connector.log'");
    expect(text).toContain(`$env:KONTEKS_SERVICE_PROGRAM = ${literal(executable)}`);
    expect(text).toContain(`$env:KONTEKS_SERVICE_ROOT = ${literal(root)}`);
    // cmd expands each variable once and never re-reads its value, so a path's
    // own percent signs, ampersands and apostrophes stay literal.
    expect(text).toContain(`'/d /v:off /s /c ""%KONTEKS_SERVICE_PROGRAM%" serve --root "%KONTEKS_SERVICE_ROOT%" >> "%KONTEKS_SERVICE_LOG%" 2>&1"'`);
    expect(text).not.toContain(`& '${executable}'`);
    expect(text).toContain("if ($child.ExitCode -eq 0) { break }");
    // A start that fails before the connector runs is written to the log too.
    expect(text).toMatch(/catch \{[\s\S]*AppendAllText\(\$log/);
    // The `${name}:` rule: a variable followed by a colon inside double quotes breaks the script.
    expect(text).not.toMatch(/"[^"\n]*\$[A-Za-z_]+:[^"\n]*"/);
  });

  it("keeps the log small at start, where the scheduler's appending handle is not yet open", () => {
    const text = script(windows());
    expect(text).toContain("20971520");
    expect(text).toContain("[IO.File]::Move($log, $log + '.1')");
  });

  it("caps crash backoff without periodically launching a scheduled task", () => {
    expect(script(windows())).toContain("[Math]::Min(60, $delay * 2)");
  });

  it("doubles a root's trailing backslashes so the connector reads the closing quote", () => {
    const service = nativeServiceDefinition({ os: "windows", home: "C:\\Users\\a", root: "C:\\Users\\a\\remote\\", executable: "C:\\Users\\a\\remote\\konteks-connector.exe", userId: "S-1-5-21-1-2-3-1001" });
    expect(script(service)).toContain("$env:KONTEKS_SERVICE_ROOT = 'C:\\Users\\a\\remote\\\\'");
  });
});

describe("--verbose and KONTEKS_REMOTE_VERBOSE=1", () => {
  afterEach(() => setVerbose(false));

  it("prints each service command, its exit code and output to stderr only when asked", () => {
    const err = new PassThrough();
    let written = "";
    err.on("data", chunk => { written += String(chunk); });
    verboseCommand({ command: "schtasks.exe", args: ["/Run", "/TN", "dev.konteks.remote.abc"] }, { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }, 12, err);
    expect(written).toBe("");
    setVerbose(true);
    verboseCommand({ command: "schtasks.exe", args: ["/Run", "/TN", "dev.konteks.remote.abc"] }, { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }, 12, err);
    verbose("service state: stopped", err);
    expect(written).toContain("[verbose] schtasks.exe /Run /TN dev.konteks.remote.abc");
    expect(written).toContain("exited 1 after 12 ms");
    expect(written).toContain("stderr: ERROR: The system cannot find the file specified.");
    expect(written).toContain("[verbose] service state: stopped");
  });

  it("never prints a secret a command echoed", () => {
    const err = new PassThrough();
    let written = "";
    err.on("data", chunk => { written += String(chunk); });
    setVerbose(true);
    verboseCommand({ command: "tool", args: [] }, { code: 0, stdout: "key sk-ant-abcdefghijklmnop", stderr: "" }, 1, err);
    expect(written).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("is a global option, and the environment turns it on as well", async () => {
    const seen: boolean[] = [];
    const actions = { start: async () => { seen.push(isVerbose()); } } as unknown as NativeCliActions;
    await createNativeProgram(actions).parseAsync(["node", "konteks-remote", "--verbose", "start"]);
    setVerbose(false);
    await createNativeProgram(actions).parseAsync(["node", "konteks-remote", "start"]);
    const before = process.env.KONTEKS_REMOTE_VERBOSE;
    process.env.KONTEKS_REMOTE_VERBOSE = "1";
    try { await createNativeProgram(actions).parseAsync(["node", "konteks-remote", "start"]); }
    finally { if (before === undefined) delete process.env.KONTEKS_REMOTE_VERBOSE; else process.env.KONTEKS_REMOTE_VERBOSE = before; }
    expect(seen).toEqual([true, false, true]);
  });
});

describe("doctor and support say the last failed start when the connector is not running", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it("records the failure, reports it with the log's last lines, and forgets it after a start that works", async () => {
    const root = await mkdtemp(join(tmpdir(), "service-report-")); dirs.push(root);
    await recordServiceStartFailure(root, { at: "2026-10-02T10:00:00.000Z", message: "Windows refused to create the Konteks task (powershell.exe exited 1: ERROR: Access is denied.)." });
    expect(await readServiceStartFailure(root)).toMatchObject({ at: "2026-10-02T10:00:00.000Z" });
    await mkdir(join(root, "logs"), { recursive: true });
    await writeFile(join(root, "logs", "connector.log"), `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\nsecret sk-ant-abcdefghijklmnop\n`);
    const report = await localServiceReport(root, { tailLines: 5 });
    expect(report.lines[0]).toBe("Konteks is not running on this computer, so only these local checks ran.");
    expect(report.lines).toContain("Last start (2026-10-02T10:00:00.000Z): Windows refused to create the Konteks task (powershell.exe exited 1: ERROR: Access is denied.).");
    expect(report.lines).toContain(`Connector log: ${join(root, "logs", "connector.log")}`);
    expect(report.value.logTail).toHaveLength(5);
    expect(report.value.logTail.at(-2)).toBe("line 29");
    expect(JSON.stringify(report)).not.toContain("sk-ant-abcdefghijklmnop");
    await clearServiceStartFailure(root);
    expect(await readServiceStartFailure(root)).toBeNull();
    const clean = await localServiceReport(root, { tailLines: 5 });
    expect(clean.lines.some(line => line.startsWith("Last start"))).toBe(false);
  });

  it("says plainly when there is no log yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "service-report-")); dirs.push(root);
    const report = await localServiceReport(root, { tailLines: 5 });
    expect(report.lines).toContain(`Connector log: ${join(root, "logs", "connector.log")} (not written yet)`);
    expect(await readFile(join(root, "logs", "connector.log"), "utf8").catch(() => null)).toBeNull();
  });
});

describe("the Windows startup manifest is UTF-8 and repairs an outdated definition", () => {
  /** What 0.10.9 and older wrote (their renderer and a plain UTF-8 write): schtasks says "unable to switch the encoding". */
  const utf8Task = (_definition: ReturnType<typeof windows>) => Buffer.from("<Task/>", "utf8");

  function serveDeps(definition: ReturnType<typeof windows>, onDisk: Uint8Array | null, registered = true) {
    const files = new Map<string, Uint8Array>();
    if (onDisk) files.set(definition.path, onDisk);
    for (const file of definition.supportFiles ?? []) files.set(file.path, Buffer.from(file.contents, "utf8"));
    const create = vi.fn(async () => 0 as number | { code: number; stderr: string });
    const value: OwnServiceDefinitionDeps = {
      definition: async () => definition,
      read: async path => { const bytes = files.get(path); if (!bytes) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return bytes; },
      write: async (path, contents) => { files.set(path, typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents)); },
      os: "windows", pid: 4242,
      inspect: async () => null,
      execute: async command => command === definition.registered ? (registered ? 0 : 1) : create(),
      detach: async () => undefined,
      lastReload: async () => null, recordReload: async () => undefined, now: () => 0, log: () => undefined,
    };
    return { files, create, value };
  }

  it("encodes and decodes the task file one way for start and serve alike", () => {
    const definition = windows();
    const bytes = encodeServiceDefinition(definition);
    expect(JSON.parse(bytes.toString("utf8")).kind).toBe("windows-login-background");
    expect(decodeServiceDefinition(bytes)).toBe(definition.contents);
    expect(decodeServiceDefinition(utf8Task(definition))).toBe("<Task/>");
  });

  it("start writes the task file serve compares against", async () => {
    const definition = windows();
    const writes = new Map<string, Uint8Array | string>();
    await startNativeServiceDefinition(definition, { execute: async command => command === definition.status ? 1 : 0, write: async (path, contents) => { writes.set(path, contents); } });
    expect(Buffer.from(writes.get(definition.path) as Uint8Array).equals(encodeServiceDefinition(definition))).toBe(true);
  });

  it("serve rewrites an outdated manifest and refreshes the shortcut", async () => {
    const definition = windows();
    const { files, create, value } = serveDeps(definition, utf8Task(definition));
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("next_start");
    expect(Buffer.from(files.get(definition.path)!).equals(encodeServiceDefinition(definition))).toBe(true);
    expect(create).toHaveBeenCalledTimes(definition.install.length);
    // Once healed, a second serve finds it current and registers nothing.
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("current");
    expect(create).toHaveBeenCalledTimes(definition.install.length);
  });

  it("a registration Windows refuses puts back the exact bytes it found, never a re-encoded copy, and says why", async () => {
    const definition = windows();
    const original = utf8Task(definition);
    const { files, create, value } = serveDeps(definition, original);
    create.mockResolvedValueOnce({ code: 1, stderr: "ERROR: The task XML is malformed. (1,40)::ERROR: unable to switch the encoding" });
    const error = await keepServiceOnOwnDefinition("root", value).catch((caught: unknown) => caught as NativeServiceCommandError);
    expect(error).toBeInstanceOf(NativeServiceCommandError);
    expect(error.message).toContain("unable to switch the encoding");
    expect(Buffer.from(files.get(definition.path)!).equals(original)).toBe(true);
    // The next serve tries again, and heals it.
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("next_start");
    expect(Buffer.from(files.get(definition.path)!).equals(encodeServiceDefinition(definition))).toBe(true);
  });

  it("creates a task that is missing although its file is current (a start whose registration failed)", async () => {
    const definition = windows();
    const { create, value } = serveDeps(definition, encodeServiceDefinition(definition), false);
    expect(await keepServiceOnOwnDefinition("root", value)).toBe("next_start");
    expect(create).toHaveBeenCalledTimes(definition.install.length);
  });

  it("asks Windows whether the task exists, whatever its state", () => {
    const definition = windows();
    expect(definition.registered?.command).toBe("powershell.exe");
    expect(Buffer.from(definition.registered!.args.at(-1)!, "base64").toString("utf16le")).toContain("if (StartupCurrent)");
  });
});

/**
 * Only a real Windows can prove these; CI's windows-native job runs them.
 * Shortcuts are isolated under a disposable home directory.
 */
describe.runIf(process.platform === "win32")("on a real Windows", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  const hostScript = (service: ReturnType<typeof windows>) => Buffer.from(service.supportFiles![0]!.contents.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1]!, "base64").toString("utf16le");

  it("Windows PowerShell parses the hidden host script", () => {
    const service = windows();
    const check = "$errors = $null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors) | Out-Null; if ($errors) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { input: hostScript(service), encoding: "utf8", timeout: 15_000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 20_000);

  it("runs the connector with a path full of cmd and PowerShell metacharacters, appends its output to the log and stops after clean exit", async () => {
    const base = await mkdtemp(join(tmpdir(), "konteks host %PATH% & O'Brien ")); dirs.push(base);
    // A batch file stands in for the connector: it says the arguments it got, on stdout and stderr, and exits cleanly.
    const executable = join(base, "connector.cmd");
    await writeFile(executable, "@echo args: %*\r\n@echo to stderr 1>&2\r\n@exit /b 0\r\n");
    const service = nativeServiceDefinition({ os: "windows", home: base, root: base, executable, userId: "S-1-5-21-1-2-3-1001" });
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(hostScript(service), "utf16le").toString("base64")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    const log = await readFile(join(base, "logs", "connector.log"), "utf8");
    expect(log).toContain(`args: serve --root "${base}"`);
    expect(log).toContain("to stderr");
  });

  it("restarts two crashes and then stops on a clean connector exit", async () => {
    const base = await mkdtemp(join(tmpdir(), "konteks-crash-")); dirs.push(base);
    const executable = join(base, "connector.cmd");
    await writeFile(executable, [
      "@echo off", "set run=0", 'if exist "%~dp0runs.txt" set /p run=<"%~dp0runs.txt"',
      "set /a run+=1", 'echo %run%>"%~dp0runs.txt"', "echo launch=%run%",
      "if %run% LSS 3 exit /b 7", "exit /b 0", "",
    ].join("\r\n"));
    const service = nativeServiceDefinition({ os: "windows", home: base, root: base, executable, userId: "S-1-5-21-1-2-3-1001" });
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(hostScript(service), "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    expect(result.status).toBe(0);
    expect((await readFile(join(base, "runs.txt"), "utf8")).trim()).toBe("3");
    expect(await readFile(join(base, "logs", "connector.log"), "utf8")).toMatch(/launch=1[\s\S]*launch=2[\s\S]*launch=3/);
  }, 35_000);

  it("migrates only its own legacy task and preserves literal root paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "konteks migration %PATH% & O'Brien ")); dirs.push(base);
    const userId = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).stdout.match(/S-1-\d+(?:-\d+)+/)![0];
    const executable = join(base, "releases", "old", "konteks-connector.exe");
    await mkdir(join(base, "releases", "old"), { recursive: true });
    await writeFile(executable, ""); await writeFile(join(base, "service.xml"), "<Task/>");
    const service = nativeServiceDefinition({ os: "windows", home: base, root: base, executable, userId });
    const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const script = (value: string) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(value, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
    const run = (command: NativeServiceCommand) => spawnSync(command.command, command.args, { encoding: "utf8", windowsHide: true });
    const register = (program: string, args: string) => script(`$ErrorActionPreference='Stop'; $a=New-ScheduledTaskAction -Execute ${literal(program)} -Argument ${literal(args)}; $p=New-ScheduledTaskPrincipal -UserId ${literal(userId)} -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName '${service.label}' -Action $a -Principal $p -Force | Out-Null`);
    const query = () => script(`if (Get-ScheduledTask -TaskName '${service.label}' -ErrorAction SilentlyContinue) { exit 0 }; exit 1`);
    try {
      expect(register("C:\\Windows\\System32\\cmd.exe", "/c exit 0").status).toBe(0);
      expect(run(service.install[0]!).status).toBe(1);
      expect(query().status).toBe(0);
      expect(register(executable, `serve --root "${base}"`).status).toBe(0);
      expect(run(service.install[0]!).status).toBe(0);
      expect(query().status).toBe(1);
      expect(run(service.registered!).status).toBe(0);
      await expect(readFile(join(base, "service.xml"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      script(`Unregister-ScheduledTask -TaskName '${service.label}' -Confirm:$false -ErrorAction SilentlyContinue`);
      expect(run(service.remove[0]!).status).toBe(0);
    }
  }, 45_000);

  it("registers and removes a login shortcut under its own home", async () => {
    const base = await mkdtemp(join(tmpdir(), "konteks-startup-")); dirs.push(base);
    const service = nativeServiceDefinition({ os: "windows", home: base, root: base, executable: process.execPath, userId: "S-1-5-21-1-2-3-1001" });
    const run = (command: NativeServiceCommand) => spawnSync(command.command, command.args, { encoding: "utf8", windowsHide: true });
    try {
      expect(run(service.registered!).status).toBe(1);
      expect(run(service.install[0]!).status).toBe(0);
      expect(run(service.registered!).status).toBe(0);
    } finally {
      expect(run(service.remove[0]!).status).toBe(0);
    }
    expect(run(service.registered!).status).toBe(1);
  });
});
