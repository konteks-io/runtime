import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Windows bootstrap must load in Windows PowerShell 5.1. "$name:" inside a
 * double-quoted string parses as a drive-qualified variable, and one such
 * string ("v$BootstrapVersion: fetching…") made the whole script fail to load
 * on every Windows computer until 0.10.8. CI also parses it with pwsh.
 */
const script = readFileSync(fileURLToPath(new URL("../../../../bootstrap/install.ps1", import.meta.url)), "utf8");
const posix = readFileSync(fileURLToPath(new URL("../../../../bootstrap/install.sh", import.meta.url)), "utf8");
const SCOPES = new Set(["env", "script", "global", "local", "private", "using", "variable", "function", "alias"]);

describe("bootstrap/install.ps1", () => {
  it("has no variable directly followed by a colon in a double-quoted string", () => {
    const offenders: string[] = [];
    for (const [index, line] of script.split("\n").entries()) {
      for (const quoted of line.match(/"(?:[^"`]|`.)*"/g) ?? []) {
        for (const match of quoted.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):/g)) {
          if (!SCOPES.has(match[1]!.toLowerCase())) offenders.push(`line ${index + 1}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names TLS 1.3 only where the running .NET knows it", () => {
    expect(script).not.toMatch(/\[Net\.SecurityProtocolType\]::Tls13/);
  });

  // Until Konteks has a Windows code-signing certificate the MSI is trusted
  // through the Ed25519-signed SHA256SUMS, with the same key install.sh pins.
  // CI (windows-2022) runs the verifier itself against RFC 8032 vectors.
  it("pins the same release key as install.sh, an Ed25519 public key", () => {
    const windowsKey = script.match(/^\$PinnedReleaseKey = '([^']+)'$/m)?.[1];
    const posixKey = posix.match(/^PINNED_RELEASE_PUBKEY="([^"]+)"$/m)?.[1];
    expect(windowsKey).toBeDefined();
    expect(windowsKey).toBe(posixKey);
    const key = createPublicKey({ key: Buffer.from(windowsKey!, "base64"), format: "der", type: "spki" });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("never takes the key from the release unless a digest names it", () => {
    const fetchKey = script.indexOf("/release-signing.pub");
    expect(fetchKey).toBeGreaterThan(script.indexOf("if ($env:KONTEKS_RELEASE_PUBKEY_SHA256) {"));
    expect(script.indexOf("release signing key digest mismatch")).toBeGreaterThan(fetchKey);
  });

  it("verifies the manifest signature before the checksum, and both before Authenticode or msiexec", () => {
    const at = (needle: string) => {
      const index = script.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const signature = at("Test-Ed25519Signature $releaseKey $sums $signature");
    expect(at("the release manifest's signature is not valid; nothing was installed")).toBeGreaterThan(signature);
    const checksum = at("package checksum mismatch; nothing was installed");
    expect(checksum).toBeGreaterThan(signature);
    expect(at("Get-AuthenticodeSignature")).toBeGreaterThan(checksum);
    expect(at("msiexec.exe")).toBeGreaterThan(at("Get-AuthenticodeSignature"));
  });

  it("holds a signed MSI to Valid and the expected publisher, and lets an unsigned one through on the signed checksums", () => {
    expect(script).toContain("This release is verified by Konteks' signed checksums; Windows may show 'Unknown publisher'.");
    expect(script).toMatch(/\$authenticode\.Status -ne 'Valid'/);
    expect(script).toMatch(/SignerCertificate\.Subject -notlike "\*\$ExpectedPublisher\*"/);
    expect(script).toMatch(/SignerCertificate\.Thumbprint -ne \$ExpectedThumbprint/);
  });

  it("defines the verifier and returns before anything runs under -VerifyOnly", () => {
    const stop = script.indexOf("if ($VerifyOnly) { return }");
    expect(stop).toBeGreaterThan(script.indexOf("function Test-Ed25519Signature"));
    for (const action of ["Invoke-WebRequest", "exit ", "Start-Process", "$ErrorActionPreference = 'Stop'"]) {
      expect(script.indexOf(action), action).toBeGreaterThan(stop);
    }
  });

  // The MSI adds konteks-remote to the machine PATH, which this window does
  // not see: the closing summary's commands ("konteks-remote agent add …")
  // would fail here. Said once, after the launcher, keeping its exit code.
  it("says to open a new window when this one cannot run konteks-remote yet, and keeps the launcher's exit code", () => {
    const launched = script.indexOf("& $launcher install --activation-id $ActivationId");
    expect(launched).toBeGreaterThan(-1);
    const tail = script.slice(launched);
    expect(tail).toMatch(/\$code = \$LASTEXITCODE/);
    expect(tail).toMatch(/Get-Command konteks-remote -ErrorAction SilentlyContinue/);
    expect(tail).toContain("open a new PowerShell window");
    expect(tail.trimEnd().endsWith("exit $code")).toBe(true);
  });

  // An MSI from before 0.10.11 runs its own old code for every command
  // and no connector update replaces it. -Update installs this release's
  // launcher on a connected computer, then updates and starts the connector.
  it("updates a connected computer's launcher with -Update: no activation, the MSI first, then update and start", () => {
    expect(script).toMatch(/^\s*\[switch\]\$Update,$/m);
    const refuseBoth = script.indexOf("if ($Update -and $ActivationId) {");
    const runtimeRoot = script.indexOf("$RuntimeRoot = Join-Path ${env:USERPROFILE} 'AppData\\Local\\konteks-remote'");
    const notInstalled = script.indexOf("if ($Update -and -not (Test-Path (Join-Path $RuntimeRoot 'native-runtime.json'))) {");
    const requireId = script.indexOf("if (-not $Update -and -not $ActivationId) {");
    expect(refuseBoth).toBeGreaterThan(script.indexOf("if ($VerifyOnly) { return }"));
    expect(runtimeRoot).toBeGreaterThan(refuseBoth);
    expect(notInstalled).toBeGreaterThan(runtimeRoot);
    expect(requireId).toBeGreaterThan(notInstalled);
    const msiexec = script.indexOf("Start-Process -FilePath 'msiexec.exe'");
    const update = script.indexOf("& $launcher update");
    const start = script.indexOf("& $launcher start");
    expect(msiexec).toBeGreaterThan(requireId);
    expect(update).toBeGreaterThan(msiexec);
    expect(start).toBeGreaterThan(update);
    expect(script.slice(msiexec, update)).toContain("-Verb RunAs -Wait -PassThru");
    expect(script.slice(update, start)).toMatch(/\$code = \$LASTEXITCODE/);
  });
});
