import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { nativeServiceDefinition } from "../native/service.js";

describe("Windows login background process", () => {
  const root = "C:\\Users\\Ada\\AppData\\Local\\konteks-remote";
  const definition = () => nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Ada", root, executable: `${root}\\releases\\next\\konteks-connector.exe`, userId: "S-1-5-21-1-2-3-1001" });

  it("installs user login startup rather than registering a scheduled task", () => {
    const service = definition();
    expect(service.path).toBe(`${root}\\service.json`);
    expect(service.contents).not.toContain("<Task");
    expect(service.install.map(command => command.args.join(" ")).join("\n")).not.toContain("/Create");
  });

  it("has an explicit stop action even while its watchdog is between connector runs", () => {
    expect(definition()).toHaveProperty("windowsBackground", true);
    expect(definition()).toHaveProperty("legacyPath", `${root}\\service.xml`);
  });
});

describe.runIf(process.platform === "win32")("legacy Windows helper migration", () => {
  const root = "C:\\Users\\Ada\\AppData\\Local\\konteks-remote";
  const sid = "S-1-5-21-1-2-3-1001";
  const program = win32.join(process.env.SystemRoot!, "System32", "wscript.exe");
  const argumentsFor = (root: string, quoted: boolean) => `//B //NoLogo //E:JScript ${quoted ? '"' : ""}${root}\\service.js${quoted ? '"' : ""}`;
  const cases = [
    { name: "historically generated unquoted helper", root, args: argumentsFor(root, false), accepted: true },
    { name: "quoted helper", root, args: argumentsFor(root, true), accepted: true },
    { name: "quoted helper under a root with spaces", root: `${root} space`, args: argumentsFor(`${root} space`, true), accepted: true },
    { name: "unquoted helper under a root with spaces", root: `${root} space`, args: argumentsFor(`${root} space`, false), accepted: false },
    { name: "appended argument", root, args: `${argumentsFor(root, false)} --other`, accepted: false },
    { name: "another helper", root, args: argumentsFor(`${root}-backup`, false), accepted: false },
    { name: "helper filename suffix", root, args: `${argumentsFor(root, false)}.backup`, accepted: false },
    { name: "another executable", root, args: argumentsFor(root, false), executable: "C:\\Windows\\System32\\cmd.exe", accepted: false },
    { name: "another user", root, args: argumentsFor(root, true), userId: "S-1-5-21-9-8-7-1001", accepted: false },
    { name: "multiple actions", root, args: argumentsFor(root, true), duplicate: true, accepted: false },
  ];

  it.each(cases)("checks $name against the actual generated migration predicate", testCase => {
    const service = nativeServiceDefinition({ os: "windows", home: "C:\\Users\\Ada", root: testCase.root, executable: `${testCase.root}\\releases\\next\\konteks-connector.exe`, userId: sid });
    const context = Buffer.from(service.status.args.at(-1)!, "base64").toString("utf16le");
    // Replace only metadata presence and Task Scheduler I/O. The generated
    // principal/action validation itself runs unchanged, without real tasks.
    const presence = "if (-not [IO.File]::Exists((Join-Path $root 'service.xml'))) { return $null }";
    expect(context).toContain(presence);
    const action = { Execute: testCase.executable ?? program, Arguments: testCase.args };
    const task = JSON.stringify({ Principal: { UserId: testCase.userId ?? sid }, Actions: testCase.duplicate ? [action, action] : [action] });
    const script = `$fixtureTask = '${task.replace(/'/g, "''")}' | ConvertFrom-Json\nfunction Get-ScheduledTask { $fixtureTask }\n${context.replace(presence, "").replace("if (HostRunning) { exit 0 }; exit 1", "[void](LegacyTask); [Console]::WriteLine('accepted')")}`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(testCase.accepted ? 0 : 1);
    if (testCase.accepted) expect(result.stdout.trim()).toBe("accepted");
    else expect(result.stderr).toMatch(/legacy Konteks task belongs|unexpected action|does not launch this Konteks root/);
  });
});
