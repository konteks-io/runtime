import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteInstanceError, sanitizeInheritedChildProcessEnv } from "@konteks/remote-common";
import { createOutput } from "../output.js";
import { confirm, promptSecret } from "../prompt.js";
import { createNativeProgram, type NativeCliActions } from "../native/cli.js";
import { setUpPersonalAgent, type AgentSetupDeps } from "../native/agent-setup.js";
import { terminalFetchConsent } from "../native/consent.js";
import { launcherChildEnv } from "../native/launcher-delegate.js";
import { runNativeUpdate, type NativeUpdateTransactionDeps } from "../native/update-transaction.js";
import { describeServiceFailure, NativeServiceCommandError } from "../native/service.js";
import { hostAgentInstallAdapter } from "@konteks/remote-supervisor";

afterEach(() => vi.unstubAllEnvs());

function sink() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  return { stream, text: () => text };
}

function currentUpdate(output: ReturnType<typeof createOutput>) {
  const record = { bundleVersion: "0.12.2" };
  const deps = { readRecord: vi.fn(async () => record), stage: vi.fn(async () => ({ status: "current", current: record, bundleVersion: record.bundleVersion })) };
  return runNativeUpdate({ root: "unused-current-fixture", output }, deps as unknown as NativeUpdateTransactionDeps);
}

