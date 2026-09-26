// Interactive repair only: two clients, one real local Codex app-server owner.
// Uses a private temporary Unix socket; never starts/stops the user's daemon.
import { spawn } from 'node:child_process';
import { mkdtemp, lstat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { connectCodexLocalTransport } from '../packages/agent-runner/dist/bridge/codex-local-transport.js';
import { spawnBridge } from '../packages/agent-runner/dist/bridge/process.js';
import { resolveBridgeSpawnSpec, resolveToolingCommand, resolveBridgeFamily } from '../packages/agent-runner/dist/bridge/spec.js';
import { RunnerConfigSchema } from '../packages/agent-runner/dist/config.js';
import { resolveNativeConnectorExecutable, signNativeReleaseManifest, verifyNativeRelease } from '../packages/release/dist/native.js';
import { installOfflineAgentPackage } from '../packages/release/dist/offline-agent.js';
import { resolveNativeCodexHome } from '../packages/supervisor/dist/native/codex-home.js';
import { konteksSessionMetadata } from '../packages/agent-runner/dist/sessions/title.js';
import { setTimeout as delay } from 'node:timers/promises';

const [workspace, confirmation, packageDirectory, connectorReleaseDirectory] = process.argv.slice(2);
if (!workspace || !isAbsolute(workspace) || confirmation !== '--create-local-probe-session') throw new Error('Explicit diagnostic workspace and session creation confirmation required');
const root = await mkdtemp(join(tmpdir(), 'codex-shared-owner-'));
// Unix socket names have a small fixed bound; disk-backed TMPDIR may be long.
// Only this empty control directory uses /tmp, never package bytes or history.
const socketRoot = await mkdtemp('/tmp/codex-owner-socket-');
const socket = join(socketRoot, 'control.sock');
const children = [];
const sockets = [];
let serverDiagnostics = '';
let sessionId;
let bridge;
let runner;
const acpUpdates = [];
const start = args => {
  const child = spawn('codex', args, { cwd: workspace, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.resume();
  return child;
};
async function client(name) {
  const connection = await connectCodexLocalTransport(socket);
  sockets.push(connection);
  connection.on('error', () => undefined);
  const pending = new Map();
  const notifications = [];
  let id = 0;
  const lines = createInterface({ input: connection });
  lines.on('line', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (typeof message.id === 'number' && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${name}: ${message.error.message}`)); else request.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      connection.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Diagnostic does not approve tool actions' } }) + '\n');
    } else if (message.method) notifications.push(message);
  });
  connection.on('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`${name}: connection closed`)); } pending.clear(); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${name}: ${method} timed out`)); }, 20_000);
    pending.set(requestId, { resolve, reject, timer });
    connection.write(JSON.stringify({ id: requestId, method, params }) + '\n');
  });
  return { request, notifications, async initialize() {
    await request('initialize', { clientInfo: { name, version: '0.1.0' } });
    connection.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  } };
}
try {
  if (packageDirectory) {
    if (!isAbsolute(packageDirectory)) throw new Error('Package directory must be absolute');
    const archive = join(packageDirectory, 'codex.tgz');
    const bytes = await readFile(archive), profileBytes = await readFile(join(packageDirectory, 'profile.json'));
    const artifact = { id: 'codex-shared-local-probe', kind: 'agent_bridge', format: 'offline_agent_tgz', agentId: 'codex', os: 'debian', architecture: 'amd64', url: 'https://local-probe.invalid/codex.tgz', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, profileDigest: `sha256:${createHash('sha256').update(profileBytes).digest('hex')}`, sizeBytes: bytes.length };
    if (!connectorReleaseDirectory || !isAbsolute(connectorReleaseDirectory)) throw new Error('Existing real connector release directory required for the native manifest');
    const existing = JSON.parse(await readFile(join(connectorReleaseDirectory, 'manifest.json'), 'utf8'));
    const connector = existing.nativeArtifacts?.find(a => a.kind === 'connector' && a.os === 'debian' && a.architecture === 'amd64');
    const connectorBytes = await readFile(await resolveNativeConnectorExecutable(connectorReleaseDirectory, 'debian'));
    if (!connector || connector.digest !== `sha256:${createHash('sha256').update(connectorBytes).digest('hex')}`) throw new Error('Existing connector does not match its artifact inventory');
    const keys = generateKeyPairSync('ed25519'), keyId = 'local-probe-only';
    const manifest = signNativeReleaseManifest({ bundleVersion: '0.1.0-local-probe', protocol: { min: '1.0', max: '1.0' }, deploymentKind: 'native_connector', components: ['agent_runner'], images: [], agentBridges: [], nativeArtifacts: [artifact, connector], expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, { keyId, privateKey: keys.privateKey });
    const roots = [{ keyId, publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) }];
    const release = verifyNativeRelease(manifest, roots);
    await writeFile(join(root, 'local-probe-manifest.json'), JSON.stringify({ manifest, roots }), { mode: 0o600 });
    const prefix = join(root, 'agent');
    const profile = await installOfflineAgentPackage(archive, prefix, release.manifest.nativeArtifacts[0]);
    const credentials = join(root, 'connector-metadata'); await mkdir(credentials, { mode: 0o700 });
    runner = RunnerConfigSchema.parse({ RUNNER_AGENT_ID: 'codex', RUNNER_BRIDGE_PREFIX: prefix, RUNNER_CREDENTIAL_DIR: credentials, RUNNER_WORKSPACE_DIR: workspace, RUNNER_NATIVE_CODEX_HOME: await resolveNativeCodexHome(), RUNNER_NATIVE_CODEX_SOCKET: socket, RUNNER_NATIVE_PACKAGE_PROFILE: profile, RUNNER_NATIVE_PACKAGE_ARTIFACT: artifact });
    process.stdout.write(JSON.stringify({ kind: 'verified_local_probe_package', artifactDigest: artifact.digest, trust: 'ephemeral-local-test-root-not-production' }) + '\n');
  }
  let server;
  if (runner) {
    const command = resolveToolingCommand(runner, resolveBridgeFamily('codex'), ['codex', 'app-server', '--listen', `unix://${socket}`]);
    server = spawn(command.command, command.args, { cwd: workspace, env: resolveBridgeSpawnSpec(runner).env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(server);
  } else server = start(['app-server', '--listen', `unix://${socket}`]);
  server.stderr.on('data', chunk => { serverDiagnostics = (serverDiagnostics + chunk.toString()).slice(-4096); });
  server.stdout.resume();
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Diagnostic app-server exited');
    if (await lstat(socket).then(s => s.isSocket()).catch(() => false)) break;
    await delay(100);
  }
  const a = runner ? null : await client('konteks_shared_owner_probe');
  if (a) await a.initialize();
  if (runner) bridge = await spawnBridge({ spec: resolveBridgeSpawnSpec(runner), initializeTimeoutMs: 20_000, clientVersion: 'packaged-local-sharing-probe', handlers: { onSessionUpdate: event => acpUpdates.push(event), onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onCreateElicitation: async () => ({ action: 'cancel' }), onExit() {} } });
  const b = await client('local_user_shared_owner_probe');
  await b.initialize();
  const expectedTitle = '[konteks] Shared owner diagnostic';
  const created = bridge ? await bridge.connection.newSession({ cwd: workspace, mcpServers: [], _meta: konteksSessionMetadata(expectedTitle, 'codex') }) : await a.request('thread/start', { cwd: workspace, approvalPolicy: 'on-request', sandbox: 'read-only' });
  sessionId = bridge ? created.sessionId : created.thread.id;
  if (!bridge) await a.request('thread/name/set', { threadId: sessionId, name: expectedTitle });
  const titled = await b.request('thread/read', { threadId: sessionId, includeTurns: false });
  if (titled.thread.name !== expectedTitle) throw new Error('Native Codex did not persist the Konteks session title');
  process.stdout.write(JSON.stringify({ kind: 'native_title_verified', sessionId, title: titled.thread.name }) + '\n');
  process.stdout.write(JSON.stringify({ kind: 'created_shared_owner', sessionId }) + '\n');
  if (bridge) {
    const seeded = await bridge.connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'Shared-owner diagnostic initialization. Reply exactly: Shared owner ready. Do not call tools or inspect or change files.' }] });
    if (seeded.stopReason !== 'end_turn') throw new Error('Packaged ACP seed prompt did not complete');
    const connectorInputObserved = acpUpdates.some(n => n.sessionId === sessionId && n.update?.sessionUpdate === 'user_message_chunk' && n.update?._meta?.konteksNativeObservation?.origin === 'connector');
    process.stdout.write(JSON.stringify({ kind: 'connector_input_correlation', verified: connectorInputObserved }) + '\n');
    if (!connectorInputObserved) throw new Error('Connector input provenance was not correlated');
    acpUpdates.length = 0;
  } else {
  const seeded = await a.request('turn/start', { threadId: sessionId, input: [{ type: 'text', text: 'Shared-owner diagnostic initialization. Reply exactly: Shared owner ready. Do not call tools or inspect or change files.' }] });
  for (let i = 0; i < 120; i++) {
    if (a.notifications.some(n => n.method === 'turn/completed' && n.params?.turn?.id === seeded.turn.id)) break;
    await delay(500);
  }
  if (!a.notifications.some(n => n.method === 'turn/completed' && n.params?.turn?.id === seeded.turn.id && n.params?.turn?.status === 'completed')) throw new Error('Initial shared-owner turn did not complete');
  }
  const resumed = await b.request('thread/resume', { threadId: sessionId });
  if (resumed.thread.id !== sessionId) throw new Error('Local client resumed another thread');
  process.stdout.write(JSON.stringify({ kind: 'second_client_resumed', sessionId }) + '\n');
  const clientUserMessageId = randomUUID();
  const started = await b.request('turn/start', { threadId: sessionId, clientUserMessageId, input: [{ type: 'text', text: 'Shared-owner diagnostic from the local client. Reply exactly: Shared owner local steering verified. Do not call tools or inspect or change files.' }] });
  const turnId = started.turn.id;
  for (let i = 0; i < 120; i++) {
    if ((a ?? b).notifications.some(n => n.method === 'turn/completed' && n.params?.turn?.id === turnId)) break;
    await delay(500);
  }
  const complete = (a ?? b).notifications.find(n => n.method === 'turn/completed' && n.params?.turn?.id === turnId);
  const expectedUserText = 'Shared-owner diagnostic from the local client. Reply exactly: Shared owner local steering verified. Do not call tools or inspect or change files.';
  const user = bridge ? acpUpdates.some(n => n.sessionId === sessionId && n.update?.sessionUpdate === 'user_message_chunk' && n.update.content?.type === 'text' && n.update.content.text === expectedUserText) : a.notifications.some(n => n.method === 'item/completed' && n.params?.turnId === turnId && n.params?.item?.type === 'userMessage');
  const final = (a ?? b).notifications.find(n => n.method === 'item/completed' && n.params?.turnId === turnId && n.params?.item?.type === 'agentMessage');
  const acpReply = acpUpdates.filter(n => n.sessionId === sessionId && n.update?.sessionUpdate === 'agent_message_chunk' && n.update.content?.type === 'text').map(n => n.update.content.text).join('');
  const replyObserved = bridge ? acpReply === 'Shared owner local steering verified.' : final?.params?.item?.text === 'Shared owner local steering verified.';
  const agentChunks = acpUpdates.filter(n => n.sessionId === sessionId && n.update?.sessionUpdate === 'agent_message_chunk');
  const agentTurnCorrelated = !bridge || (agentChunks.length > 0 && agentChunks.every(n => n.update?._meta?.konteksNativeObservation?.turnId === turnId && typeof n.update?._meta?.konteksNativeObservation?.itemId === 'string'));
  const localObservation = acpUpdates.find(n => n.sessionId === sessionId && n.update?.sessionUpdate === 'user_message_chunk')?.update?._meta?.konteksNativeObservation;
  const inputCorrelationVerified = bridge ? localObservation?.turnId === turnId && localObservation?.clientUserMessageId === clientUserMessageId && localObservation?.origin === 'unclassified' : true;
  process.stdout.write(JSON.stringify({ kind: 'cross_client_activity', sessionId, turnId, completed: complete?.params?.turn?.status, userObserved: user, replyObserved, inputCorrelationVerified, agentTurnCorrelated, finalReply: final?.params?.item?.text?.slice(0,150) }) + '\n');
  if (bridge) {
    await bridge.stop();
    const retained = await b.request('thread/read', { threadId: sessionId, includeTurns: false });
    const serverRetained = retained.thread.id === sessionId && server.exitCode === null;
    process.stdout.write(JSON.stringify({ kind: 'shared_server_survives_acp_disconnect', verified: serverRetained }) + '\n');
    if (!serverRetained) throw new Error('ACP disconnect did not preserve the shared server');
  }
  if (complete?.params?.turn?.status !== 'completed' || !user || !replyObserved || !inputCorrelationVerified || !agentTurnCorrelated || final?.params?.item?.text !== 'Shared owner local steering verified.') throw new Error('Cross-client activity was not fully verified');
} finally {
  await bridge?.stop();
  for (const connection of sockets) connection.destroy();
  // Only exact children created by this diagnostic; session history is retained.
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    await Promise.race([done, delay(2000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  process.stdout.write(JSON.stringify({ kind: 'diagnostic_finished', sessionId, retainedDiagnosticDirectory: root, retainedSocketDirectory: socketRoot }) + '\n');
  if (!sessionId) process.stdout.write(JSON.stringify({ kind: 'transport_diagnostics', text: serverDiagnostics.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/https?:\/\/\S+/g, '[url]').slice(-2000) }) + '\n');
}
