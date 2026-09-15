import { freemem, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { RemoteInstanceError, runCommand, type CommandResult } from "@konteks/remote-common";
import type { ReleaseManifest } from "@konteks/remote-release";
import { compareSemver } from "@konteks/remote-supervisor";
import type { HostPlatform } from "./paths.js";

/**
 * Dependency preflight (installation-and-auth.md "Preflight and supported
 * matrix"). It never installs or accepts Docker Desktop, WSL, virtualization,
 * or licences; it reports exactly what is missing with the official guidance
 * and stops. On Debian an optional Engine setup path exists only behind an
 * explicit privileged confirmation, elsewhere.
 */
export interface PreflightCheck {
  id: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  guidance?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  docker: { version: string | null; composeVersion: string | null; desktop: boolean };
}

export interface PreflightDeps {
  run?: typeof runCommand;
  fetchFn?: typeof fetch;
  probeWebSocket?: (url: string) => Promise<boolean>;
  now?: () => number;
    /** Free-space probe; tests inject one so a small host disk never fails the suite. */
    statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
}

const DOCKER_DESKTOP_GUIDANCE = "Install and start Docker Desktop from https://docs.docker.com/get-started/get-docker/ and accept its licence terms yourself (professional use may require a paid subscription: https://docs.docker.com/subscription/desktop-license/). Then rerun this command.";
const DOCKER_ENGINE_GUIDANCE = "Install Docker Engine + Compose v2 from https://docs.docker.com/engine/install/debian/ (or rerun `install` with --setup-docker-engine to see the exact privileged steps and confirm them).";

/**
 * The optional Debian Engine setup path (installation-and-auth.md): the exact
 * privileged changes are SHOWN and must be confirmed explicitly before any of
 * them runs. They follow Docker's official apt instructions; nothing here
 * accepts a licence, installs Docker Desktop, or touches WSL/virtualization.
 */
export interface PrivilegedStep {
  description: string;
  command: string[];
}

export function dockerEngineSetupSteps(codename: string): PrivilegedStep[] {
  const safeCodename = /^[a-z]+$/.test(codename) ? codename : "bookworm";
  return [
    { description: "install prerequisites for Docker's apt repository", command: ["apt-get", "install", "-y", "ca-certificates", "curl"] },
    { description: "create the apt keyring directory", command: ["install", "-m", "0755", "-d", "/etc/apt/keyrings"] },
    { description: "download Docker's signing key to /etc/apt/keyrings/docker.asc", command: ["curl", "-fsSL", "https://download.docker.com/linux/debian/gpg", "-o", "/etc/apt/keyrings/docker.asc"] },
    { description: "make the signing key world-readable", command: ["chmod", "a+r", "/etc/apt/keyrings/docker.asc"] },
    {
      description: "add Docker's apt repository to /etc/apt/sources.list.d/docker.list",
      command: ["sh", "-c", `printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian %s stable\n' "$(dpkg --print-architecture)" "${safeCodename}" > /etc/apt/sources.list.d/docker.list`],
    },
    { description: "refresh apt metadata", command: ["apt-get", "update"] },
    { description: "install Docker Engine, CLI, containerd, and the Compose v2 plugin", command: ["apt-get", "install", "-y", "docker-ce", "docker-ce-cli", "containerd.io", "docker-compose-plugin"] },
    { description: "enable and start the Docker service", command: ["systemctl", "enable", "--now", "docker"] },
  ];
}

export function describePrivilegedSteps(steps: PrivilegedStep[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step.description}\n     $ ${step.command.join(" ")}`);
}

/** Runs the confirmed steps as root (via sudo when not already root); stops at the first failure. */
export async function runDockerEngineSetup(steps: PrivilegedStep[], run: typeof runCommand = runCommand): Promise<void> {
  const asRoot = process.getuid?.() === 0;
  for (const step of steps) {
    const command = asRoot ? step.command : ["sudo", "--", ...step.command];
    const [executable, ...args] = command;
    const result = await run({ command: executable ?? "sudo", args, timeoutMs: 20 * 60_000 });
    if (result.code !== 0) {
      throw new RemoteInstanceError("prerequisite_missing", `Docker Engine setup step failed: ${step.description}`, { recoveryActions: [{ kind: "install_backend" }] });
    }
  }
}

export async function debianCodename(run: typeof runCommand = runCommand): Promise<string> {
  try {
    const result = await run({ command: "sh", args: ["-c", ". /etc/os-release && printf '%s' \"$VERSION_CODENAME\""], timeoutMs: 5_000 });
    return result.code === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : "bookworm";
  } catch {
    return "bookworm";
  }
}

export async function runPreflight(args: { platform: HostPlatform; release: ReleaseManifest; coreUrl: string; relayUrl: string | null; installRoot: string; deps?: PreflightDeps }): Promise<PreflightResult> {
  const run = args.deps?.run ?? runCommand;
  const fetchFn = args.deps?.fetchFn ?? fetch;
  const checks: PreflightCheck[] = [];
  const minimums = args.release.minimums;

  checks.push({ id: "platform", status: "pass", detail: `${args.platform.os}/${args.platform.architecture} via ${args.platform.containerBackend}` });
  if (args.platform.os === "windows" && args.platform.architecture !== "amd64") {
    checks.push({ id: "platform-arch", status: "fail", detail: "Windows on ARM is not supported" });
  }

  const docker = await tryVersion(run, "docker", ["version", "--format", "{{.Server.Version}}"]);
  const desktop = docker !== null && (await isDockerDesktop(run));
  if (docker === null) {
    checks.push({ id: "docker", status: "fail", detail: "Docker is not installed or not running", guidance: args.platform.os === "debian" ? DOCKER_ENGINE_GUIDANCE : DOCKER_DESKTOP_GUIDANCE });
  } else {
    const minimum = args.platform.os === "debian" ? minimums.dockerEngine : minimums.dockerDesktop;
    const ok = compareSemver(docker, minimum) >= 0;
    checks.push({ id: "docker", status: ok ? "pass" : "fail", detail: `Docker ${docker}${desktop ? " (Desktop)" : " (Engine)"}`, ...(ok ? {} : { guidance: `Docker ${minimum} or newer is required.` }) });
    if (args.platform.os !== "debian" && !desktop) {
      checks.push({ id: "docker-backend", status: "warn", detail: "a non-Desktop Docker backend was detected; only Docker Desktop is supported on this OS" });
    }
  }
  const compose = await tryVersion(run, "docker", ["compose", "version", "--short"]);
  if (compose === null) {
    checks.push({ id: "compose", status: "fail", detail: "Docker Compose v2 is not available", guidance: "Compose v2 ships with Docker Desktop and the docker-compose-plugin package." });
  } else {
    const ok = compareSemver(compose, minimums.compose) >= 0;
    checks.push({ id: "compose", status: ok ? "pass" : "fail", detail: `Compose ${compose}` });
  }
  if (args.platform.os === "windows") {
    const wsl = await tryVersion(run, "wsl", ["--version"]);
    checks.push({ id: "wsl", status: wsl === null ? "fail" : "pass", detail: wsl === null ? "WSL2 is not available" : "WSL2 available", ...(wsl === null ? { guidance: "Enable WSL2 yourself following https://learn.microsoft.com/windows/wsl/install; the launcher never enables virtualization or WSL." } : {}) });
  }

  const memory = totalmem();
  checks.push({ id: "memory", status: memory >= minimums.memoryBytes ? "pass" : "fail", detail: `${Math.round(memory / 1024 ** 3)} GiB total (${Math.round(freemem() / 1024 ** 3)} GiB free)`, ...(memory >= minimums.memoryBytes ? {} : { guidance: `${Math.round(minimums.memoryBytes / 1024 ** 3)} GiB of memory is required.` }) });
  try {
    const probe = args.deps?.statfs ?? statfs;
    const disk = await probe(args.installRoot).catch(() => probe("/"));
    const free = Number(disk.bavail) * Number(disk.bsize);
    checks.push({ id: "disk", status: free >= minimums.diskBytes ? "pass" : "fail", detail: `${Math.round(free / 1024 ** 3)} GiB free`, ...(free >= minimums.diskBytes ? {} : { guidance: `${Math.round(minimums.diskBytes / 1024 ** 3)} GiB of free disk is required before pull/update.` }) });
  } catch {
    checks.push({ id: "disk", status: "warn", detail: "free disk could not be measured" });
  }

  const now = args.deps?.now?.() ?? Date.now();
  try {
    const response = await fetchFn(new URL("/health", args.coreUrl), { method: "GET", signal: AbortSignal.timeout(10_000) });
    const serverDate = Date.parse(response.headers.get("date") ?? "");
    const skew = Number.isFinite(serverDate) ? Math.abs(serverDate - now) : 0;
    checks.push({ id: "core", status: "pass", detail: `Core reachable over TLS (HTTP ${response.status})` });
    checks.push({ id: "clock", status: skew > 120_000 ? "fail" : "pass", detail: skew > 120_000 ? `clock skew of ${Math.round(skew / 1000)} s from Core` : "clock within tolerance", ...(skew > 120_000 ? { guidance: "Synchronise the system clock (NTP) and rerun." } : {}) });
  } catch (error) {
    checks.push({ id: "core", status: "fail", detail: `Core is not reachable: ${error instanceof Error ? error.message : String(error)}`, guidance: "Check DNS, outbound HTTPS, and TLS interception on this network." });
  }
  if (args.relayUrl) {
    const reachable = args.deps?.probeWebSocket ? await args.deps.probeWebSocket(args.relayUrl) : await probeWebSocket(args.relayUrl);
    checks.push({ id: "relay", status: reachable ? "pass" : "warn", detail: reachable ? "outbound WSS to the relay verified" : "outbound WSS to the relay is blocked; the runtime will fall back to HTTPS polling", ...(reachable ? {} : { guidance: "Allow outbound WebSocket (443) to the Konteks relay for low-latency sessions." }) });
  }

  const ok = checks.every((check) => check.status !== "fail");
  return { ok, checks, docker: { version: docker, composeVersion: compose, desktop } };
}

async function tryVersion(run: typeof runCommand, command: string, args: string[]): Promise<string | null> {
  let result: CommandResult;
  try {
    result = await run({ command, args, timeoutMs: 15_000 });
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout);
  return match?.[1] ?? null;
}

async function isDockerDesktop(run: typeof runCommand): Promise<boolean> {
  try {
    const result = await run({ command: "docker", args: ["info", "--format", "{{.OperatingSystem}}"], timeoutMs: 15_000 });
    return /desktop/i.test(result.stdout);
  } catch {
    return false;
  }
}

async function probeWebSocket(url: string): Promise<boolean> {
  try {
    const { WebSocket: NodeWebSocket } = await import("ws");
    return await new Promise<boolean>((resolve) => {
      const socket = new NodeWebSocket(url);
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(false);
      }, 8_000);
      socket.once("open", () => {
        clearTimeout(timer);
        socket.close();
        resolve(true);
      });
      socket.once("unexpected-response", () => {
        clearTimeout(timer);
        resolve(true); // the relay answered (it rejects an unauthenticated open); the path is open
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

export function assertPreflight(result: PreflightResult): void {
  if (result.ok) return;
  const failures = result.checks.filter((check) => check.status === "fail");
  throw new RemoteInstanceError("prerequisite_missing", failures.map((check) => `${check.id}: ${check.detail}${check.guidance ? ` — ${check.guidance}` : ""}`).join("\n"), {
    recoveryActions: failures.some((check) => check.id === "docker") ? [{ kind: "install_backend" }] : [{ kind: "run_doctor" }],
  });
}
