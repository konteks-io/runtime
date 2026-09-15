#!/usr/bin/env node
/** Assemble one unsigned native-connector manifest from closed artifact facts. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) =>
  value.startsWith("--") ? [value.slice(2), all[index + 1]] : []).filter(pair => pair.length === 2));
const tag = args.tag, artifactsPath = args.artifacts, policyPath = args.policy ?? "release/release-policy.json";
const out = args.out ?? "release/unsigned-native-manifest.json";
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || !artifactsPath) {
  console.error("usage: assemble-release-manifest.mjs --tag vX.Y.Z --artifacts native-artifacts.json [--policy release/release-policy.json] [--targets os/arch,...] --out path");
  process.exit(2);
}
const bundleVersion = tag.slice(1), index = parseJson(artifactsPath), policy = parseJson(policyPath);
exactKeys(index, ["schemaVersion", "artifacts"], "artifact index");
if (index.schemaVersion !== 1 || !Array.isArray(index.artifacts)) fail("unsupported artifact index");
const ALL_TARGETS = [["macos", "amd64"], ["macos", "arm64"], ["windows", "amd64"], ["debian", "amd64"], ["debian", "arm64"]];
// A release ships the full matrix; a developer/e2e channel may name a subset (`--targets macos/arm64,debian/amd64`).
const targets = args.targets
  ? args.targets.split(",").map(pair => { const target = ALL_TARGETS.find(([os, architecture]) => `${os}/${architecture}` === pair.trim()); if (!target) fail(`unknown target ${pair}`); return target; })
  : ALL_TARGETS;
const agents = ["claude-code", "codex", "opencode"], ids = new Set(), coordinates = new Set();
for (const artifact of index.artifacts) {
  const bridge = artifact.kind === "agent_bridge";
  exactKeys(artifact, bridge
    ? ["id", "kind", "format", "agentId", "os", "architecture", "url", "digest", "profileDigest", "sizeBytes"]
    : ["id", "kind", "format", "os", "architecture", "url", "digest", "sizeBytes"], "artifact");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(artifact.id) || ids.has(artifact.id)) fail("artifact ids must be unique and portable");
  ids.add(artifact.id);
  if (!targets.some(([os, architecture]) => artifact.os === os && artifact.architecture === architecture)) fail("unsupported artifact target");
  if (!/^https:\/\/[^?#]+$/.test(artifact.url) || !artifact.url.includes(`/${tag}/`)) fail("artifact URL must be immutable and versioned");
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > 2 ** 32) fail("invalid artifact integrity fields");
  if (bridge) {
    if (artifact.format !== "offline_agent_tgz" || !agents.includes(artifact.agentId) || !/^sha256:[a-f0-9]{64}$/.test(artifact.profileDigest)) fail("agent artifacts must be complete offline packages");
  } else if (artifact.kind !== "connector" || artifact.format !== "executable") fail("connector artifacts must be native executables");
  const coordinate = `${artifact.os}/${artifact.architecture}/${artifact.kind}/${artifact.agentId ?? "connector"}`;
  if (coordinates.has(coordinate)) fail("duplicate artifact coordinate");
  coordinates.add(coordinate);
}
for (const [os, architecture] of targets) for (const coordinate of ["connector/connector", ...agents.map(agent => `agent_bridge/${agent}`)]) {
  if (!coordinates.has(`${os}/${architecture}/${coordinate}`)) fail(`artifact matrix is incomplete at ${os}/${architecture}/${coordinate}`);
}
if (coordinates.size !== targets.length * (agents.length + 1)) fail("artifact matrix contains an unapproved entry");
if (!policy.protocol || typeof policy.manifestValidityDays !== "number") fail("release policy is incomplete");
const manifest = {
  bundleVersion, protocol: policy.protocol, deploymentKind: "native_connector", components: ["agent_runner"],
  images: [], agentBridges: [], nativeArtifacts: [...index.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
  expiresAt: new Date(Date.now() + policy.manifestValidityDays * 86_400_000).toISOString(),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`assembled ${out} for native connector ${bundleVersion} (${manifest.nativeArtifacts.length} artifacts)`);

function parseJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail(`cannot read ${path}`); } }
function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  const actual = Object.keys(value).sort(), expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(`${name} has unknown or missing fields`);
}
function fail(message) { throw new Error(message); }
