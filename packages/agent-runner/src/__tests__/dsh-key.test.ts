import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerEventBus, type RunnerEvent } from "../events.js";
import { readDshApiKey, removeDshApiKey, startDshKeyLogin, verifyDeepSeekApiKey, writeDshApiKey } from "../auth/dsh-key.js";

const KEY = "sk-0123456789abcdef0123456789abcdef";
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const file = async () => { const folder = await mkdtemp(join(tmpdir(), "dsh-key-")); folders.push(folder); return join(folder, ".dsh", ".credentials.yaml"); };

describe("DeepSeek API key for DeepSeek Harness", () => {
  it("stores the key as the credential document dsh reads, privately, and reads it back", async () => {
    const path = await file();
    await writeDshApiKey(path, KEY);
    expect(await readFile(path, "utf8")).toBe(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${KEY}"\n`);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    }
    expect(await readDshApiKey(path)).toBe(KEY);
    await removeDshApiKey(path);
    expect(await readDshApiKey(path)).toBeNull();
  });

  it("reads a plain or quoted ref, treats anything else as no key, and repairs a loose mode", async () => {
    const path = await file();
    await writeDshApiKey(path, KEY);
    await writeFile(path, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${KEY}\n`);
    expect(await readDshApiKey(path)).toBe(KEY);
    await writeFile(path, "version: 1\nrefs: [\n");
    expect(await readDshApiKey(path)).toBeNull();
    await writeFile(path, `version: 1\nrefs:\n  OTHER_KEY: "${KEY}"\n`);
    expect(await readDshApiKey(path)).toBeNull();
    if (process.platform !== "win32") {
      await writeFile(path, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${KEY}"\n`);
      await chmod(path, 0o644);
      expect(await readDshApiKey(path)).toBe(KEY);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("checks a key with DeepSeek's model list, which spends no tokens", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response("{}", { status });
    }) as typeof fetch;
    await expect(verifyDeepSeekApiKey(KEY, { fetch: fetcher(200) })).resolves.toBe("valid");
    await expect(verifyDeepSeekApiKey(KEY, { fetch: fetcher(401) })).resolves.toBe("rejected");
    await expect(verifyDeepSeekApiKey(KEY, { fetch: fetcher(503) })).resolves.toBe("unreachable");
    await expect(verifyDeepSeekApiKey(KEY, { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch })).resolves.toBe("unreachable");
    expect(seen[0]).toEqual({ url: "https://api.deepseek.com/models", authorization: `Bearer ${KEY}` });
  });

  it("asks for the key as a secret, retries a rejected key, and stores only a checked one", async () => {
    const path = await file();
    const events = new RunnerEventBus();
    const seen: RunnerEvent[] = [];
    events.subscribe(event => seen.push(event));
    const answers: Array<"valid" | "rejected"> = ["rejected", "valid"];
    const flow = startDshKeyLogin({ credentialsFile: path, events, loginId: "login-1", verify: async () => answers.shift()! });
    const prompts = () => seen.filter(event => event.kind === "login_event" && event.event.type === "prompt");
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toMatchObject({ event: { type: "prompt", label: "DeepSeek API key", secret: true } });
    flow.input("   ");
    flow.input("sk-wrong-but-well-formed-0000000000");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await readDshApiKey(path)).toBeNull();
    expect(prompts().length).toBeGreaterThanOrEqual(2);
    flow.input(`  ${KEY}  `);
    await expect(flow.done).resolves.toEqual({ code: 0 });
    expect(await readDshApiKey(path)).toBe(KEY);
    // The key never appears in any event.
    expect(JSON.stringify(seen)).not.toContain(KEY);
    expect(JSON.stringify(seen)).not.toContain("sk-wrong");
  });

  it("stops after repeated rejection, on an unreachable DeepSeek, and on cancel, storing nothing", async () => {
    const rejected = startDshKeyLogin({ credentialsFile: await file(), events: new RunnerEventBus(), verify: async () => "rejected", maxAttempts: 2 });
    rejected.input(KEY); await new Promise(resolve => setTimeout(resolve, 5)); rejected.input(KEY);
    await expect(rejected.done).resolves.toEqual({ code: 1 });
    const offlinePath = await file();
    const offline = startDshKeyLogin({ credentialsFile: offlinePath, events: new RunnerEventBus(), verify: async () => "unreachable" });
    offline.input(KEY);
    await expect(offline.done).resolves.toEqual({ code: 1 });
    expect(await readDshApiKey(offlinePath)).toBeNull();
    const cancelled = startDshKeyLogin({ credentialsFile: await file(), events: new RunnerEventBus(), verify: async () => "valid" });
    await cancelled.cancel();
    await expect(cancelled.done).resolves.toEqual({ code: 1 });
  });
});
