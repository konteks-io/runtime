#!/usr/bin/env node
/**
 * GitHub Release asset layout for one native release. Assets are flat files
 * on an immutable per-tag release; `releases/latest/download/<name>` is the
 * stable channel. Every artifact URL written here is pinned by digest and
 * size inside the signed manifest, so the host is never the trust anchor.
 *
 *   stage   — per platform job: package the offline agents, lay out the
 *             connector executable, installer package and descriptors.
 *   collect — release job: merge every platform's staging directory.
 *   verify  — release job: every manifest artifact is present with its exact bytes.
 *   notes   — release job: human-readable release notes from the manifest.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const [command, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter(pair => pair.length === 2));
const AGENTS = ["claude-code", "codex", "opencode"];
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const node = (script, argv) => execFileSync(process.execPath, [script, ...argv], { stdio: "inherit" });

switch (command) {
  case "stage": {
    for (const key of ["os", "architecture", "tag", "repository", "executable", "package", "approval"]) if (!args[key]) fail(`stage requires --${key}`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository)) fail("repository must be owner/name");
    const out = join("dist", "release");
    mkdirSync(out, { recursive: true });
    // Immutable per-tag asset URLs; a developer/e2e channel may serve the same layout from --base-url.
    const base = (args["base-url"] ?? `https://github.com/${args.repository}/releases/download`).replace(/\/+$/, "");
    if (!/^https:\/\//.test(base)) fail("base-url must be https");
    const url = name => `${base}/${args.tag}/${name}`;
    const connectorName = `konteks-remote-${args.os}-${args.architecture}${args.os === "windows" ? ".exe" : ""}`;
    copyFileSync(args.executable, join(out, connectorName));
    node("scripts/native-artifact-index.mjs", ["--file", join(out, connectorName), "--id", `konteks-remote-${args.os}-${args.architecture}`, "--kind", "connector", "--format", "executable", "--os", args.os, "--architecture", args.architecture, "--url", url(connectorName), "--out", join(out, `konteks-remote-${args.os}-${args.architecture}.artifact.json`)]);
    for (const agent of AGENTS) {
      const name = `${agent}-${args.os}-${args.architecture}.tgz`, profile = join("dist", "profiles", `${agent}-${args.os}-${args.architecture}.profile.json`);
      mkdirSync(join("dist", "profiles"), { recursive: true });
      node("scripts/build-offline-agent.mjs", ["--agent", agent, "--os", args.os, "--architecture", args.architecture, "--approval", args.approval, "--out", join(out, name), "--profile", profile]);
      node("scripts/native-artifact-index.mjs", ["--file", join(out, name), "--profile", profile, "--id", `${agent}-${args.os}-${args.architecture}`, "--kind", "agent_bridge", "--format", "offline_agent_tgz", "--agent", agent, "--os", args.os, "--architecture", args.architecture, "--url", url(name), "--out", join(out, `${agent}-${args.os}-${args.architecture}.artifact.json`)]);
    }
    copyFileSync(args.package, join(out, basename(args.package)));
    if (existsSync(`${args.package}.asc`)) copyFileSync(`${args.package}.asc`, join(out, `${basename(args.package)}.asc`));
    console.log(`staged ${readdirSync(out).length} release assets for ${args.os}/${args.architecture} in ${out}`);
    break;
  }
  case "collect": {
    if (!args.artifacts || !args.out || !args.descriptors) fail("collect requires --artifacts --out --descriptors");
    mkdirSync(args.out, { recursive: true });
    mkdirSync(args.descriptors, { recursive: true });
    const seen = new Set();
    for (const path of walk(args.artifacts)) {
      const name = basename(path);
      if (seen.has(name)) fail(`duplicate release asset ${name}`);
      seen.add(name);
      copyFileSync(path, join(name.endsWith(".artifact.json") ? args.descriptors : args.out, name));
    }
    console.log(`collected ${seen.size} files`);
    break;
  }
  case "verify": {
    if (!args.manifest || !args.dir) fail("verify requires --manifest --dir");
    const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
    for (const artifact of manifest.nativeArtifacts) {
      const name = basename(new URL(artifact.url).pathname), path = join(args.dir, name);
      if (!existsSync(path)) fail(`manifest artifact ${artifact.id} is missing from ${args.dir}: ${name}`);
      const bytes = readFileSync(path);
      if (bytes.length !== artifact.sizeBytes || sha(bytes) !== artifact.digest) fail(`manifest artifact ${artifact.id} does not match its signed digest`);
    }
    const sums = readFileSync(join(args.dir, "SHA256SUMS"), "utf8").trim().split("\n");
    for (const line of sums) {
      const [digest, name] = line.split(/\s+/);
      const path = join(args.dir, name);
      if (!existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") !== digest) fail(`checksum manifest entry ${name} does not match a present file`);
    }
    for (const required of ["native-manifest.json", "SHA256SUMS", "SHA256SUMS.sig", "release-signing.pub", "install.sh", "install.ps1", "onboarding.md"]) if (!existsSync(join(args.dir, required))) fail(`release is missing ${required}`);
    if (!readFileSync(join(args.dir, "install.sh"), "utf8").match(/BAKED_EXECUTABLE_SUMS="[0-9a-f]{64}  konteks-remote-/)) fail("install.sh was not baked with this release's executable digests");
    console.log(`verified ${manifest.nativeArtifacts.length} manifest artifacts and ${sums.length} package checksums`);
    break;
  }
  case "notes": {
    if (!args.manifest || !args.tag) fail("notes requires --manifest --tag");
    const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
    const rows = manifest.nativeArtifacts.map(a => `| ${a.id} | ${a.kind} | ${a.os}/${a.architecture} | ${a.sizeBytes} | \`${a.digest}\` |`);
    process.stdout.write([
      `## konteks-remote ${manifest.bundleVersion}`, "",
      `Signed native manifest digest: \`${manifest.digest}\` (key \`${manifest.signature.keyId}\`, valid until ${manifest.expiresAt}).`, "",
      "Installed connectors pick this release up automatically from the stable channel and verify it against the roots embedded in their own executable.", "",
      "| artifact | kind | platform | bytes | digest |", "|---|---|---|---|---|", ...rows, "",
    ].join("\n"));
    break;
  }
  default:
    fail("usage: release-assets.mjs stage|collect|verify|notes ...");
}

function walk(directory) { return readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
function fail(message) { console.error(message); process.exit(2); }
