import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  dpkg: "#!/bin/sh\nexit 0\n",
  gpg: "#!/bin/sh\nexit 0\n",
  sha256sum: "#!/bin/sh\nprintf '%s  %s\\n' fake \"$1\"\n",
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

test("accepts Ubuntu for the signed Debian package path", { skip: process.platform === "win32" }, () => {
  const result = runWithOsRelease("ID=ubuntu\nVERSION_ID=\"24.04\"\n");
  // The empty fake release must stop at package verification, before dpkg -i.
  assert.equal(result.status, 4);
  assert.match(result.output, /error: package checksum mismatch; refusing to install/);
  assert.doesNotMatch(result.output, /unsupported Linux distribution/);
});

test("continues to reject unsupported Linux distributions", { skip: process.platform === "win32" }, () => {
  const result = runWithOsRelease("ID=fedora\nVERSION_ID=\"41\"\n");
  assert.equal(result.status, 3);
  assert.match(result.output, /unsupported Linux distribution 'fedora'/);
});

// Exercise the complete bootstrap with a genuinely signed fixture release.
// Only downloads, Windows Installer, and the installed launcher are replaced;
// the signature and package-digest checks still run before the mock MSI can run.
const powershell = process.env.KONTEKS_TEST_POWERSHELL ?? "powershell.exe";
const windowsOnly = { skip: process.platform !== "win32" };
const psLiteral = value => `'${value.replaceAll("'", "''")}'`;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function runWindowsBootstrap(options = {}) {
  const { msiCode, cancelled, tampered, update, updateCode, startCode } = {
    msiCode: 0,
    cancelled: false,
    tampered: false,
    update: true,
    updateCode: 0,
    startCode: 0,
    ...options,
  };
  const fixture = mkdtempSync(join(root, "windows bootstrap "));
  const profile = join(fixture, "profile");
  const runtimeRoot = join(profile, "AppData", "Local", "konteks-remote");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(join(runtimeRoot, "native-runtime.json"), "{}\n");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "pem" });
  const msi = Buffer.from("the Windows installer fixture\n");
  const sums = Buffer.from(`${sha256(msi)}  konteks-remote-x64.msi\n`);
  for (const [name, bytes] of Object.entries({
    "release-signing.pub": key,
    "SHA256SUMS": sums,
    "SHA256SUMS.sig": sign(null, sums, privateKey),
    "konteks-remote-x64.msi": tampered ? Buffer.from("changed installer") : msi,
  })) writeFileSync(join(fixture, name), bytes);
  const callsPath = join(fixture, "launcher-calls.jsonl");
  const msiCallPath = join(fixture, "msi-call.json");
  const harnessPath = join(fixture, "run.ps1");
  writeFileSync(harnessPath, `
# A PowerShell 7 parent can give Windows PowerShell an incompatible module
# search path. Use each test shell's own built-in modules before changing home.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$ErrorActionPreference = 'Stop'
$env:USERPROFILE = ${psLiteral(profile)}
$env:ProgramFiles = ${psLiteral(join(fixture, "Program Files"))}
$env:LOCALAPPDATA = ${psLiteral(join(profile, "AppData", "Local"))}
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:KONTEKS_RELEASE_BASE = 'https://fixture.invalid/release'
$env:KONTEKS_RELEASE_PUBKEY_SHA256 = '${sha256(key)}'
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  Copy-Item -LiteralPath (Join-Path ${psLiteral(fixture)} ([Uri]$Uri).Segments[-1]) -Destination $OutFile
}
function Get-AuthenticodeSignature { param([string]$FilePath); return @{ Status = 'NotSigned' } }
function Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList, [string]$Verb, [string]$WindowStyle, [switch]$Wait, [switch]$PassThru)
  @{ FilePath = $FilePath; Arguments = @($ArgumentList); Verb = $Verb } | ConvertTo-Json | Set-Content -LiteralPath ${psLiteral(msiCallPath)} -Encoding UTF8
  if ($${cancelled}) { throw [System.ComponentModel.Win32Exception]::new(1223) }
  $logIndex = [Array]::IndexOf($ArgumentList, '/L*v')
  if ($logIndex -ge 0) { Set-Content -LiteralPath ($ArgumentList[$logIndex + 1].Trim('"')) -Value 'MSI fixture diagnostics' }
  return [PSCustomObject]@{ ExitCode = ${msiCode} }
}
function konteks-remote {
  ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath ${psLiteral(callsPath)} -Encoding UTF8
  $global:LASTEXITCODE = switch ($args[0]) { 'update' { ${updateCode} }; 'start' { ${startCode} }; default { 0 } }
}
try {
  & ${psLiteral(join(process.cwd(), "bootstrap", "install.ps1"))} ${update ? "-Update" : "-ActivationId activation-test-id"}
  exit $LASTEXITCODE
} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
`);
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harnessPath], { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  const json = path => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line.replace(/^\uFEFF/, ""))) : [],
    msiCall: existsSync(msiCallPath) ? json(msiCallPath) : null,
    runtimeRoot,
  };
}

