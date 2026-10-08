import { randomUUID } from "node:crypto";
import {
  RemoteInstanceError,
  createLogger,
  redactText,
  spawnPiped,
  stopProcessGroupLeaderFirst,
  type Logger,
  type PipedChildProcess,
} from "@konteks/remote-common";
import type { AgentBridgeFamily } from "@konteks/remote-release";
import type { RunnerConfig } from "../config.js";
import { resolveToolingCommand } from "../bridge/spec.js";
import type { RunnerEvent, RunnerEventBus } from "../events.js";

export type LoginEvent = Extract<RunnerEvent, { kind: "login_event" }>["event"];

/**
 * `auth login <agent>`: the bridge's OFFICIAL tooling owns the login. The
 * runner spawns it inside the credential volume, relays its output to the
 * operator through the supervisor/launcher as sanitized display events,
 * detects device-flow URLs and user codes so the launcher can present them
 * clearly (the interaction model adapted from bb's oauth/device-login flows),
 * and pipes the operator's typed input back. The runner never parses, copies,
 * or reverse-engineers a token, and never automates a sign-in.
 */
interface LoginFlowOptions {
  config: RunnerConfig;
  family: AgentBridgeFamily;
  env: NodeJS.ProcessEnv;
  events: RunnerEventBus;
  loginId?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface LoginFlow {
  loginId: string;
  input(text: string): void;
  cancel(): Promise<void>;
  /** `reason`: why a sign-in failed, when the person can act on it (Gemini Enterprise found no licence). */
  readonly done: Promise<{ code: number | null; reason?: LoginFailureReason }>;
}

/** A failed sign-in's reason the site shows in its own words (Core 7.1.0 `AgentLoginFailure`). */
export type LoginFailureReason = "no_license";

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const USER_CODE_PATTERN = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
const PROMPT_PATTERN = /(?:paste|enter|input|type)[^\n]*(?:code|token|key|url)[^\n]*[:?>]\s*$/i;
// Codex colours its device link and one-time code. Left in, the escape after
// the link became part of the URL Konteks showed, and the one before the code
// hid it from USER_CODE_PATTERN's word boundary.
const TERMINAL_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;

export function withoutTerminalEscapes(line: string): string {
  return line.replace(TERMINAL_ESCAPE, "");
}

export function extractLoginSignals(line: string): { url?: string; userCode?: string; prompt?: { label: string; secret: boolean } } {
  const out: { url?: string; userCode?: string; prompt?: { label: string; secret: boolean } } = {};
  const url = URL_PATTERN.exec(line)?.[0];
  URL_PATTERN.lastIndex = 0;
  if (url) out.url = url;
  const userCode = USER_CODE_PATTERN.exec(line)?.[1];
  if (userCode) out.userCode = userCode;
  if (PROMPT_PATTERN.test(line)) {
    out.prompt = { label: line.trim().slice(0, 256), secret: /token|key|secret/i.test(line) };
  }
  return out;
}

export function startLoginFlow(options: LoginFlowOptions): LoginFlow {
  const logger = options.logger ?? createLogger({ name: "runner-login" });
  const loginId = options.loginId ?? `login-${randomUUID()}`;
  const { command, args } = resolveToolingCommand(options.config, options.family, options.family.tooling.login);
  let child: PipedChildProcess;
  try {
    child = spawnPiped({ command, args, cwd: options.config.RUNNER_CREDENTIAL_DIR, env: options.env, detached: true });
  } catch (error) {
    throw new RemoteInstanceError("agent_unavailable", "official login tooling could not be started", { cause: error, recoveryActions: [{ kind: "update" }] });
  }
  const emit = (event: LoginEvent): void => {
    options.events.publish({ kind: "login_event", loginId, event });
  };
  let lastOutputAt = Date.now();
  let awaitingInput = false;
  const relay = (line: string): void => {
    lastOutputAt = Date.now();
    const sanitized = redactText(withoutTerminalEscapes(line)).slice(0, 4_096);
    if (sanitized.trim().length === 0) return;
    emit({ type: "display", text: sanitized });
    const signals = extractLoginSignals(sanitized);
    if (signals.url) emit({ type: "open_url", url: signals.url, ...(signals.userCode ? { userCode: signals.userCode } : {}) });
    if (signals.prompt) {
      awaitingInput = true;
      emit({ type: "prompt", ...signals.prompt });
    }
  };
  // Login tools write prompts without a newline. Keep chunk boundaries out of
  // redaction and signal detection, then flush an unterminated prompt promptly.
  const flushers: Array<() => void> = [];
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    let partial: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (partial) { clearTimeout(partial); partial = undefined; }
      if (pending) { relay(pending); pending = ""; }
    };
    flushers.push(flush);
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (partial) { clearTimeout(partial); }
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) relay(line);
      // Bound a noisy tool's unterminated output; sanitize before truncation.
      if (pending.length > 16_384) flush();
      if (pending) {
        partial = setTimeout(() => {
          // Only an actionable, complete prompt can end an unterminated line.
          // Arbitrary partial output may be half of a credential to redact.
          if (extractLoginSignals(withoutTerminalEscapes(pending)).prompt) flush();
        }, 100);
        partial.unref();
      }
    });
    stream.once("end", flush);
  }
  const timeoutMs = options.timeoutMs ?? options.config.RUNNER_LOGIN_TIMEOUT_MS;
  const startedAt = Date.now();
  const progress = setInterval(() => {
    if (awaitingInput || Date.now() - lastOutputAt < 30_000) return;
    emit({ type: "display", text: `Sign-in is still running (${Math.round((Date.now() - startedAt) / 1000)} seconds). Complete the browser sign-in or paste the requested code below. The limit is ${Math.ceil(timeoutMs / 60_000)} minutes; press Ctrl+C to cancel.` });
  }, 30_000);
  progress.unref();
  const timer = setTimeout(() => {
    emit({ type: "display", text: `Sign-in timed out. Check your browser and network connection, then retry konteks-remote auth login ${options.family.agentId}. You can also run the agent's own login in a terminal to diagnose it.` });
    logger.warn({ loginId }, "login timed out; stopping the official tooling");
    void stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 });
  }, timeoutMs);
  timer.unref();
  const done = new Promise<{ code: number | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progress);
      for (const flush of flushers) flush();
      resolve({ code });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      emit({ type: "display", text: `The official login could not start (${error.code ?? "process error"}). Check that the agent is installed for this user account, then retry. Run konteks-remote doctor for details.` });
      finish(null);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code === 0) emit({ type: "display", text: "The agent's sign-in finished. Checking local account readiness…" });
      else if (code !== null) emit({ type: "display", text: `The agent's sign-in exited with code ${code}. Review the messages above, then retry.` });
      finish(code);
    });
  });
  return {
    loginId,
    input(text) {
      awaitingInput = false;
      lastOutputAt = Date.now();
      // Operator-typed input (a pasted code or URL) is written to the tool's
      // stdin and never logged or echoed by the runner.
      if (!child.stdin.destroyed) child.stdin.write(`${text}\n`);
    },
    cancel: () => stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 }),
    done,
  };
}

export async function runLogout(options: Pick<LoginFlowOptions, "config" | "family" | "env">): Promise<{ code: number | null }> {
  const { command, args } = resolveToolingCommand(options.config, options.family, options.family.tooling.logout);
  const child = spawnPiped({ command, args, cwd: options.config.RUNNER_CREDENTIAL_DIR, env: options.env, detached: true });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.end();
  return new Promise((resolve) => {
    const timer = setTimeout(() => void stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 }), 60_000);
    timer.unref();
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}
