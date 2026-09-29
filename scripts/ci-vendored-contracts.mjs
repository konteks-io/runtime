#!/usr/bin/env node
/**
 * CI only: point the workspaces at the vendored contract tarballs.
 *
 * The development branch links the sibling `../packages` checkout
 * (`file:../packages/...`), which does not exist on a CI runner, so `npm ci`
 * cannot resolve `@konteks/agent-core` or `@konteks/backstage-plugin-common`
 * there. `main` and public exports already use `vendor/*.tgz`
 * (`konteksContracts` names the version). This rewrites the checked-out
 * manifests the way `export-public.mjs` does, in the runner's working tree
 * only, and never commits anything; on a tree that is already vendored it
 * changes nothing. Afterwards install with `npm install` (the lockfile still
 * names the sibling links), never `npm ci`.
 *
 *   node scripts/ci-vendored-contracts.mjs        (refuses outside CI)
 *   node scripts/ci-vendored-contracts.mjs --yes  (anywhere; dirties the tree)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
if (process.env.CI !== "true" && !process.argv.includes("--yes")) {
  console.error("ci-vendored-contracts rewrites package.json files; run it in CI, or pass --yes");
  process.exit(2);
}
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const rootManifest = readJson(join(root, "package.json"));
const contracts = rootManifest.konteksContracts ?? {};
const vendored = {};
for (const [name, version] of Object.entries(contracts)) {
  const file = `konteks-${name.replace(/^@konteks\//, "")}-${version}.tgz`;
  if (!existsSync(join(root, "vendor", file))) {
    console.error(`vendor/${file} is missing: konteksContracts names ${name}@${version}`);
    process.exit(1);
  }
  vendored[name] = { file, version };
}

let changed = 0;
const swap = (manifest, section, name, spec, replacement) => {
  if (spec === replacement) return;
  manifest[section][name] = replacement;
  changed += 1;
};
for (const [name, spec] of Object.entries(rootManifest.dependencies ?? {})) {
  if (!vendored[name]) continue;
  swap(rootManifest, "dependencies", name, spec, `file:vendor/${vendored[name].file}`);
}
writeFileSync(join(root, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);
for (const entry of readdirSync(join(root, "packages"))) {
  const manifestPath = join(root, "packages", entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = readJson(manifestPath);
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith("@konteks/") || name.startsWith("@konteks/remote-") || !String(spec).startsWith("file:")) continue;
      if (!vendored[name]) { console.error(`packages/${entry} links ${name}, which is not in konteksContracts`); process.exit(1); }
      // The tarball is declared once at the root; workspaces pin its exact version.
      swap(manifest, section, name, spec, vendored[name].version);
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(changed === 0
  ? "contracts already vendored; nothing changed"
  : `pointed ${changed} contract link(s) at vendor/ (${Object.entries(vendored).map(([name, entry]) => `${name}@${entry.version}`).join(", ")})`);
