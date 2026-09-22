#!/usr/bin/env node
/** Build a complete, immutable agent+ACP package; runtime install never invokes npm. */
import { execFileSync } from "node:child_process";
// npm is a .cmd shim on Windows and needs a shell to spawn.
const shell = process.platform === "win32";
const npm = shell ? "npm.cmd" : "npm";
import { Buffer } from "node:buffer";
import process from "node:process";
import { chmodSync, cpSync, createReadStream, createWriteStream, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { createGzip } from "node:zlib";
import { inventoryOfflineFiles } from "./offline-agent-files.mjs";
import { patchCodexAcpLiveUsers } from "./codex-acp-live-user-patch.mjs";
import { patchClaudeSettings } from "./claude-acp-settings-patch.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : []).filter(pair => pair.length === 2));
if (!args.agent || !args.os || !args.architecture || !args.out || !args.profile || !args.approval || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/.test(args.approval)) throw new Error("offline agent packaging requires an explicit redistribution approval reference");
const config = JSON.parse(readFileSync(args.config ?? "release/native-agent-builds.json", "utf8"));
const selected = config.agents?.[args.agent];
if (!selected || args.agent === "pi") throw new Error("agent is not approved for native offline distribution");
if (process.version !== `v${config.nodeVersion}`) throw new Error(`offline bundles require Node ${config.nodeVersion}`);
const work = mkdtempSync(join(tmpdir(), "konteks-agent-build-")), root = join(work, "root");
try {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const packages = [...new Set([`${selected.bridge.package}@${selected.bridge.version}`, `${selected.tooling.package}@${selected.tooling.version}`])];
  const sharedCodex = args.agent === "codex" && args.os !== "windows";
  if (sharedCodex) packages.push("ws@8.21.3");
  // Personal-profile agents (Claude Code) run the operator's installed CLI, so
  // their platform-native optional binaries are deliberately not vendored.
  execFileSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--omit=dev", ...(selected.tooling.personalProfile ? ["--omit=optional"] : []), "--prefix", root, ...packages], { stdio: "inherit" , shell });
  const runtimeName = args.os === "windows" ? "node.exe" : "node";
  mkdirSync(join(root, "bin"), { recursive: true, mode: 0o700 });
  cpSync(process.execPath, join(root, "bin", runtimeName));
  const bridgeEntry = packageBin(root, selected.bridge.package, selected.bridge.bin);
  const toolingEntry = packageBin(root, selected.tooling.package, selected.tooling.bin);
  if (args.agent === "claude-code") {
    mkdirSync(join(root, "konteks"), { recursive: true, mode: 0o700 });
    cpSync(new URL("./claude-instruction-scope.mjs", import.meta.url), join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "konteks-instruction-scope.mjs"));
    const provenance = [];
    for (const file of ["acp-agent.js", "settings.js"]) {
      const path = join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", file);
      const patched = patchClaudeSettings(readFileSync(path, "utf8"), file, selected.bridge.version);
      writeFileSync(path, patched.source);
      provenance.push(patched.provenance);
    }
    writeFileSync(join(root, "konteks", "claude-acp-provenance.json"), JSON.stringify(provenance));
  }
  if (sharedCodex) {
    mkdirSync(join(root, "konteks"), { mode: 0o700 });
    const bridgePath = join(root, bridgeEntry);
    const patched = patchCodexAcpLiveUsers(readFileSync(bridgePath, "utf8"), selected.bridge.version);
    writeFileSync(bridgePath, patched.source);
    writeFileSync(join(root, "konteks", "codex-acp-provenance.json"), JSON.stringify(patched.provenance));
    for (const file of ["codex-local-proxy.js", "codex-local-transport.js", "codex-input-correlation.js"]) {
      cpSync(new URL(`../packages/agent-runner/dist/bridge/${file}`, import.meta.url), join(root, "konteks", file));
    }
    writeFileSync(join(root, "konteks", "package.json"), '{"type":"module"}\n');
    chmodSync(join(root, "konteks", "codex-local-proxy.js"), 0o755);
  }
  const files = await inventoryOfflineFiles(root, walk(root), runtimeName);
  if (files.length < 1 || files.length > 20_000 || files.reduce((sum, file) => sum + file.sizeBytes, 0) > 1024 ** 3) throw new Error("offline package exceeds the installed-profile bounds");
  validatePaths(files.map(file => file.path));
  const profile = {
    schemaVersion: 1, agentId: args.agent, os: args.os, architecture: args.architecture,
    bridge: { package: selected.bridge.package, version: selected.bridge.version, entrypoint: bridgeEntry, runtime: "node" },
    tooling: { package: selected.tooling.package, version: selected.tooling.version, entrypoint: toolingEntry, runtime: selected.tooling.personalProfile ? "native" : "node" },
    node: { version: config.nodeVersion, entrypoint: `bin/${runtimeName}` },
    ...(sharedCodex ? { codexLocalProxy: { version: 1, entrypoint: "konteks/codex-local-proxy.js" } } : {}),
    files: files.map(({ path, digest, sizeBytes, executable }) => ({ path, digest, sizeBytes, executable })),
  };
  const profileBytes = Buffer.from(JSON.stringify(profile));
  if (profileBytes.length > 4 * 1024 ** 2) throw new Error("offline package profile exceeds 4 MiB");
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.profile, profileBytes, { mode: 0o600 });
  const archivePath = join(work, "agent.tgz");
  await pipeline(Readable.from(tar([{ path: "konteks-agent.json", bytes: profileBytes, sizeBytes: profileBytes.length }, ...files])), createGzip({ level: 9 }), createWriteStream(archivePath, { mode: 0o600, flags: "wx" }));
  // Publish only a complete archive. cp supports output directories on another filesystem.
  const publishing = `${args.out}.partial-${process.pid}`;
  try { cpSync(archivePath, publishing); renameSync(publishing, args.out); }
  finally { rmSync(publishing, { force: true }); }
} finally { rmSync(work, { recursive: true, force: true }); }

