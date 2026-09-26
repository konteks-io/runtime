import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_MCP_PACKAGE } from "../browser.js";

describe("the QA browser pin", () => {
  it("is the same in the release build config and in the connector", () => {
    const config = JSON.parse(readFileSync(new URL("../../../../release/native-agent-builds.json", import.meta.url), "utf8")) as { browser: unknown };
    expect(config.browser).toEqual({ package: BROWSER_MCP_PACKAGE.package, version: BROWSER_MCP_PACKAGE.version, bin: BROWSER_MCP_PACKAGE.bin, agents: [...BROWSER_MCP_PACKAGE.agents] });
  });
});
