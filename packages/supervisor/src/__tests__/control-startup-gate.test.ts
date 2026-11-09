import { describe, expect, it } from "vitest";
import { ConnectorAvailabilitySchema } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";

/**
 * The control socket now opens before `start()` finishes, so the closed
 * protocol must answer during startup and refuse everything it cannot compose.
 */
function handler() {
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({
    SUPERVISOR_DEPLOYMENT_KIND: "native_connector",
    SUPERVISOR_DATA_DIR: "/unused-control-startup-fixture",
    SUPERVISOR_CORE_URL: "https://core.example",
  }));
  return supervisor.controlHandler();
}

const emit = { event: () => undefined, signal: new AbortController().signal };

describe("the control protocol before startup completes", () => {
  it("answers availability.status with the starting phase and an explicit unknown return", async () => {
    const availability = await handler()({ op: "availability.status" }, emit);
    expect(ConnectorAvailabilitySchema.parse(availability)).toMatchObject({
      available: false,
      phase: "starting",
      reason: { code: "startup_in_progress" },
      expectedReturn: { kind: "unknown" },
      liveness: { state: "unknown" },
      heartbeat: { state: "unknown" },
      relay: { state: "unknown" },
    });
  });

  it("still answers status from what the constructor holds", async () => {
    const status = await handler()({ op: "status" }, emit);
    expect(status).toMatchObject({ instanceId: null, administrativeStatus: "unknown" });
  });

  it.each(["agents", "drain.status", "doctor", "instance.retire", "readiness.submit"] as const)(
    "refuses %s with a RemoteInstanceError instead of a half-composed dependency",
    async op => {
      await expect(handler()({ op } as never, emit)).rejects.toMatchObject({ code: "temporarily_unavailable" });
    },
  );
});
