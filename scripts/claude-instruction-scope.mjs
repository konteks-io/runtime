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

// Stage 0 (S0-1): the repository a Konteks session works in chose its hooks,
// not the person who started the session. As flag settings these outrank the
// project's own, and they switch off only settings hooks: the SDK's callback
// hooks (the bridge's PostToolUse, Stop, Task and model-switch hooks) still run.
// S0-2: the account's claude.ai connectors are not fetched or connected (the
// bridge's strictMcpConfig already leaves them out; this holds on its own).
//
// CP2 (external-integration): an integration task's own session admits the
// account connectors so the bound one can be called; every call still meets
// the connector's integration gate, and its hooks stay off.
export function hardenClaudeSession(settings, accountConnectors = false) {
  const hardened = { ...(settings ?? {}), disableAllHooks: true };
  if (accountConnectors) delete hardened.disableClaudeAiConnectors;
  else hardened.disableClaudeAiConnectors = true;
  return hardened;
}

// Only the connector's integration session/new carries this, versioned; any
// other shape (or a client option) admits nothing.
export function konteksAccountConnectors(meta) {
  const integration = meta && typeof meta === 'object' ? meta.konteksIntegration : undefined;
  return Boolean(integration && typeof integration === 'object' && integration.version === 1 && integration.accountConnectors === true);
}
