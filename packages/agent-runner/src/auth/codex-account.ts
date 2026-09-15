import { createInterface } from "node:readline";
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
  const command = resolveToolingCommand(config, family, ["codex", "app-server"]);
  const shared = config.RUNNER_NATIVE_CODEX_SOCKET ? await connectCodexLocalTransport(config.RUNNER_NATIVE_CODEX_SOCKET) : null;
  const child = shared ? null : (deps.spawn ?? spawnPiped)({ ...command, env, cwd: config.RUNNER_CREDENTIAL_DIR });
  const input = shared ?? child!.stdout, output = shared ?? child!.stdin;
  const owner = shared ?? child!;
  const lines = createInterface({ input, terminal: false });
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string | null>((resolve, reject) => {
      let initialized = false;
      let settled = false;
      const fail = () => { if (!settled) { settled = true; reject(new Error("Official Codex account probe unavailable")); } };
      const send = (value: unknown) => { if (!output.destroyed) output.write(`${JSON.stringify(value)}\n`); else fail(); };
      timer = setTimeout(fail, 20_000);
      owner.once("error", fail);
      owner.once("close", fail);
      output.on("error", fail);
      lines.on("error", fail);
      for (const stream of shared ? [shared] : [child!.stdout, child!.stderr]) {
        stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) fail(); });
      }
      lines.on("line", line => {
        if (settled) return;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try { message = JSON.parse(line); } catch { fail(); return; }
        if (!message || typeof message !== "object") { fail(); return; }
        if (message.id === 1 && !initialized) {
          if (message.error || !message.result) { fail(); return; }
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ method: "account/read", id: 2, params: { refreshToken: false } });
        } else if (message.id === 2 && initialized) {
          if (message.error || !message.result || typeof message.result !== "object") { fail(); return; }
          const account = (message.result as { account?: unknown }).account;
          if (account === null) { settled = true; resolve(null); return; }
          if (!account || typeof account !== "object") { fail(); return; }
          const { type, email } = account as { type?: unknown; email?: unknown };
          // A login mode or plan is not a stable identity. Unknown/no-email
          // accounts remain unproven rather than sharing a synthetic identity.
          if (type !== "chatgpt" || typeof email !== "string" || email.trim().length === 0 || email.length > 1024) { fail(); return; }
          settled = true;
          resolve(email.trim());
        }
      });
      send({ method: "initialize", id: 1, params: { clientInfo: { name: "konteks_identity_probe", version: "0.1.0" } } });
    });
  } finally {
    if (timer) clearTimeout(timer);
    lines.close();
    if (shared) shared.destroy();
    else await (deps.stop ?? stopProcessGroupLeaderFirst)({ child: child!, timeoutMs: 1_000, killGraceMs: 1_000 });
  }
}
