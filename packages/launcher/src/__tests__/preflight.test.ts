import { describe, expect, it } from "vitest";
import { buildReleaseFixture } from "@konteks/remote-release";
import type { runCommand } from "@konteks/remote-common";
import { assertPreflight, describePrivilegedSteps, dockerEngineSetupSteps, runDockerEngineSetup, runPreflight } from "../preflight.js";

type Run = typeof runCommand;

function fakeRun(table: Record<string, { code: number; stdout: string }>): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = async (spec) => {
    const key = [spec.command, ...spec.args].join(" ");
    calls.push(key);
    const hit = Object.entries(table).find(([prefix]) => key.startsWith(prefix));
    if (!hit) throw new Error(`ENOENT: ${key}`);
    return { code: hit[1].code, stdout: hit[1].stdout, stderr: "", signal: null, timedOut: false } as never;
  };
  return { run, calls };
}

const fetchOk: typeof fetch = async () => new Response("ok", { status: 200, headers: { date: new Date().toUTCString() } });

describe("preflight", () => {
  const { manifest } = buildReleaseFixture();

  it("fails closed with the official guidance when Docker is missing and never installs anything", async () => {
    const { run, calls } = fakeRun({});
    const result = await runPreflight({ platform: { os: "macos", architecture: "arm64", containerBackend: "docker_compose" }, release: manifest, coreUrl: "https://core.example", relayUrl: null, installRoot: "/", deps: { run, fetchFn: fetchOk } });
    expect(result.ok).toBe(false);
    const docker = result.checks.find((check) => check.id === "docker");
    expect(docker?.status).toBe("fail");
    expect(docker?.guidance).toContain("docs.docker.com");
    expect(docker?.guidance).toContain("licence");
    expect(calls.some((call) => /install|brew|apt/.test(call))).toBe(false);
    expect(() => assertPreflight(result)).toThrow(expect.objectContaining({ code: "prerequisite_missing" }));
  });

  it("passes with a supported Docker Desktop, Compose v2, reachable Core, and verified WSS", async () => {
    const { run } = fakeRun({
      "docker version": { code: 0, stdout: "27.1.1\n" },
      "docker info": { code: 0, stdout: "Docker Desktop\n" },
      "docker compose version": { code: 0, stdout: "2.29.0\n" },
    });
    const result = await runPreflight({ platform: { os: "macos", architecture: "arm64", containerBackend: "docker_compose" }, release: manifest, coreUrl: "https://core.example", relayUrl: "wss://relay.example/relay/runtime", installRoot: "/", deps: { run, fetchFn: fetchOk, probeWebSocket: async () => true } });
    expect(result.checks.find((check) => check.id === "docker")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "compose")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "relay")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "core")?.status).toBe("pass");
    expect(result.docker.desktop).toBe(true);
  });

  it("notes the HTTPS fallback (warn, not fail) when outbound WSS is blocked", async () => {
    const { run } = fakeRun({
      "docker version": { code: 0, stdout: "27.1.1\n" },
      "docker info": { code: 0, stdout: "Docker Desktop\n" },
      "docker compose version": { code: 0, stdout: "2.29.0\n" },
    });
    const result = await runPreflight({ platform: { os: "macos", architecture: "amd64", containerBackend: "docker_compose" }, release: manifest, coreUrl: "https://core.example", relayUrl: "wss://relay.example/relay/runtime", installRoot: "/", deps: { run, fetchFn: fetchOk, probeWebSocket: async () => false } });
    const relay = result.checks.find((check) => check.id === "relay");
    expect(relay?.status).toBe("warn");
    expect(relay?.detail).toContain("HTTPS");
  });

  it("rejects an old Engine, Windows on ARM, and a large clock skew", async () => {
    const { run } = fakeRun({
      "docker version": { code: 0, stdout: "20.10.0\n" },
      "docker info": { code: 0, stdout: "Debian GNU/Linux 12\n" },
      "docker compose version": { code: 0, stdout: "2.29.0\n" },
    });
    const skewed: typeof fetch = async () => new Response("ok", { status: 200, headers: { date: new Date(Date.now() - 10 * 60_000).toUTCString() } });
    const debian = await runPreflight({ platform: { os: "debian", architecture: "amd64", containerBackend: "docker_compose" }, release: manifest, coreUrl: "https://core.example", relayUrl: null, installRoot: "/", deps: { run, fetchFn: skewed } });
    expect(debian.checks.find((check) => check.id === "docker")?.status).toBe("fail");
    expect(debian.checks.find((check) => check.id === "clock")?.status).toBe("fail");
    const windows = await runPreflight({ platform: { os: "windows", architecture: "arm64", containerBackend: "docker_compose" }, release: manifest, coreUrl: "https://core.example", relayUrl: null, installRoot: "/", deps: { run, fetchFn: fetchOk } });
    expect(windows.checks.find((check) => check.id === "platform-arch")?.status).toBe("fail");
  });

  it("describes the Debian Engine steps verbatim and runs them only through the confirmed path", async () => {
    const steps = dockerEngineSetupSteps("bookworm");
    const lines = describePrivilegedSteps(steps);
    expect(lines).toHaveLength(steps.length);
    expect(lines.join("\n")).toContain("download.docker.com/linux/debian");
    expect(lines.join("\n")).toContain("docker-compose-plugin");
    expect(dockerEngineSetupSteps("evil; rm -rf /")[4]?.command.join(" ")).toContain("bookworm");
    const { run, calls } = fakeRun({ sudo: { code: 0, stdout: "" }, "apt-get": { code: 0, stdout: "" }, install: { code: 0, stdout: "" }, curl: { code: 0, stdout: "" }, chmod: { code: 0, stdout: "" }, sh: { code: 0, stdout: "" }, systemctl: { code: 0, stdout: "" } });
    await runDockerEngineSetup(steps, run);
    expect(calls).toHaveLength(steps.length);
    const failing = fakeRun({ sudo: { code: 1, stdout: "" }, "apt-get": { code: 1, stdout: "" } });
    await expect(runDockerEngineSetup(steps, failing.run)).rejects.toMatchObject({ code: "prerequisite_missing" });
    expect(failing.calls).toHaveLength(1);
  });
});
