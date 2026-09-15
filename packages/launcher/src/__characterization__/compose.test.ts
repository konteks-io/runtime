import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "@konteks/remote-common";
import { buildReleaseFixture } from "@konteks/remote-release";
import { createComposeRunner, loadComposeTemplate, renderCompose } from "../compose.js";
import { installPaths, volumeDirectories } from "../paths.js";
import { prepareInstallRoot } from "../commands/install.js";
import { createOutput } from "../output.js";

/**
 * Characterization of Docker Compose behaviour against the shipped template
 * (CP2 "Characterization tests first"): resolved configuration, restart
 * policies, dependency health conditions, volume modes, network isolation,
 * architecture selection, and profile selection. Opt-in: needs a running
 * Docker Compose v2 (`REMOTE_INSTANCE_CHARACTERIZE=1`). It only runs
 * `docker compose config` — nothing is pulled or started here; the
 * interrupted-pull and restart cases are exercised by the launcher's unit
 * tests through the ComposeRunner seam and by the CP7 platform matrix.
 */
let dir = "";
let available = false;
let resolved: Record<string, unknown> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-compose-char-"));
  try {
    const version = await runCommand({ command: "docker", args: ["compose", "version", "--short"], timeoutMs: 15_000 });
    available = version.code === 0;
  } catch {
    available = false;
  }
  if (!available) return;
  const paths = installPaths(join(dir, "root"));
  await prepareInstallRoot(paths, { os: "debian", architecture: process.arch === "arm64" ? "arm64" : "amd64", containerBackend: "docker_compose" }, ["codex", "pi"], createOutput({ json: true }));
  const { digest } = await loadComposeTemplate();
  const { manifest } = buildReleaseFixture({ compose: { templateDigest: digest, configSchemaVersion: 1 } });
  await renderCompose({
    release: manifest,
    paths,
    coreUrl: "https://core.example",
    relayUrl: "wss://relay.example/relay/runtime",
    agents: [
      { agentId: "codex", authMode: "agent_local_subscription" },
      { agentId: "pi", authMode: "gateway_keyed" },
    ],
    platform: { os: "debian", architecture: process.arch === "arm64" ? "arm64" : "amd64" },
    bundleVersion: manifest.bundleVersion,
  });
  const runner = createComposeRunner(paths);
  const config = await runner.run(["config", "--format", "json"], { timeoutMs: 60_000 });
  expect(config.code, config.stderr).toBe(0);
  resolved = JSON.parse(config.stdout) as Record<string, unknown>;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Service = { image: string; restart?: string; read_only?: boolean; cap_drop?: string[]; networks?: Record<string, unknown>; depends_on?: Record<string, { condition: string }>; volumes?: Array<{ type: string; source?: string; target: string; read_only?: boolean }>; platform?: string; profiles?: string[]; network_mode?: string; user?: string };

function services(): Record<string, Service> {
  return (resolved.services ?? {}) as Record<string, Service>;
}

describe.skipIf(!available)("docker compose resolves the shipped template", () => {
  it("selects exactly the profiled runners and resolves every image by digest", () => {
    const names = Object.keys(services());
    expect(names).toContain("runner-codex");
    expect(names).toContain("runner-pi-keyed");
    expect(names).not.toContain("runner-pi");
    expect(names).not.toContain("runner-claude-code");
    for (const [name, service] of Object.entries(services())) expect(service.image, name).toMatch(/@sha256:[a-f0-9]{64}$/);
  });

  it("applies restart policy, read-only root, dropped capabilities, non-root user, and the platform architecture to every service", () => {
    for (const [name, service] of Object.entries(services())) {
      expect(service.restart, name).toBe("unless-stopped");
      expect(service.read_only, name).toBe(true);
      expect(service.cap_drop, name).toEqual(["ALL"]);
      expect(service.user, name).toBeTruthy();
      expect(service.user, name).not.toMatch(/^(0|root)(:|$)/);
      if (!service.network_mode) expect(service.platform, name).toMatch(/^linux\/(amd64|arm64)$/);
    }
  });

  it("isolates networks: keyed runners reach only control + keyed, the gateway bridges keyed to egress, the browser tool has no egress", () => {
    const keyed = services()["runner-pi-keyed"]!;
    expect(Object.keys(keyed.networks ?? {}).sort()).toEqual(["control", "keyed"]);
    const subscription = services()["runner-codex"]!;
    expect(Object.keys(subscription.networks ?? {}).sort()).toEqual(["control", "egress"]);
    expect(Object.keys(services().gateway!.networks ?? {}).sort()).toEqual(["control", "egress", "keyed"]);
    expect(Object.keys(services()["browser-tool"]!.networks ?? {})).toEqual(["control"]);
    const networks = resolved.networks as Record<string, { internal?: boolean }>;
    expect(networks.control?.internal).toBe(true);
    expect(networks.keyed?.internal).toBe(true);
    expect(networks.stores?.internal).toBe(true);
    expect(networks.egress?.internal).toBeFalsy();
    expect(services()["preview-forwarder"]!.network_mode).toBe("service:validation-runtime");
  });

  it("mounts each volume for exactly one service, read-only where the contract says so, and never the Docker socket", () => {
    const owners = new Map<string, string[]>();
    for (const [name, service] of Object.entries(services())) {
      for (const volume of service.volumes ?? []) {
        expect(volume.source ?? "", `${name} ${volume.target}`).not.toContain("docker.sock");
        if (volume.type !== "bind" || !volume.source) continue;
        owners.set(volume.source, [...(owners.get(volume.source) ?? []), name]);
      }
    }
    const paths = installPaths(join(dir, "root"));
    expect(owners.get(paths.supervisorData)).toEqual(["supervisor"]);
    expect(owners.get(paths.credentials("codex"))).toEqual(["runner-codex"]);
    expect(owners.get(paths.credentials("pi"))).toEqual(["runner-pi-keyed"]);
    const checkouts = services()["validation-runtime"]!.volumes?.find((volume) => volume.target === "/checkouts");
    expect(checkouts?.read_only).toBe(true);
    const gatewayConfig = services().gateway!.volumes?.find((volume) => volume.target === "/etc/konteks");
    expect(gatewayConfig?.read_only).toBe(true);
    for (const volume of volumeDirectories(paths, ["codex", "pi"])) expect([...owners.keys()].some((source) => source.startsWith(volume.path) || volume.path.startsWith(source)), volume.path).toBe(true);
  });

  it("gates dependencies on health: supervisor after gateway+sysmon, components after stores+supervisor, runners after supervisor", () => {
    expect(services().supervisor!.depends_on?.gateway?.condition).toBe("service_healthy");
    expect(services().harness!.depends_on?.["harness-postgres"]?.condition).toBe("service_healthy");
    expect(services().harness!.depends_on?.supervisor?.condition).toBe("service_healthy");
    expect(services()["runner-codex"]!.depends_on?.supervisor?.condition).toBe("service_healthy");
  });
});
