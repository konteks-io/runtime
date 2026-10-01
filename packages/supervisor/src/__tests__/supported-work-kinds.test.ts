import { describe, expect, it } from "vitest";
import { supportedWorkKindsForCore } from "../supervisor.js";

describe("native Operations work-kind compatibility", () => {
  it.each([
    [undefined, false, false],
    [null, false, false],
    ["7.0", false, false],
    ["7.1", true, false],
    ["7.2", true, true],
  ] as const)("preserves existing compatibility at Core %s", (version, supportsDirect, supportsOperations) => {
    const kinds = supportedWorkKindsForCore(version);
    expect(kinds.includes("direct")).toBe(supportsDirect);
    expect(kinds.includes("operations")).toBe(supportsOperations);
    expect(kinds).toContain("onboarding");
    expect(kinds).toContain("repository_relocation");
  });
});
