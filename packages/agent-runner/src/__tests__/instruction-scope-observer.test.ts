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
  it("reports the Stage 0 session scope: no repository hooks, no repository MCP servers, no account connectors", () => {
    const emit = vi.fn(); const observe = instructionScopeObserver(emit);
    const v3 = "[konteks] instruction_scope version=3 settings=project ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=24 hooks=disabled repository_mcp=excluded account_connectors=excluded";
    observe(`${v3}\n`);
    expect(emit).toHaveBeenCalledExactlyOnceWith({ version: 3, settings: "project", ancestors: "excluded", user: "excluded", local: "excluded", autoMemory: "excluded", auth: "official_profile", exclusionCount: 24,
      hooks: "disabled", repositoryMcp: "excluded", accountConnectors: "excluded" });
    observe(`${v3.replace("hooks=disabled", "hooks=enabled")}\n`);
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it("reports a v4 scope, and says when an integration session admitted the account connectors", () => {
    const emit = vi.fn(); const observe = instructionScopeObserver(emit);
    const v4 = (accounts: string, settings = accounts === "integration" ? "none" : "project") => `[konteks] instruction_scope version=4 settings=${settings} ancestors=excluded user=excluded local=excluded auto_memory=excluded auth=official_profile exclusions=3 hooks=disabled repository_mcp=excluded account_connectors=${accounts}`;
    observe(`${v4("excluded")}\n${v4("integration")}\n${v4("everything")}\n${v4("integration", "project")}\n${v4("excluded", "none")}\n`);
    const base = { version: 4, ancestors: "excluded", user: "excluded", local: "excluded", autoMemory: "excluded", auth: "official_profile", exclusionCount: 3, hooks: "disabled", repositoryMcp: "excluded" };
    expect(emit.mock.calls).toEqual([[{ ...base, settings: "project", accountConnectors: "excluded" }], [{ ...base, settings: "none", accountConnectors: "integration" }]]);
  });
});
