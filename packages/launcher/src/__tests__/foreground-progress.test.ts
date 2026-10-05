import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutput } from "../output.js";
import { promptSecret } from "../prompt.js";
import { setupText, withSetupProgress } from "../setup-locale.js";
import { sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";

function sink(tty = false) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  }) as Writable & { isTTY: boolean };
  stream.isTTY = tty;
  return { stream, text: () => chunks.join("") };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("foreground setup presentation", () => {
  it.each(["en", "id"] as const)(
    "keeps the startup message truthful before health in %s",
    (locale) => {
      expect(setupText("serviceStarting", {}, locale)).not.toMatch(/ready for work|siap bekerja/i);
    },
  );
  it.each([
    ["en", "Runtime setup"],
    ["id", "Pemasangan runtime"],
  ] as const)("opens with Konteks identity in %s", (locale, title) => {
    const out = sink();
    createOutput({
      json: false,
      stdout: out.stream,
      stderr: sink().stream,
      locale,
      foreground: "install",
    });
    expect(out.text()).toBe(`\nKONTEKS\n${title}\n\n`);
  });

  it("keeps JSON and ordinary status output free of setup identity", () => {
    const out = sink(true);
    const json = createOutput({
      json: true,
      stdout: out.stream,
      stderr: sink().stream,
      foreground: "update",
    });
    json.result({ state: "updated", to: "0.12.1" });
    createOutput({ json: false, stdout: out.stream, stderr: sink().stream });
    expect(out.text()).toBe('{\n  "state": "updated",\n  "to": "0.12.1"\n}\n');
  });

  it("skips only an exact process-only branded marker and strips it from provider children", () => {
    const out = sink();
    vi.stubEnv("KONTEKS_SETUP_HEADER_SHOWN", "1");
    createOutput({ json: false, stdout: out.stream, foreground: "install" });
    expect(out.text()).toBe("");
    vi.stubEnv("KONTEKS_SETUP_HEADER_SHOWN", "true");
    createOutput({ json: false, stdout: out.stream, foreground: "install" });
    expect(out.text()).toContain("KONTEKS");
    expect(
      sanitizeInheritedChildProcessEnv({
        env: { KONTEKS_SETUP_HEADER_SHOWN: "1", KONTEKS_SETUP_LOCALE: "id", PATH: "fixture" },
      }),
    ).toEqual({ PATH: "fixture" });
  });

  it("cleans a replaced phase when its action refuses", async () => {
    vi.useFakeTimers();
    const out = sink(true);
    const output = createOutput({ json: false, stdout: out.stream, foreground: "install" });
    await expect(
      withSetupProgress(output, "phaseDownload", async () => {
        output.progress!("Unpacking Codex");
        throw new Error("fixture refusal");
      }),
    ).rejects.toThrow("fixture refusal");
    expect(vi.getTimerCount()).toBe(0);
    const before = out.text();
    vi.advanceTimersByTime(600);
    expect(out.text()).toBe(before);
  });

  it("cleans the original row when the CLI reports a failure through a fresh output", () => {
    vi.useFakeTimers();
    const out = sink(true),
      err = sink(true);
    const output = createOutput({
      json: false,
      stdout: out.stream,
      stderr: err.stream,
      foreground: "install",
    });
    output.progress!("Starting runtime");
    createOutput({ json: false, stdout: out.stream, stderr: err.stream }).error(
      new Error("fixture refusal"),
    );
    expect(vi.getTimerCount()).toBe(0);
    const before = out.text();
    vi.advanceTimersByTime(500);
    expect(out.text()).toBe(before);
    expect(err.text()).toContain("fixture refusal");
  });

  it("uses readable phase lines with no cursor frames for redirected output", () => {
    const out = sink();
    const output = createOutput({
      json: false,
      stdout: out.stream,
      stderr: sink().stream,
      foreground: "update",
    });
    expect(output.progress).toBeTypeOf("function");
    const stop = output.progress!("Downloading and verifying");
    stop();
    expect(out.text()).toContain("Downloading and verifying\n");
    expect(out.text()).not.toContain("\r");
    expect(out.text()).not.toContain("\u001b");
  });

  it("animates one transient TTY row and removes its timer when the phase finishes", () => {
    vi.useFakeTimers();
    const out = sink(true);
    const output = createOutput({
      json: false,
      stdout: out.stream,
      stderr: sink().stream,
      foreground: "update",
    });
    expect(output.progress).toBeTypeOf("function");
    const stop = output.progress!("Starting runtime");
    vi.advanceTimersByTime(600);
    expect(out.text()).toMatch(/\r[|/\\-] Starting runtime/);
    expect(out.text()).not.toMatch(/Ready/);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(out.text()).toMatch(/\r +\r$/);
  });

  it("pauses frames for hidden input and resumes after the prompt", async () => {
    vi.useFakeTimers();
    const out = sink(true),
      err = sink(true);
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    const output = createOutput({
      json: false,
      stdout: out.stream,
      stderr: err.stream,
      foreground: "install",
    });
    expect(output.progress).toBeTypeOf("function");
    const stop = output.progress!("Connecting this computer");
    const answer = promptSecret({ label: "One-time code", input, output: err.stream });
    const before = out.text();
    vi.advanceTimersByTime(600);
    expect(out.text()).toBe(before);
    input.write("fixture-answer-only\n");
    expect(await answer).toBe("fixture-answer-only");
    expect(err.text()).not.toContain("fixture-answer-only");
    vi.advanceTimersByTime(600);
    expect(out.text().length).toBeGreaterThan(before.length);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
