import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DSH_PROFILE_EXPECTATIONS, DSH_READ_ONLY_TOOLS, renderDshKonteksProfile, writeDshKonteksProfile } from "../bridge/dsh-profile.js";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe("Konteks patch set for DeepSeek Harness", () => {
  it("asks before every tool outside the read-only allowlist", () => {
    const hooks = JSON.parse(renderDshKonteksProfile("/konteks/dsh", "darwin").files.find(file => file.name === "konteks-hooks.json")!.content);
    const matcher = new RegExp(hooks.hooks.PreToolUse[0].matcher);
    for (const tool of DSH_READ_ONLY_TOOLS) expect(matcher.test(tool), tool).toBe(false);
    for (const tool of ["bash", "pwsh", "write", "edit", "str_replace_editor", "run_code", "plugin_manager", "subagent", "mcp__konteks-platform__platform__builtin__echo", "reader", "readx"]) {
      expect(matcher.test(tool), tool).toBe(true);
    }
  });

  it("answers the hook with a shell built-in on each OS, never another program", () => {
    const decision = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Konteks reviews this tool call" } };
    const command = (platform: NodeJS.Platform) =>
      JSON.parse(renderDshKonteksProfile("/konteks/dsh", platform).files.find(file => file.name === "konteks-hooks.json")!.content).hooks.PreToolUse[0].hooks[0].command as string;
    expect(command("darwin")).toBe(`printf '%s' '${JSON.stringify(decision)}'`);
    expect(command("linux")).toBe(command("darwin"));
    expect(command("win32")).toBe(`Write-Output '${JSON.stringify(decision)}'`);
  });

  it("points the ask patch at the written hook config by absolute path, quoted for YAML", () => {
    const windows = renderDshKonteksProfile("C:\\Users\\Ada Lovelace\\konteks\\dsh", "win32");
    const ask = windows.files.find(file => file.name === "konteks-dsh-ask.patch.yml")!.content;
    expect(ask).toContain(`configPath: ${JSON.stringify("C:\\Users\\Ada Lovelace\\konteks\\dsh\\konteks-hooks.json")}`);
    expect(windows.patches).toEqual(["C:\\Users\\Ada Lovelace\\konteks\\dsh\\konteks-dsh.patch.yml", "C:\\Users\\Ada Lovelace\\konteks\\dsh\\konteks-dsh-ask.patch.yml"]);
  });

  it("states every row the self-check later asserts", () => {
    const patch = renderDshKonteksProfile("/konteks/dsh", "darwin").files.find(file => file.name === "konteks-dsh.patch.yml")!.content;
    for (const row of DSH_PROFILE_EXPECTATIONS("/konteks/dsh", "darwin")) {
      if (row.id === "konteks-ask-hook") continue;
      expect(patch, row.id).toContain(`- id: ${row.id}\n`);
    }
    expect(DSH_PROFILE_EXPECTATIONS("/konteks/dsh", "darwin").find(row => row.id === "acp")?.config).toEqual({ provider: "deepseek-official", model: "deepseek-flash" });
    expect(DSH_PROFILE_EXPECTATIONS("/konteks/dsh", "darwin").find(row => row.id === "konteks-ask-hook")?.config).toEqual({ configPath: "/konteks/dsh/konteks-hooks.json" });
  });

  it("writes the set privately and returns the patch paths in layer order", async () => {
    const folder = await mkdtemp(join(tmpdir(), "dsh-profile-")); folders.push(folder);
    const dir = join(folder, "konteks");
    const patches = await writeDshKonteksProfile(dir, process.platform);
    expect(patches).toEqual([join(dir, "konteks-dsh.patch.yml"), join(dir, "konteks-dsh-ask.patch.yml")]);
    const hooks = JSON.parse(await readFile(join(dir, "konteks-hooks.json"), "utf8"));
    expect(hooks.hooks.PreToolUse).toHaveLength(1);
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      for (const name of ["konteks-dsh.patch.yml", "konteks-dsh-ask.patch.yml", "konteks-hooks.json"]) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
    }
    // Rewriting is idempotent.
    await writeDshKonteksProfile(dir, process.platform);
    expect(JSON.parse(await readFile(join(dir, "konteks-hooks.json"), "utf8"))).toEqual(hooks);
  });
});
