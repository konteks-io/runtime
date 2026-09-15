#!/usr/bin/env node
/**
 * Image builds resolve the shared `@konteks/*` contracts from the Konteks
 * registry (D41), while development uses `file:` links into the sibling
 * `packages` checkout. This rewrites every `file:` dependency on a published
 * `@konteks/*` package to the version pinned in `packages/*/package.json`'s
 * `konteksContracts` field (or `KONTEKS_CONTRACTS_VERSION`), in place, inside
 * the image build context only. It never runs against a developer checkout
 * unless invoked explicitly.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const version = process.env.KONTEKS_CONTRACTS_VERSION ?? readRootPin();
if (!version) {
  console.error("KONTEKS_CONTRACTS_VERSION is not set and package.json has no konteksContracts pin");
  process.exit(1);
}

const packagesDir = join(root, "packages");
for (const entry of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let changed = false;
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = manifest[section] ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      if (name.startsWith("@konteks/") && !name.startsWith("@konteks/remote-") && String(spec).startsWith("file:")) {
        deps[name] = `^${version}`;
        changed = true;
      }
    }
  }
  if (changed) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function readRootPin() {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).konteksContracts;
  } catch {
    return undefined;
  }
}
