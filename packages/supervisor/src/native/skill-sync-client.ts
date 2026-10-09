import { LocalSkillInventorySchema, LocalSkillExportDeliverySchema, LocalSkillExportResultSchema, type LocalSkillExportIntent } from "@konteks/backstage-plugin-common/remote-instance-internal";
import { coreContractAtLeast } from "@konteks/remote-common";
import {
  RuntimeSkillSyncEnvelopeSchema, RuntimeSkillSyncFileRequestSchema,
  RuntimeSkillSyncPublishRequestSchema, RemoteFileTreeSchema,
  RuntimeSkillSyncDeliveryResponseSchema, RuntimeSkillSyncReceiptSchema,
  type RuntimeSkillSyncRequest, type RuntimeSkillSyncReceipt,
  REMOTE_INPUT_METADATA_MAX_BYTES, REMOTE_INPUT_TREE_MAX_BYTES,
  type RuntimeSkillSyncEnvelope, type RemoteFileTree,
} from "@konteks/backstage-plugin-common/remote-instance-internal";
import type { EmbeddedReleaseRoot } from "@konteks/remote-release";
import { CoreSignatureVerifier } from "../control/core-signature.js";
const unavailable = () => new Error("Organization Skill synchronization is unavailable");
/** No response body, header, URL, credential or underlying exception is retained. */
export class NativeSkillSyncTransportFailure extends Error {
  constructor(readonly httpStatus?: number) { super("Organization Skill synchronization is unavailable"); }
}
/** Machine transport: identity comes from enrollment, authority from the active lease. */
export class NativeSkillSyncClient {
  private readonly origin: string;
  private readonly verifier: CoreSignatureVerifier;
  private busy = false;
  constructor(private readonly options: {
    baseUrl: string; roots: readonly EmbeddedReleaseRoot[];
    identity: () => { workspaceId: string; instanceId: string };
    credential: () => string | null; now: () => number;
    fetchFn?: typeof fetch;
    coreContractVersion: () => string | undefined;
  }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw unavailable();
    this.origin = url.origin; this.verifier = new CoreSignatureVerifier(options.roots);
  }
  private verify(value: unknown): RuntimeSkillSyncEnvelope {
    const envelope = RuntimeSkillSyncEnvelopeSchema.parse(value), identity = this.options.identity(), now = this.options.now();
    if (!Number.isFinite(now) || !this.verifier.verifyRuntimeSkillSync(envelope) || envelope.instanceId !== identity.instanceId || envelope.catalog.binding.workspaceId !== identity.workspaceId || Date.parse(envelope.issuedAt) > now + 1000 || Date.parse(envelope.expiresAt) <= now) throw unavailable();
    return envelope;
  }
  async reportLocalInventory(value: unknown, signal?: AbortSignal): Promise<void> {
    await this.request('local-inventory', LocalSkillInventorySchema.parse(value), 1024, candidate => {
      if (!candidate || typeof candidate !== 'object' || (candidate as { accepted?: unknown }).accepted !== true) throw unavailable();
    }, signal);
  }
  async pendingLocalExport(signal?: AbortSignal): Promise<LocalSkillExportIntent | null> {
    return this.request('export-request', {}, REMOTE_INPUT_METADATA_MAX_BYTES, value => {
      const { request } = LocalSkillExportDeliverySchema.parse(value); if (!request) return null;
      this.assertLocalExport(request); return request;
    }, signal);
  }
  assertLocalExport(request: LocalSkillExportIntent): void {
    const identity = this.options.identity(), now = this.options.now();
    if (!Number.isFinite(now) || !this.verifier.verifyLocalSkillExport(request) || request.workspaceId !== identity.workspaceId || request.instanceId !== identity.instanceId || !this.options.credential() || Date.parse(request.issuedAt) > now + 1000 || Date.parse(request.expiresAt) <= now) throw unavailable();
  }
  async reportLocalExport(request: LocalSkillExportIntent, tree: RemoteFileTree | null, signal?: AbortSignal): Promise<void> {
    this.assertLocalExport(request);
    if (tree !== null && tree.treeDigest !== request.treeDigest) throw unavailable();
    await this.request('export-result', LocalSkillExportResultSchema.parse({ requestId: request.requestId, tree }), 1024, candidate => {
      this.assertLocalExport(request);
      if (!candidate || typeof candidate !== 'object' || (candidate as { accepted?: unknown }).accepted !== true) throw unavailable();
    }, signal);
  }
  async pendingRequest(signal?: AbortSignal): Promise<RuntimeSkillSyncRequest | null> {
    return this.request("request", {}, REMOTE_INPUT_METADATA_MAX_BYTES, value => {
      const { request } = RuntimeSkillSyncDeliveryResponseSchema.parse(value);
      if (!request) return null;
      const identity = this.options.identity(), now = this.options.now();
      if (!Number.isFinite(now) || !this.verifier.verifyRuntimeSkillSyncRequest(request) ||
          request.workspaceId !== identity.workspaceId || request.instanceId !== identity.instanceId ||
          Date.parse(request.issuedAt) > now + 1000 || Date.parse(request.expiresAt) <= now) throw unavailable();
      return request;
    }, signal);
  }
  async receipt(value: RuntimeSkillSyncReceipt, signal?: AbortSignal): Promise<boolean> {
    try {
      const body = RuntimeSkillSyncReceiptSchema.parse(value);
      return await this.request("receipt", body, 1024, candidate => {
        if (!candidate || typeof candidate !== "object" || Object.keys(candidate).length !== 1 ||
            typeof (candidate as { accepted?: unknown }).accepted !== "boolean") throw unavailable();
        return (candidate as { accepted: boolean }).accepted;
      }, signal);
    } catch { throw unavailable(); }
  }
  async prepare(signal?: AbortSignal): Promise<RuntimeSkillSyncEnvelope> {
    return this.request("prepare", {}, REMOTE_INPUT_METADATA_MAX_BYTES, value => this.verify(value), signal);
  }
  async read(value: unknown, skillId: string, signal?: AbortSignal): Promise<RemoteFileTree> {
    try {
      const envelope = this.verify(value), selected = envelope.catalog.skills.find(skill => skill.skillId === skillId);
      if (!selected) throw unavailable();
      const body = RuntimeSkillSyncFileRequestSchema.parse({ envelope, skillId });
      return await this.request("read", body, REMOTE_INPUT_TREE_MAX_BYTES, candidate => {
        this.verify(envelope); const tree = RemoteFileTreeSchema.parse(candidate);
        if (tree.treeDigest !== selected.treeDigest || tree.entries.length !== selected.fileCount || tree.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) !== selected.sizeBytes || !tree.entries.some(entry => entry.path === "SKILL.md")) throw unavailable();
        return tree;
      }, signal);
    } catch { throw unavailable(); }
  }
  async authorize(value: unknown, signal?: AbortSignal): Promise<void> {
    try {
      const envelope = this.verify(value), body = RuntimeSkillSyncPublishRequestSchema.parse({ envelope });
      await this.request("authorize", body, 1024, candidate => {
        this.verify(envelope);
        if (!candidate || typeof candidate !== "object" || Object.keys(candidate).length !== 1 || (candidate as { authorized?: unknown }).authorized !== true) throw unavailable();
      }, signal);
    } catch { throw unavailable(); }
  }
  private async request<T>(operation: string, body: unknown, maxBytes: number, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    if (!coreContractAtLeast(this.options.coreContractVersion(), "7.5")) throw unavailable();
    verifyReady(this.busy, signal, this.verifier.configured);
    const identity = structuredClone(this.options.identity()), credential = this.options.credential();
    verifyCredentials(identity, credential);
    this.busy = true;
    const controller = new AbortController(), cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true }); const timer = setTimeout(cancel, 90000);
    const pending = new Set<Promise<unknown>>(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let httpStatus: number | undefined;
    const wait = async <U>(task: Promise<U>): Promise<U> => {
      pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task));
      let abort = () => {};
      const stopped = new Promise<never>((_, reject) => { abort = () => reject(unavailable()); });
      controller.signal.addEventListener("abort", abort, { once: true });
      try { if (controller.signal.aborted) throw unavailable(); const result = await Promise.race([task, stopped]); if (controller.signal.aborted) throw unavailable(); return result; }
      finally { controller.signal.removeEventListener("abort", abort); }
    };
    try {
      const response = await wait((this.options.fetchFn ?? fetch)(`${this.origin}/api/remote-instances/internal/remote-instances/${encodeURIComponent(identity.instanceId)}/skills/sync/${operation}`, {
        method: "POST", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
      }).then(result => { if (controller.signal.aborted) void result.body?.cancel().catch(() => {}); return result; }));
      httpStatus = response.status;
      verifyResponse(response, maxBytes);
      reader = response.body!.getReader();
      const bytes = await readBody(reader, wait, maxBytes);
      verifyIdentity(this.options.identity(), identity);
      return decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch { throw new NativeSkillSyncTransportFailure(httpStatus); }
    finally {
      finishRequest(timer, signal, cancel, controller, reader);
      const release = () => { this.busy = false; };
      if (pending.size) void Promise.allSettled([...pending]).then(release); else release();
    }
  }
}

