import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "konteks-bootstrap-test-"));
const bin = join(root, "bin");
mkdirSync(bin);

for (const [name, body] of Object.entries({
  uname: "#!/bin/sh\ncase \"$1\" in -s) printf '%s\\n' Linux ;; -m) printf '%s\\n' x86_64 ;; esac\n",
  curl: "#!/bin/sh\nout=''\nwhile [ $# -gt 0 ]; do [ \"$1\" = -o ] && { out=$2; shift; }; shift; done\n: > \"$out\"\n",
  openssl: "#!/bin/sh\nexit 0\n",
})) writeFileSync(join(bin, name), body, { mode: 0o755 });

function runWithOsRelease(contents) {
  const osRelease = join(root, "os-release");
  writeFileSync(osRelease, contents);
  try {
    execFileSync("sh", ["bootstrap/install.sh", "--activation-id", "activation-test-id"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KONTEKS_OS_RELEASE_FILE: osRelease },
      stdio: "pipe",
    });
    return { status: 0, output: "" };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("accepts Ubuntu for the signed Debian package path", () => {
  const result = runWithOsRelease("ID=ubuntu\nVERSION_ID=\"24.04\"\n");
  assert.equal(result.status, 3);
  assert.match(result.output, /error: dpkg is required/);
  assert.doesNotMatch(result.output, /unsupported Linux distribution/);
});

test("continues to reject unsupported Linux distributions", () => {
  const result = runWithOsRelease("ID=fedora\nVERSION_ID=\"41\"\n");
  assert.equal(result.status, 3);
  assert.match(result.output, /unsupported Linux distribution 'fedora'/);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
