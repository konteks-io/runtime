#!/usr/bin/env node
/**
 * Export the code-and-config tree of this repository into the public
 * `konteks-io/runtime` checkout. Contracts, proofs, plans and every other
 * Markdown document stay here; only THIRD_PARTY_NOTICES.md and the public
 * README travel. `file:` links to the sibling contracts checkout become
 * vendored tarballs (`vendor/*.tgz`, packed from that checkout's built
 * `dist/`), so the public tree builds without the private registry; the
 * lockfile is regenerated against them.
 *
 *   node scripts/export-public.mjs --out ../runtime [--contracts ../packages]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter(pair => pair.length === 2));
if (!args.out) { console.error("usage: export-public.mjs --out <public checkout> [--contracts <contracts checkout>]"); process.exit(2); }
const source = resolve(dirname(new URL(import.meta.url).pathname), "..");
const out = resolve(args.out);
if (!existsSync(join(out, ".git"))) { console.error(`${out} is not a git checkout; clone github.com/konteks-io/runtime there first`); process.exit(2); }
const contractsRoot = resolve(args.contracts ?? join(source, "..", "packages"));
const VENDORED = ["agent-core", "backstage-plugin-common"];
for (const name of VENDORED) if (!existsSync(join(contractsRoot, "packages", name, "dist"))) { console.error(`${name} is not built in ${contractsRoot}; run its build first`); process.exit(2); }

const tracked = execFileSync("git", ["-C", source, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const EXCLUDED_DIRS = ["proof", "codex-plans", ".gitea", "public"];
const EXCLUDED_FILES = new Set(["CLAUDE.md", "vitest.native-source.config.ts", "package-lock.json"]);
const keep = path => {
  const top = path.split("/")[0];
  if (EXCLUDED_DIRS.includes(top) || EXCLUDED_FILES.has(path)) return false;
  if (path.endsWith(".md")) return path === "THIRD_PARTY_NOTICES.md";
  return true;
};
const selected = tracked.filter(keep);

// Start from an empty tree so removed files disappear from the mirror too.
for (const entry of readdirSync(out)) if (entry !== ".git" && entry !== "node_modules") rmSync(join(out, entry), { recursive: true, force: true });
for (const path of selected) {
  const target = join(out, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(source, path), target);
}
copyFileSync(join(source, "public", "README.md"), join(out, "README.md"));

// Vendored tarballs instead of sibling checkout links. `npm pack` respects each
// package's `files`, so only built output travels.
mkdirSync(join(out, "vendor"), { recursive: true });
const vendored = {};
for (const name of VENDORED) {
  const manifest = JSON.parse(readFileSync(join(contractsRoot, "packages", name, "package.json"), "utf8"));
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", join(out, "vendor")], { cwd: join(contractsRoot, "packages", name), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const [packed] = JSON.parse(output);
  vendored[manifest.name] = { file: packed.filename, version: manifest.version };
}
for (const entry of readdirSync(join(out, "packages"))) {
  const manifestPath = join(out, "packages", entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith("@konteks/") || name.startsWith("@konteks/remote-") || !String(spec).startsWith("file:")) continue;
      if (!vendored[name]) { console.error(`${entry} depends on ${name}, which is not vendored`); process.exit(1); }
      manifest[section][name] = `file:../../vendor/${vendored[name].file}`;
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
const rootManifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
rootManifest.konteksContracts = Object.fromEntries(Object.entries(vendored).map(([name, entry]) => [name, entry.version]));
writeFileSync(join(out, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps"], { cwd: out, stdio: "inherit" });

const leaked = walk(out).filter(path => path.endsWith(".md") && !["README.md", "THIRD_PARTY_NOTICES.md"].includes(relative(out, path)));
if (leaked.length > 0) { console.error(`markdown leaked into the public tree: ${leaked.join(", ")}`); process.exit(1); }
console.log(`exported ${selected.length + 1} files to ${out}; vendored ${Object.entries(vendored).map(([name, entry]) => `${name}@${entry.version}`).join(", ")}`);

function walk(directory) {
  return readdirSync(directory).flatMap(name => {
    if (name === ".git" || name === "node_modules") return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
