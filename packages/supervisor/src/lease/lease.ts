import { RemoteInstanceError, RemoteInstanceLeaseClaimsSchema, parseRfc3339, type Clock, type RelayChannel } from "@konteks/remote-common";
import type { LeaseRecord } from "../state/store.js";

/** Only Core lease acquisition/adoption; never agent execution or recovery. */
export type LeaseAcquisition = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Lease handling. The lease is a Core-signed token; the supervisor reads its
 * claims to schedule renewal and to gate what it may do, but Core remains the
 * authority and re-evaluates limits on every renew/assignment.
 */
/** Canonical signed payload validation followed only by a local time projection. */
export const LeaseClaimsSchema = RemoteInstanceLeaseClaimsSchema.transform(claims => {
  const { drain_deadline, ...rest } = claims;
  return { ...rest, ...(drain_deadline === undefined ? {} : { drain_deadline: parseRfc3339(drain_deadline) / 1000 }) };
});
export type LeaseClaims = ReturnType<typeof LeaseClaimsSchema.parse>;

interface ExpectedLease { instanceId: string; audience: string; deploymentKind?: "native_connector" | "appliance" }

/** Decodes canonical Core HTTPS claims; this does not verify a JWS signature. */
export function decodeLeaseClaims(lease: string, expected: ExpectedLease): LeaseClaims {
  return decode(lease, expected, false);
}

/** Historical numeric deadlines are accepted only on the stored-record read path. */
export function decodeStoredLeaseClaims(lease: string, expected: ExpectedLease): LeaseClaims {
  return decode(lease, expected, true);
}

function decode(lease: string, expected: ExpectedLease, stored: boolean): LeaseClaims {
  const segments = lease.split(".");
  const payload = segments.length === 3 ? segments[1] : undefined;
  if (!payload) throw new RemoteInstanceError("temporarily_unavailable", "lease is not a compact JWS");
  let claims: LeaseClaims;
  try {
    const candidate: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (stored && candidate && typeof candidate === "object" && "drain_deadline" in candidate && typeof candidate.drain_deadline === "number" && Number.isSafeInteger(candidate.drain_deadline) && candidate.drain_deadline >= 0) {
      claims = LeaseClaimsSchema.parse({ ...candidate, drain_deadline: new Date(candidate.drain_deadline * 1000).toISOString() });
    } else claims = LeaseClaimsSchema.parse(candidate);
  } catch (error) {
    throw new RemoteInstanceError("temporarily_unavailable", "lease claims do not parse", { cause: error });
  }
  if (claims.sub !== expected.instanceId) throw new RemoteInstanceError("registration_mismatch", "lease subject is not this instance");
  if (claims.aud !== expected.audience) throw new RemoteInstanceError("registration_mismatch", "lease audience mismatch");
  if (expected.deploymentKind === "native_connector" && (claims.deployment_kind !== "native_connector" || claims.components.length !== 1 || claims.components[0] !== "agent_runner")) {
    throw new RemoteInstanceError("registration_mismatch", "lease topology does not match the native connector");
  }
  if (expected.deploymentKind === "appliance" && claims.deployment_kind === "native_connector") throw new RemoteInstanceError("registration_mismatch", "native lease cannot authorize an appliance");
  return claims;
}

export function leaseRecordFromClaims(lease: string, claims: LeaseClaims): LeaseRecord {
  return {
    lease,
    mode: claims.lease_mode,
    expiresAt: new Date(claims.exp * 1_000).toISOString(),
    drainDeadline: claims.drain_deadline === undefined ? null : new Date(claims.drain_deadline * 1_000).toISOString(),
    issuedAt: new Date(claims.iat * 1_000).toISOString(),
    workspaceId: claims.workspace_id,
  };
}

/** Channels a drain-only lease may still open (A2 §5). */
const DRAIN_ONLY_CHANNELS: ReadonlySet<RelayChannel> = new Set(["control", "heartbeat", "assignment", "observation", "support"]);

export class LeaseState {
  private record: LeaseRecord | null = null;

  constructor(private readonly clock: Clock) {}

  set(record: LeaseRecord | null): void {
    this.record = record;
  }

  current(): LeaseRecord | null {
    return this.record;
  }

  isValid(): boolean {
    if (!this.record) return false;
    return parseRfc3339(this.record.expiresAt) > this.clock.coreNow();
  }

  mode(): "active" | "drain_only" | "none" {
    if (!this.isValid() || !this.record) return "none";
    if (this.record.mode === "drain_only" && this.record.drainDeadline !== null && parseRfc3339(this.record.drainDeadline) <= this.clock.coreNow()) {
      return "none";
    }
    return this.record.mode;
  }

  canPullNewWork(): boolean {
    return this.mode() === "active";
  }

  canOpenChannel(channel: RelayChannel): boolean {
    const mode = this.mode();
    if (mode === "none") return channel === "control";
    if (mode === "active") return true;
    return DRAIN_ONLY_CHANNELS.has(channel);
  }

  /**
   * Renew at half the remaining TTL, but never later than 30 s before expiry
   * and never sooner than 5 s; skew is folded in through the clock's coreNow.
   */
  nextRenewalDelayMs(): number {
    if (!this.record) return 0;
    const remaining = parseRfc3339(this.record.expiresAt) - this.clock.coreNow();
    return Math.max(5_000, Math.min(remaining / 2, Math.max(remaining - 30_000, 5_000)));
  }
}
