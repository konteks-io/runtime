#!/usr/bin/env node
/**
 * Secret-canary guard (security-operations-observability.md "Release is
 * blocked by … any test that places a canary … into a log, metric, backup
 * default, or support bundle"). It scans every committed artifact that could
 * ship to a customer — source, release metadata, bootstrap scripts, CI
 * workflows, `.env.example` — for the shared canary markers and
 * for credential-shaped literals, and fails on any hit outside the redaction
 * module and its tests.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "tmp", ".runtime", ".konteks-remote"]);
const ALLOWLIST = [/^packages\/common\/src\/redaction\.ts$/, /__tests__\//, /__characterization__\//, /^scripts\/check-secret-canary\.mjs$/, /\.md$/];
const PATTERNS = [
  { name: "secret canary marker", regex: /KONTEKS_CANARY_[A-Z_]+/ },
  { name: "Anthropic key literal", regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI key literal", regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: "Google API key literal", regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "provisioning credential literal", regex: /kxrp_[A-Za-z0-9_-]{16,}/ },
  { name: "activation code literal", regex: /kxac_[A-Za-z0-9_-]{16,}/ },
  { name: "private key material", regex: /-----BEGIN (?:EC |RSA |OPENSSH |)PRIVATE KEY-----/ },
  { name: "JWT literal", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

const hits = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    // The git-ignored graph mirrors allowlisted redaction fixtures in JSON.
    // It is a local index, not a release input; scan the original sources.
    if (path === join(root, "graft") && info.isDirectory()) continue;
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    const rel = relative(root, path);
    if (ALLOWLIST.some((pattern) => pattern.test(rel))) continue;
    if (entry === "package-lock.json") continue;
    const text = readFileSync(path, "utf8");
    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(text);
      if (match) hits.push(`${rel}: ${pattern.name} (${match[0].slice(0, 8)}…)`);
    }
  }
}
walk(root);
if (hits.length > 0) {
  console.error("secret-canary guard failed:");
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log("secret-canary guard passed: no canary or credential-shaped literal in shippable files.");
