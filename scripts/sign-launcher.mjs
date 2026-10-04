#!/usr/bin/env node
/**
 * Release pipeline: package and sign the launcher executable produced by
 * build-launcher.mjs.
 *   macOS   — pkgbuild + productsign (Developer ID Installer) + notarytool submit/staple
 *   Windows — WiX (candle/light) MSI + signtool Authenticode (RFC 3161 timestamp)
 *   Debian  — dpkg-deb + detached armored GPG signature (.asc) for the bootstrap
 * Secrets arrive only through the environment of this step and are removed
 * from the temporary keychain/store afterwards. The exact tool invocations are
 * the vendor-documented ones; this script is the single place they live so the
 * bootstrap verification (bootstrap/install.sh, install.ps1) stays in sync.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter((pair) => pair.length === 2));
const layout = JSON.parse(readFileSync(join("dist", "launcher-build", "PACKAGE_LAYOUT.json"), "utf8"));
const artifact = args.artifact ?? layout.out;
const version = (process.env.KONTEKS_LAUNCHER_VERSION ?? "0.0.0").replace(/^v/, "");
mkdirSync(dirname(artifact), { recursive: true });
const run = (command, argv) => execFileSync(command, argv, { stdio: "inherit" });
const has = (command) => { try { execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }); return true; } catch { return false; } };
// Without publisher credentials the pipeline still produces installable
// packages, loudly marked unsigned: the connector's own update path verifies
// executables by signed manifest digest, but the bootstrap refuses these.
const unsigned = (what) => console.warn(`WARNING: ${what} is NOT publisher-signed (no signing credentials configured); the bootstrap installers will refuse it`);

switch (args.os ?? layout.os) {
  case "macos": {
    const root = join("dist", "launcher-build", "pkgroot");
    mkdirSync(join(root, "usr", "local", "bin"), { recursive: true });
    run("cp", [layout.executable, join(root, "usr", "local", "bin", "konteks-remote")]);
    const identity = process.env.MACOS_SIGNING_IDENTITY;
    run("codesign", ["--force", ...(identity ? ["--options", "runtime", "--timestamp", "--sign", identity] : ["--sign", "-"]), join(root, "usr", "local", "bin", "konteks-remote")]);
    if (identity) {
      const unsignedPkg = join("dist", "launcher-build", "unsigned.pkg");
      run("pkgbuild", ["--root", root, "--identifier", "com.konteks.remote", "--version", version, "--install-location", "/", unsignedPkg]);
      run("productsign", ["--sign", identity, unsignedPkg, artifact]);
      if (process.env.MACOS_NOTARY_KEY) { run("xcrun", ["notarytool", "submit", artifact, "--key", process.env.MACOS_NOTARY_KEY, "--wait"]); run("xcrun", ["stapler", "staple", artifact]); }
    } else {
      run("pkgbuild", ["--root", root, "--identifier", "com.konteks.remote", "--version", version, "--install-location", "/", artifact]);
      unsigned("macOS package");
    }
    break;
  }
  case "windows": {
    // A GitHub secret is the certificate's content, not a path on the runner:
    // accept a path or base64 PFX bytes, and its password when it has one.
    const pfxSecret = process.env.WINDOWS_AUTHENTICODE_PFX;
    let pfx = pfxSecret;
    if (pfxSecret && !existsSync(pfxSecret)) {
      pfx = join(tmpdir(), `konteks-authenticode-${process.pid}.pfx`);
      writeFileSync(pfx, Buffer.from(pfxSecret.replace(/\s+/g, ""), "base64"), { mode: 0o600 });
      process.on("exit", () => rmSync(pfx, { force: true }));
    }
    const password = process.env.WINDOWS_AUTHENTICODE_PASSWORD;
    const signtool = (file) => run("signtool", ["sign", "/fd", "SHA256", "/tr", "http://timestamp.digicert.com", "/td", "SHA256", "/f", pfx, ...(password ? ["/p", password] : []), file]);
    if (pfx) signtool(layout.executable);
    const wix = process.env.WIX ? join(process.env.WIX, "bin") : null;
    const tool = (name) => (wix ? join(wix, `${name}.exe`) : name);
    if (!wix && !has("candle")) throw new Error("WiX Toolset (candle/light) is required to build the Windows installer");
    run(tool("candle"), [`-dProductVersion=${version}`, "-o", join("dist", "launcher-build", "launcher.wixobj"), "packaging/windows/launcher.wxs"]);
    run(tool("light"), ["-o", artifact, join("dist", "launcher-build", "launcher.wixobj")]);
    // No Windows code-signing certificate yet: install.ps1 trusts an unsigned
    // MSI through the Ed25519-signed SHA256SUMS instead.
    if (pfx) signtool(artifact); else console.warn("WARNING: Windows installer is NOT Authenticode-signed; install.ps1 accepts it on the signed SHA256SUMS and Windows shows 'Unknown publisher'");
    break;
  }
  case "debian": {
    const root = join("dist", "launcher-build", "debroot");
    mkdirSync(join(root, "DEBIAN"), { recursive: true });
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    run("cp", [layout.executable, join(root, "usr", "bin", "konteks-remote")]);
    const control = readFileSync("packaging/debian/control", "utf8")
      .replace("Version: 0.1.0", `Version: ${version}`)
      .replace("Architecture: amd64", `Architecture: ${args.architecture ?? "amd64"}`);
    writeFileSync(join(root, "DEBIAN", "control"), control);
    run("dpkg-deb", ["--build", "--root-owner-group", root, artifact]);
    if (process.env.DEB_SIGNING_KEY) run("gpg", ["--batch", "--yes", "--armor", "--detach-sign", "--local-user", process.env.DEB_SIGNING_KEY, "--output", `${artifact}.asc`, artifact]);
    else unsigned("Debian package");
    break;
  }
  default:
    console.error(`unknown os ${args.os}`);
    process.exit(2);
}
console.log(`signed ${artifact}`);
