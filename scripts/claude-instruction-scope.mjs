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
