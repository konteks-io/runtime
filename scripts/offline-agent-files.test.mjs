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
