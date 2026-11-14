import { describe, expect, it } from "vitest";
import { fetchedAgentPin, fetchedAgentPlatformPin, FetchedAgentSignerSchema } from "../fetched-agents.js";
import { hostAgentFamily, hostAgentVersionSupported } from "../bridges.js";

describe("Google Antigravity on Linux and Windows", () => {
  for (const key of ["linux-x64", "linux-arm64", "win32-x64", "win32-arm64"] as const) {
    it(`offers the pinned ACP server on ${key}`, () => {
      const pin = fetchedAgentPlatformPin("antigravity", key);
      expect(pin).toBeDefined();
      expect(pin!.command).toBe(key.startsWith("win32") ? "agy_acp_server.exe" : "agy_acp_server.par");
      expect(pin!.args).toEqual(key.startsWith("linux") ? ["--uid="] : []);
      expect(new URL(pin!.url).hostname).toBe("dl.google.com");
      expect(pin!.files.some(file => file.path === pin!.command)).toBe(true);
      expect(pin!.signer.kind).toBe(key.startsWith("win32") ? "authenticode" : "none");
    });
  }

  it("accepts the version supplying Google's Linux and Windows packages", () => {
    const pin = fetchedAgentPin("antigravity")!;
    expect(pin.version).toBe("1.5.0");
    expect(hostAgentVersionSupported(hostAgentFamily("antigravity"), pin.version)).toBe(true);
  });

  it("pins Windows archives to Google's Authenticode identity", () => {
    for (const key of ["win32-x64", "win32-arm64"] as const) {
      expect(fetchedAgentPlatformPin("antigravity", key)?.signer).toMatchObject({
        kind: "authenticode", certificateSha256: "2029505d14baf18af60a0d1a7d8b56447db643b32faa849d4c08d2ab1ff3a4fd",
      });
    }
  });

  it("pins the exact public signing certificate rather than a display name", () => {
    expect(FetchedAgentSignerSchema.safeParse({ kind: "authenticode", certificateSha256: "2029505d14baf18af60a0d1a7d8b56447db643b32faa849d4c08d2ab1ff3a4fd" }).success).toBe(true);
    expect(FetchedAgentSignerSchema.safeParse({ kind: "authenticode", certificateSha256: "Google LLC" }).success).toBe(false);
  });
});
