#!/usr/bin/env node
/**
 * Release pipeline: sign the connector executable produced by
 * build-launcher.mjs (in place: the self-update channel ships these exact
 * bytes) and wrap it into the platform's installer package.
 *   macOS   — codesign (Developer ID Application) + notarytool, then
 *             pkgbuild + productsign (Developer ID Installer) + notarytool/staple
 *   Windows — signtool Authenticode, then WiX (candle/light) MSI + signtool
 *   Debian  — detached Ed25519 `.sig` for the connector, dpkg-deb + armored
 *             GPG signature (.asc) for the bootstrap
 * Signing is opt-in per OS (`sign-connector.mjs`): without its secrets the
 * package is built unsigned and the job summary says so. Secrets arrive
 * only through this step's environment and are removed afterwards.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { macosSigning, notarize, report, signConnector, windowsSigning } from "./sign-connector.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => (value.startsWith("--") ? [value.slice(2), all[index + 1]] : [])).filter((pair) => pair.length === 2));
const layout = JSON.parse(readFileSync(join("dist", "launcher-build", "PACKAGE_LAYOUT.json"), "utf8"));
const artifact = args.artifact ?? layout.out;
const version = (process.env.KONTEKS_LAUNCHER_VERSION ?? "0.0.0").replace(/^v/, "");
mkdirSync(dirname(artifact), { recursive: true });
const run = (command, argv) => execFileSync(command, argv, { stdio: "inherit" });
const has = (command) => { try { execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }); return true; } catch { return false; } };

switch (args.os ?? layout.os) {
  case "macos": {
    const signing = macosSigning();
    await signConnector("macos", layout.executable, { macos: signing });
    const root = join("dist", "launcher-build", "pkgroot");
    mkdirSync(join(root, "usr", "local", "bin"), { recursive: true });
    run("cp", [layout.executable, join(root, "usr", "local", "bin", "konteks-remote")]);
    const pkgArgs = ["--root", root, "--identifier", "com.konteks.remote", "--version", version, "--install-location", "/"];
    if (!signing) {
      run("pkgbuild", [...pkgArgs, artifact]);
      report("macOS installer package", { signed: false, detail: "not Developer ID signed; install.sh refuses it for a system install" });
      break;
    }
    const unsignedPkg = join("dist", "launcher-build", "unsigned.pkg");
    run("pkgbuild", [...pkgArgs, unsignedPkg]);
    run("productsign", ["--keychain", signing.keychain, "--sign", signing.installer, unsignedPkg, artifact]);
    if (signing.notary) { notarize(signing, artifact); run("xcrun", ["stapler", "staple", artifact]); }
    report("macOS installer package", { signed: true, detail: `Developer ID Installer ${signing.team}${signing.notary ? ", notarized and stapled" : ", not notarized"}` });
    break;
  }
  case "windows": {
    const sign = windowsSigning();
    await signConnector("windows", layout.executable, { windows: sign });
    const wix = process.env.WIX ? join(process.env.WIX, "bin") : null;
    const tool = (name) => (wix ? join(wix, `${name}.exe`) : name);
    if (!wix && !has("candle")) throw new Error("WiX Toolset (candle/light) is required to build the Windows installer");
    run(tool("candle"), [`-dProductVersion=${version}`, "-o", join("dist", "launcher-build", "launcher.wixobj"), "packaging/windows/launcher.wxs"]);
    run(tool("light"), ["-o", artifact, join("dist", "launcher-build", "launcher.wixobj")]);
    // Unsigned, install.ps1 still trusts the MSI through the Ed25519-signed SHA256SUMS.
    if (sign) sign(artifact);
    report("Windows installer", sign ? { signed: true, detail: "Authenticode, timestamped" } : { signed: false, detail: "Windows shows 'Unknown publisher'; install.ps1 accepts it on the signed SHA256SUMS" });
    break;
  }
  case "debian": {
    const root = join("dist", "launcher-build", "debroot");
    mkdirSync(join(root, "DEBIAN"), { recursive: true });
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    await signConnector("debian", layout.executable);
    run("cp", [layout.executable, join(root, "usr", "bin", "konteks-remote")]);
    const control = readFileSync("packaging/debian/control", "utf8")
      .replace("Version: 0.1.0", `Version: ${version}`)
      .replace("Architecture: amd64", `Architecture: ${args.architecture ?? "amd64"}`);
    writeFileSync(join(root, "DEBIAN", "control"), control);
    run("dpkg-deb", ["--build", "--root-owner-group", root, artifact]);
    if (process.env.DEB_SIGNING_KEY) run("gpg", ["--batch", "--yes", "--armor", "--detach-sign", "--local-user", process.env.DEB_SIGNING_KEY, "--output", `${artifact}.asc`, artifact]);
    report("Debian package", process.env.DEB_SIGNING_KEY ? { signed: true, detail: "GPG detached signature" } : { signed: false, detail: "no GPG signature; install.sh refuses it for a system install" });
    break;
  }
  default:
    console.error(`unknown os ${args.os}`);
    process.exit(2);
}
console.log(`packaged ${artifact}`);
