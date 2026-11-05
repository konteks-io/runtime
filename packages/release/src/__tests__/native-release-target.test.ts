import { describe, expect, it } from "vitest";
import { nativeManifestUrlForVersion } from "../native.js";

describe("immutable native release resolution", () => {
  it("keeps the configured origin and repository when selecting an accepted release", () => {
    for (const path of ["latest/download", "download/v1.2.0"]) {
      expect(nativeManifestUrlForVersion("1.1.0", `https://releases.example/owner/runtime/releases/${path}/native-manifest.json`))
        .toBe("https://releases.example/owner/runtime/releases/download/v1.1.0/native-manifest.json");
    }
  });

  it.each(["../other", "1.2.0/../../other", "https://other.example", "1.2.0?token=bad"])("refuses a version that could change the URL: %s", version => {
    expect(() => nativeManifestUrlForVersion(version)).toThrow();
  });

  it.each([
    "http://releases.example/runtime/releases/latest/download/native-manifest.json",
    "https://user:pass@releases.example/runtime/releases/latest/download/native-manifest.json",
    "https://releases.example/runtime/releases/latest/download/native-manifest.json?channel=custom",
    "https://releases.example/custom/native-manifest.json",
  ])("does not guess an immutable target for an unsupported channel: %s", channel => {
    expect(() => nativeManifestUrlForVersion("1.1.0", channel)).toThrow();
  });
});
