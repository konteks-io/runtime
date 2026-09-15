#!/usr/bin/env node
/**
 * AGPL guard (CP2 item 1 / CI acceptance): no Shellular (AGPL-3.0) code may
 * enter this repository. It scans source, scripts, Dockerfiles, and the
 * Compose template for AGPL licence headers, Shellular identifiers, and
 * imports of Shellular packages, and fails the build on any hit. Design
 * reading is fine; copying or paraphrasing is not (THIRD_PARTY_NOTICES.md).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "tmp", ".runtime", ".konteks-remote"]);
const SCAN_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".sh", ".ps1", ""]);
const PATTERNS = [
  { name: "AGPL licence text", regex: /GNU AFFERO GENERAL PUBLIC LICENSE|AGPL-3\.0|agpl-3\.0|AGPLv3/i },
  { name: "Shellular identifier", regex: /shellular/i },
  { name: "Shellular package import", regex: /from\s+["']@shellular\/|require\(["']@shellular\//i },
];
// The notices file legitimately names AGPL and Shellular to say they are excluded.
const ALLOWLIST = new Set(["THIRD_PARTY_NOTICES.md", "CLAUDE.md", "scripts/check-agpl.mjs"]);

const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    const rel = relative(root, path);
    if (ALLOWLIST.has(rel) || rel.endsWith(".md")) continue;
    const dot = entry.lastIndexOf(".");
    const ext = dot === -1 ? "" : entry.slice(dot);
    if (!SCAN_EXTENSIONS.has(ext) && entry !== "Dockerfile") continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(text)) hits.push(`${rel}: ${pattern.name}`);
    }
  }
}
walk(root);
if (hits.length > 0) {
  console.error("AGPL guard failed:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log("AGPL guard passed: no Shellular/AGPL traces in source.");
