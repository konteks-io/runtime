import { test } from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventoryOfflineFiles } from "./offline-agent-files.mjs";

test("offline inventory preserves native dependency execution without making data executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "offline-inventory-"));
  try {
    writeFileSync(join(root, "codex"), "native executable");
    writeFileSync(join(root, "package.json"), "{}");
    chmodSync(join(root, "codex"), 0o755);
    chmodSync(join(root, "package.json"), 0o644);
    const [binary, data] = await inventoryOfflineFiles(root, ["codex", "package.json"], "node");
    assert.equal("bytes" in binary, false);
    assert.equal(binary.executable, true);
    assert.equal(data.executable, false);
    assert.equal(binary.sizeBytes, Buffer.byteLength("native executable"));
    assert.match(binary.digest, /^sha256:[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("offline inventory built on Windows marks programs by extension, which has no execute bit", async () => {
  const root = mkdtempSync(join(tmpdir(), "offline-inventory-win-"));
  try {
    writeFileSync(join(root, "claude.exe"), "native executable");
    writeFileSync(join(root, "cli.js"), "data");
    chmodSync(join(root, "claude.exe"), 0o644);
    chmodSync(join(root, "cli.js"), 0o644);
    const [program, script] = await inventoryOfflineFiles(root, ["claude.exe", "cli.js"], "node.exe", "win32");
    assert.equal(program.executable, true);
    assert.equal(script.executable, false);
    const [unix] = await inventoryOfflineFiles(root, ["claude.exe"], "node", "linux");
    assert.equal(unix.executable, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
