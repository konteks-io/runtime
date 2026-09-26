import { chmod, chown, mkdir, writeFile } from "node:fs/promises";
import { RemoteInstanceError, SupervisorStatusSchema, SystemClock, createLogger, type Logger } from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, type EmbeddedReleaseRoot, type ReleaseManifest } from "@konteks/remote-release";
import { CoreClient, SupervisorStore, runActivationExchange } from "@konteks/remote-supervisor";
import { bundleServices, createComposeRunner, pullServices, renderCompose, type AgentAuthMode, type AgentSelection, type ComposeRunner } from "../compose.js";
import { SupervisorControl } from "../control.js";
import { InstallStateFile, advance, initialInstallState, phaseReached, resumePhase, type InstallState } from "../install-state.js";
import type { Output } from "../output.js";
import { defaultInstallRoot, detectPlatform, installPaths, volumeDirectories, type HostPlatform } from "../paths.js";
import { assertPreflight, debianCodename, describePrivilegedSteps, dockerEngineSetupSteps, runDockerEngineSetup, runPreflight, type PreflightDeps } from "../preflight.js";
import { confirm, promptSecret } from "../prompt.js";
import { fetchReleaseManifest, persistReleaseArtifacts } from "../release-fetch.js";

/**
 * `konteks-remote install --activation-id <id>`: the resumable one-command
 * lifecycle from installation-and-auth.md.
 *
 *   preflight → exchange (secure prompt; BEFORE any image pull) → verify the
 *   exchange manifest against the embedded root AND the independently fetched
 *   signed release manifest → persist verified artifacts → render Compose
 *   (template digest checked) → pull by digest → start stores, gateway,
 *   runners, both domain components → wait for health → the supervisor
 *   submits signed readiness → active.
 *
 * Reruns resume from the last durable phase; the same instance key and
 * exchange nonce are reused so an interrupted exchange cannot create a
 * duplicate identity. The activation code exists only inside the prompt
 * closure and is never printed, persisted, or passed to a child process.
 */
export const DEFAULT_AGENTS = Object.freeze(["claude-code", "codex"] as const);

export interface InstallOptions {
  activationId: string;
  coreUrl: string;
  relayUrl: string | null;
  root?: string;
  agents?: string[];
  gatewayKeyedAgents?: string[];
  /** Debian only: show the exact privileged Docker Engine steps and run them after explicit confirmation. */
  setupDockerEngine?: boolean;
  output: Output;
  deps?: {
    platform?: HostPlatform;
    release?: ReleaseManifest;
    roots?: readonly EmbeddedReleaseRoot[];
    compose?: ComposeRunner;
    control?: Pick<SupervisorControl, "call">;
    preflight?: PreflightDeps;
    readActivationCode?: () => Promise<string>;
    confirm?: (question: string) => Promise<boolean>;
    fetchFn?: typeof fetch;
    now?: () => number;
    logger?: Logger;
    templatePath?: string;
    /** Test hook: stop after `configured` without starting containers. */
    skipStart?: boolean;
    sleepMs?: (ms: number) => Promise<void>;
  };
}

export function selectAgents(agents: readonly string[] | undefined, gatewayKeyed: readonly string[] | undefined): AgentSelection[] {
  const ids = agents ?? [...DEFAULT_AGENTS];
  const keyed = new Set(gatewayKeyed ?? []);
  for (const agentId of keyed) {
    if (!ids.includes(agentId)) throw new RemoteInstanceError("agent_unavailable", `--gateway-keyed names ${agentId}, which is not in the installed agent set`);
  }
  return ids.map((agentId) => ({ agentId, authMode: (keyed.has(agentId) ? "gateway_keyed" : "agent_local_subscription") as AgentAuthMode }));
}

/** Creates the restricted root and every per-component volume (0700); on Linux, assigns the container uids when running as root. */
export async function prepareInstallRoot(paths: ReturnType<typeof installPaths>, platform: HostPlatform, agentIds: readonly string[], output: Output): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700).catch(() => undefined);
  for (const dir of [paths.composeDir, paths.backups, paths.stores]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirs = volumeDirectories(paths, agentIds);
  for (const dir of dirs) await mkdir(dir.path, { recursive: true, mode: 0o700 });
  if (platform.os === "debian") {
    const isRoot = process.getuid?.() === 0;
    for (const dir of dirs) {
      if (isRoot) await chown(dir.path, dir.uid, dir.gid).catch(() => undefined);
    }
    if (!isRoot) output.line("note: not running as root; container volume ownership was not assigned. If a component fails to write its volume, rerun `install` with sudo once (this is the only privileged step besides the service install).");
  }
}

