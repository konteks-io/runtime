#!/usr/bin/env node
/**
 * Operator/e2e helper: send one closed-protocol control request to an installed
 * native connector and print the reply. The authenticated loopback client is
 * the launcher's own; this only widens the reachable operations (for example
 * `update.apply`, `update.status`, `drain.cancel`) beyond the public commands.
 *
 *   node scripts/native-control-call.mjs --root <install root> --op update.status
 */
import { z } from "zod";
import { SupervisorControl } from "../packages/launcher/dist/control.js";
import { ControlRequestSchema, NativeUpdateApplySchema, NativeUpdateStatusSchema } from "../packages/common/dist/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter(pair => pair.length === 2));
if (!args.root || !args.op) { console.error("usage: native-control-call.mjs --root <root> --op <op> [--json '{...}']"); process.exit(2); }
const record = JSON.parse(await readFile(join(args.root, "native-runtime.json"), "utf8"));
const request = ControlRequestSchema.parse({ op: args.op, ...(args.json ? JSON.parse(args.json) : {}) });
const schema = args.op === "update.apply" ? NativeUpdateApplySchema : args.op === "update.check" || args.op === "update.status" ? NativeUpdateStatusSchema : z.unknown();
const control = new SupervisorControl({ supervisorData: join(args.root, "supervisor") }, record.controlPort);
console.log(JSON.stringify(await control.call(request, schema, { timeoutMs: 120_000 }), null, 2));
