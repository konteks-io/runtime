import { afterEach, expect, it, vi } from "vitest";
import { REMOTE_INSTANCE_PROTOCOL_VERSION, generateInstanceKey } from "@konteks/remote-common";
import { Supervisor } from "../supervisor.js";
import { SupervisorConfigSchema } from "../config.js";

afterEach(() => vi.restoreAllMocks());

it("composes the assignment mux using the build protocol, not the presence of an empty cursor callback", async () => {
  const supervisor = new Supervisor(SupervisorConfigSchema.parse({ SUPERVISOR_DATA_DIR: "/unused-assignment-composition-fixture", SUPERVISOR_CORE_URL: "https://core.example" }));
  vi.spyOn(supervisor.store, "init").mockResolvedValue();
  vi.spyOn(supervisor.journal, "load").mockResolvedValue();
  vi.spyOn(supervisor.outbox, "load").mockResolvedValue();
  vi.spyOn(supervisor.store, "loadOrCreateInstanceKey").mockResolvedValue(generateInstanceKey());
  vi.spyOn(supervisor.store, "identity").mockResolvedValue(null);
  vi.spyOn(supervisor.store, "manifest").mockResolvedValue(null);
  vi.spyOn(supervisor.store, "lease").mockResolvedValue(null);
  // Stop immediately after real mux composition, before opening any transport.
  const boundary = new Error("composition boundary");
  vi.spyOn(supervisor.store, "cursors").mockRejectedValue(boundary);
  await expect(supervisor.start()).rejects.toBe(boundary);
  const pull = () => supervisor.mux.send("assignment:i", "assignment", { instanceId: "i", maxItems: 1, acceptedKinds: ["delivery"] });
  if (String(REMOTE_INSTANCE_PROTOCOL_VERSION) === "2.0") {
    expect(pull).toThrow("retained logical frame owner");
  } else {
    expect(pull()).toBe(1);
  }
});