export async function install(options: InstallOptions): Promise<InstallState> {
  const logger = options.deps?.logger ?? createLogger({ name: "launcher-install" });
  const clock = new SystemClock();
  const platform = options.deps?.platform ?? detectPlatform();
  const paths = installPaths(options.root ?? defaultInstallRoot(platform.os));
  const stateFile = new InstallStateFile(paths.installState);
  const now = (): string => new Date(options.deps?.now?.() ?? Date.now()).toISOString();
  const sleep = options.deps?.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ask = options.deps?.confirm ?? ((question: string) => confirm(question));

  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const existing = await stateFile.read();
  if (existing && existing.activationId !== options.activationId && existing.phase !== "preflight") {
    throw new RemoteInstanceError("registration_mismatch", "an install for a different activation is already in progress here; finish it or run `konteks-remote uninstall` first", { recoveryActions: [{ kind: "revoke_in_app" }] });
  }
  const agents = existing && existing.agents.length > 0 ? existing.agents : selectAgents(options.agents, options.gatewayKeyedAgents);
  let state = existing ?? initialInstallState(options.activationId, now(), agents);
  if (state.phase === "failed") {
    options.output.line(`previous attempt failed (${state.lastError ?? "unknown"}); resuming from ${resumePhase(state)}`);
    state = { ...state, phase: resumePhase(state), lastError: null };
  }
  const persist = async (next: InstallState): Promise<InstallState> => {
    state = next;
    await stateFile.write(next);
    return next;
  };
  const fail = async (error: unknown): Promise<never> => {
    const message = error instanceof Error ? error.message : String(error);
    await persist(advance(state, "failed", now(), { lastError: message.slice(0, 512) }));
    throw error;
  };

  await prepareInstallRoot(paths, platform, agents.map((agent) => agent.agentId), options.output);

  const roots = options.deps?.roots ?? EMBEDDED_RELEASE_ROOTS;
  const release = options.deps?.release ?? (await fetchReleaseManifest({ roots, ...(options.deps?.fetchFn ? { fetchFn: options.deps.fetchFn } : {}), ...(options.deps?.now ? { now: options.deps.now } : {}) }));

  // Phase: preflight (always re-run; cheap and the environment may have changed).
  let preflight = await runPreflight({ platform, release, coreUrl: options.coreUrl, relayUrl: options.relayUrl, installRoot: paths.root, ...(options.deps?.preflight ? { deps: options.deps.preflight } : {}) });
  if (!preflight.ok && options.setupDockerEngine && platform.os === "debian" && preflight.checks.some((check) => check.id === "docker" && check.status === "fail")) {
    const steps = dockerEngineSetupSteps(await debianCodename(options.deps?.preflight?.run));
    options.output.line("Docker Engine is missing. The following privileged changes would be made (Docker's official apt instructions):");
    for (const line of describePrivilegedSteps(steps)) options.output.line(`  ${line}`);
    const ok = await ask("Run these privileged steps now?");
    if (!ok) throw new RemoteInstanceError("prerequisite_missing", "Docker Engine setup declined; install it yourself and rerun", { recoveryActions: [{ kind: "install_backend" }] });
    await runDockerEngineSetup(steps, options.deps?.preflight?.run);
    preflight = await runPreflight({ platform, release, coreUrl: options.coreUrl, relayUrl: options.relayUrl, installRoot: paths.root, ...(options.deps?.preflight ? { deps: options.deps.preflight } : {}) });
  }
  for (const check of preflight.checks) options.output.line(`[${check.status.padEnd(4)}] ${check.id}: ${check.detail}${check.guidance ? ` — ${check.guidance}` : ""}`);
  assertPreflight(preflight);

  // Phase: exchange BEFORE any image pull. The supervisor's store is written
  // directly by the launcher here (same restricted volume, same key file), so
  // the supervisor container later finds its identity and provisioning record.
  const store = new SupervisorStore(paths.supervisorData);
  await store.init();
  if (!phaseReached(state, "exchanged")) {
    try {
      const key = await store.loadOrCreateInstanceKey();
      const core = new CoreClient({ baseUrl: options.coreUrl, clock, key: () => key, credential: () => null, ...(options.deps?.fetchFn ? { fetchFn: options.deps.fetchFn } : {}) });
      const outcome = await runActivationExchange({
        store,
        core,
        clock,
        key,
        activationId: options.activationId,
        readActivationCode: options.deps?.readActivationCode ?? (() => promptSecret({ label: "Activation code", minLength: 8 })),
        platform,
        release,
        roots,
        logger,
      });
      state = await persist(advance(state, "exchanged", now(), { instanceId: outcome.instanceId, bundleVersion: release.bundleVersion, manifestDigest: outcome.manifestDigest, provisioningWindowExpiresAt: outcome.provisioningWindowExpiresAt }));
      options.output.line(`activated: instance ${outcome.instanceId} is provisioning (window until ${outcome.provisioningWindowExpiresAt})`);
    } catch (error) {
      await fail(error);
    }
  } else {
    options.output.line(`resuming install for instance ${state.instanceId} (phase ${state.phase})`);
  }

  // Phase: verified — the exchange manifest was verified against root + release during exchange; persist the artifacts the containers read.
  if (!phaseReached(state, "verified")) {
    if (state.bundleVersion !== null && state.bundleVersion !== release.bundleVersion) {
      await fail(new RemoteInstanceError("bundle_untrusted", "the release manifest changed bundle version since activation; rerun with a fresh activation", { recoveryActions: [{ kind: "new_activation" }] }));
    }
    await persistReleaseArtifacts(paths, release, roots);
    await writeFile(`${paths.gatewayConfig}/egress-allowlist.json`, `${JSON.stringify(release.egressAllowlist)}\n`, { mode: 0o600 });
    await writeFile(`${paths.gatewayConfig}/instance-id`, `${state.instanceId ?? ""}\n`, { mode: 0o600 });
    state = await persist(advance(state, "verified", now()));
  }

  // Phase: configured — render Compose (template digest checked against the manifest; fails closed).
  try {
    await renderCompose({ release, paths, coreUrl: options.coreUrl, relayUrl: options.relayUrl, agents, platform, bundleVersion: release.bundleVersion }, options.deps?.templatePath);
  } catch (error) {
    await fail(error);
  }
  const compose = options.deps?.compose ?? createComposeRunner(paths);

  // Phase: pulled — by digest, resumable per service.
  if (!phaseReached(state, "pulled")) {
    const services = bundleServices(agents).filter((service) => !state.pulledImages.includes(service));
    try {
      await pullServices(compose, services, async (service) => {
        state = await persist({ ...state, pulledImages: [...state.pulledImages, service], updatedAt: now() });
        options.output.line(`pulled ${service}`);
      });
    } catch (error) {
      await fail(error);
    }
    state = await persist(advance(state, "pulled", now()));
  }
  state = await persist(advance(state, "configured", now()));

  if (options.deps?.skipStart) return state;

  // Phase: started — stores, gateway, runners, domain components; then wait for health.
  const up = await compose.run(["up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", String(release.healthGates.startupTimeoutSeconds)], { timeoutMs: (release.healthGates.startupTimeoutSeconds + 60) * 1_000 });
  if (up.code !== 0) {
    await fail(new RemoteInstanceError("temporarily_unavailable", "the bundle did not start healthy; run `konteks-remote logs` and `konteks-remote doctor`", { recoveryActions: [{ kind: "run_doctor" }, { kind: "retry" }] }));
  }
  state = await persist(advance(state, "started", now()));

  // Phase: ready — the supervisor submits signed readiness once all four components are healthy.
  const control = options.deps?.control ?? new SupervisorControl(paths);
  const deadline = (options.deps?.now?.() ?? Date.now()) + release.healthGates.startupTimeoutSeconds * 1_000;
  let kicked = false;
  for (;;) {
    let status;
    try {
      status = await control.call({ op: kicked ? "status" : "readiness.submit" }, SupervisorStatusSchema, { timeoutMs: 60_000 });
      kicked = true;
    } catch (error) {
      if ((options.deps?.now?.() ?? Date.now()) > deadline) await fail(error);
      await sleep(5_000);
      continue;
    }
    if (status.administrativeStatus === "active") {
      state = await persist(advance(state, "ready", now()));
      options.output.line(`ready: runtime ${status.instanceId} is active; log in your agents with \`konteks-remote auth login <agent>\` and tag roles in the Konteks App or MCP`);
      return state;
    }
    if ((options.deps?.now?.() ?? Date.now()) > deadline) {
      await fail(new RemoteInstanceError("temporarily_unavailable", "components did not become healthy before the startup gate; the install can be rerun", { recoveryActions: [{ kind: "run_doctor" }, { kind: "retry" }] }));
    }
    await sleep(5_000);
  }
}
