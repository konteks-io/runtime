import { describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWindowsServiceOwner, windowsServiceProcessQueryScript, windowsServiceTerminationScript, type WindowsServiceProcess } from "../native/windows-service-owner.js";

const root = "C:\\Users\\Test User\\literal %PATH% & O'Brien\\remote";
const executable = `${root}\\releases\\old\\konteks-connector.exe`;
const connector: WindowsServiceProcess = { pid: 42, parentPid: 41, startToken: "10000", executable,
  command: `"${executable}" serve --root "${root}"` };
const child: WindowsServiceProcess = { pid: 43, parentPid: 42, startToken: "20000", executable: "C:\\node.exe", command: "node agent.js" };

async function waitForFixtureChildPid(root: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await readFile(join(root, "child.pid"), "utf8").catch(() => null);
    if (value) return Number(value);
    if (Date.now() >= deadline) throw new Error("fixture child did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe("Windows connector service ownership", () => {
  it.skipIf(process.platform !== "win32")("retains a same-root connector that replaces another PID between the Windows snapshots", async () => {
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = [
      "$script:query=0",
      "function Get-Process { param([int]$Id) [pscustomobject]@{Path='C:\\ordinary.exe';StartTime=[datetime]'2026-01-01T00:00:00Z'} }",
      "function Get-CimInstance { param([string]$ClassName) $script:query++; if ($script:query -eq 1) { [pscustomobject]@{ProcessId=42;ParentProcessId=41;ExecutablePath='C:\\ordinary.exe';CommandLine='ordinary.exe';CreationDate=[datetime]'2026-01-01T00:00:00Z'} } else {",
      `[pscustomobject]@{ProcessId=42;ParentProcessId=41;ExecutablePath=${literal(executable)};CommandLine=${literal(connector.command)};CreationDate=[datetime]'2026-01-02T00:00:00Z'} } }`,
      windowsServiceProcessQueryScript(),
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    const processes = JSON.parse(result.stdout) as WindowsServiceProcess[];
    expect(processes).toEqual([{ ...connector, startToken: "" }]);
    await expect(captureWindowsServiceOwner(root, { read: async () => processes, terminate: vi.fn() })).rejects.toThrow(/creation identity/);
  });
  it("pins the kernel process handle before checking creation identity and terminating", () => {
    const script = windowsServiceTerminationScript([connector]);
    expect(script.indexOf("$handle=$process.Handle")).toBeLessThan(script.indexOf("$process.StartTime"));
    expect(script.indexOf("$handle=$process.Handle")).toBeLessThan(script.indexOf("$process.Kill()"));
    expect(script).toContain("finally { $process.Dispose() }");
    expect(script).not.toContain("taskkill");
  });
  it("captures the exact root's serve process and descendants while the task is Ready", async () => {
    let processes = [connector, child, { ...connector, pid: 45, executable: "C:\\other\\connector.exe" }];
    const terminate = vi.fn(async () => { processes = []; });
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate });
    expect(owner?.pid).toBe(42);
    expect(await owner?.alive()).toBe(true);
    await owner?.terminate();
    expect(terminate).toHaveBeenCalledWith([child, connector]);
    expect(await owner?.alive()).toBe(false);
  });

  it.each([
    { ...connector, command: `"${executable}" serve --root "${root}-other"` },
    { ...connector, command: `"${executable}" doctor --root "${root}"` },
    { ...connector, executable: `${root}\\releases\\old\\unrelated.exe` },
    { ...connector, executable: `${root}\\releases\\old\\nested\\connector.exe` },
    { ...connector, command: `"${executable}" serve --root "${root}" --extra` },
  ])("refuses a process whose executable or parsed argv does not belong to this service", async process => {
    expect(await captureWindowsServiceOwner(root, { read: async () => [process], terminate: vi.fn() })).toBeNull();
  });

  it("accepts the older connector file name and literal root paths", async () => {
    const old = `${root}\\releases\\old\\connector.exe`;
    const process = { ...connector, executable: old, command: `"${old}" serve --root "${root}"` };
    expect((await captureWindowsServiceOwner(root, { read: async () => [process], terminate: vi.fn() }))?.pid).toBe(42);
  });

  it("refuses reused PIDs before termination and preserves unrelated processes", async () => {
    let processes = [connector, child];
    const terminate = vi.fn();
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate });
    processes = [{ ...connector, startToken: "replacement" }, child];
    await expect(owner?.terminate()).rejects.toThrow(/identity changed/);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("keeps watching exact descendants after the connector disappears", async () => {
    let processes = [connector, child];
    const terminate = vi.fn(async () => { processes = []; });
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate });
    processes = [child];
    expect(await owner?.alive()).toBe(true);
    await owner?.terminate();
    expect(terminate).toHaveBeenCalledWith([child]);
  });
  it("does not adopt a surviving child of a former owner of the same parent PID", async () => {
    const unrelated = { ...child, pid: 44, startToken: "9000" };
    let processes = [connector, child, unrelated];
    const terminate = vi.fn(async () => { processes = [unrelated]; });
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate });
    await owner?.terminate();
    expect(terminate).toHaveBeenCalledWith([child, connector]);
  });
  it("refuses a live owned PID whose executable identity becomes unreadable", async () => {
    let processes = [connector];
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate: vi.fn() });
    processes = [{ ...connector, executable: "", startToken: "" }];
    await expect(owner?.alive()).rejects.toThrow(/identity changed/);
  });
  it("excludes the unattended updater's own branch while tracking new agent descendants", async () => {
    const updater = { ...child, pid: 99, startToken: "30000", command: "connector update" };
    const worker = { ...child, pid: 100, parentPid: 99, startToken: "40000" };
    const lateWorker = { ...worker, pid: 101, startToken: "50000" };
    const lateAgent = { ...child, pid: 44, parentPid: 43, startToken: "60000" };
    let processes = [connector, child, updater, worker];
    const terminate = vi.fn(async () => { processes = [updater, worker, lateWorker]; });
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate, excludePid: 99 });
    processes.push(lateWorker, lateAgent);
    await owner?.terminate();
    expect(terminate).toHaveBeenCalledWith([lateAgent, child, connector]);
    expect(await owner?.alive()).toBe(false);
  });
  it("does not exclude a connector's descendants when the command caller is its ancestor", async () => {
    const caller = { ...child, pid: 41, parentPid: 1, startToken: "9000" };
    let processes = [caller, connector, child];
    const terminate = vi.fn(async () => { processes = [caller]; });
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate, excludePid: 41 });
    await owner?.terminate();
    expect(terminate).toHaveBeenCalledWith([child, connector]);
  });
  it("refuses stop proof when a new undrained connector starts serving the same root", async () => {
    let processes = [connector, child];
    const terminate = vi.fn();
    const owner = await captureWindowsServiceOwner(root, { read: async () => processes, terminate });
    processes = [{ ...connector, pid: 44, startToken: "50000" }];
    await expect(owner?.alive()).rejects.toThrow(/Another connector/);
    await expect(owner?.terminate()).rejects.toThrow(/Another connector/);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("does not infer absence from a failed process query", async () => {
    let failed = false;
    const owner = await captureWindowsServiceOwner(root, { read: async () => { if (failed) throw new Error("query failed"); return [connector]; }, terminate: vi.fn() });
    failed = true;
    await expect(owner?.alive()).rejects.toThrow("query failed");
  });

  it.skipIf(process.platform !== "win32")("stops a real orphaned Windows connector tree without stopping a sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-service-owner-"));
    const directory = join(root, "releases", "fixture");
    await mkdir(directory, { recursive: true });
    const executable = join(directory, "konteks-connector.exe");
    await copyFile(process.execPath, executable);
    await writeFile(join(root, "serve"), `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'}); child.once('spawn',()=>writeFileSync('child.pid',String(child.pid))); setInterval(()=>{},1000);`);
    const leader = spawn(executable, ["serve", "--root", root], { cwd: root, windowsHide: true, stdio: "ignore" });
    const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
    let childPid: number | null = null;
    try {
      await Promise.all([leader, sibling].map(child => new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); })));
      childPid = await waitForFixtureChildPid(root);
      const owner = await captureWindowsServiceOwner(root);
      expect(owner?.pid).toBe(leader.pid);
      leader.kill("SIGKILL"); // Reproduce a lost task/host while a child survives.
      await new Promise<void>(resolve => leader.exitCode !== null ? resolve() : leader.once("exit", () => resolve()));
      expect(await owner?.alive()).toBe(true);
      await owner?.terminate();
      expect(await owner?.alive()).toBe(false);
      expect(() => process.kill(childPid!, 0)).toThrow();
      expect(() => process.kill(sibling.pid!, 0)).not.toThrow();
    } finally {
      leader.kill("SIGKILL");
      sibling.kill("SIGKILL");
      if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ } }
      await new Promise<void>(resolve => sibling.exitCode !== null ? resolve() : sibling.once("exit", () => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