for (const msiCode of [3010, 1641]) {
  test(`Windows bootstrap continues after successful MSI reboot result ${msiCode}`, windowsOnly, () => {
    const result = runWindowsBootstrap({ msiCode });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
    assert.match(result.output, /restart Windows/i);
  });
}

test("Windows bootstrap retains an MSI failure log with a useful recovery message", windowsOnly, () => {
  const result = runWindowsBootstrap({ msiCode: 1603 });
  assert.notEqual(result.status, 0, result.output);
  assert.deepEqual(result.calls, []);
  const logIndex = result.msiCall.Arguments.indexOf("/L*v");
  assert.ok(logIndex >= 0, "Windows Installer must write a diagnostic log");
  const logPath = result.msiCall.Arguments[logIndex + 1].replace(/^"|"$/g, "");
  assert.ok(existsSync(logPath), "the failure log must survive temporary package cleanup");
  assert.ok(logPath.startsWith(result.runtimeRoot));
  assert.ok(result.output.includes(logPath), result.output);
  assert.match(result.output, /1603/);
});

test("Windows bootstrap explains a cancelled elevation prompt", windowsOnly, () => {
  const result = runWindowsBootstrap({ cancelled: true });
  assert.notEqual(result.status, 0, result.output);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /installation was cancel(?:led|ed).*elevation prompt/i);
});

test("Windows bootstrap shows the stages of an update", windowsOnly, () => {
  const result = runWindowsBootstrap();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
  assert.match(result.output, /downloading the Windows installer/i);
  assert.match(result.output, /verified the Windows installer/i);
  assert.match(result.output, /updating the connected runtime/i);
  assert.match(result.output, /starting the runtime/i);
});

test("Windows bootstrap rejects a changed MSI before installation", windowsOnly, () => {
  const result = runWindowsBootstrap({ tampered: true, update: false });
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.msiCall, null);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /package checksum mismatch/);
});

test("Windows bootstrap connects a new installation after verifying the MSI", windowsOnly, () => {
  const result = runWindowsBootstrap({ update: false });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [["install", "--activation-id", "activation-test-id"]], result.output);
  assert.match(result.output, /installation completed/i);
});

test("Windows bootstrap preserves a failed update while recovering the runtime", windowsOnly, () => {
  const result = runWindowsBootstrap({ updateCode: 8 });
  assert.equal(result.status, 8, result.output);
  assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
  assert.doesNotMatch(result.output, /update completed/i);
});

test("Windows bootstrap reports a failed runtime start after an update", windowsOnly, () => {
  const result = runWindowsBootstrap({ startCode: 9 });
  assert.equal(result.status, 9, result.output);
  assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
  assert.doesNotMatch(result.output, /update completed/i);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
