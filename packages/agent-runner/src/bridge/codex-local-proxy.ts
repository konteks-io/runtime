#!/usr/bin/env node
import { connectCodexLocalTransport } from "./codex-local-transport.js";
import { CodexInputCorrelation } from "./codex-input-correlation.js";

// Invoked by the signed Codex ACP bridge through its supported CODEX_PATH.
// Only app-server is accepted; login/logout remain local-user operations.
try {
  if (process.argv.length !== 3 || process.argv[2] !== "app-server") throw new Error("Unsupported local Codex proxy command");
  const path = process.env.KONTEKS_NATIVE_CODEX_SOCKET;
  if (!path) throw new Error("Local Codex socket is not configured");
  const stream = await connectCodexLocalTransport(path, new CodexInputCorrelation());
  stream.on("error", () => { process.stderr.write("Local Codex connection unavailable; no session ownership was transferred.\n"); process.exitCode = 1; process.stdin.unpipe(stream); process.stdin.pause(); });
  stream.on("close", () => { process.stdin.unpipe(stream); process.stdin.pause(); });
  process.stdin.pipe(stream).pipe(process.stdout);
} catch {
  process.stderr.write("The supervisor-owned shared Codex service is unavailable on its private local socket.\n");
  process.exitCode = 1;
}
