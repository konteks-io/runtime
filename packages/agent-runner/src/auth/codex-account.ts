import type { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { spawnPiped, stopProcessGroupLeaderFirst } from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import { resolveToolingCommand } from "../bridge/spec.js";
import { connectCodexLocalTransport } from "../bridge/codex-local-transport.js";

/** Official pinned Codex account/read only; never reads auth files or returns tokens.
 * Protocol: codex-rs/app-server/README.md at rust-v0.153.4, Auth endpoints.
 * `login status` writes stderr and identifies an auth mode, not an account.
 */
export async function readCodexAccount(config: RunnerConfig, family: AgentBridgeFamily, env: NodeJS.ProcessEnv, deps: { spawn?: typeof spawnPiped; stop?: typeof stopProcessGroupLeaderFirst } = {}): Promise<string | null> {
  const channel = await openAppServer(config, family, env, deps);
  const lines = createInterface({ input: channel.input, terminal: false });
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string | null>((resolve, reject) => {
      let initialized = false;
      let settled = false;
      const fail = () => { if (!settled) { settled = true; reject(new Error("Official Codex account probe unavailable")); } };
      const send = (value: unknown) => { if (!channel.output.destroyed) channel.output.write(`${JSON.stringify(value)}\n`); else fail(); };
      timer = setTimeout(fail, 20_000);
      channel.owner.once("error", fail);
      channel.owner.once("close", fail);
      channel.output.on("error", fail);
      lines.on("error", fail);
      for (const stream of channel.streams) {
        stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) fail(); });
      }
      lines.on("line", line => {
        if (settled) return;
        const step = probeStep(line, initialized);
        if (step.kind === "fail") fail();
        else if (step.kind === "initialized") {
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ method: "account/read", id: 2, params: { refreshToken: false } });
        } else if (step.kind === "account") {
          settled = true;
          resolve(step.email);
        }
      });
      send({ method: "initialize", id: 1, params: { clientInfo: { name: "konteks_identity_probe", version: "0.1.0" } } });
    });
  } finally {
    if (timer) clearTimeout(timer);
    lines.close();
    await channel.close();
  }
}

interface AppServerChannel {
  input: Readable;
  output: Writable;
  owner: EventEmitter;
  /** Every stream whose bytes count toward the probe's bound. */
  streams: Readable[];
  close(): Promise<void>;
}

/** The supervisor's shared Codex service when it has one, else a private `codex app-server`. */
async function openAppServer(config: RunnerConfig, family: AgentBridgeFamily, env: NodeJS.ProcessEnv, deps: { spawn?: typeof spawnPiped; stop?: typeof stopProcessGroupLeaderFirst }): Promise<AppServerChannel> {
  const command = resolveToolingCommand(config, family, ["codex", "app-server"]);
  if (config.RUNNER_NATIVE_CODEX_SOCKET) {
    const shared = await connectCodexLocalTransport(config.RUNNER_NATIVE_CODEX_SOCKET);
    return { input: shared, output: shared, owner: shared, streams: [shared], close: async () => { shared.destroy(); } };
  }
  const child = (deps.spawn ?? spawnPiped)({ ...command, env, cwd: config.RUNNER_CREDENTIAL_DIR });
  const stop = deps.stop ?? stopProcessGroupLeaderFirst;
  return { input: child.stdout, output: child.stdin, owner: child, streams: [child.stdout, child.stderr],
    close: () => stop({ child, timeoutMs: 1_000, killGraceMs: 1_000 }) };
}

type ProbeStep = { kind: "ignore" } | { kind: "fail" } | { kind: "initialized" } | { kind: "account"; email: string | null };
type ProbeMessage = { id?: unknown; result?: unknown; error?: unknown };

/** What one app-server line means for the probe: `initialize` answered, then `account/read`. */
function probeStep(line: string, initialized: boolean): ProbeStep {
  const message = probeMessage(line);
  if (!message) return { kind: "fail" };
  if (message.id === 1 && !initialized) return message.error || !message.result ? { kind: "fail" } : { kind: "initialized" };
  if (message.id === 2 && initialized) return accountStep(message);
  return { kind: "ignore" };
}

function probeMessage(line: string): ProbeMessage | null {
  try {
    const message: unknown = JSON.parse(line);
    return message && typeof message === "object" ? message as ProbeMessage : null;
  } catch { return null; }
}

function accountStep(message: ProbeMessage): ProbeStep {
  if (message.error || !message.result || typeof message.result !== "object") return { kind: "fail" };
  const account = (message.result as { account?: unknown }).account;
  if (account === null) return { kind: "account", email: null };
  const email = chatgptEmail(account);
  return email === null ? { kind: "fail" } : { kind: "account", email };
}

/**
 * A login mode or plan is not a stable identity. Unknown/no-email accounts
 * remain unproven rather than sharing a synthetic identity.
 */
function chatgptEmail(account: unknown): string | null {
  if (!account || typeof account !== "object") return null;
  const { type, email } = account as { type?: unknown; email?: unknown };
  if (type !== "chatgpt" || typeof email !== "string" || email.trim().length === 0 || email.length > 1024) return null;
  return email.trim();
}
