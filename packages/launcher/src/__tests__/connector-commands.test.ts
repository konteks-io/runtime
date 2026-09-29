import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { ConnectorCommandsManifestSchema, connectorCommandsFor } from "@konteks/remote-common";
import { createNativeProgram } from "../native/cli.js";

/**
 * runtime-view R20: the connector commands a release ships (`commands.json`)
 * never name a command, option or argument the launcher does not have, and
 * every command a person runs on the computer is listed.
 */
const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "release", "src", "connector-commands.json"), "utf8")) as { commands: unknown[] };

/** Commands a person does not run from the page: the service's own, the first install (the site hands it out with a code), and key revocation (needs a reference from `git key list`). */
const NOT_LISTED = new Set(["install", "onboard", "stage-enrollment", "serve", "git key remove"]);

function program(): Command {
  const actions = { install: vi.fn(), addAgent: vi.fn(), removeAgent: vi.fn(), serve: vi.fn(), start: vi.fn(), stop: vi.fn(), update: vi.fn(), uninstall: vi.fn(), control: vi.fn(), onboard: vi.fn(), stageEnrollment: vi.fn() };
  return createNativeProgram(actions as never);
}

/** The command a line names, its placeholders and its options, checked against the real table. */
function resolve(root: Command, line: string): { path: string; command: Command } {
  const words = line.split(/\s+/);
  expect(words[0]).toBe("konteks-remote");
  let command = root;
  const path: string[] = [];
  const argumentsGiven: string[] = [];
  for (const word of words.slice(1)) {
    if (word.startsWith("--")) {
      const known = [...command.options, ...(command === root ? [] : root.options)].some(option => option.long === word);
      expect(known, `${line}: ${word} is not an option of "${path.join(" ") || "konteks-remote"}"`).toBe(true);
      continue;
    }
    const sub = command.commands.find(candidate => candidate.name() === word);
    if (sub && argumentsGiven.length === 0) { command = sub; path.push(word); continue; }
    argumentsGiven.push(word);
  }
  const registered = (command as unknown as { registeredArguments: Array<{ required: boolean }> }).registeredArguments;
  expect(argumentsGiven.length, `${line}: more arguments than "${path.join(" ")}" takes`).toBeLessThanOrEqual(registered.length);
  expect(argumentsGiven.length, `${line}: a required argument is missing`).toBeGreaterThanOrEqual(registered.filter(argument => argument.required).length);
  return { path: path.join(" "), command };
}

function leaves(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap(sub => {
    if ((sub as unknown as { _hidden?: boolean })._hidden) return [];
    const path = [...prefix, sub.name()];
    return sub.commands.length > 0 ? leaves(sub, path) : [path.join(" ")];
  });
}

describe("connector commands shipped with the release (runtime-view R20)", () => {
  it("is a manifest the site takes once the release names its version", () => {
    const manifest = ConnectorCommandsManifestSchema.parse({ version: "0.4.1", ...table });
    expect(manifest.commands.length).toBeGreaterThan(10);
    expect(connectorCommandsFor(manifest, "windows").map(command => command.id)).not.toContain("agent.remove");
    expect(connectorCommandsFor(manifest, "macos").map(command => command.id)).toContain("agent.remove");
    // Plain lines: no em dash, one line each.
    for (const command of manifest.commands) expect(command.description).not.toMatch(/[—\n]/);
  });

  it("names only commands, arguments and options the launcher really has", () => {
    const root = program();
    const listed = new Set<string>();
    for (const entry of ConnectorCommandsManifestSchema.parse({ version: "0.4.1", ...table }).commands) listed.add(resolve(root, entry.command).path);
    // And lists every command a person runs here.
    const missing = leaves(root).filter(path => !listed.has(path) && !NOT_LISTED.has(path));
    expect(missing).toEqual([]);
  });
});

describe("the commands the connector reports on its heartbeat (runtime-view R20)", () => {
  it("are this release's table at the installed bundle version, or nothing when they would not parse", async () => {
    const { connectorCommandsManifest, CONNECTOR_COMMANDS_TABLE } = await import("@konteks/remote-release");
    const manifest = connectorCommandsManifest("0.4.1");
    expect(manifest).toEqual({ version: "0.4.1", commands: ConnectorCommandsManifestSchema.parse({ version: "0.4.1", ...table }).commands });
    expect(CONNECTOR_COMMANDS_TABLE.commands).toHaveLength(table.commands.length);
    expect(connectorCommandsManifest("not a version!")).toBeNull();
    expect(connectorCommandsManifest("0.4.1", { commands: [{ id: "BAD" }] })).toBeNull();
    expect(connectorCommandsManifest("0.4.1", undefined)).toEqual(manifest);
  });
});
