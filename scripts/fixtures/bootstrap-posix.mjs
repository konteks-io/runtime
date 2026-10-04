// Test-only native-tool boundaries. Signature and digest operations verify the
// actual fixture bytes with Node, including on macOS's Ed25519-less LibreSSL.
import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fixture = JSON.parse(process.env.KONTEKS_BOOTSTRAP_FIXTURE);
const [operation, ...args] = process.argv.slice(2);
const effect = (value) => appendFileSync(join(fixture.directory, "effects.txt"), `${value}\n`);

function download() {
  effect("download");
  if (fixture.downloadFailed) {
    console.error("Fixture download unavailable; raw technical detail");
    return 4;
  }
  const name = new URL(args.at(-1)).pathname.split("/").at(-1);
  copyFileSync(join(fixture.directory, name), args[args.indexOf("-o") + 1]);
  return 0;
}

function signature() {
  if (
    args[0] !== "pkeyutl" ||
    ["-verify", "-pubin", "-rawin", "-inkey", "-in", "-sigfile"].some(
      (flag) => !args.includes(flag),
    )
  )
    return 1;
  const at = (flag) => args[args.indexOf(flag) + 1];
  const valid = verify(
    null,
    readFileSync(at("-in")),
    createPublicKey(readFileSync(at("-inkey"))),
    readFileSync(at("-sigfile")),
  );
  return valid ? 0 : 1;
}

function launcher() {
  appendFileSync(
    join(fixture.directory, "calls.jsonl"),
    `${JSON.stringify({ args, locale: process.env.KONTEKS_SETUP_LOCALE })}\n`,
  );
  if (args[0] === "--version") {
    console.log("konteks-remote fixture");
    return 0;
  }
  if (fixture.launcherOutput !== undefined) console.log(fixture.launcherOutput);
  return fixture.launcherCode ?? 0;
}

function install() {
  effect("package-install");
  return fixture.installCode ?? 0;
}

const hash = () => {
  console.log(
    `${createHash("sha256")
      .update(readFileSync(args.at(-1)))
      .digest("hex")}  ${args.at(-1)}`,
  );
  return 0;
};
const handlers = {
  curl: download,
  openssl: signature,
  launcher,
  sudo: install,
  sha256sum: hash,
  shasum: hash,
  uname: () => {
    console.log(args[0] === "-s" ? (fixture.os ?? "Linux") : "x86_64");
    return 0;
  },
  gpg: () => {
    if (args.includes("--with-colons"))
      console.log("fpr:::::::::0000000000000000000000000000000000000000:");
    return 0;
  },
  pkgutil: () => {
    console.log("Developer ID Installer KONTEKS0000");
    return 0;
  },
  spctl: () => 0,
  dpkg: () => 0,
};
process.exit(handlers[operation]());
