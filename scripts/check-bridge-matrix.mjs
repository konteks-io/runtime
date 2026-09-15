#!/usr/bin/env node
/**
 * CI guard: the runner-image build matrix in the workflows must name exactly
 * the bridge package/version the release pins (packages/release/src/bridges.ts,
 * mirrored from cp0-anchor-drift.md). A drift here would vendor a bridge the
 * signed manifest does not describe.
 */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter((pair) => pair.length === 2));
const source = readFileSync(new URL("../packages/release/src/bridges.ts", import.meta.url), "utf8");
const block = source.split("agentId:").find((chunk) => chunk.trim().startsWith(`"${args.family}"`));
if (!block) {
  console.error(`unknown agent family ${args.family}`);
  process.exit(1);
}
const pkg = /package:\s*"([^"]+)"/.exec(block)?.[1];
const version = /version:\s*"([^"]+)"/.exec(block)?.[1];
if (pkg !== args.package || version !== args.version) {
  console.error(`bridge matrix drift for ${args.family}: workflow has ${args.package}@${args.version}, release pins ${pkg}@${version}`);
  process.exit(1);
}
console.log(`bridge matrix ok: ${args.family} = ${pkg}@${version}`);
