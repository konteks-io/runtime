import nativeFiles from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { onTestFinished, vi } from "vitest";

/** Keep DSH discovery inside the fixture, even on a developer's installed host. */
export function isolateDshDiscovery(root: string): void {
  const original = nativeFiles.realpath;
  const prefix = `${root.replaceAll("\\", "/")}/`;
  const spy = vi.spyOn(nativeFiles, "realpath").mockImplementation(async path => {
    const candidate = String(path).replaceAll("\\", "/");
    if (candidate.endsWith("/node_modules/@deepseek-ai/dsh") && !candidate.startsWith(prefix)) {
      throw Object.assign(new Error("DSH installation is outside the test fixture"), { code: "ENOENT" });
    }
    return original(path);
  });
  syncBuiltinESMExports();
  onTestFinished(() => { spy.mockRestore(); syncBuiltinESMExports(); });
}
