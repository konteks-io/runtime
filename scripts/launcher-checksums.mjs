#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const out = process.argv[2];
if (!out) throw new Error("usage: launcher-checksums.mjs <output-directory> [search-root]");
const files = walk(process.argv[3] ?? "dist").filter(path => /konteks-remote(?:-|_).+\.(?:pkg|msi|deb)$/.test(basename(path))).sort();
if (files.length !== 5 || new Set(files.map(path => basename(path))).size !== 5) throw new Error("the signed launcher platform matrix is incomplete");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "SHA256SUMS"), files.map(path => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${basename(path)}`).join("\n") + "\n");
function walk(directory) { return readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
