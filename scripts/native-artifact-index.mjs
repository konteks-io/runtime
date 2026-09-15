#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : []).filter(pair => pair.length === 2));
if (args.merge || args.directory) {
  const paths = args.merge ? args.merge.split(",") : descriptorFiles(args.directory);
  const artifacts = paths.flatMap(path => JSON.parse(readFileSync(path, "utf8")).artifacts);
  writeFileSync(args.out, `${JSON.stringify({ schemaVersion: 1, artifacts }, null, 2)}\n`);
  process.exit(0);
}
if (!args.file || !args.id || !args.kind || !args.os || !args.architecture || !args.url || !args.out) throw new Error("incomplete native artifact descriptor arguments");
const bytes = readFileSync(args.file);
const artifact = {
  id: args.id, kind: args.kind, format: args.format ?? "executable",
  ...(args.agent ? { agentId: args.agent } : {}), os: args.os, architecture: args.architecture,
  url: args.url, digest: sha(bytes), ...(args.profile ? { profileDigest: sha(readFileSync(args.profile)) } : {}), sizeBytes: bytes.length,
};
writeFileSync(args.out, `${JSON.stringify({ schemaVersion: 1, artifacts: [artifact] }, null, 2)}\n`);
function sha(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function descriptorFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? descriptorFiles(join(directory, entry.name))
    : entry.name.endsWith(".artifact.json") ? [join(directory, entry.name)] : []);
}
