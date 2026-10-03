import {
  ANTIGRAVITY_LOGIN_OPTIONS,
  AgentLoginUserCodeSchema,
  OPENCODE_LOGIN_OPTIONS,
  REMOTE_AGENT_LOGIN_ANTIGRAVITY_CAPABILITY,
  antigravityLoginOptionCapability,
  type AgentLoginOptionId,
  type AntigravityLoginOptionId,
  OpenCodeLoginUserCodeSchema,
  REMOTE_AGENT_LOGIN_OPENCODE_CAPABILITY,
  REMOTE_OPENCODE_FREE_MODELS_CAPABILITY,
  openCodeLoginOptionCapability,
  agentLoginMethod,
  agentLoginUrlAllowed,
  type ControlLoginEvent,
  type OpenCodeLoginOptionId,
} from "@konteks/remote-common";

type Agent = "codex" | "claude-code" | "opencode" | "antigravity";
type Failure = "timed_out" | "login_failed" | "already_in_progress" | "unavailable" | "no_license";

/** What the machine reports to Core about a site-started login (the `RuntimeAgentLoginReport` fields it sets). */
export interface SiteLoginReport {
  loginId: string;
  agentId: Agent;
  loginOption?: AgentLoginOptionId;
  state: "awaiting_person" | "succeeded" | "failed";
  verificationUrl?: string;
  userCode?: string;
  failure?: Failure;
}

interface SiteLoginRelayOptions {
  loginId: string;
  agentId: Agent;
  /** OpenCode's or Antigravity's sign-in option; every report echoes it. */
  loginOption?: AgentLoginOptionId;
  /**
   * Core takes `no_license` as a failure (from Core 7.1.0): a Gemini
   * Enterprise sign-in that found no licence says so; otherwise it reads
   * `login_failed`.
   */
  coreAcceptsNoLicense?: boolean;
  report: (value: SiteLoginReport) => void;
  /** Stop the agent's login (it asked for typed input, which never crosses Konteks). */
  cancel: () => void;
  /** The login is over, whatever its end. */
  onFinished: () => void;
  onSucceeded?: () => void;
}

/**
 * A login a person started from the site: the agent's
 * own device login runs on this machine and only the provider link and code
 * go back to Core. Claude Code, OpenCode's browser sign-ins (GitLab, Poe) and
 * Google Antigravity's Gemini Enterprise finish in a
 * browser this machine opens: nothing is shown but Google's page (never the
 * licence picker Antigravity serves on loopback).
 * A login that asks for typed input is stopped. Links must be on the agent's
 * (for OpenCode: the option's) own provider hosts.
 */
