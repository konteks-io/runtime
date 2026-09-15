// Explicit interactive-repair probe: real pinned ACP/Codex, no cloud assignment.
// Creates a user-visible session; never enumerate unrelated history or print auth.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { loadNativeInstallation } from '../packages/supervisor/dist/native/installation.js';
import { nativePlatform } from '../packages/launcher/dist/native/service.js';
import { parseEmbeddedRoots } from '../packages/release/dist/roots.js';
import { resolveBridgeSpawnSpec } from '../packages/agent-runner/dist/bridge/spec.js';
import { spawnBridge } from '../packages/agent-runner/dist/bridge/process.js';
import { konteksSessionMetadata } from '../packages/agent-runner/dist/sessions/title.js';

const [root, workspace, ownerPid, confirmation, observedSession] = process.argv.slice(2);
const watch = confirmation === '--watch-local-probe-session' && /^[0-9a-f-]{36}$/.test(observedSession ?? '');
if (!root || !workspace || !isAbsolute(root) || !isAbsolute(workspace) || !/^\d+$/.test(ownerPid ?? '') || (!watch && confirmation !== '--create-local-probe-session')) {
  throw new Error('Expected native root, diagnostic workspace, current supervisor PID, and --create-local-probe-session');
}
const entries = (await readFile(`/proc/${ownerPid}/environ`, 'utf8')).split('\0');
const ownerCommand = (await readFile(`/proc/${ownerPid}/cmdline`, 'utf8')).split('\0');
if (!ownerCommand.includes('serve') || !ownerCommand.includes(root)) throw new Error('PID is not serving the requested native root');
const rootsEntry = entries.find(entry => entry.startsWith('KONTEKS_RELEASE_ROOTS_JSON='));
if (!rootsEntry) throw new Error('Current native supervisor public release roots unavailable');
const installation = await loadNativeInstallation(root, { roots: parseEmbeddedRoots(rootsEntry.slice('KONTEKS_RELEASE_ROOTS_JSON='.length)), platform: nativePlatform() });
const runner = installation.runners.find(candidate => candidate.RUNNER_AGENT_ID === 'codex');
if (!runner?.RUNNER_NATIVE_CODEX_HOME) throw new Error('Shared native profile not resolved');
const spec = { ...resolveBridgeSpawnSpec(runner), cwd: workspace };
let observing = false;
let localMessages = 0;
const handlers = {
  onSessionUpdate(params) {
    if (observing && params.sessionId === observedSession && params.update.sessionUpdate === 'user_message_chunk') {
      localMessages++;
      process.stdout.write(JSON.stringify({ kind: 'observed_user_update', sessionId: observedSession, count: localMessages }) + '\n');
    }
  },
  onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  onCreateElicitation: async () => ({ action: 'cancel' }),
  onExit() {},
};
const open = () => spawnBridge({ spec, handlers, initializeTimeoutMs: 20_000, clientVersion: 'native-shared-session-repair-probe' });
let creator, reader;
let timer;
try {
  creator = await open();
  if (watch) {
    const listed = await creator.connection.listSessions({ cwd: workspace });
    if (!listed.sessions.some(session => session.sessionId === observedSession && session.cwd === workspace)) throw new Error('Probe session is not in the diagnostic workspace');
    await creator.connection.loadSession({ sessionId: observedSession, cwd: workspace, mcpServers: [] });
    observing = true;
    process.stdout.write(JSON.stringify({ kind: 'watching_local_continuation', sessionId: observedSession }) + '\n');
    await new Promise(resolve => { timer = setTimeout(resolve, 45_000); });
    process.stdout.write(JSON.stringify({ kind: 'local_continuation_observation', sessionId: observedSession, liveUserUpdates: localMessages }) + '\n');
  } else {
  const session = await creator.connection.newSession({ cwd: workspace, mcpServers: [], _meta: konteksSessionMetadata('Native session sharing diagnostic', 'codex') });
  process.stdout.write(JSON.stringify({ kind: 'created', sessionId: session.sessionId, profile: runner.RUNNER_NATIVE_CODEX_HOME }) + '\n');
  const result = await Promise.race([
    creator.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Native session sharing diagnostic. Reply exactly: Native shared session ready. Do not use any tools, inspect files, change files, or perform project work.' }] }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native sharing probe prompt timed out')), 60_000); }),
  ]);
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ kind: 'prompt_completed', sessionId: session.sessionId, stopReason: result.stopReason }) + '\n');
  await creator.stop();
  reader = await open();
  const listed = await reader.connection.listSessions({ cwd: workspace });
  const match = listed.sessions.find(candidate => candidate.sessionId === session.sessionId);
  process.stdout.write(JSON.stringify({ kind: 'independent_profile_listing', sessionId: session.sessionId, found: Boolean(match), sameWorkspace: match?.cwd === workspace }) + '\n');
  if (!match || match.cwd !== workspace) throw new Error('Independent native client did not list the same session');
  }
} finally {
  clearTimeout(timer);
  await reader?.stop();
  await creator?.stop();
}
