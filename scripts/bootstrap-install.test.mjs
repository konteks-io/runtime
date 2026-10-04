import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function saveFixtureTranscript(scenario, output, status) {
  const directory = process.env.KONTEKS_BOOTSTRAP_FIXTURE_OUTPUT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${scenario}.txt`), `SIGNED FIXTURE OUTPUT ONLY - no actual installation or connected runtime\nShell: ${powershell}\nFixture exit: ${status}\n\n${output}`);
}

function runWindowsBootstrap(options = {}) {
  const { msiCode, cancelled, tampered, downloadFailed, downloadError, directoryFailed, launcherThrow, update, updateCode, startCode } = {
    msiCode: 0,
    cancelled: false,
    tampered: false,
    downloadFailed: false,
    downloadError: "Fixture download unavailable",
    directoryFailed: false,
    launcherThrow: "none",
    update: true,
    updateCode: 0,
    startCode: 0,
    ...options,
  };
  const fixture = mkdtempSync(join(root, "windows bootstrap "));
  const profile = join(fixture, "profile");
  const temporaryRoot = join(fixture, "temporary downloads");
  mkdirSync(temporaryRoot);
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
  if ($${downloadFailed}) { throw ${psLiteral(downloadError)} }
  Copy-Item -LiteralPath (Join-Path ${psLiteral(fixture)} ([Uri]$Uri).Segments[-1]) -Destination $OutFile
}
function New-Item {
  param([string]$ItemType, [string]$Path, [switch]$Force)
  if ($${directoryFailed} -and $Path.StartsWith(${psLiteral(temporaryRoot)})) { throw 'Fixture temporary directory unavailable' }
  Microsoft.PowerShell.Management\\New-Item @PSBoundParameters
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
  if ($args[0] -eq ${psLiteral(launcherThrow)}) { throw 'Fixture launcher could not start' }
  $global:LASTEXITCODE = switch ($args[0]) { 'update' { ${updateCode} }; 'start' { ${startCode} }; default { 0 } }
}
# Match the App starter's inline scriptblock entry; no catch may hide raw errors.
& ([scriptblock]::Create([IO.File]::ReadAllText(${psLiteral(join(process.cwd(), "bootstrap", "install.ps1"))}))) ${update ? "-Update" : "-ActivationId activation-test-id"}
`);
  const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${psLiteral(harnessPath)})))`;
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", timeout: 60_000, windowsHide: true, env: { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot } });
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`.replaceAll("\r\n", "\n");
  const scenario = `msi-${msiCode}-cancel-${cancelled}-tampered-${tampered}-download-failed-${downloadFailed}-update-${update}-update-exit-${updateCode}-start-exit-${startCode}-${sha256(JSON.stringify(options)).slice(0, 8)}`;
  saveFixtureTranscript(scenario, output, result.status);
  const json = path => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return {
    status: result.status,
    output,
    stderr: result.stderr,
    remainingDownloadDirectories: readdirSync(temporaryRoot).filter(name => name.startsWith("konteks-remote-")),
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
    assert.match(result.output, /\n\nSetup complete\n  Konteks runtime update completed\./);
    assert.match(result.output, /\n  Restart Windows/);
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
  assert.match(result.output, /\n\nSetup could not finish\n  Windows Installer failed \(exit 1603\)/);
  assert.match(result.output, /\n  Installer log:\n    /);
  assert.match(result.output, /open the downloaded setup file again/i);
  assert.match(result.output, /\n  Check the installer log for the cause\.\n  After resolving it, open the downloaded setup file again\./);
});

test("Windows bootstrap explains a cancelled elevation prompt", windowsOnly, () => {
  const result = runWindowsBootstrap({ cancelled: true });
  assert.notEqual(result.status, 0, result.output);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /installation was cancel(?:led|ed).*elevation prompt/i);
  assert.match(result.output, /\n\nSetup could not finish\n  /);
  assert.match(result.output, /open the downloaded setup file again and approve/i);
});

test("Windows bootstrap shows the stages of an update", windowsOnly, () => {
  const result = runWindowsBootstrap();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
  assert.match(result.output, /downloading the Windows installer/i);
  assert.match(result.output, /verified the Windows installer/i);
  assert.match(result.output, /updating the connected runtime/i);
  assert.match(result.output, /starting the runtime/i);
  assert.match(result.output, /\n\n1 of 4 - Download and verify\n  Fetching the signed release manifest/);
  assert.match(result.output, /\n\n2 of 4 - Install the Konteks command\n  Approve the Windows elevation prompt/);
  assert.match(result.output, /\n\n3 of 4 - Update the connected runtime\n  Updating the connected runtime/);
  assert.match(result.output, /\n\n4 of 4 - Start and reconnect\n  Starting the runtime/);
  assert.match(result.output, /\n\nSetup complete\n  Konteks runtime update completed\./);
  assert.match(result.output, /\n  Return to Konteks -> Customize -> Runtimes\.\n  Confirm this computer is online\./);
  assert.match(result.output, /\n  You can close this setup window\./);
});

