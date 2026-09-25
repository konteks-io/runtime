import { randomUUID } from "node:crypto";
import { assertRestrictedMode, deleteSecretFile, readSecretFileIfPresent, writeSecretFile, type Logger } from "@konteks/remote-common";
import type { RunnerEventBus } from "../events.js";
import type { LoginFlow } from "./login-flow.js";

/**
 * DeepSeek Harness has no login command: it reads `DEEPSEEK_API_KEY` from its
 * credential document (`$DSH_HOME/.credentials.yaml`, `refs`). The runtime
 * owns that document in its private DSH_HOME, so this module is its only
 * writer and reads back only what it wrote; it is not a vendor credential file
 * parsed behind the agent's back (D111). The key is never logged, never put in
 * an event and never passed through the environment.
 */
export const DSH_KEY_REF = "DEEPSEEK_API_KEY";
const MODELS_URL = "https://api.deepseek.com/models";
const KEY_SHAPE = /^[\x21-\x7e]{16,512}$/;

export async function readDshApiKey(credentialsFile: string): Promise<string | null> {
  const document = await readSecretFileIfPresent(credentialsFile);
  if (document === null) return null;
  // dsh refuses a document other users can read; repair ours before relying on it.
  await assertRestrictedMode(credentialsFile);
  const lines = document.split(/\r?\n/);
  if (lines[0]?.trim() !== "version: 1" || !lines.includes("refs:")) return null;
  const entry = lines.map(line => /^ {2}DEEPSEEK_API_KEY: (.+)$/.exec(line)?.[1]?.trim()).find(Boolean);
  if (!entry) return null;
  let key = entry;
  if (entry.startsWith('"')) {
    try { key = JSON.parse(entry) as string; } catch { return null; }
  }
  return typeof key === "string" && KEY_SHAPE.test(key) ? key : null;
}

export async function writeDshApiKey(credentialsFile: string, key: string): Promise<void> {
  if (!KEY_SHAPE.test(key)) throw new Error("not an API key");
  // A JSON string is a valid YAML double-quoted scalar.
  await writeSecretFile(credentialsFile, `version: 1\nrefs:\n  ${DSH_KEY_REF}: ${JSON.stringify(key)}\n`);
}

export async function removeDshApiKey(credentialsFile: string): Promise<void> {
  await deleteSecretFile(credentialsFile);
}

/** Check a key against DeepSeek's model list: no tokens are spent. */
export async function verifyDeepSeekApiKey(key: string, deps: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<"valid" | "rejected" | "unreachable"> {
  try {
    const response = await (deps.fetch ?? fetch)(MODELS_URL, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "valid";
    if (response.status === 401 || response.status === 403) return "rejected";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export interface DshKeyLoginOptions {
  credentialsFile: string;
  events: RunnerEventBus;
  loginId?: string;
  logger?: Pick<Logger, "info">;
  verify?: (key: string) => Promise<"valid" | "rejected" | "unreachable">;
  maxAttempts?: number;
  timeoutMs?: number;
}

/**
 * `konteks-remote auth login dsh`: one secret prompt through the existing
 * login relay (the CLI reads it without echo), a check with DeepSeek, then
 * the credential document. Same LoginFlow contract as official tooling.
 */
export function startDshKeyLogin(options: DshKeyLoginOptions): LoginFlow {
  const loginId = options.loginId ?? `login-${randomUUID()}`;
  const verify = options.verify ?? (key => verifyDeepSeekApiKey(key));
  const maxAttempts = options.maxAttempts ?? 3;
  let attempts = 0;
  let busy = false;
  let finished = false;
  let resolveDone!: (value: { code: number | null }) => void;
  const done = new Promise<{ code: number | null }>(resolve => { resolveDone = resolve; });
  const display = (text: string) => options.events.publish({ kind: "login_event", loginId, event: { type: "display", text } });
  const ask = () => options.events.publish({ kind: "login_event", loginId, event: { type: "prompt", label: "DeepSeek API key", secret: true } });
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolveDone({ code });
  };
  const timer = setTimeout(() => { display("The login timed out. Run it again when you have the key."); finish(1); }, options.timeoutMs ?? 15 * 60_000);
  timer.unref();

  display("Paste your DeepSeek API key. Konteks checks it with DeepSeek and keeps it only on this machine.");
  ask();
  return {
    loginId,
    input(text) {
      if (finished || busy) return;
      const key = text.trim();
      if (key.length === 0) { display("No key was entered. Paste the key, or press Ctrl+C to stop."); ask(); return; }
      if (!KEY_SHAPE.test(key)) { display("That does not look like an API key. Paste the key from platform.deepseek.com, or press Ctrl+C to stop."); ask(); return; }
      busy = true;
      attempts += 1;
      void verify(key).then(async verdict => {
        if (finished) return;
        if (verdict === "valid") {
          await writeDshApiKey(options.credentialsFile, key);
          options.logger?.info({ event: "dsh.key.saved" }, "DeepSeek API key saved");
          display("Key saved.");
          finish(0);
        } else if (verdict === "unreachable") {
          display("Konteks could not reach DeepSeek to check the key. Check the connection, then run the login again.");
          finish(1);
        } else if (attempts >= maxAttempts) {
          display("DeepSeek did not accept the key. Run the login again with a key from platform.deepseek.com.");
          finish(1);
        } else {
          display("DeepSeek did not accept that key. Paste it again, or press Ctrl+C to stop.");
          ask();
        }
      }).catch(() => {
        display("The key could not be saved on this machine. Run the login again.");
        finish(1);
      }).finally(() => { busy = false; });
    },
    cancel: async () => finish(1),
    done,
  };
}
