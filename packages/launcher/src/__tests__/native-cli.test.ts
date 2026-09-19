import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeProgram, installedReleaseVersion } from "../native/cli.js";

function fixture() {
  const actions = { install: vi.fn(async () => {}), addAgent: vi.fn(async () => {}), serve: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), update: vi.fn(async () => {}), uninstall: vi.fn(async () => {}), control: vi.fn(async () => {}) };
  const program = createNativeProgram(actions).exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  return { program, actions };
}

describe("native customer entry point", () => {
  it("exposes native lifecycle without a BYOK or appliance command", () => {
    const { program } = fixture();
    expect(program.commands.map(command => command.name())).toEqual(expect.arrayContaining(["install", "serve", "start", "stop", "status", "agents", "auth"]));
    expect(program.commands.map(command => command.name())).not.toContain("gateway");
    expect(program.helpInformation()).not.toMatch(/Docker|Compose|gateway-keyed/);
  });
  it("offers an uninstall an agent can find in --help (W1-L2)", async () => {
    const { program, actions } = fixture();
    expect(program.helpInformation()).toMatch(/uninstall\s+remove Konteks from this machine/);
    await program.parseAsync(["--json", "uninstall"], { from: "user" });
    expect(actions.uninstall).toHaveBeenCalledWith(expect.objectContaining({ root: expect.any(String) }));
  });
  it("runs the native service command used by all OS service definitions", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["serve", "--root", "/private/native-root"], { from: "user" });
    expect(actions.serve).toHaveBeenCalledWith(expect.objectContaining({ root: "/private/native-root" }));
    expect(actions.install).not.toHaveBeenCalled();
  });
  it("routes install to native activation without passing a secret or appliance switches", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "install", "--activation-id", "activation-123", "--agents", "codex", "--core-url", "https://core.example", "--relay-url", "wss://relay.example/runtime"], { from: "user" });
    expect(actions.install).toHaveBeenCalledWith(expect.objectContaining({ activationId: "activation-123", agents: ["codex"], root: "/private/native-root" }));
    expect(actions.install.mock.calls[0]?.[0]).not.toHaveProperty("activationCode");
  });
  it.each(["--setup-docker-engine", "--gateway-keyed", "--activation-code"])("rejects retired/secret install switch %s", async option => {
    const { program, actions } = fixture();
    await expect(program.parseAsync(["install", "--activation-id", "activation-123", option], { from: "user" })).rejects.toThrow();
    expect(actions.install).not.toHaveBeenCalled();
  });
  it("routes official login and organization attestation through native control", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["auth", "login", "codex", "--organization"], { from: "user" });
    expect(actions.control).toHaveBeenCalledWith(expect.objectContaining({ operation: "auth.login", agent: "codex", organization: true }));
  });
  it("reports the installed release as its version, so it matches status after an update (W1-L4)", async () => {
    const root = await mkdtemp(join(tmpdir(), "konteks-version-"));
    try {
      expect(installedReleaseVersion(root)).toBeNull();
      await writeFile(join(root, "native-runtime.json"), JSON.stringify({ releaseId: "release-next", bundleVersion: "0.5.1" }));
      expect(installedReleaseVersion(root)).toBe("0.5.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("exposes update as a native transaction with check-only and unattended forms", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "update"], { from: "user" });
    expect(actions.update).toHaveBeenLastCalledWith(expect.objectContaining({ root: "/private/native-root", check: false, unattended: false }));
    await program.parseAsync(["--root", "/private/native-root", "--json", "update", "--unattended"], { from: "user" });
    expect(actions.update).toHaveBeenLastCalledWith(expect.objectContaining({ unattended: true, check: false }));
    await program.parseAsync(["update", "--check"], { from: "user" });
    expect(actions.update).toHaveBeenLastCalledWith(expect.objectContaining({ check: true }));
    expect(program.commands.map(command => command.name())).not.toContain("rollback");
  });
  it("adds an agent to the installed runtime without asking for activation material", async () => {
    const { program, actions } = fixture();
    await program.parseAsync(["--root", "/private/native-root", "agent", "add", "codex"], { from: "user" });
    expect(actions.addAgent).toHaveBeenCalledWith(expect.objectContaining({ root: "/private/native-root", agent: "codex" }));
    expect(actions.install).not.toHaveBeenCalled();
  });
});
