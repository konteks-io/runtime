import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeServiceDefinition } from "../native/service.js";

const roots: Array<{ path: string; removable: boolean }> = [];
afterEach(async () => { for (const root of roots.splice(0)) if (root.removable) await rm(root.path, { recursive: true, force: true }); });
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function compileWriter(root: string): Promise<string> {
  const executable = join(root, "bin", "konteks-connector.exe");
  await mkdir(join(root, "bin"));
  const program = `using System; using System.IO; using System.Threading;
public class Probe { public static void Main(string[] args) {
  string root=args[args.Length-1]; string line=new string('X',4096);
  for(int i=0;i<8192;i++){Console.Out.WriteLine(line);}
  Console.Error.WriteLine("runtime-log-end"); Console.Out.Flush(); Console.Error.Flush();
  File.WriteAllText(Path.Combine(root,"probe-ready"),"ready");
  while(!File.Exists(Path.Combine(root,"probe-finish"))){
    if(File.Exists(Path.Combine(root,"probe-more"))){for(int j=0;j<16;j++){Console.Out.WriteLine(line);} Console.Out.Flush(); Console.Error.WriteLine("runtime-log-resumed"); Console.Error.Flush();}
    Thread.Sleep(100);
  }
} }`;
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${quote(program)} -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  return executable;
}

async function ready(root: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (await stat(join(root, "probe-ready")).catch(() => null)) return;
    await delay(50);
  }
  throw new Error("The disposable Windows log writer did not become ready");
}

function exitWithin(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 10_000);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

async function output(root: string, marker: string): Promise<Buffer> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const bytes = await readFile(join(root, "logs", "connector.log"));
    if (bytes.includes(Buffer.from(marker))) return bytes;
    await delay(50);
  }
  throw new Error("The running Windows host did not retain the expected output");
}

describe.runIf(process.platform === "win32")("live Windows background log retention", () => {
  it.each([false, true])("bounds running logs and preserves linked archives: archive linked=%s", async linked => {
    const root = { path: await mkdtemp(join(tmpdir(), "runtime logs ")), removable: true }; roots.push(root);
    const executable = await compileWriter(root.path);
    await mkdir(join(root.path, "logs"));
    const personal = join(root.path, "person-owned-data");
    await writeFile(personal, "keep personal data");
    if (linked) await link(personal, join(root.path, "logs", "connector.log.1"));
    const definition = nativeServiceDefinition({ os: "windows", home: join(root.path, "home"), root: root.path, executable, userId: "S-1-5-21-1-2-3-1001" });
    const command = definition.supportFiles![0]!.contents.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
    expect(command).toBeDefined();
    // Run the actual generated host only: no Startup shortcut or installed service.
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command!], { stdio: "ignore", windowsHide: true });
    root.removable = false;
    try {
      await ready(root.path, child);
      expect(child.exitCode).toBeNull();
      const file = join(root.path, "logs", "connector.log");
      if (linked) {
        expect((await stat(file)).size).toBeLessThanOrEqual(20 * 1024 * 1024);
        expect(await readFile(personal, "utf8")).toBe("keep personal data");
        await unlink(`${file}.1`);
        await writeFile(join(root.path, "probe-more"), "more");
      }
      const current = await output(root.path, linked ? "runtime-log-resumed" : "runtime-log-end");
      const previous = await readFile(`${file}.1`);
      expect(current.length).toBeLessThanOrEqual(20 * 1024 * 1024);
      expect(previous.length).toBeLessThanOrEqual(20 * 1024 * 1024);
      if (linked) expect(current.includes(Buffer.from("droppedBytes")) || previous.includes(Buffer.from("droppedBytes"))).toBe(true);
      expect(await readFile(personal, "utf8")).toBe("keep personal data");
      expect(current.includes(0)).toBe(false); expect(previous.includes(0)).toBe(false);
    } finally {
      await mkdir(join(root.path, "supervisor"), { recursive: true });
      await writeFile(join(root.path, "supervisor", "background-stop"), "stop");
      await writeFile(join(root.path, "probe-finish"), "finish");
      const code = await exitWithin(child);
      root.removable = code === 0;
      expect(code, "preserve an unconfirmed probe host and its files").toBe(0);
    }
  }, 90_000);
});
