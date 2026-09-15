import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteInstanceError } from "@konteks/remote-common";
import { buildReleaseFixture } from "@konteks/remote-release";
import { bundleServices, composeTemplatePath, createComposeRunner, loadComposeTemplate, readComposeProfiles, renderCompose, renderComposeEnv, runnerProfile, runnerService } from "../compose.js";
import { installPaths } from "../paths.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kr-compose-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixtureForTemplate() {
  const { digest } = await loadComposeTemplate();
  return buildReleaseFixture({ compose: { templateDigest: digest, configSchemaVersion: 1 } });
}

const platform = { os: "debian", architecture: "arm64" };

describe("compose rendering", () => {
  it("renders every image by digest, never by tag, and selects runner profiles per auth mode", async () => {
    const { manifest } = await fixtureForTemplate();
    const paths = installPaths(dir);
    const env = renderComposeEnv({
      release: manifest,
      paths,
      coreUrl: "https://core.example",
      relayUrl: "wss://relay.example/relay/runtime",
      agents: [
        { agentId: "codex", authMode: "gateway_keyed" },
        { agentId: "claude-code", authMode: "agent_local_subscription" },
      ],
      platform,
      bundleVersion: manifest.bundleVersion,
    });
    for (const line of env.split("\n").filter((entry) => entry.endsWith("_IMAGE") || /_IMAGE=/.test(entry))) {
      expect(line).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(line).not.toMatch(/:latest/);
    }
    expect(env).toContain("KONTEKS_PLATFORM_ARCH=arm64");
    expect(env).toContain("COMPOSE_PROFILES=runner-codex-keyed,runner-claude-code-subscription");
    expect(env).toContain("KONTEKS_RUNNER_CODEX_AUTH_MODE=gateway_keyed");
    expect(env).toContain("KONTEKS_RUNNER_URLS=codex=http://runner-codex:41840,claude-code=http://runner-claude-code:41840");
    // Bridges not selected still get an image line so the template interpolates, but no profile.
    expect(env).toContain("KONTEKS_RUNNER_PI_IMAGE=");
    expect(env).not.toContain("runner-pi-subscription");
    expect(env).toContain(`KONTEKS_STORES_DIR=${paths.stores}`);
  });

  it("names the keyed and subscription runner services and profiles", () => {
    expect(runnerService("codex", "gateway_keyed")).toBe("runner-codex-keyed");
    expect(runnerService("codex", "agent_local_subscription")).toBe("runner-codex");
    expect(runnerProfile("pi", "gateway_keyed")).toBe("runner-pi-keyed");
    expect(bundleServices([{ agentId: "pi", authMode: "gateway_keyed" }])).toContain("runner-pi-keyed");
    expect(bundleServices([])).toEqual(expect.arrayContaining(["harness-postgres", "supervisor", "preview-forwarder"]));
  });

  it("refuses an agent the release does not pin", async () => {
    const { manifest } = await fixtureForTemplate();
    expect(() =>
      renderComposeEnv({ release: manifest, paths: installPaths(dir), coreUrl: "https://core.example", relayUrl: null, agents: [{ agentId: "cline", authMode: "agent_local_subscription" }], platform, bundleVersion: manifest.bundleVersion }),
    ).toThrow(RemoteInstanceError);
  });

  it("fails closed with bundle_untrusted when the template digest does not match the signed manifest", async () => {
    const { manifest } = buildReleaseFixture(); // fixture digest is synthetic, so it never matches the shipped template
    const paths = installPaths(dir);
    await expect(renderCompose({ release: manifest, paths, coreUrl: "https://core.example", relayUrl: null, agents: [], platform, bundleVersion: manifest.bundleVersion })).rejects.toMatchObject({ code: "bundle_untrusted" });
    await expect(stat(paths.composeFile)).rejects.toThrow();
  });

  it("fails closed when the template on disk was tampered with", async () => {
    const { manifest } = await fixtureForTemplate();
    const tampered = join(dir, "compose.template.yaml");
    await writeFile(tampered, `${await readFile(composeTemplatePath(), "utf8")}\n# tampered\n`);
    const paths = installPaths(join(dir, "root"));
    await expect(renderCompose({ release: manifest, paths, coreUrl: "https://core.example", relayUrl: null, agents: [], platform, bundleVersion: manifest.bundleVersion }, tampered)).rejects.toMatchObject({ code: "bundle_untrusted" });
  });

  it("writes the verified template, a 0600 .env, and unique store credentials", async () => {
    const { manifest } = await fixtureForTemplate();
    const paths = installPaths(join(dir, "root"));
    const result = await renderCompose({ release: manifest, paths, coreUrl: "https://core.example", relayUrl: null, agents: [{ agentId: "pi", authMode: "gateway_keyed" }], platform, bundleVersion: manifest.bundleVersion });
    expect(result.templateDigest).toBe(manifest.compose.templateDigest);
    expect(await readFile(paths.composeFile, "utf8")).toBe(await readFile(composeTemplatePath(), "utf8"));
    if (process.platform !== "win32") {
      expect((await stat(paths.envFile)).mode & 0o777).toBe(0o600);
      expect((await stat(join(paths.stores, "valkey.password"))).mode & 0o777).toBe(0o600);
    }
    const first = await readFile(join(paths.stores, "harness-postgres.password"), "utf8");
    await renderCompose({ release: manifest, paths, coreUrl: "https://core.example", relayUrl: null, agents: [{ agentId: "pi", authMode: "gateway_keyed" }], platform, bundleVersion: manifest.bundleVersion });
    expect(await readFile(join(paths.stores, "harness-postgres.password"), "utf8")).toBe(first);
    expect(first).not.toBe(await readFile(join(paths.stores, "validation-postgres.password"), "utf8"));
    expect(await readComposeProfiles(paths)).toEqual(["runner-pi-keyed"]);
  });

  it("drives docker compose with a fixed project name, the rendered profiles, and a secret-free environment", async () => {
    const { manifest } = await fixtureForTemplate();
    const paths = installPaths(join(dir, "root"));
    await renderCompose({ release: manifest, paths, coreUrl: "https://core.example", relayUrl: null, agents: [{ agentId: "codex", authMode: "agent_local_subscription" }], platform, bundleVersion: manifest.bundleVersion });
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    process.env.KONTEKS_TEST_CANARY_SECRET = "kxrp_should_not_leak";
    const runner = createComposeRunner(paths, async (spec) => {
      calls.push({ command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env as Record<string, string> } : {}) });
      return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false } as never;
    });
    await runner.run(["ps"]);
    delete process.env.KONTEKS_TEST_CANARY_SECRET;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("docker");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["compose", "--project-name", "konteks-remote"]);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--profile", "runner-codex-subscription", "ps"]));
    expect(Object.keys(calls[0]?.env ?? {})).not.toContain("KONTEKS_TEST_CANARY_SECRET");
  });
});
