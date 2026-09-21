#!/usr/bin/env node
/**
 * Release pipeline: pin this release's connector executables inside the POSIX
 * bootstrap (onboarding-simplified OS3, R10).
 *
 * `install.sh --user` runs on machines whose `openssl` may not speak Ed25519
 * (macOS ships LibreSSL, which refuses the key), so the user-local path cannot
 * depend on verifying SHA256SUMS.sig. Instead the release job writes the
 * executables' digests — and the digest of the release signing key file —
 * into the copy of install.sh that is published with the same immutable
 * release. A script fetched from a tag only ever installs that tag's bytes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter(pair => pair.length === 2));
for (const key of ["sums", "pub", "in", "out"]) if (!args[key]) throw new Error("usage: bake-bootstrap.mjs --sums SHA256SUMS --pub release-signing.pub --in bootstrap/install.sh --out dist/release/install.sh");

const EXECUTABLE = /^konteks-remote-(?:macos|debian|windows)-(?:amd64|arm64)(?:\.exe)?$/;
// The Graft package is baked too: on macOS the bootstrap cannot verify the
// signed SHA256SUMS, and the baked digest is what it records for Graft.
const GRAFT = /^konteks-graft-(?:macos|debian)-(?:amd64|arm64)\.tgz$/;
const all = readFileSync(args.sums, "utf8").trim().split("\n").map(line => line.trim().split(/\s+/));
const executables = all.filter(([, name]) => EXECUTABLE.test(name ?? ""));
if (executables.length !== 5) throw new Error(`expected five connector executables in ${args.sums}, found ${executables.length}`);
const lines = [...executables, ...all.filter(([, name]) => GRAFT.test(name ?? ""))];
for (const [digest] of lines) if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("malformed digest in SHA256SUMS");
const pubDigest = createHash("sha256").update(readFileSync(args.pub)).digest("hex");

let script = readFileSync(args.in, "utf8");
const marker = { sums: 'BAKED_EXECUTABLE_SUMS=""', pub: 'BAKED_RELEASE_PUBKEY_SHA256=""' };
for (const value of Object.values(marker)) if (!script.includes(value)) throw new Error(`bootstrap is missing the ${value} placeholder`);
script = script.replace(marker.sums, `BAKED_EXECUTABLE_SUMS="${lines.map(([digest, name]) => `${digest}  ${name}`).join("\\n")}"`);
script = script.replace(marker.pub, `BAKED_RELEASE_PUBKEY_SHA256="${pubDigest}"`);
writeFileSync(args.out, script, { mode: 0o755 });
console.log(`baked ${lines.length} executable digests and the signing key digest into ${args.out}`);
