#!/usr/bin/env node
/**
 * SHA256SUMS over every installable launcher artifact: the five signed
 * platform packages AND the five bare connector executables the user-local
 * bootstrap installs (onboarding-simplified OS3, R10). The bootstrap pins the
 * executable it downloads to the digest recorded here, so an executable that
 * is missing from this manifest is an executable nobody can install.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const out = process.argv[2];
if (!out) throw new Error("usage: launcher-checksums.mjs <output-directory> [search-root]");
const PACKAGE = /^konteks-remote(?:-|_).+\.(?:pkg|msi|deb)$/;
const EXECUTABLE = /^konteks-remote-(?:macos|debian|windows)-(?:amd64|arm64)(?:\.exe)?$/;
const files = walk(process.argv[3] ?? "dist").filter(path => PACKAGE.test(basename(path)) || EXECUTABLE.test(basename(path))).sort();
const packages = files.filter(path => PACKAGE.test(basename(path))), executables = files.filter(path => EXECUTABLE.test(basename(path)));
if (packages.length !== 5 || new Set(packages.map(path => basename(path))).size !== 5) throw new Error("the signed launcher platform matrix is incomplete");
if (executables.length !== 5 || new Set(executables.map(path => basename(path))).size !== 5) throw new Error("the connector executable matrix is incomplete");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "SHA256SUMS"), files.map(path => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${basename(path)}`).join("\n") + "\n");
function walk(directory) { return readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
