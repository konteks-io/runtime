import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAcpLiveUserPatch, patchCodexAcpLiveUsers } from "./codex-acp-live-user-patch.mjs";

test("live-user compatibility change rejects an unreviewed upstream version", () => {
  assert.throws(() => patchCodexAcpLiveUsers("untrusted", "1.10.1"), /requires review/);
});

test("version equality does not allow modified or incomplete upstream bytes", () => {
  assert.throws(() => patchCodexAcpLiveUsers("", codexAcpLiveUserPatch.version), /requires review/);
  assert.throws(() => patchCodexAcpLiveUsers("// locally modified artifact", codexAcpLiveUserPatch.version), /requires review/);
});
