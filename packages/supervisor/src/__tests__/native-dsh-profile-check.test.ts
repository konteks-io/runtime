import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDshKonteksProfile, dshProfileDrift, parseDshDumpConfig } from "../native/dsh-profile-check.js";

// A real `dsh --profile acp --patch … --dump-config` of 0.1.7-rc.2 with the
// Konteks patch set, captured with the patch directory at "/konteks/dsh home".
const DUMP = readFileSync(new URL("./fixtures/dsh-0.1.7-rc.2-dump-config.yml", import.meta.url), "utf8");
const DUMP_0_1_5 = readFileSync(new URL("./fixtures/dsh-0.1.5-rc.3-dump-config.yml", import.meta.url), "utf8");
const DIR = "/konteks/dsh home";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe("DeepSeek Harness profile self-check", () => {
  it("reads rows, modules, disabled flags and scalar config from a real dump", () => {
    const rows = parseDshDumpConfig(DUMP);
    expect(rows.get("tool-plugin-manager")).toMatchObject({ name: "@deepseek-ai/dsh-plugin-manager/tools", disabled: "true" });
    expect(rows.get("tool-bash")).toMatchObject({ disabled: "!!js process.platform === 'win32'", config: { enableRunInBackground: "false" } });
    expect(rows.get("acp")?.config).toEqual({ provider: "deepseek-official", model: "deepseek-flash" });
    expect(rows.get("konteks-ask-hook")).toMatchObject({ name: "@deepseek-ai/dsh-hooks-claude-code", config: { configPath: `${DIR}/konteks-hooks.json` } });
  });

  it("reads folded and literal block scalars", () => {
    const rows = parseDshDumpConfig([
      "- id: konteks-ask-hook",
      "  name: '@deepseek-ai/dsh-hooks-claude-code'",
      "  config:",
      "    configPath: >-",
      "      /a/very/long/path",
      "      with spaces/konteks-hooks.json",
      "    note: |-",
      "      one",
      "      two",
      "- id: next",
      "  name: \"quoted \\\"name\\\"\"",
      "",
    ].join("\n"));
    expect(rows.get("konteks-ask-hook")?.config).toEqual({ configPath: "/a/very/long/path with spaces/konteks-hooks.json", note: "one\ntwo" });
    expect(rows.get("next")?.name).toBe('quoted "name"');
  });

  it("finds no drift in the composed Konteks profile", () => {
    expect(dshProfileDrift(DUMP, DIR, "darwin")).toEqual([]);
    expect(dshProfileDrift(DUMP, DIR, "darwin", "0.1.7-rc.2")).toEqual([]);
  });

  it("lets rows dsh added in 0.1.7 be absent only from older versions (npm latest 0.1.5-rc.3)", () => {
    expect(dshProfileDrift(DUMP_0_1_5, DIR, "darwin", "0.1.5-rc.3")).toEqual([]);
    expect(dshProfileDrift(DUMP_0_1_5, DIR, "darwin", "0.1.7-rc.2")).toEqual(["deepseek-account: missing", "llm-deepseek-account: missing", "tool-plugin-manager: missing"]);
    expect(dshProfileDrift(DUMP_0_1_5, DIR, "darwin")).toHaveLength(3);
    // Every other row stays required on an older version.
    expect(dshProfileDrift(DUMP_0_1_5.replace("- id: tool-subagent\n", "- id: tool-subagent-renamed\n"), DIR, "darwin", "0.1.5-rc.3")).toEqual(["tool-subagent: missing"]);
  });

  it("names every row that drifted: removed, re-enabled, repointed or reconfigured", () => {
    const drifted = DUMP
      .replace("- id: tool-plugin-manager\n  name: '@deepseek-ai/dsh-plugin-manager/tools'\n  disabled: true\n", "- id: tool-plugin-manager\n  name: '@deepseek-ai/dsh-plugin-manager/tools'\n")
      .replace(/(- id: acp\n[\s\S]*? {4}model: )deepseek-flash/, "$1deepseek-v4-flash")
      .replace(/- id: konteks-ask-hook[\s\S]*$/, "")
      .replace("- id: tool-goal\n", "- id: tool-goal-renamed\n");
    expect(dshProfileDrift(drifted, DIR, "darwin")).toEqual([
      "tool-plugin-manager: expected disabled",
      "tool-goal: missing",
      "acp: config model is \"deepseek-v4-flash\", expected \"deepseek-flash\"",
      "konteks-ask-hook: missing",
    ]);
    expect(dshProfileDrift(DUMP.replace(`${DIR}/konteks-hooks.json`, "/elsewhere/hooks.json"), DIR, "darwin"))
      .toEqual([`konteks-ask-hook: config configPath is "/elsewhere/hooks.json", expected "${DIR}/konteks-hooks.json"`]);
    // Unparseable output is drift, never a pass.
    expect(dshProfileDrift("not a profile tree", DIR, "darwin").length).toBeGreaterThan(0);
  });

  it("writes the patch set, dumps with the runtime's own Node and home, and refuses drift", async () => {
    const folder = await mkdtemp(join(tmpdir(), "dsh-check-")); folders.push(folder);
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const konteksDir = join(folder, "konteks");
    const installation = { root: join(folder, "pkg"), entry: join(folder, "pkg", "lib", "bin.js"), version: "0.1.7-rc.2" };
    const run = async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options.env });
      return { code: 0, stdout: DUMP.split(DIR).join(konteksDir), stderr: "" };
    };
    await checkDshKonteksProfile({ node: "/runtime/bin/node", installation, dshHome: join(folder, "home"), konteksDir, platform: "darwin", run });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/runtime/bin/node");
    expect(calls[0]!.args).toEqual([installation.entry, "--profile", "acp", "--patch", join(konteksDir, "konteks-dsh.patch.yml"), "--patch", join(konteksDir, "konteks-dsh-ask.patch.yml"), "--dump-config"]);
    expect(calls[0]!.env).toMatchObject({ DSH_HOME: join(folder, "home"), DSH_TELEMETRY_DISABLED: "1", NO_COLOR: "1" });
    expect(Object.keys(calls[0]!.env).filter(key => /KEY|TOKEN|SECRET/i.test(key))).toEqual([]);
    expect(await readFile(join(konteksDir, "konteks-hooks.json"), "utf8")).toContain("PreToolUse");

    const drift = async () => ({ code: 0, stdout: DUMP.split(DIR).join(konteksDir).replace(/(- id: acp\n[\s\S]*? {4}model: )deepseek-flash/, "$1other"), stderr: "" });
    await expect(checkDshKonteksProfile({ node: "/runtime/bin/node", installation, dshHome: join(folder, "home"), konteksDir, platform: "darwin", run: drift }))
      .rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_profile_drift" });
    const failed = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(checkDshKonteksProfile({ node: "/runtime/bin/node", installation, dshHome: join(folder, "home"), konteksDir, platform: "darwin", run: failed }))
      .rejects.toMatchObject({ code: "prerequisite_missing", diagnostic: "dsh_profile_drift" });
  });
});
