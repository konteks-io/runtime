import { describe, it, expect, vi } from "vitest";
import { instructionScopeObserver } from "../bridge/instruction-scope-observer.js";

const marker = "[konteks] instruction_scope version=2 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=24";
describe("bridge instruction scope diagnostics", () => {
  it("retains split markers and emits only the closed policy fields", () => {
    const emit = vi.fn(); const observe = instructionScopeObserver(emit);
    observe(marker.slice(0, 80)); expect(emit).not.toHaveBeenCalled();
    observe(`${marker.slice(80)}\nprivate stderr\n`);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ version: 2, settings: "project", ancestors: "excluded", user: "excluded", local: "excluded", autoMemory: "excluded", auth: "official_profile", exclusionCount: 24 });
  });
  it("does not report unsupported or oversized lines as applied scope", () => {
    const emit = vi.fn(); const observe = instructionScopeObserver(emit);
    observe(`${marker.replace("version=2", "version=9")}\n`);
    observe(`${"x".repeat(4096)}${marker}\n`);
    observe(`${marker} token=secret\n`);
    expect(emit).not.toHaveBeenCalled();
    observe(`${marker}\n`); expect(emit).toHaveBeenCalledTimes(1);
  });
});
