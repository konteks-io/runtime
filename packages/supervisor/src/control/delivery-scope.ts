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
 * How far a Core delivery's `issuedAt` may run ahead of this computer's clock.
 * Core and a person's computer are rarely in step (10-15: taufan-mac ran about
 * 450 ms behind Core), and each delivery still expires on its own clock and is
 * used once.
 */
export const CORE_DELIVERY_CLOCK_SKEW_MS = 300_000;

/**
 * Why a delivery is not for this connection, or null when it is: it names
 * another runtime, workspace or connection epoch, was issued later than
 * `now + skewMs`, has expired, or outlives the connection's lease. An
 * unreadable clock or lease counts as not current. The reason carries the
 * times it compared, so a refusal explains itself from the log (10-15: an
 * answer refused as "connection_window" alone could not be told apart).
 */
export function deliveryStaleReason(request: DeliveryRequest, scope: DeliveryConnection, now: number, skewMs: number): string | null {
  const leaseDeadline = Date.parse(scope.leaseExpiresAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(now)) return "clock";
  if (!Number.isFinite(leaseDeadline)) return "lease_unreadable";
  return windowStaleReason(request, scope, now, skewMs, { expiresAt, leaseDeadline }) ?? addressStaleReason(request, scope);
}

function windowStaleReason(request: DeliveryRequest, scope: DeliveryConnection, now: number, skewMs: number,
  times: { expiresAt: number; leaseDeadline: number }): string | null {
  const at = new Date(now).toISOString();
  if (Date.parse(request.issuedAt) > now + skewMs) return `issued_ahead issuedAt=${request.issuedAt} now=${at}`;
  if (!(times.expiresAt > now)) return `expired expiresAt=${request.expiresAt} now=${at}`;
  if (times.expiresAt > times.leaseDeadline) return `beyond_lease expiresAt=${request.expiresAt} leaseExpiresAt=${scope.leaseExpiresAt}`;
  return null;
}

function addressStaleReason(request: DeliveryRequest, scope: DeliveryConnection): string | null {
  if (request.intent.instanceId !== scope.instanceId) return "instance";
  if (request.intent.tenantId !== scope.workspaceId) return "workspace";
  if (request.connectionEpoch !== scope.connectionEpoch) return `epoch delivery=${request.connectionEpoch} connection=${scope.connectionEpoch}`;
  return null;
}

/** Whether a delivery is not for this connection; see `deliveryStaleReason`. */
export function deliveryNotCurrent(request: DeliveryRequest, scope: DeliveryConnection, now: number, skewMs: number): boolean {
  return deliveryStaleReason(request, scope, now, skewMs) !== null;
}
