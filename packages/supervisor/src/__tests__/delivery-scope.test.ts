import { describe, expect, it } from "vitest";
import { CORE_DELIVERY_CLOCK_SKEW_MS, deliveryNotCurrent, deliveryStaleReason } from "../control/delivery-scope.js";

/** 10-15: an answer refused as "connection_window" alone could not be told apart; each refusal now says which check and what it compared. */
describe("why a Core delivery is not for this connection", () => {
  const now = Date.parse("2026-10-15T18:20:29Z");
  const scope = { instanceId: "instance-1", workspaceId: "workspace-1", connectionEpoch: 7, leaseExpiresAt: "2026-10-15T18:30:24.000Z" };
  const request = { intent: { instanceId: "instance-1", tenantId: "workspace-1" }, connectionEpoch: 7,
    issuedAt: "2026-10-15T18:20:28.000Z", expiresAt: "2026-10-15T18:28:00.000Z" };
  const reason = (over: Partial<typeof request> = {}, scopeOver: Partial<typeof scope> = {}) =>
    deliveryStaleReason({ ...request, ...over }, { ...scope, ...scopeOver }, now, CORE_DELIVERY_CLOCK_SKEW_MS);

  it("accepts a delivery for this connection, inside its lease", () => {
    expect(reason()).toBeNull();
    expect(deliveryNotCurrent(request, scope, now, CORE_DELIVERY_CLOCK_SKEW_MS)).toBe(false);
  });

  it("names the check that refused and the times it compared", () => {
    expect(reason({ expiresAt: "2026-10-15T18:45:00.000Z" })).toBe("beyond_lease expiresAt=2026-10-15T18:45:00.000Z leaseExpiresAt=2026-10-15T18:30:24.000Z");
    expect(reason({ expiresAt: "2026-10-15T18:20:00.000Z" })).toBe("expired expiresAt=2026-10-15T18:20:00.000Z now=2026-10-15T18:20:29.000Z");
    expect(reason({ issuedAt: "2026-10-15T18:26:00.000Z" })).toMatch(/^issued_ahead /);
    expect(reason({ connectionEpoch: 6 })).toBe("epoch delivery=6 connection=7");
    expect(reason({ intent: { instanceId: "instance-2", tenantId: "workspace-1" } })).toBe("instance");
    expect(reason({ intent: { instanceId: "instance-1", tenantId: "workspace-2" } })).toBe("workspace");
    expect(reason({}, { leaseExpiresAt: "not a time" })).toBe("lease_unreadable");
  });

  it("treats an unreadable expiry as expired rather than current", () => {
    expect(reason({ expiresAt: "not a time" })).toMatch(/^expired /);
  });
});
