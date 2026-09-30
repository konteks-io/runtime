import { describe, expect, it, vi } from "vitest";
import { refreshOwnServiceDefinition } from "../native/commands.js";
import { nativeServiceDefinition } from "../native/service.js";

/** RCA 2026-09-30: a launcher that is never replaced wrote the plist without the log file, release after release. */
describe("the serving release refreshes its own service definition", () => {
  const definition = nativeServiceDefinition({ os: "macos", home: "/Users/ada", root: "/Users/ada/Library/Application Support/konteks-remote", executable: "/Users/ada/Library/Application Support/konteks-remote/releases/release-new/konteks-connector", uid: 501 });
  const olderPlist = definition.contents.replace(/<key>StandardOutPath<\/key><string>[^<]*<\/string>\n<key>StandardErrorPath<\/key><string>[^<]*<\/string>\n/, "");

  it("rewrites a definition an older launcher wrote, so the log file arrives from the next start", async () => {
    expect(olderPlist).not.toContain("StandardOutPath");
    expect(definition.contents).toContain("<key>StandardOutPath</key>");
    const write = vi.fn(async () => undefined);
    expect(await refreshOwnServiceDefinition("root", { definition: async () => definition, read: async () => olderPlist, write })).toBe(true);
    expect(write).toHaveBeenCalledWith(definition.path, definition.contents);
  });

  it("leaves a current definition, and a service that was never installed, untouched", async () => {
    const write = vi.fn(async () => undefined);
    expect(await refreshOwnServiceDefinition("root", { definition: async () => definition, read: async () => definition.contents, write })).toBe(false);
    expect(await refreshOwnServiceDefinition("root", { definition: async () => definition, read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
