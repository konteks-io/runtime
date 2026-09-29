#!/usr/bin/env node
/**
 * Agent OS proof summary: every job's JSON result into one table (per agent
 * and OS) plus the checks that failed. Fails when a required check failed or
 * an expected result is missing (a job that died before writing one).
 *
 *   node scripts/agent-os-proof/summary.mjs --dir <results> [--out <markdown>]
 *        [--agents claude-code,codex,dsh,opencode] [--oses macos-15,ubuntu-24.04,…]
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : []).filter(pair => pair.length === 2));
if (!args.dir) { console.error("usage: summary.mjs --dir <results> [--out <markdown>]"); process.exit(2); }
const agents = (args.agents ?? "claude-code,codex,dsh,opencode").split(",");
const oses = (args.oses ?? "macos-15,ubuntu-24.04,ubuntu-24.04-arm,windows-2022").split(",");

const walk = directory => existsSync(directory) ? readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? walk(path) : name.endsWith(".json") ? [path] : [];
}) : [];
const results = new Map();
for (const path of walk(args.dir)) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.schemaVersion !== 1 || !value.agent) continue;
    const os = value.matrixOs ?? /(?:^|[\\/])([a-z0-9.-]+)\.json$/.exec(path)?.[1]?.replace(`${value.agent}-`, "");
    results.set(`${value.agent}|${os}`, value);
  } catch { /* not a result */ }
}

const cell = result => {
  if (!result) return "missing";
  const failed = result.checks.filter(entry => entry.required && entry.status === "fail").map(entry => entry.id);
  const turn = result.checks.find(entry => entry.id === "real_turn");
  const turnWord = !turn ? "" : turn.status === "pass" ? ", real turn" : turn.status === "not_proven" ? ", turn not proven" : "";
  return failed.length === 0 ? `pass (${result.agentVersion ?? "?"}${turnWord})` : `FAIL: ${failed.join(", ")}`;
};
const lines = [];
lines.push("## Agent OS proof", "");
lines.push(`| Agent | ${oses.join(" | ")} |`, `|---|${oses.map(() => "---").join("|")}|`);
for (const agent of agents) lines.push(`| ${agent} | ${oses.map(os => cell(results.get(`${agent}|${os}`))).join(" | ")} |`);
lines.push("");
const problems = [];
for (const agent of agents) for (const os of oses) {
  const result = results.get(`${agent}|${os}`);
  if (!result) { problems.push({ agent, os, id: "result", observed: "no result: the job failed before the probe wrote one (see its log)" }); continue; }
  for (const entry of result.checks) if (entry.required && entry.status === "fail") problems.push({ agent, os, id: entry.id, observed: entry.observed });
}
if (problems.length > 0) {
  lines.push("### Failed checks", "", "| Agent | OS | Check | Observed |", "|---|---|---|---|");
  for (const problem of problems) lines.push(`| ${problem.agent} | ${problem.os} | ${problem.id} | ${String(problem.observed).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 400)} |`);
  lines.push("");
}
const notProven = [...results.values()].flatMap(result => result.checks.filter(entry => entry.status === "not_proven").map(entry => `${result.agent} on ${result.matrixOs ?? result.os.platform}: ${entry.observed}`));
if (notProven.length > 0) lines.push("### Not proven", "", ...notProven.map(line => `- ${line}`), "");
const markdown = `${lines.join("\n")}\n`;
if (args.out) (existsSync(args.out) ? appendFileSync : writeFileSync)(args.out, markdown);
console.log(markdown);
if (process.env.GITHUB_ACTIONS === "true") {
  const escape = text => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const agent of agents) console.log(`::notice title=${escape(`agent OS proof: ${agent}`)}::${escape(oses.map(os => `${os}: ${cell(results.get(`${agent}|${os}`))}`).join(" ; "))}`);
}
process.exit(problems.length > 0 ? 1 : 0);