describe("foreground setup language", () => {
  it.each([undefined, "en"])("keeps the canonical English when locale is %s", async locale => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", locale);
    const out = sink();
    await currentUpdate(createOutput({ json: false, stdout: out.stream }));
    expect(out.text()).toBe("Installed release 0.12.2 is current; nothing was changed.\n");
  });

  it("keeps the process language captured for a foreground outcome", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const out = sink();
    const output = createOutput({ json: false, stdout: out.stream });
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "en");
    await currentUpdate(output);
    expect(out.text()).toBe("Rilis terpasang 0.12.2 sudah terbaru; tidak ada perubahan.\n");
  });

  it.each(["fr", "ID", "", "id;anything"])("refuses invalid locale %j before a CLI action", async locale => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", locale);
    const install = vi.fn(async () => {});
    const actions = { install } as unknown as NativeCliActions;
    await expect(Promise.resolve().then(() => createNativeProgram(actions).parseAsync(["install", "--activation-id", "activation-123"], { from: "user" }))).rejects.toThrow("KONTEKS_SETUP_LOCALE");
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses invalid locale before direct update reads or stages an installation", async () => {
    const output = createOutput({ json: false, stdout: sink().stream });
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "fr");
    const deps = { readRecord: vi.fn(async () => ({ bundleVersion: "0.12.2" })), stage: vi.fn() };
    await expect(runNativeUpdate({ root: "unused-invalid-fixture", output }, deps as unknown as NativeUpdateTransactionDeps)).rejects.toThrow("KONTEKS_SETUP_LOCALE");
    expect(deps.readRecord).not.toHaveBeenCalled();
    expect(deps.stage).not.toHaveBeenCalled();
  });

  it("asks Indonesian Git/agent questions and leaves official commands unchanged", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const questions: string[] = [], runs: Array<[string, readonly string[]]> = [];
    let installed = false, git = false;
    const deps: AgentSetupDeps = {
      interactive: () => true,
      ask: async question => { questions.push(question); return true; },
      run: async (command, args) => { runs.push([command, args]); if (command === "winget") git = true; else installed = true; return 0; },
      platform: "win32", found: async () => installed, codexHome: () => undefined, gitForWindows: () => git,
    };
    const out = sink();
    expect(await setUpPersonalAgent("claude-code", createOutput({ json: false, stdout: out.stream }), deps)).toBe(true);
    expect(questions[0]).toContain("Claude Code belum terpasang");
    expect(questions[0]).toContain("https://claude.ai/install.ps1");
    expect(questions[1]).toContain("Pasang terlebih dahulu dengan winget (Git.Git)?");
    expect(runs[0]).toEqual(["winget", ["install", "--id", "Git.Git", "-e", "--source", "winget"]]);
    expect(runs[1]?.[1].at(-1)).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(out.text()).toContain("Memasang Git for Windows dengan winget");
  });

  it.each(["darwin", "linux"] as const)("uses the same Indonesian offer on %s with its official shell installer", async platform => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const questions: string[] = [], runs: Array<[string, readonly string[]]> = [];
    let installed = false;
    const deps: AgentSetupDeps = {
      interactive: () => true, ask: async question => { questions.push(question); return true; },
      run: async (command, args) => { runs.push([command, args]); installed = true; return 0; },
      platform, found: async () => installed, codexHome: () => undefined, gitForWindows: () => true,
    };
    await setUpPersonalAgent("claude-code", createOutput({ json: false, stdout: sink().stream }), deps);
    expect(questions[0]).toContain("Claude Code belum terpasang");
    expect(runs).toEqual([["/bin/bash", ["-o", "pipefail", "-c", "curl -fsSL https://claude.ai/install.sh | bash"]]]);
  });

  it("offers shipped Codex in Indonesian and creates nothing when the person declines", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const ask = vi.fn(async (_question: string) => false), run = vi.fn(async () => null), home = vi.fn(() => undefined);
    const deps: AgentSetupDeps = { interactive: () => true, ask, run, platform: "linux", found: async () => false, codexHome: home, gitForWindows: () => true };
    expect(await setUpPersonalAgent("codex", createOutput({ json: false, stdout: sink().stream }), deps)).toBe(false);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Codex belum disiapkan"));
    expect(ask.mock.calls[0]?.[0]).toContain("tidak ada yang diunduh");
    expect(home).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps an Indonesian activation prompt hidden without echoing its value", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const input = new PassThrough(), out = sink();
    const pending = promptSecret({ label: "One-time code", labelKey: "oneTimeCode", input, output: out.stream, minLength: 8 });
    input.write("fixture-private-entry\n");
    expect(await pending).toBe("fixture-private-entry");
    expect(out.text()).toContain("Kode sekali pakai (input disembunyikan)");
    expect(out.text()).not.toContain("fixture-private-entry");
  });

  it("keeps a Konteks activation-prompt failure canonical in JSON and localized for the person", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const input = new PassThrough(), out = sink();
    const pending = promptSecret({ label: "One-time code", labelKey: "oneTimeCode", input, output: out.stream, minLength: 8 }).catch(error => error);
    input.write("x\n");
    const failure = await pending;
    expect(failure.message).toBe("One-time code has an unexpected length");
    const err = sink();
    createOutput({ json: false, stderr: err.stream }).error(failure);
    expect(err.text()).toContain("Panjang Kode sekali pakai tidak sesuai");
    const json = sink();
    createOutput({ json: true, stderr: json.stream }).error(failure);
    expect(JSON.parse(json.text())).toMatchObject({ error: { code: "activation_invalid", message: "One-time code has an unexpected length" } });
  });

  it.each(["", "tidak"])("never defaults an Indonesian confirmation %j to yes", async answer => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const input = new PassThrough(), out = sink();
    const pending = confirm("Pasang agen?", { input, output: out.stream });
    input.write(`${answer}\n`);
    expect(await pending).toBe(false);
    expect(out.text()).toContain("[y=ya/N=tidak]");
  });

  it("accepts an explicit Indonesian yes for a translated, complete download consent", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const input = new PassThrough(), out = sink();
    const question = hostAgentInstallAdapter("antigravity")!.consentText!;
    const consent = terminalFetchConsent({ input, output: out.stream, line: line => out.stream.write(line) });
    const pending = consent("antigravity", question);
    input.write("ya\n");
    expect(await pending).toBe(true);
    expect(out.text()).toContain("Konteks akan mengunduh Google Antigravity");
    for (const fact of ["dl.google.com", "110 MB", "400 MB", "antigravity.google/terms"]) expect(out.text()).toContain(fact);
    expect(out.text()).toContain("[y=ya/N=tidak]");
  });

  it("declines fetched-agent consent when Indonesian input closes", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const input = new PassThrough(), out = sink();
    const consent = terminalFetchConsent({ input, output: out.stream, line: line => out.stream.write(line) });
    const pending = consent("other-provider", "Provider's original consent? [y/N]");
    input.end();
    expect(await pending).toBe(false);
    expect(out.text()).toContain("Provider's original consent? [y/N]");
  });

  it("shows the complete Indonesian consent and acknowledgement for a person's explicit --yes", async () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const lines: string[] = [];
    const consent = terminalFetchConsent({ yes: true, line: text => { lines.push(text); } });
    expect(await consent("antigravity", hostAgentInstallAdapter("antigravity")!.consentText!)).toBe(true);
    expect(lines[0]).toContain("Konteks akan mengunduh Google Antigravity");
    for (const fact of ["dl.google.com", "110 MB", "400 MB", "antigravity.google/terms"]) expect(lines[0]).toContain(fact);
    expect(lines[1]).toBe("Jawaban ya diberikan melalui --yes.");
  });

  it("localizes recovery instructions while preserving diagnostics, codes and JSON", () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const out = sink(), err = sink();
    const failure = new RemoteInstanceError("temporarily_unavailable", "provider diagnostic C:\\literal\\path (0x80041315)", { recoveryActions: [{ kind: "run_doctor" }] });
    createOutput({ json: false, stdout: out.stream, stderr: err.stream }).error(failure);
    expect(err.text()).toContain("Kesalahan (temporarily_unavailable)");
    expect(err.text()).toContain("provider diagnostic C:\\literal\\path (0x80041315)");
    expect(err.text()).toContain("jalankan `konteks-remote doctor`");
    const json = sink();
    createOutput({ json: true, stderr: json.stream }).error(failure);
    expect(JSON.parse(json.text())).toEqual({ error: failure.toJSON() });
  });

  it.each([
    ["windows", "Windows tidak menjalankan tugas Konteks"],
    ["macos", "macOS tidak memuat agen launch Konteks"],
    ["debian", "systemd tidak memulai layanan pengguna Konteks"],
  ] as const)("localizes a %s service failure while keeping its technical excerpt", (os, words) => {
    const failure = new NativeServiceCommandError("start", { command: "fixture-service", args: ["literal-path"] }, { code: 23, stderr: "provider/OS diagnostic 0x123" });
    const detail = describeServiceFailure(os, failure, "id");
    expect(detail).toContain(words);
    expect(detail).toContain("provider/OS diagnostic 0x123");
    expect(detail).toContain("konteks-remote --verbose start");
    expect(failure.message).toContain("exited 23");
  });

  it("never translates provider output or leaks setup locale to provider/service children", () => {
    vi.stubEnv("KONTEKS_SETUP_LOCALE", "id");
    const out = sink();
    createOutput({ json: false, stdout: out.stream }).line("Provider says: Installed release 0.12.2 is current; nothing was changed.");
    expect(out.text()).toBe("Provider says: Installed release 0.12.2 is current; nothing was changed.\n");
    const env = { PATH: "/safe-path", KONTEKS_SETUP_LOCALE: "id" };
    expect(sanitizeInheritedChildProcessEnv({ env })).toEqual({ PATH: "/safe-path" });
    expect(launcherChildEnv(env, [])).toMatchObject({ KONTEKS_SETUP_LOCALE: "id" });
  });
});
