/* global process, setTimeout */
// A stand-in for OpenCode 2.0.18's `auth` and `api integration.list`, shaped
// like the real binary's output (opencode-runtime-support proof/CP3.md). It
// keeps its credentials in `$XDG_DATA_HOME/fake-opencode.json` and records
// every call's argv and environment in `$XDG_DATA_HOME/calls.jsonl`, so tests
// can prove what reached it (and what never did).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const data = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share");
mkdirSync(data, { recursive: true });
const store = join(data, "fake-opencode.json");
const args = process.argv.slice(2);
appendFileSync(join(data, "calls.jsonl"), `${JSON.stringify({ args, env: process.env, tty: process.stdin.isTTY === true })}\n`);
const read = () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : []);
const save = value => writeFileSync(store, JSON.stringify(value));
const NAMES = { opencode: "OpenCode Console", openai: "OpenAI", deepseek: "DeepSeek", "github-copilot": "GitHub Copilot", poe: "Poe" };

const INTEGRATIONS = [
  { id: "opencode", name: "OpenCode Console", methods: [{ type: "key", label: "API key (service account)" }, { type: "env", names: ["OPENCODE_API_KEY"] },
    { id: "device", type: "oauth", label: "OpenCode Console account", form: [{ key: "server", hidden: true, type: "string", format: "uri", default: "https://opencode.ai/console" }] }], connections: [] },
  { id: "openai", name: "OpenAI", methods: [{ type: "key" }, { type: "env", names: ["OPENAI_API_KEY"] }, { id: "chatgpt-browser", type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { id: "chatgpt-headless", type: "oauth", label: "ChatGPT Pro/Plus (headless)" }], connections: [] },
  { id: "github-copilot", name: "GitHub Copilot", methods: [{ type: "env", names: ["GITHUB_TOKEN"] }, { id: "device", type: "oauth", label: "Login with GitHub Copilot", form: [
    { key: "deploymentType", title: "Select GitHub deployment type", required: true, type: "string", options: [{ value: "github.com", label: "GitHub.com" }, { value: "enterprise", label: "GitHub Enterprise" }] },
    { key: "enterpriseUrl", title: "Enter your GitHub Enterprise URL or domain", required: true, when: [{ key: "deploymentType", op: "eq", value: "enterprise" }], type: "string" }] }], connections: [] },
  { id: "deepseek", name: "DeepSeek", methods: [{ type: "key" }, { type: "env", names: ["DEEPSEEK_API_KEY"] }], connections: [] },
  { id: "snowflake-cortex", name: "Snowflake Cortex", methods: [{ type: "key", label: "Paste PAT or bearer token", form: [{ key: "account", title: "Snowflake account", required: true, type: "string" }] },
    { id: "browser", type: "oauth", label: "Login with Snowflake", form: [{ key: "account", required: true, type: "string" }] }], connections: [] },
  { id: "poe", name: "Poe", methods: [{ type: "key" }, { id: "browser", type: "oauth", label: "Login with Poe (browser)" }], connections: [] },
];

const at = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const positional = args.filter((value, index) => !value.startsWith("--") && !(args[index - 1] ?? "").startsWith("--method") && !(args[index - 1] ?? "").startsWith("--answer") && !(args[index - 1] ?? "").startsWith("--format"));
const spin = text => { for (const frame of ["◒", "◐", "◓", "◑"]) process.stdout.write(`${frame}  ${text}\u001b[999D\u001b[J`); };

if (args[0] === "api" && args.includes("integration.list")) {
  process.stdout.write(JSON.stringify({ location: { directory: process.cwd() }, data: INTEGRATIONS }));
} else if (args[0] === "auth" && args[1] === "list") {
  const grouped = new Map();
  for (const credential of read()) {
    if (!grouped.has(credential.integration)) grouped.set(credential.integration, { id: credential.integration, name: NAMES[credential.integration] ?? credential.integration, connections: [] });
    grouped.get(credential.integration).connections.push({ type: "credential", id: credential.id, label: credential.label, method: credential.method });
  }
  // OpenCode also lists credentials it found in its environment; the connector's is scrubbed.
  if (process.env.GITHUB_TOKEN) grouped.set("github-copilot", { id: "github-copilot", name: "GitHub Copilot", connections: [{ type: "environment", name: "GITHUB_TOKEN" }] });
  process.stdout.write(JSON.stringify([...grouped.values()], null, 2));
} else if (args[0] === "auth" && args[1] === "logout") {
  const [, , integration, credential] = positional;
  const before = read();
  const after = before.filter(entry => !(entry.integration === integration && entry.id === credential));
  if (after.length === before.length) { process.stdout.write("■  No such account\n"); process.exit(1); }
  save(after);
  process.stdout.write(`◇  Removed account from ${NAMES[integration] ?? integration}\n└  Done\n`);
} else if (args[0] === "auth" && args[1] === "login") {
  const integration = positional[2];
  const method = at("--method");
  process.stdout.write("┌  Connect an integration\n│\n");
  if (method === "key") {
    if (!process.stdin.isTTY) { process.stdout.write("■  API key input requires an interactive terminal\n└  Failed\n"); process.exit(1); }
    process.stdout.write(`◆  Enter your ${NAMES[integration] ?? integration} API key\n│  _`);
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.once("line", key => {
      rl.close();
      writeFileSync(join(data, "received-key.txt"), key);
      // A misbehaving build that echoes the key: the relay must never pass it on.
      process.stdout.write(`\u001b[2K\u001b[G│  ▪▪▪▪▪▪▪▪_\r\n◇  Enter your ${NAMES[integration]} API key (${key})\r\n◇  Connected to ${NAMES[integration] ?? integration}\r\n└  Done\r\n`);
      save([...read(), { integration, id: `cred_key_${read().length}`, label: NAMES[integration] ?? integration, method: "key" }]);
      process.exit(0);
    });
  } else {
    spin("Starting authorization");
    process.stdout.write("◇  Authorization started\n│\n●  Enter code: ABCD-EFGH\n│\n●  https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli\n");
    spin("Waiting for authorization");
    spin("Waiting for authorization.");
    setTimeout(() => {
      save([...read(), { integration, id: `cred_oauth_${read().length}`, label: "Personal", method: "oauth" }]);
      process.stdout.write("◇  Connected\n└  Done\n");
      process.exit(Number(process.env.FAKE_OPENCODE_LOGIN_EXIT ?? "0"));
    }, 150);
  }
} else {
  process.stderr.write(`fake opencode: unsupported ${args.join(" ")}\n`);
  process.exit(2);
}
