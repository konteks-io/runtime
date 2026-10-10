import { join } from "node:path";
import {
  REMOTE_RUNTIME_UPDATE_PROGRESS_MIN_CORE_CONTRACT_VERSION,
  SystemClock,
  allEqual,
  coreContractAtLeast,
  createLogger,
  jcsDigest,
  type FetchFn,
  type JsonValue,
} from "@konteks/remote-common";
import { EMBEDDED_RELEASE_ROOTS, type EmbeddedReleaseRoot } from "@konteks/remote-release";
import {
  CoreClient,
  CoreSignatureVerifier,
  SupervisorStore,
  type NativeRuntimeRecord,
  type NativeUpdateAttempt,
} from "@konteks/remote-supervisor";

export interface NativeUpdateProgressHandle {
  finish(state: "succeeded" | "failed"): Promise<void>;
}

type ProgressInput = { root: string; previous: NativeRuntimeRecord; attempt: NativeUpdateAttempt };
type ProgressOptions = { roots?: readonly EmbeddedReleaseRoot[]; fetchFn?: FetchFn };
const REQUEST_BUDGET_MS = 6_000;

/** Foreground setup reuses the existing runtime identity and TLS client. No credential is minted or persisted. */
export async function beginNativeUpdateProgress(
  input: ProgressInput,
  options: ProgressOptions = {},
): Promise<NativeUpdateProgressHandle | null> {
  const verifier = new CoreSignatureVerifier(options.roots ?? EMBEDDED_RELEASE_ROOTS);
  if (!verifier.configured) return null;
  const clock = new SystemClock();
  const client = await progressClient(input, clock, options);
  if (!client) return null;
  const deadlineAtMs = Date.now() + REQUEST_BUDGET_MS;
  const envelope = await client.fetchDesiredConfiguration(input.previous.instanceId, {
    deadlineAtMs,
  });
  if (!progressConfiguration(envelope, verifier, clock.coreNow())) return null;
  const { update } = await client.beginLocalRuntimeUpdate(
    input.previous.instanceId,
    {
      attemptId: input.attempt.id,
      targetBundle: input.attempt.bundleVersion,
      manifestDigest: input.attempt.manifestDigest,
    },
    { deadlineAtMs },
  );
  if (update.state !== "updating" || Date.parse(update.expiresAt) <= clock.coreNow()) return null;
  return {
    async finish(state) {
      // The successor may have rotated the lease. Read it again, without creating or changing identity.
      const current = await progressClient(input, clock, options);
      if (!current) return;
      await current.reportRuntimeUpdate(
        input.previous.instanceId,
        {
          updateId: update.updateId,
          targetBundle: update.targetBundle,
          manifestDigest: update.manifestDigest,
          state,
          ...(state === "failed" ? { failure: "update_failed" as const } : {}),
        },
        { deadlineAtMs: Date.now() + REQUEST_BUDGET_MS },
      );
    },
  };
}

function progressConfiguration(
  envelope: Awaited<ReturnType<CoreClient["fetchDesiredConfiguration"]>>,
  verifier: CoreSignatureVerifier,
  now: number,
): boolean {
  // Core's HTTP Date has second precision, matching the signed delivery clock allowance.
  return (
    Date.parse(envelope.issuedAt) <= now + 1_000 &&
    Date.parse(envelope.expiresAt) > now &&
    envelope.digest === jcsDigest(envelope.configuration as unknown as JsonValue) &&
    verifier.verify(envelope as unknown as { [key: string]: JsonValue }, envelope.signature) &&
    coreContractAtLeast(
      envelope.configuration.coreContractVersion,
      REMOTE_RUNTIME_UPDATE_PROGRESS_MIN_CORE_CONTRACT_VERSION,
    )
  );
}

async function progressClient(
  input: ProgressInput,
  clock: SystemClock,
  options: ProgressOptions,
): Promise<CoreClient | null> {
  const store = new SupervisorStore(join(input.root, "supervisor"));
  const [identity, key, lease] = await Promise.all([
    store.identity(),
    store.loadInstanceKey(),
    store.lease(),
  ]);
  if (!identity || !key || !lease) return null;
  if (
    !allEqual([
      [identity.instanceId, input.previous.instanceId],
      [identity.workspaceId, input.previous.workspaceId],
      [lease.workspaceId, input.previous.workspaceId],
    ])
  )
    return null;
  if (lease.mode !== "active" || !(Date.parse(lease.expiresAt) > clock.coreNow())) return null;
  return new CoreClient({
    baseUrl: input.previous.coreUrl,
    clock,
    key: () => key,
    credential: () => lease.lease,
    // Best-effort progress for the site: its retries are not the person's to
    // read. `konteks-remote update` printed raw JSON log lines under
    // "Updated to 0.12.17." when the report timed out (10-09, E30).
    logger: createLogger({ name: "update-progress", silent: true }),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
}
