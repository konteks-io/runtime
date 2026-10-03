import { allEqual } from "@konteks/remote-common";

/** The live relay connection a signed Core delivery arrived on. */
interface DeliveryConnection {
  instanceId: string;
  workspaceId: string;
  connectionEpoch: number;
  leaseExpiresAt: string;
}

/** A signed delivery's addressing and validity window. */
interface DeliveryRequest {
  intent: { instanceId: string; tenantId: string };
  connectionEpoch: number;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Whether a delivery is not for this connection: it names another runtime,
 * workspace or connection epoch, was issued later than `now + skewMs`, has
 * expired, or outlives the connection's lease. An unreadable clock or lease
 * counts as not current.
 */
export function deliveryNotCurrent(request: DeliveryRequest, scope: DeliveryConnection, now: number, skewMs: number): boolean {
  const leaseDeadline = Date.parse(scope.leaseExpiresAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(leaseDeadline)) return true;
  if (Date.parse(request.issuedAt) > now + skewMs || expiresAt <= now || expiresAt > leaseDeadline) return true;
  return !allEqual([
    [request.intent.instanceId, scope.instanceId],
    [request.intent.tenantId, scope.workspaceId],
    [request.connectionEpoch, scope.connectionEpoch],
  ]);
}
