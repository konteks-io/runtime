import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAcpLiveUserPatch, konteksTitlePrefixCheck, patchCodexAcpLiveUsers } from "./codex-acp-live-user-patch.mjs";

test("live-user compatibility change rejects an unreviewed upstream version", () => {
  assert.throws(() => patchCodexAcpLiveUsers("untrusted", "1.10.1"), /requires review/);
});

test("version equality does not allow modified or incomplete upstream bytes", () => {
  assert.throws(() => patchCodexAcpLiveUsers("", codexAcpLiveUserPatch.version), /requires review/);
  assert.throws(() => patchCodexAcpLiveUsers("// locally modified artifact", codexAcpLiveUserPatch.version), /requires review/);
});

test("the injected title check accepts both Konteks title forms and nothing else", () => {
  const check = new Function(`return ${konteksTitlePrefixCheck}`)();
  assert.equal(check.test("[konteks] Coding session 3fa9c1d2"), true);
  assert.equal(check.test("[konteks/Todo List/initiative] [v3] Stand up the todo list API 3fa9c1d2"), true);
  assert.equal(check.test("[konteksx] Other"), false);
  assert.equal(check.test("Fix filters"), false);
});
