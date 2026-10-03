import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNativeManual, manualReadCommand, nativeGuide } from "../native/guide.js";
import { execFileSync } from "node:child_process";
it("explains PATH discovery without claiming to modify shell profiles", () => {
  expect(nativeGuide()).toContain("On macOS, man discovers this manual when <runtime-root>/bin is on PATH.");
  expect(nativeGuide()).toContain("The installer prints the PATH command when needed; it does not edit your shell profile.");
});
it("quotes the manual path as one literal shell argument", () => {
  const directory = "/tmp/a'b $(printf unsafe) `printf unsafe` $HOME";
  const command = manualReadCommand(directory).replace(/^man -M /, "printf '%s' ").replace(/ konteks-remote$/, "");
  expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe(directory);
});
it("installs the offline manual below the runtime root", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-manual-"));
  try {
    const directory = await installNativeManual(root);
    expect(directory).toBe(join(root, "share", "man"));
    const manual = await readFile(join(directory, "man1", "konteks-remote.1"), "utf8");
    expect(manual).toContain(".TH KONTEKS-REMOTE 1");
    expect(manual).toContain("REMOVAL");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses a substituted manual directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-manual-"));
  const outside = await mkdtemp(join(tmpdir(), "native-manual-outside-"));
  try {
    await symlink(outside, join(root, "share"));
    await expect(installNativeManual(root)).rejects.toThrow();
    await expect(readFile(join(outside, "man", "man1", "konteks-remote.1"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
