#!/usr/bin/env node
/**
 * Release pipeline: build the launcher as a Node single-executable
 * application (SEA) with the embedded release roots, then wrap it into the
 * platform's native package layout. Packaging/signing tools (pkgbuild,
 * WiX, dpkg-deb) are invoked by sign-launcher.mjs; this step only produces
 * the executable and the package skeleton.
 */
import { execFileSync } from "node:child_process";
// npm/npx are .cmd shims on Windows and need a shell to spawn.
const shell = process.platform === "win32";
const npx = shell ? "npx.cmd" : "npx";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter((pair) => pair.length === 2));
const os = args.os;
const out = args.out;
if (!os || !out) {
  console.error("usage: build-launcher.mjs --os macos|windows|debian --out dist/<artifact>");
  process.exit(2);
}
const roots = process.env.KONTEKS_RELEASE_ROOTS_JSON;
if (!roots) {
  console.error("KONTEKS_RELEASE_ROOTS_JSON must be set: a launcher without embedded roots verifies nothing and must not be shipped");
  process.exit(2);
}
JSON.parse(roots); // must be valid

execFileSync(npx, ["tsc", "--build", "packages/launcher"], { stdio: "inherit", shell });
const work = join("dist", "launcher-build");
mkdirSync(work, { recursive: true });
const composeTemplate = readFileSync(join("compose", "compose.template.yaml"), "utf8");
// Embed the roots and version as build-time constants: the SEA reads them
// from process.env-equivalent defaults baked into the entry stub.
const entry = join(work, "entry.cjs");
writeFileSync(
  entry,
  // The Core and relay endpoints are baked too: the onboarding block passes
  // no URL, so a release must know which Konteks it belongs to. An explicit
  // KONTEKS_CORE_URL / KONTEKS_RELAY_URL in the environment still wins at run
  // time (the e2e stack relies on that).
  `process.env.KONTEKS_RELEASE_ROOTS_JSON = ${JSON.stringify(roots)};\nprocess.env.KONTEKS_LAUNCHER_VERSION = ${JSON.stringify(process.env.KONTEKS_LAUNCHER_VERSION ?? "0.0.0")};\nprocess.env.KONTEKS_CORE_URL ??= ${JSON.stringify(process.env.KONTEKS_DEFAULT_CORE_URL ?? "https://api.konteks.io")};\nprocess.env.KONTEKS_RELAY_URL ??= ${JSON.stringify(process.env.KONTEKS_DEFAULT_RELAY_URL ?? "wss://relay.konteks.io/relay/runtime")};\nprocess.env.KONTEKS_EMBEDDED_COMPOSE_TEMPLATE = ${JSON.stringify(composeTemplate)};\nimport("../../packages/launcher/dist/cli.js");\n`,
);
execFileSync(npx, [
  "esbuild",
  entry,
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  // npx.cmd is spawned through cmd.exe on Windows. Keep every argument free
  // of shell syntax so cmd cannot split one option into extra input files.
  // createRequire accepts __filename, and composeTemplatePath handles either
  // that path or the file URL used by repository ESM builds.
  "--define:import.meta.url=__filename",
  `--outfile=${join(work, "launcher.bundle.cjs")}`,
], { stdio: "inherit", shell });
writeFileSync(join(work, "sea-config.json"), JSON.stringify({ main: join(work, "launcher.bundle.cjs"), output: join(work, "launcher.blob"), disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", join(work, "sea-config.json")], { stdio: "inherit" });
const executable = join(work, os === "windows" ? "konteks-remote.exe" : "konteks-remote");
copyFileSync(process.execPath, executable);
execFileSync(npx, ["postject", executable, "NODE_SEA_BLOB", join(work, "launcher.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(os === "macos" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit", shell });
// Injection invalidates the Mach-O signature; an unsigned arm64 binary will not
// launch at all. Ad-hoc sign here so the artifact runs; sign-launcher.mjs
// replaces this with the Developer ID signature when one is configured.
if (os === "macos") execFileSync("codesign", ["--force", "--sign", "-", executable], { stdio: "inherit" });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(join(work, "PACKAGE_LAYOUT.json"), JSON.stringify({ os, executable, out, install: os === "windows" ? "C:\\Program Files\\konteks-remote\\konteks-remote.exe" : "/usr/local/bin/konteks-remote" }));
console.log(`built ${executable}; package skeleton recorded for ${out}`);