function packageBin(root, name, bin) {
  const directory = join(root, "node_modules", ...name.split("/"));
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[bin];
  if (typeof entry !== "string") throw new Error(`package ${name} does not publish bin ${bin}`);
  const path = relative(root, join(directory, entry)).split(sep).join("/");
  if (!walk(root).includes(path)) throw new Error(`package ${name} bin is not a regular bundled file`);
  return path;
}
function walk(root, directory = root) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const absolute = join(directory, entry.name), info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error("offline package cannot contain links");
    if (info.isDirectory()) paths.push(...walk(root, absolute));
    else if (info.isFile()) paths.push(relative(root, absolute).split(sep).join("/"));
    else throw new Error("offline package contains an unsupported filesystem entry");
  }
  return paths.sort();
}
async function* tar(entries) {
  for (const entry of entries) {
    const block = Buffer.alloc(512), split = splitPath(entry.path);
    block.write(split.name, 0, 100); block.write("0000600\0", 100); block.write("0000000\0", 108); block.write("0000000\0", 116);
    block.write(`${entry.sizeBytes.toString(8).padStart(11, "0")}\0`, 124); block.write("00000000000\0", 136); block.fill(32, 148, 156);
    block.write("0", 156); block.write("ustar\0", 257); block.write("00", 263); if (split.prefix) block.write(split.prefix, 345, 155);
    block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
    yield block;
    if (entry.bytes) yield entry.bytes;
    else {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(join(root, entry.path))) {
        size += chunk.length;
        if (size > entry.sizeBytes) throw new Error("Offline file grew after inventory");
        hash.update(chunk);
        yield chunk;
      }
      if (size !== entry.sizeBytes || `sha256:${hash.digest("hex")}` !== entry.digest) throw new Error("Offline file changed after inventory");
    }
    yield Buffer.alloc((512 - entry.sizeBytes % 512) % 512);
  }
  yield Buffer.alloc(1024);
}
function splitPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index), name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`offline path is not portable: ${basename(path)}`);
}
function validatePaths(paths) {
  const folded = new Set(), files = new Set(paths.map(path => path.toLowerCase())), directories = new Set();
  for (const path of paths) {
    // eslint-disable-next-line no-control-regex -- Archive paths must reject control characters.
    if (Buffer.byteLength(path) > 240 || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)) throw new Error("offline package path is not portable");
    const parts = path.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("offline package path is not portable");
    const key = path.toLowerCase(); if (folded.has(key)) throw new Error("offline package contains a case collision"); folded.add(key);
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join("/").toLowerCase());
  }
  if ([...directories].some(directory => files.has(directory))) throw new Error("offline package contains a file/directory collision");
}
