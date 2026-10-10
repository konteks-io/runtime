import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { commandHintText, resolveCliCommand, shellWord } from "../cli-command.js";
import { createOutput } from "../output.js";
import { AGAIN, runnableStep, type OnboardStep } from "../native/onboard-session.js";

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buffer = "";
  stream.on("data", (chunk: Buffer) => (buffer += chunk.toString("utf8")));
  return { stream, text: () => buffer };
}

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("resolveCliCommand", () => {
  let home: string;
  let bin: string;
  let self: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-command-"));
    bin = join(home, "Library", "Application Support", "konteks-remote", "bin");
    self = executable(join(bin, "konteks-remote"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const packaged = (path: string) => ({ platform: "darwin" as const, execPath: self, argv1: self, path });

  it("keeps the short name when the konteks-remote on PATH is this executable", () => {
    expect(resolveCliCommand(packaged(`/usr/bin:${bin}`))).toBe("konteks-remote");
  });

  it("keeps the short name when PATH reaches this executable through a link", () => {
    mkdirSync(join(home, "links"));
    symlinkSync(self, join(home, "links", "konteks-remote"));
    expect(resolveCliCommand(packaged(join(home, "links")))).toBe("konteks-remote");
  });

  it("names the quoted full path when no konteks-remote is on PATH", () => {
    expect(resolveCliCommand(packaged("/usr/bin:/bin"))).toBe(`"${self}"`);
    expect(resolveCliCommand(packaged(""))).toBe(`"${self}"`);
  });

  it("names the full path when PATH finds a different konteks-remote first", () => {
    const other = join(home, "old", "bin");
    executable(join(other, "konteks-remote"));
    expect(resolveCliCommand(packaged(`${other}:${bin}`))).toBe(`"${self}"`);
  });

  it("skips a konteks-remote on PATH that cannot be run", () => {
    const other = join(home, "plain");
    mkdirSync(other);
    writeFileSync(join(other, "konteks-remote"), "");
    expect(resolveCliCommand(packaged(`${other}:${bin}`))).toBe("konteks-remote");
  });

  it("leaves Windows and source runs as they are", () => {
    expect(resolveCliCommand({ ...packaged("/usr/bin"), platform: "win32" })).toBe("konteks-remote");
    expect(resolveCliCommand({ ...packaged("/usr/bin"), execPath: "/usr/local/bin/node", argv1: join(home, "dist", "cli.js") })).toBe("konteks-remote");
  });
});

describe("commandHintText", () => {
  const full = shellWord("/Users/a/Library/Application Support/konteks-remote/bin/konteks-remote");

  it("quotes only a path that needs it", () => {
    expect(full).toBe('"/Users/a/Library/Application Support/konteks-remote/bin/konteks-remote"');
    expect(shellWord("/home/a/.local/share/konteks-remote/bin/konteks-remote")).toBe("/home/a/.local/share/konteks-remote/bin/konteks-remote");
    expect(shellWord('/a "b"/$x')).toBe('"/a \\"b\\"/\\$x"');
  });

  it("rewrites every hint, with or without backticks", () => {
    expect(commandHintText("To add DeepSeek Harness: konteks-remote agent add dsh", full)).toBe(`To add DeepSeek Harness: ${full} agent add dsh`);
    expect(commandHintText("run `konteks-remote doctor`, then `konteks-remote auth login codex`", full))
      .toBe(`run \`${full} doctor\`, then \`${full} auth login codex\``);
    expect(commandHintText("To see every step, run konteks-remote --verbose start.", full)).toBe(`To see every step, run ${full} --verbose start.`);
  });

  it("leaves the name alone where it is not a command", () => {
    for (const text of [
      "konteks-remote itself could not be refreshed to 1.2.3",
      "konteks-remote: could not start the installed release",
      "konteks-remote installed for this user at /x/bin/konteks-remote",
      "/x/bin/konteks-remote start",
      "konteks-remote-macos-arm64 start",
    ]) expect(commandHintText(text, full)).toBe(text);
  });

  it("does not resolve the command for text without a hint", () => {
    const resolve = () => { throw new Error("resolved"); };
    expect(commandHintText("Konteks is running.", resolve)).toBe("Konteks is running.");
  });
});

describe("createOutput names the command the way this computer runs it", () => {
  const command = '"/Users/a/Library/Application Support/konteks-remote/bin/konteks-remote"';

  it("rewrites lines, table values and errors a person reads", () => {
    const out = sink();
    const err = sink();
    const output = createOutput({ json: false, stdout: out.stream, stderr: err.stream, locale: "en", command });
    output.line("To add DeepSeek Harness: konteks-remote agent add dsh");
    output.table([["next", "konteks-remote status"]]);
    output.error(new RemoteInstanceError("agent_unavailable", "Codex is missing", { recoveryActions: [{ kind: "run_doctor" }] }));
    expect(out.text()).toContain(`To add DeepSeek Harness: ${command} agent add dsh\n`);
    expect(out.text()).toContain(`${command} status\n`);
    expect(err.text()).toContain(`→ run \`${command} doctor\``);
    expect(out.text() + err.text()).not.toMatch(/(?<!\/)konteks-remote (agent|status|doctor)/);
  });

  it("leaves --json output untouched", () => {
    const out = sink();
    const err = sink();
    const output = createOutput({ json: true, stdout: out.stream, stderr: err.stream, locale: "en", command });
    output.line("To add DeepSeek Harness: konteks-remote agent add dsh");
    output.result({ next: "konteks-remote agent add dsh" });
    output.error(new RemoteInstanceError("agent_unavailable", "run konteks-remote doctor", { recoveryActions: [{ kind: "run_doctor" }] }));
    expect(JSON.parse(out.text())).toEqual({ next: "konteks-remote agent add dsh" });
    expect(err.text()).toContain("run konteks-remote doctor");
    expect(out.text() + err.text()).not.toContain("Application Support");
  });
});

describe("onboarding steps name the command the way this computer runs it", () => {
  const executable = "/Users/a/Library/Application Support/konteks-remote/bin/konteks-remote";
  const command = shellWord(executable);

  it("rewrites the instructions the agent runs and keeps every structural field", () => {
    const step: OnboardStep = {
      step: "agents",
      note: "DeepSeek Harness is on this computer but not added yet: konteks-remote agent add dsh",
      ask: { question: "Run `konteks-remote doctor` first?", kind: "confirm", choices: ["yes", "no"] },
      run: AGAIN,
      done: {
        summary: "No coding agent was found on this machine; install one and run konteks-remote auth login.",
        links: { site: "https://konteks.example/s/konteks-remote" },
        remedies: ["DeepSeek Harness needs your DeepSeek API key: konteks-remote auth login dsh", "To keep the runtime available after logout: loginctl enable-linger $USER"],
      },
    };
    const shown = runnableStep(step, command, executable);
    expect(shown.step).toBe("agents");
    expect(shown.note).toBe(`DeepSeek Harness is on this computer but not added yet: ${command} agent add dsh`);
    expect(shown.ask).toEqual({ question: `Run \`${command} doctor\` first?`, kind: "confirm", choices: ["yes", "no"] });
    expect(shown.run).toEqual({ argv: [executable, "onboard", "--json"] });
    expect(shown.done?.summary).toBe(`No coding agent was found on this machine; install one and run ${command} auth login.`);
    expect(shown.done?.links).toEqual(step.done!.links);
    expect(shown.done?.remedies).toEqual([`DeepSeek Harness needs your DeepSeek API key: ${command} auth login dsh`, step.done!.remedies![1]]);
    expect(AGAIN.argv).toEqual(["konteks-remote", "onboard", "--json"]);
    expect(JSON.parse(JSON.stringify(shown))).toEqual(shown);
  });

  it("returns the step untouched where konteks-remote is on PATH", () => {
    const step: OnboardStep = { step: "start", note: "To start it: konteks-remote start", run: { argv: ["konteks-remote", "start"] } };
    expect(runnableStep(step, "konteks-remote", "konteks-remote")).toBe(step);
  });

  it("prints a step's JSON line without rewriting it again", () => {
    const out = sink();
    const shown = runnableStep({ step: "agents", note: "To add it: konteks-remote agent add dsh", run: AGAIN }, command, executable);
    const output = createOutput({ json: false, stdout: out.stream, locale: "en", command });
    output.line(JSON.stringify(shown, null, 2));
    expect(JSON.parse(out.text())).toEqual(shown);
    const raw = sink();
    createOutput({ json: false, stdout: raw.stream, locale: "en", command }).line(JSON.stringify({ note: "run konteks-remote doctor" }));
    expect(JSON.parse(raw.text())).toEqual({ note: "run konteks-remote doctor" });
  });
});
