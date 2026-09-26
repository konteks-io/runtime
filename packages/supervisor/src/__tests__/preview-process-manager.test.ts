import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inferPreviewPlan, parsePreviewYaml, resolvePreviewPlan, frameworkFlags, substitutePreviewVariables, type PreviewPlanResult } from "../preview/config.js";
import { buildPreviewEnv, PreviewProcessManager, PreviewProcessRegistry, allocatePreviewPort, type PreviewChild } from "../preview/process-manager.js";
import { resolvePreviewPath } from "../preview/user-path.js";

class FakeChild extends EventEmitter implements PreviewChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly pid: number, readonly command: string, readonly env: NodeJS.ProcessEnv, readonly cwd: string) { super(); }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code; this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

let dir = "";
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kr-preview-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function files(entries: Record<string, string>) {
  return {
    readText: async (path: string) => entries[path.slice(dir.length + 1)] ?? null,
    exists: async (path: string) => Object.keys(entries).some(name => name === path.slice(dir.length + 1) || name.startsWith(`${path.slice(dir.length + 1)}/`)),
    platform: "darwin" as NodeJS.Platform,
  };
}

describe("preview configuration: .konteks/preview.yaml, else a sensible inferred default", () => {
  it("infers the dev script with the lockfile's package manager and the framework's host/port flags", async () => {
    const result = await resolvePreviewPlan(dir, files({ "package.json": JSON.stringify({ scripts: { dev: "vite", start: "node server.js" } }), "pnpm-lock.yaml": "", "node_modules/.bin/vite": "" }));
    expect(result).toMatchObject({ ok: true, plan: { command: "pnpm run dev --host $HOST --port $PORT --strictPort", source: "inferred", healthPath: "/" } });
    expect(result.ok && result.plan.install).toBeUndefined();
    expect(result.ok && result.plan.explanation).toContain('the "dev" script (Vite), run with pnpm (pnpm-lock.yaml)');
  });

  it("installs first when node_modules is missing and passes flags through npm with --", async () => {
    const result = await resolvePreviewPlan(dir, files({ "package.json": JSON.stringify({ scripts: { dev: "next dev" } }), "package-lock.json": "" }));
    expect(result).toMatchObject({ ok: true, plan: { command: "npm run dev -- -H $HOST -p $PORT", install: "npm install" } });
    expect(result.ok && result.plan.explanation).toContain("node_modules is missing");
  });

  it("leaves compound or port-owning scripts alone and says they must read $PORT", async () => {
    expect(frameworkFlags("vite --port 3000")).toBeNull();
    expect(frameworkFlags("concurrently \"vite\" \"tsc -w\"")).toBeNull();
    expect(frameworkFlags("npm run build && vite")).toBeNull();
    const result = await inferPreviewPlan(dir, { ...files({ "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { start: "node server.js" } }), ".pnp.cjs": "" }) });
    expect(result).toMatchObject({ ok: true, plan: { command: "yarn run start", notes: [expect.stringContaining("$PORT")] } });
  });

  it("infers Django and Rails, and explains what to add when nothing is recognisable", async () => {
    expect(await inferPreviewPlan(dir, files({ "manage.py": "" }))).toMatchObject({ ok: true, plan: { command: "python3 manage.py runserver $HOST:$PORT --noreload" } });
    expect(await inferPreviewPlan(dir, files({ "bin/rails": "" }))).toMatchObject({ ok: true, plan: { command: "bin/rails server -b $HOST -p $PORT" } });
    expect(await inferPreviewPlan(dir, files({ "README.md": "" }))).toMatchObject({ ok: false, message: expect.stringContaining(".konteks/preview.yaml") });
    expect(await inferPreviewPlan(dir, files({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) }))).toMatchObject({ ok: false, message: expect.stringContaining("no dev, start or serve script") });
  });

  it("prefers the repository's serve block, ignores serve.port and keeps only literal, unreserved env", async () => {
    const yaml = [
      "# how to preview",
      "serve:",
      "  command: \"bun run dev --port $PORT\"",
      "  install: bun install # deps",
      "  healthPath: /health",
      "  port: 3000",
      "  env:",
      "    VITE_API: 'http://127.0.0.1:9999'",
      "    PATH: /evil",
      "services:",
      "  - postgres",
      "readinessTimeoutMs: 60000",
    ].join("\n");
    const result = await resolvePreviewPlan(dir, files({ ".konteks/preview.yaml": yaml, "package.json": "{}" }));
    expect(result).toMatchObject({ ok: true, plan: { command: "bun run dev --port $PORT", install: "bun install", healthPath: "/health", env: { VITE_API: "http://127.0.0.1:9999" }, readinessTimeoutMs: 60_000, source: "preview_yaml" } });
    const notes = result.ok ? result.plan.notes.join("\n") : "";
    expect(notes).toContain("serve.port is ignored");
    expect(notes).toContain("serve.env.PATH is reserved");
    expect(notes).toContain('"services" is not used');
  });

  it("falls back to inference, with a note, when preview.yaml is malformed or has no command", async () => {
    const malformed = await resolvePreviewPlan(dir, files({ ".konteks/preview.yaml": "serve: npm start", "package.json": JSON.stringify({ scripts: { dev: "astro dev" } }), "node_modules/x": "" }));
    expect(malformed).toMatchObject({ ok: true, plan: { command: "npm run dev -- --host $HOST --port $PORT", source: "inferred", notes: [expect.stringContaining("could not be read")] } });
    const partial = await resolvePreviewPlan(dir, files({ ".konteks/preview.yaml": "serve:\n  prepare: npm run db:migrate\n", "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "node_modules/x": "" }));
    expect(partial).toMatchObject({ ok: true, plan: { prepare: "npm run db:migrate", source: "inferred" } });
    expect(parsePreviewYaml("serve:\n  command: a\n   install: b")).toMatchObject({ ok: false });
  });

  it("substitutes the assigned host and port on every OS spelling", () => {
    expect(substitutePreviewVariables("x --host $HOST --port ${PORT} %PORT% $PORTS", { host: "127.0.0.1", port: 43111 })).toBe("x --host 127.0.0.1 --port 43111 43111 $PORTS");
  });
});

describe("preview environment and PATH", () => {
  it("passes only allow-listed variables, never connector secrets, and pins HOST/PORT", () => {
    const env = buildPreviewEnv({ HOME: "/Users/a", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", KONTEKS_ACTIVATION_CODE: "secret", ANTHROPIC_API_KEY: "sk", SUPERVISOR_DATA_DIR: "/d", GITHUB_TOKEN: "t", NODE_OPTIONS: "--require x" },
      "/opt/homebrew/bin:/usr/bin", 43100, { VITE_FLAG: "1", PORT: "1", HOST: "0.0.0.0" });
    expect(env).toEqual({ HOME: "/Users/a", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", VITE_FLAG: "1", PATH: "/opt/homebrew/bin:/usr/bin", HOST: "127.0.0.1", PORT: "43100", BROWSER: "none", FORCE_COLOR: "0", TERM: "dumb" });
  });

  it("takes the login shell's PATH and adds the usual toolchain folders", async () => {
    const path = await resolvePreviewPath({ env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" }, platform: "darwin", home: "/Users/a", shellPath: async shell => shell === "/bin/zsh" ? "/Users/a/.nvm/versions/node/v22/bin:/usr/bin" : null });
    expect(path.split(":").slice(0, 3)).toEqual(["/Users/a/.nvm/versions/node/v22/bin", "/usr/bin", "/bin"]);
    expect(path).toContain("/opt/homebrew/bin");
    expect(await resolvePreviewPath({ env: { PATH: "C:\\node" }, platform: "win32" })).toBe("C:\\node");
  });

  it("allocates a free loopback port from the private range, skipping ones in use", async () => {
    const port = await allocatePreviewPort(new Set([43_100]), { first: 43_100, last: 43_101 });
    expect(port).toBe(43_101);
  });
});

describe("supervised preview process manager", () => {
  function manager(overrides: Partial<ConstructorParameters<typeof PreviewProcessManager>[0]> = {}, plan: PreviewPlanResult = { ok: true, plan: { command: "npm run dev -- --port $PORT", healthPath: "/", env: {}, source: "inferred", explanation: "Inferred from package.json.", notes: [] } }) {
    const children: FakeChild[] = [];
    let up = false;
    let now = 1_000_000;
    const terminated: FakeChild[] = [];
    const stopped: string[] = [];
    const instance = new PreviewProcessManager({
      spawn: ({ command, env, cwd }) => { const child = new FakeChild(1000 + children.length, command, env, cwd); children.push(child); return child; },
      terminate: async child => { terminated.push(child as FakeChild); if ((child as FakeChild).exitCode === null) (child as FakeChild).exit(null, "SIGTERM"); },
      resolvePlan: async () => plan,
      probe: async () => up,
      allocatePort: async inUse => { let port = 43_100; while (inUse.has(port)) port += 1; return port; },
      resolvePath: async () => "/usr/bin",
      env: { HOME: "/Users/a", OPENAI_API_KEY: "sk" },
      registry: null,
      probeIntervalMs: 5,
      readinessTimeoutMs: 60_000,
      onStopped: sessionId => void stopped.push(sessionId),
      now: () => now,
      ...overrides,
    });
    return { instance, children, terminated, stopped, setUp: (value: boolean) => { up = value; }, advance: (ms: number) => { now += ms; } };
  }

  it("starts one preview per session in its working copy, reports the inferred command and serves only once healthy", async () => {
    const f = manager();
    const first = await f.instance.start("s1", "/work/s1");
    expect(first).toMatchObject({ state: "starting", url: null });
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    expect(f.children[0]).toMatchObject({ command: "npm run dev -- --port 43100", cwd: "/work/s1" });
    expect(f.children[0]!.env).toMatchObject({ HOST: "127.0.0.1", PORT: "43100", PATH: "/usr/bin" });
    expect(f.children[0]!.env.OPENAI_API_KEY).toBeUndefined();
    expect(f.instance.originFor("s1")).toBeNull();
    f.children[0]!.stdout.write("\u001b[32m  VITE ready\u001b[0m\n  Local: http://127.0.0.1:43100/\n");
    f.setUp(true);
    const running = await f.instance.waitForSettled("s1", 2_000);
    expect(running).toMatchObject({ state: "running", url: "http://127.0.0.1:43100", port: 43100, command: "npm run dev -- --port $PORT", source: "inferred", explanation: "Inferred from package.json." });
    expect(running.logTail).toContain("  VITE ready");
    expect(running.logTail.join("\n")).not.toContain("\u001b");
    expect(f.instance.originFor("s1")).toBe("http://127.0.0.1:43100");
    // A second start is the same preview.
    expect(await f.instance.start("s1", "/work/s1")).toMatchObject({ state: "running", port: 43100 });
    expect(f.children).toHaveLength(1);
  });

  it("runs install before the server, and reports a failing step with its log", async () => {
    const f = manager({}, { ok: true, plan: { command: "npm run dev", install: "npm install", healthPath: "/", env: {}, source: "inferred", explanation: "x", notes: [] } });
    await f.instance.start("s", "/w");
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    expect(f.instance.status("s")).toMatchObject({ state: "starting", phase: "install" });
    f.children[0]!.stderr.write("npm ERR! network\n");
    f.children[0]!.exit(1);
    const failed = await f.instance.waitForSettled("s", 2_000);
    expect(failed).toMatchObject({ state: "failed", message: expect.stringContaining("install step (npm install) exited with code 1") });
    expect(failed.logTail).toContain("npm ERR! network");
    expect(f.instance.health().lastFailure?.message).toContain("install step");
  });

  it("fails clearly when the server exits early or never answers on its port, killing the tree", async () => {
    const early = manager();
    await early.instance.start("s", "/w");
    await vi.waitFor(() => expect(early.children).toHaveLength(1));
    early.children[0]!.exit(127);
    expect(await early.instance.waitForSettled("s", 2_000)).toMatchObject({ state: "failed", message: expect.stringContaining("exit code 127") });

    const silent = manager({ readinessTimeoutMs: 1, now: Date.now });
    await silent.instance.start("s", "/w");
    const failed = await silent.instance.waitForSettled("s", 2_000);
    expect(failed).toMatchObject({ state: "failed", message: expect.stringContaining("did not answer on 127.0.0.1:43100") });
    expect(silent.terminated).toHaveLength(1);
  });

  it("refuses a command the connector's command policy blocks", async () => {
    const f = manager({}, { ok: true, plan: { command: "git push origin main", healthPath: "/", env: {}, source: "preview_yaml", explanation: "x", notes: [] } });
    await f.instance.start("s", "/w");
    expect(await f.instance.waitForSettled("s", 2_000)).toMatchObject({ state: "failed", message: expect.stringContaining("command policy") });
    expect(f.children).toHaveLength(0);
  });

  it("caps previews running at once with a clear message, and frees a slot when one stops", async () => {
    const f = manager({ maxRunning: 2 });
    f.setUp(true);
    await f.instance.start("a", "/a");
    await f.instance.start("b", "/b");
    const refused = await f.instance.start("c", "/c");
    expect(refused).toMatchObject({ state: "failed", message: expect.stringContaining("2 previews are already running") });
    await f.instance.waitForSettled("b", 2_000);
    await f.instance.stop("a", "agent");
    expect(f.stopped).toContain("a");
    expect(await f.instance.start("c", "/c")).toMatchObject({ state: "starting" });
  });

  it("stops a preview after the idle window unless viewers or the agent keep it active, and says why", async () => {
    const f = manager({ idleMs: 30 * 60_000 });
    f.setUp(true);
    await f.instance.start("s", "/w");
    await f.instance.waitForSettled("s", 2_000);
    f.advance(29 * 60_000);
    f.instance.touch("s");
    f.advance(29 * 60_000);
    await f.instance.sweepIdle();
    expect(f.instance.status("s").state).toBe("running");
    f.advance(2 * 60_000);
    await f.instance.sweepIdle();
    expect(f.instance.status("s")).toMatchObject({ state: "stopped", url: null, message: expect.stringContaining("idle") });
    expect(f.instance.originFor("s")).toBeNull();
    expect(f.terminated).toHaveLength(1);
  });

  it("stops every preview when the connector stops and refuses new ones", async () => {
    const f = manager();
    f.setUp(true);
    await f.instance.start("a", "/a");
    await f.instance.waitForSettled("a", 2_000);
    await f.instance.close();
    expect(f.instance.status("a").state).toBe("stopped");
    expect(await f.instance.start("b", "/b")).toMatchObject({ state: "failed", message: expect.stringContaining("stopping") });
  });

  it("reports the unexpected exit of a running preview", async () => {
    const f = manager();
    f.setUp(true);
    await f.instance.start("s", "/w");
    await f.instance.waitForSettled("s", 2_000);
    f.children[0]!.exit(1);
    expect(f.instance.status("s")).toMatchObject({ state: "failed", message: expect.stringContaining("stopped unexpectedly") });
    expect(f.stopped).toEqual(["s"]);
  });
});

describe("preview process registry (restart never adopts)", () => {
  it("kills only recorded process groups whose start identity still matches, then forgets them", async () => {
    const file = join(dir, "preview-processes.json");
    const identities = new Map<number, string>([[501, "start-a"], [502, "start-b"]]);
    const registry = new PreviewProcessRegistry(file, pid => identities.get(pid) ?? null);
    await registry.record(501);
    await registry.record(502);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([{ pid: 501, token: "start-a" }, { pid: 502, token: "start-b" }]);
    identities.set(502, "reused-pid");
    const signalled: number[] = [];
    const next = new PreviewProcessRegistry(file, pid => identities.get(pid) ?? null);
    expect(await next.sweep(pid => void signalled.push(pid))).toBe(1);
    expect(signalled).toEqual([501]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  });

  it("does nothing on a clean start", async () => {
    await writeFile(join(dir, "other"), "");
    const registry = new PreviewProcessRegistry(join(dir, "preview-processes.json"), () => "x");
    expect(await registry.sweep(() => { throw new Error("never"); })).toBe(0);
  });
});
