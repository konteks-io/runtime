import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
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
export interface LoginFlowOptions {
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
  readonly done: Promise<{ code: number | null }>;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const USER_CODE_PATTERN = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
const PROMPT_PATTERN = /(?:paste|enter|input|type)[^\n]*(?:code|token|key|url)[^\n]*[:?]\s*$/i;
// Codex colours its device link and one-time code. Left in, the escape after
// the link became part of the URL Konteks showed, and the one before the code
// hid it from USER_CODE_PATTERN's word boundary (WS1-115).
// eslint-disable-next-line no-control-regex
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
  const relay = (line: string): void => {
    const sanitized = redactText(withoutTerminalEscapes(line)).slice(0, 4_096);
    if (sanitized.trim().length === 0) return;
    emit({ type: "display", text: sanitized });
    const signals = extractLoginSignals(sanitized);
    if (signals.url) emit({ type: "open_url", url: signals.url, ...(signals.userCode ? { userCode: signals.userCode } : {}) });
    if (signals.prompt) emit({ type: "prompt", ...signals.prompt });
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    createInterface({ input: stream, terminal: false }).on("line", relay);
  }
  const timeoutMs = options.timeoutMs ?? options.config.RUNNER_LOGIN_TIMEOUT_MS;
  const timer = setTimeout(() => {
    logger.warn({ loginId }, "login timed out; stopping the official tooling");
    void stopProcessGroupLeaderFirst({ child, timeoutMs: 2_000, killGraceMs: 1_000 });
  }, timeoutMs);
  timer.unref();
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
  return {
    loginId,
    input(text) {
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