test("Windows bootstrap rejects a changed MSI before installation", windowsOnly, () => {
  const result = runWindowsBootstrap({ tampered: true, update: false });
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.msiCall, null);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /package checksum mismatch/);
  assert.match(result.output, /\n\nSetup could not finish\n  package checksum mismatch/);
  assert.match(result.output, /\n  Stopped during: Download and verify\./);
  assert.match(result.output, /\n  Return to Konteks and download a fresh setup file if a retry is needed\./);
});

test("Windows bootstrap formats a failed download with a safe return action", windowsOnly, () => {
  const result = runWindowsBootstrap({ downloadFailed: true });
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.msiCall, null);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /\n\nSetup could not finish\n  Fixture download unavailable/);
  assert.match(result.output, /\n  Stopped during: Download and verify\./);
  assert.match(result.output, /\n  Return to Konteks and download a fresh setup file if a retry is needed\./);
});

for (const [name, options] of Object.entries({ download: { downloadFailed: true }, checksum: { tampered: true }, cancellation: { cancelled: true }, installer: { msiCode: 1603 } })) {
  test(`Windows bootstrap keeps production ${name} failure free of raw PowerShell errors`, windowsOnly, () => {
    const result = runWindowsBootstrap(options);
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stderr, "", "the real starter must not append a raw ErrorRecord after recovery guidance");
    assert.doesNotMatch(result.output, /CategoryInfo|FullyQualifiedErrorId|At line:\d+ char:/);
    assert.match(result.output, /\n\nSetup could not finish\n  /);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.remainingDownloadDirectories, [], "finally must remove temporary downloads on explicit failure exit");
  });
}

test("Windows bootstrap preserves diagnostic paths and indents physical error lines", windowsOnly, () => {
  const message = "Fixture could not read C:\\Users\\Dr. Smith\\release.log\nThe next physical line has no period";
  const result = runWindowsBootstrap({ downloadFailed: true, downloadError: message });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\n  Fixture could not read C:\\Users\\Dr\. Smith\\release\.log\n  The next physical line has no period\n/);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.remainingDownloadDirectories, []);
});

test("Windows bootstrap explains temporary directory creation failure", windowsOnly, () => {
  const result = runWindowsBootstrap({ directoryFailed: true });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /\n\nSetup could not finish\n  Fixture temporary directory unavailable/);
  assert.match(result.output, /\n  Stopped during: Prepare secure downloads\./);
  assert.equal(result.stderr, "");
  assert.equal(result.msiCall, null);
  assert.deepEqual(result.calls, []);
});

for (const [name, options, code, calls] of [
  ["update", { launcherThrow: "update" }, 1, [["update"]]],
  ["start", { launcherThrow: "start" }, 1, [["update"], ["start"]]],
  ["failed update then start", { updateCode: 8, launcherThrow: "start" }, 8, [["update"], ["start"]]],
  ["connection", { update: false, launcherThrow: "install" }, 1, [["install", "--activation-id", "activation-test-id"]]],
]) {
  test(`Windows bootstrap explains ${name} command-start failure`, windowsOnly, () => {
    const result = runWindowsBootstrap(options);
    assert.equal(result.status, code, result.output);
    assert.match(result.output, /\n\nSetup needs attention\n  /);
    assert.match(result.output, /\n  Fixture launcher could not start\n/);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.calls, calls);
    assert.deepEqual(result.remainingDownloadDirectories, []);
  });
}

test("Windows bootstrap connects a new installation after verifying the MSI", windowsOnly, () => {
  const result = runWindowsBootstrap({ update: false });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [["install", "--activation-id", "activation-test-id"]], result.output);
  assert.match(result.output, /installation completed/i);
  assert.match(result.output, /\n\n1 of 3 - Download and verify\n  /);
  assert.match(result.output, /\n\n2 of 3 - Install the Konteks command\n  /);
  assert.match(result.output, /\n\n3 of 3 - Connect this computer\n  /);
  assert.match(result.output, /\n  Enter the activation code when asked\.\n  It is hidden while you type\./);
});

test("Windows bootstrap preserves a failed update while recovering the runtime", windowsOnly, () => {
  const result = runWindowsBootstrap({ updateCode: 8 });
  assert.equal(result.status, 8, result.output);
  assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
  assert.doesNotMatch(result.output, /update completed/i);
  assert.match(result.output, /\n\nSetup needs attention\n  The runtime update did not complete \(exit 8\)\./);
  assert.match(result.output, /\n  Failure in: Update the connected runtime\./);
  assert.match(result.output, /\n  Keep this window open to review the message above\./);
  assert.match(result.output, /\n  If a retry is needed, open the downloaded setup file again\./);
});

test("Windows bootstrap reports a failed runtime start after an update", windowsOnly, () => {
  const result = runWindowsBootstrap({ startCode: 9 });
  assert.equal(result.status, 9, result.output);
  assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
  assert.doesNotMatch(result.output, /update completed/i);
  assert.match(result.output, /\n\nSetup needs attention\n  The runtime update did not complete \(exit 9\)\./);
  assert.match(result.output, /\n  Failure in: Start and reconnect\./);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