export function siteLoginRelay(options: SiteLoginRelayOptions) {
  const browser = agentLoginMethod(options.agentId, options.loginOption) === "machine_browser";
  const codeSchema = options.agentId === "opencode" ? OpenCodeLoginUserCodeSchema : AgentLoginUserCodeSchema;
  let url: string | undefined;
  let code: string | undefined;
  let over = false;
  const report = (value: Omit<SiteLoginReport, "loginId" | "agentId" | "loginOption">) =>
    options.report({ loginId: options.loginId, agentId: options.agentId, ...(options.loginOption === undefined ? {} : { loginOption: options.loginOption }), ...value });
  const finish = (value: Omit<SiteLoginReport, "loginId" | "agentId" | "loginOption">) => {
    if (over) return;
    over = true;
    options.onFinished();
    report(value);
  };
  const awaiting = () => {
    if (over || (!url && !browser)) return;
    report({ state: "awaiting_person", ...(url ? { verificationUrl: url } : {}), ...(code && !browser ? { userCode: code } : {}) });
  };
  const onOpenUrl = (event: { url: string; userCode?: string | undefined }) => {
    if (!agentLoginUrlAllowed(options.agentId, event.url, options.loginOption)) return;
    url = event.url;
    if (event.userCode && codeSchema.safeParse(event.userCode).success) code = event.userCode;
    awaiting();
  };
  // Codex's code may come on its own line after the link (OpenCode's relay
  // sends it with the link: its codes take several shapes).
  const onDisplay = (text: string) => {
    if (browser || options.agentId === "opencode") return;
    const found = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/.exec(text)?.[1];
    if (found && found !== code) {
      code = found;
      awaiting();
    }
  };
  const onPrompt = () => {
    // The browser's own callback completes a browser login.
    if (browser) return;
    options.cancel();
    finish({ state: "failed", failure: "login_failed" });
  };
  const onFailed = (reason: string | undefined) => {
    const noLicense = reason === "no_license" && options.coreAcceptsNoLicense === true
      && options.agentId === "antigravity" && options.loginOption === "gemini-enterprise";
    finish({ state: "failed", failure: noLicense ? "no_license" : "login_failed" });
  };
  return {
    browser,
    emit(event: ControlLoginEvent): void {
      if (event.kind === "open_url") onOpenUrl(event);
      else if (event.kind === "display") onDisplay(event.text);
      else if (event.kind === "prompt") onPrompt();
      else if (event.kind === "completed") {
        finish({ state: "succeeded" });
        options.onSucceeded?.();
      } else if (event.kind === "failed") onFailed(event.reason);
    },
    /** The agent's login started: a browser login is awaiting the person at once. */
    started(): void {
      if (browser) awaiting();
    },
    fail(failure: Failure): void {
      finish({ state: "failed", failure });
    },
  };
}

/**
 * What a connector with OpenCode installed advertises on its `agent_runner`:
 * the free-models switch it reads from the desired configuration, and,
 * while the relay can carry a site-started login, `agent-login-opencode-v1`
 * with one capability per reviewed sign-in its OpenCode offers (a browser one
 * only where this machine can open a browser).
 */
export function openCodeRunnerCapabilities(input: { installed: boolean; relayReady: boolean; options: readonly AgentLoginOptionId[]; desktop: boolean }): string[] {
  if (!input.installed) return [];
  const capabilities: string[] = [REMOTE_OPENCODE_FREE_MODELS_CAPABILITY];
  if (!input.relayReady) return capabilities;
  const options = input.options.filter((id): id is OpenCodeLoginOptionId => id in OPENCODE_LOGIN_OPTIONS && (OPENCODE_LOGIN_OPTIONS[id as OpenCodeLoginOptionId].method !== "machine_browser" || input.desktop));
  if (options.length > 0) capabilities.push(REMOTE_AGENT_LOGIN_OPENCODE_CAPABILITY, ...options.map(openCodeLoginOptionCapability));
  return capabilities;
}

/**
 * What a connector with Google Antigravity advertises on its `agent_runner`:
 * while the relay can carry a site-started login and this
 * machine can open a browser, `agent-login-antigravity-v1` with one
 * capability per released sign-in (Gemini Enterprise; personal Google
 * sign-in is held back, A10). Nothing otherwise: whether Core takes 7.1
 * fields is the generic `core-contract-version-v1` signal (inventory.ts).
 */
export function antigravityRunnerCapabilities(input: { installed: boolean; relayReady: boolean; options: readonly AgentLoginOptionId[]; desktop: boolean }): string[] {
  if (!input.installed) return [];
  const capabilities: string[] = [];
  if (!input.relayReady || !input.desktop) return capabilities;
  const options = input.options.filter((id): id is AntigravityLoginOptionId => id in ANTIGRAVITY_LOGIN_OPTIONS && ANTIGRAVITY_LOGIN_OPTIONS[id as AntigravityLoginOptionId].released);
  if (options.length > 0) capabilities.push(REMOTE_AGENT_LOGIN_ANTIGRAVITY_CAPABILITY, ...options.map(antigravityLoginOptionCapability));
  return capabilities;
}
