#!/usr/bin/env node
/**
 * Build the offline Graft package a release ships next to the connector
 * (W1-G1, WS1-081): `konteks-graft-<os>-<architecture>.tgz`, holding
 * `node_modules/@nanonets/graft` with its native grammars compiled for this
 * platform. It carries no Node: the connector runs it on the Node inside the
 * release's own agent packages, so it must be built with that same Node
 * (release/native-agent-builds.json `nodeVersion`), whose ABI the native
 * builds are compiled for. The release's signed SHA256SUMS lists it and the
 * bootstrap bakes its digest, so a connector installs only these bytes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const shell = process.platform === "win32";
const npm = shell ? "npm.cmd" : "npm";
const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : []).filter(pair => pair.length === 2));
if (!args.tool || !args.out) throw new Error("usage: build-offline-tool.mjs --tool graft --out dist/release/konteks-graft-<os>-<architecture>.tgz");
const config = JSON.parse(readFileSync(args.config ?? "release/native-agent-builds.json", "utf8"));
const tool = config.tools?.[args.tool];
if (!tool) throw new Error(`tool ${args.tool} is not approved for the release`);
if (process.version !== `v${config.nodeVersion}`) throw new Error(`offline tools require Node ${config.nodeVersion}, the Node the agent packages carry`);

const work = mkdtempSync(join(tmpdir(), "konteks-tool-build-"));
try {
  const root = join(work, "root");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Install scripts run on purpose: some grammars ship no prebuilt binary and
  // are compiled here, once, instead of on the person's laptop.
  execFileSync(npm, ["install", "--no-audit", "--no-fund", "--no-package-lock", "--omit=dev", "--prefix", root, `${tool.package}@${tool.version}`], { stdio: "inherit", shell });
  const cli = join(root, "node_modules", ...tool.package.split("/"), ...tool.entrypoint.split("/"));
  if (!existsSync(cli)) throw new Error(`${tool.package} has no ${tool.entrypoint}`);
  // The package must run with nothing but this Node: no network, no home.
  execFileSync(process.execPath, [cli, "--version"], { stdio: "inherit", env: { PATH: "/usr/bin:/bin", HOME: work, DO_NOT_TRACK: "1" } });
  execFileSync("tar", ["-czf", args.out, "-C", root, "node_modules"], { stdio: "inherit" });
  console.log(`built ${args.out} (${tool.package}@${tool.version})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
