import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

// Settings-source selection does not bound Claude's parent-directory memory
// walk. Apply the supported memory exclusions independently, on new AND resumed
// queries. Keep the official auth profile and workspace-owned instructions.
export async function isolateClaudeInstructions(settings, cwd, userConfigDir) {
  const base = typeof settings === 'string'
    ? JSON.parse(await readFile(path.resolve(cwd, settings), 'utf8'))
    : settings ?? {};
  const excluded = new Set(Array.isArray(base.claudeMdExcludes)
    ? base.claudeMdExcludes.filter(value => typeof value === 'string') : []);
  // picomatch consumes glob syntax, so literal parent paths must be escaped.
  const literal = value => value.split(path.sep).join('/').replace(/[\\*?\[\]{}()!+@]/g, '\\$&');
  const addMemory = directory => {
    for (const file of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/CLAUDE.local.md']) {
      excluded.add(literal(path.join(directory, file)));
    }
    excluded.add(`${literal(path.join(directory, '.claude', 'rules'))}/**`);
  };
  for (const workspace of new Set([path.resolve(cwd), await realpath(cwd)])) {
    excluded.add(`${literal(workspace)}/**/CLAUDE.local.md`);
    let parent = path.dirname(workspace);
    while (parent !== workspace) {
      addMemory(parent);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  for (const config of new Set([path.resolve(userConfigDir), await realpath(userConfigDir).catch(() => path.resolve(userConfigDir))])) {
    excluded.add(literal(path.join(config, 'CLAUDE.md')));
    excluded.add(`${literal(path.join(config, 'rules'))}/**`);
  }
  return { ...base, claudeMdExcludes: [...excluded], autoMemoryEnabled: false };
}

// Stage 0: the repository a Konteks session works in chose its hooks,
// not the person who started the session. As flag settings these outrank the
// project's own, and they switch off only settings hooks: the SDK's callback
// hooks (the bridge's PostToolUse, Stop, Task and model-switch hooks) still run.
// The account's claude.ai connectors are not fetched or connected (the
// bridge's strictMcpConfig already leaves them out; this holds on its own).
//
// An integration task's own session admits the
// account connectors so the bound one can be called; every call still meets
// the connector's integration gate, and its hooks stay off.
export function hardenClaudeSession(settings, accountConnectors = false) {
  const hardened = { ...(settings ?? {}), disableAllHooks: true };
  if (accountConnectors) delete hardened.disableClaudeAiConnectors;
  else hardened.disableClaudeAiConnectors = true;
  return hardened;
}

// The connector supplies this versioned admission for integration tasks and
// owner-admitted direct Claude sessions (also on load/resume); any
// other shape (or a client option) admits nothing.
export function konteksAccountConnectors(meta) {
  const integration = meta && typeof meta === 'object' ? meta.konteksIntegration : undefined;
  return Boolean(integration && typeof integration === 'object' && integration.version === 1 && integration.accountConnectors === true);
}

// Only the connector's owner-direct admission loads the person's top-level MCP
// definitions. Project entries, settings, hooks and permissions never enter.
export async function ownerClaudeMcpServers(meta, userConfigDir, reservedNames) {
  if (!ownerMcpAdmission(meta)) return {};
  const file = process.env.CLAUDE_CONFIG_DIR
    ? path.join(userConfigDir, '.claude.json') : path.join(userConfigDir, '..', '.claude.json');
  const config = await readPersonalMcpConfig(file);
  const servers = config.mcpServers ?? {};
  if (!record(servers)) throw new Error('Invalid personal MCP configuration.');
  for (const [name, server] of Object.entries(servers)) validatePersonalMcp(name, server, reservedNames);
  return servers;
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

async function readPersonalMcpConfig(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!record(value)) throw new Error('Invalid personal MCP configuration.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Cannot read personal MCP configuration; check it in Claude Code.');
  }
}

function ownerMcpAdmission(meta) {
  return konteksAccountConnectors(meta) && meta?.konteksPersonalMcp?.version === 1;
}

function validatePersonalMcp(name, server, reservedNames) {
  if (reservedNames.includes(name)) throw new Error('A personal MCP server conflicts with a Konteks session server; rename it in Claude Code.');
  if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('Invalid personal MCP configuration.');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || !record(server)) throw new Error('Invalid personal MCP configuration.');
}

export async function ownerClaudeMcpToolServer(meta, userConfigDir, toolName) {
  if (!toolName.startsWith('mcp__')) return undefined;
  const servers = await ownerClaudeMcpServers(meta, userConfigDir, []);
  return Object.keys(servers).find(name => toolName.startsWith(`mcp__${name}__`));
}