function verifyCredentials(identity: { instanceId: string; workspaceId: string }, credential: string | null): asserts credential is string {
  if (!identity.instanceId || !identity.workspaceId || !credential || /\s/.test(credential)) throw unavailable();
}
function verifyIdentity(current: { instanceId: string; workspaceId: string }, expected: { instanceId: string; workspaceId: string }): void {
  if (current.instanceId !== expected.instanceId || current.workspaceId !== expected.workspaceId) throw unavailable();
}
function verifyResponse(response: Response, maxBytes: number): void {
  try {
    if (response.status !== 200 || response.redirected || response.headers.has("content-range") ||
      !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get("content-type") ?? "") || !response.body) throw unavailable();
    verifyLength(response.headers.get("content-length"), maxBytes);
  } catch (error) { cancelBody(response); throw error; }
}
function verifyLength(length: string | null, maxBytes: number): void {
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw unavailable();
}
async function readBody(reader: ReadableStreamDefaultReader<Uint8Array>, wait: <T>(task: Promise<T>) => Promise<T>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const chunk = await wait(reader.read());
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) throw unavailable();
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, bytes);
}

function verifyReady(busy: boolean, signal: AbortSignal | undefined, configured: boolean): void {
  if (busy || signal?.aborted || !configured) throw unavailable();
}
function cancelBody(response: Response): void { void response.body?.cancel().catch(() => {}); }
function finishRequest(timer: ReturnType<typeof setTimeout>, signal: AbortSignal | undefined, cancel: () => void,
  controller: AbortController, reader: ReadableStreamDefaultReader<Uint8Array> | undefined): void {
  clearTimeout(timer); signal?.removeEventListener("abort", cancel); controller.abort();
  if (reader) void reader.cancel().catch(() => {});
}
