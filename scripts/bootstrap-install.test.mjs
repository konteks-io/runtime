import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "konteks-bootstrap-test-"));
const bin = join(root, "bin");
mkdirSync(bin);

for (const [name, body] of Object.entries({
  uname:
    "#!/bin/sh\ncase \"$1\" in -s) printf '%s\\n' Linux ;; -m) printf '%s\\n' x86_64 ;; esac\n",
  curl: '#!/bin/sh\nout=\'\'\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { out=$2; shift; }; shift; done\n: > "$out"\n',
  openssl: "#!/bin/sh\nexit 0\n",
  dpkg: "#!/bin/sh\nexit 0\n",
  gpg: "#!/bin/sh\nexit 0\n",
  sha256sum: "#!/bin/sh\nprintf '%s  %s\\n' fake \"$1\"\n",
}))
  writeFileSync(join(bin, name), body, { mode: 0o755 });

function runWithOsRelease(contents) {
  const osRelease = join(root, "os-release");
  writeFileSync(osRelease, contents);
  try {
    execFileSync("sh", ["bootstrap/install.sh", "--activation-id", "activation-test-id"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        KONTEKS_OS_RELEASE_FILE: osRelease,
      },
      stdio: "pipe",
    });
    return { status: 0, output: "" };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test(
  "accepts Ubuntu for the signed Debian package path",
  { skip: process.platform === "win32" },
  () => {
    const result = runWithOsRelease('ID=ubuntu\nVERSION_ID="24.04"\n');
    // The empty fake release must stop at package verification, before dpkg -i.
    assert.equal(result.status, 4);
    assert.match(result.output, /error: package checksum mismatch; refusing to install/);
    assert.doesNotMatch(result.output, /unsupported Linux distribution/);
  },
);

test(
  "continues to reject unsupported Linux distributions",
  { skip: process.platform === "win32" },
  () => {
    const result = runWithOsRelease('ID=fedora\nVERSION_ID="41"\n');
    assert.equal(result.status, 3);
    assert.match(result.output, /unsupported Linux distribution 'fedora'/);
  },
);

// Exercise the complete bootstrap with a genuinely signed fixture release.
// Only downloads, Windows Installer, and the installed launcher are replaced;
// the signature and package-digest checks still run before the mock MSI can run.
const powershell = process.env.KONTEKS_TEST_POWERSHELL ?? "powershell.exe";
const windowsOnly = { skip: process.platform !== "win32" };
const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixtureLocale(locale) {
  return locale === undefined
    ? "Remove-Item Env:KONTEKS_SETUP_LOCALE -ErrorAction SilentlyContinue"
    : `$env:KONTEKS_SETUP_LOCALE = ${psLiteral(locale)}`;
}

function fixtureInvocation({ verifyOnly, update }) {
  if (verifyOnly) return "-VerifyOnly";
  return update ? "-Update" : "-ActivationId activation-test-id";
}

function fixtureLines(path) {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .replace(/^\uFEFF/, "")
        .trim()
        .split(/\r?\n/)
    : [];
}

const posixShell = process.env.KONTEKS_TEST_SH ?? "sh";
const posixOnly = { skip: process.platform === "win32" && !process.env.KONTEKS_TEST_SH };
const shellLiteral = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const shellPath = (value) =>
  process.platform === "win32"
    ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    : value;

function writePosixFixture(fixture, options) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "pem" });
  const launcher = `#!/bin/sh\nexec ${shellLiteral(shellPath(process.execPath))} ${shellLiteral(shellPath(join(process.cwd(), "scripts", "fixtures", "bootstrap-posix.mjs")))} launcher "$@"\n`;
  const payloads = {
    "konteks-remote-debian-amd64": launcher,
    "konteks-remote-macos-amd64": launcher,
    "konteks-remote_amd64.deb": "Debian package fixture\n",
    "konteks-remote-amd64.pkg": "macOS package fixture\n",
  };
  const sums = Buffer.from(
    Object.entries(payloads)
      .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
      .join(""),
  );
  for (const [name, bytes] of Object.entries({
    ...payloads,
    SHA256SUMS: sums,
    "SHA256SUMS.sig": sign(null, sums, privateKey),
    "release-signing.pub": key,
    "konteks-remote_amd64.deb.asc": "fixture",
    "deb-signing.asc": "fixture",
  })) {
    writeFileSync(join(fixture, name), bytes);
  }
  if (options.tampered) writeFileSync(join(fixture, "konteks-remote_amd64.deb"), "changed package");
  return sha256(key);
}

function posixFixtureEnvironment(fixture, fixtureBin, options, keyDigest) {
  const env = {
    ...process.env,
    PATH: `${shellPath(fixtureBin)}:${process.platform === "win32" ? "/usr/bin:/bin" : process.env.PATH}`,
    TMPDIR: shellPath(join(fixture, "temporary")),
    KONTEKS_ROOT: shellPath(join(fixture, "runtime")),
    KONTEKS_RELEASE_BASE: "https://fixture.invalid/release",
    KONTEKS_RELEASE_PUBKEY_SHA256: keyDigest,
    KONTEKS_OS_RELEASE_FILE: shellPath(join(fixture, "os-release")),
    KONTEKS_MACOS_TEAM_ID: "KONTEKS0000",
    KONTEKS_DEB_KEY_FINGERPRINT: "0000000000000000000000000000000000000000",
    KONTEKS_BOOTSTRAP_FIXTURE: JSON.stringify({ directory: fixture, ...options }),
  };
  delete env.KONTEKS_SETUP_LOCALE;
  if (options.locale !== undefined) env.KONTEKS_SETUP_LOCALE = options.locale;
  return env;
}

function posixFixtureInvocation(scriptPath, fixtureBin, args) {
  if (process.platform !== "win32") return [scriptPath, ...args];
  // The Git shell's native entry point rewrites Windows PATH. Set the mock
  // path inside that shell so no real downloader or package installer runs.
  const command = `PATH=${shellLiteral(shellPath(fixtureBin))}:/usr/bin:/bin; export PATH; exec /usr/bin/sh "$@"`;
  return ["-c", command, "bootstrap-fixture", shellPath(scriptPath), ...args];
}

function runPosixBootstrap(options = {}) {
  const fixture = mkdtempSync(join(root, "posix bootstrap "));
  const fixtureBin = join(fixture, "bin");
  mkdirSync(fixtureBin);
  mkdirSync(join(fixture, "temporary"));
  // Git's Windows checkout uses CRLF; exercise the LF bytes native CI receives.
  const scriptPath = join(fixture, "install.sh");
  writeFileSync(scriptPath, readFileSync("bootstrap/install.sh", "utf8").replaceAll("\r\n", "\n"));
  writeFileSync(join(fixture, "os-release"), "ID=ubuntu\nVERSION_ID=24.04\n");
  const keyDigest = writePosixFixture(fixture, options);
  for (const name of [
    "uname",
    "curl",
    "openssl",
    "sha256sum",
    "shasum",
    "sudo",
    "gpg",
    "pkgutil",
    "spctl",
    "dpkg",
    "konteks-remote",
  ]) {
    const operation = name === "konteks-remote" ? "launcher" : name;
    writeFileSync(
      join(fixtureBin, name),
      `#!/bin/sh\nexec ${shellLiteral(shellPath(process.execPath))} ${shellLiteral(shellPath(join(process.cwd(), "scripts", "fixtures", "bootstrap-posix.mjs")))} ${operation} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const args = options.args ?? ["--activation-id", "activation-test-id"];
  const result = spawnSync(posixShell, posixFixtureInvocation(scriptPath, fixtureBin, args), {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: posixFixtureEnvironment(fixture, fixtureBin, options, keyDigest),
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: fixtureLines(join(fixture, "calls.jsonl")).map(JSON.parse),
    effects: fixtureLines(join(fixture, "effects.txt")),
    temporary: readdirSync(join(fixture, "temporary")),
  };
}

for (const os of ["Linux", "Darwin"]) {
  for (const locale of ["en", "id"]) {
    test(
      `POSIX bootstrap follows ${locale} on ${os} and preserves activation arguments`,
      posixOnly,
      () => {
        const result = runPosixBootstrap({ os, locale });
        assert.equal(result.status, 0, result.output);
        assert.deepEqual(result.calls, [
          { args: ["--version"], locale },
          { args: ["install", "--activation-id", "activation-test-id"], locale },
        ]);
        assert.match(
          result.output,
          locale === "id"
            ? /Mengambil manifes checksum bertanda tangan/
            : /fetching the signed checksum manifest/,
        );
        assert.match(
          result.output,
          locale === "id"
            ? /Menghubungkan komputer ini ke Konteks/
            : /Connecting this computer to Konteks/,
        );
        assert.match(result.output, locale === "id" ? /Pemasangan selesai/ : /Setup complete/);
        assert.deepEqual(result.temporary, []);
      },
    );
    test(
      `POSIX bootstrap preserves ${locale} for user-local enrollment on ${os}`,
      posixOnly,
      () => {
        const result = runPosixBootstrap({ os, locale, args: ["--user", "--enroll"] });
        assert.equal(result.status, 0, result.output);
        assert.deepEqual(result.calls, [{ args: ["install", "--enroll"], locale }]);
        assert.match(
          result.output,
          locale === "id"
            ? /Mendaftarkan komputer ini ke Konteks/
            : /Enrolling this computer with Konteks/,
        );
        assert.deepEqual(result.temporary, []);
      },
    );
  }
}

test("POSIX bootstrap defaults to English only when locale is absent", posixOnly, () => {
  const result = runPosixBootstrap();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.at(-1).locale, "en");
});

for (const locale of ["en", "id"]) {
  test(
    `POSIX bootstrap indents ${locale} details beneath each stage and keeps provider output verbatim`,
    posixOnly,
    () => {
      const provider =
        "Fixture provider output at /home/Dr. Smith/release.log\nSecond technical line";
      const result = runPosixBootstrap({ locale, launcherOutput: provider });
      assert.equal(result.status, 0, result.output);
      assert.match(
        result.output,
        locale === "id"
          ? /\n1 dari 3 - Unduh dan verifikasi\n  konteks-remote bootstrap v1: Mengambil manifes checksum bertanda tangan\n/
          : /\n1 of 3 - Download and verify\n  konteks-remote bootstrap v1: fetching the signed checksum manifest\n/,
      );
      assert.match(
        result.output,
        locale === "id"
          ? /\n2 dari 3 - Pasang perintah Konteks\n  Memasang konteks-remote_amd64\.deb \(sudo mungkin meminta kata sandi\)\n  perintah Konteks terpasang: konteks-remote fixture\n/
          : /\n2 of 3 - Install the Konteks command\n  installing konteks-remote_amd64\.deb \(sudo may prompt\)\n  launcher installed: konteks-remote fixture\n/,
      );
      assert.match(
        result.output,
        locale === "id"
          ? /\n3 dari 3 - Hubungkan komputer ini\n  Menghubungkan komputer ini ke Konteks\.\.\.\n  Masukkan kode aktivasi saat diminta\. Kode disembunyikan saat Anda mengetik\.\n/
          : /\n3 of 3 - Connect this computer\n  Connecting this computer to Konteks\.\.\.\n  Enter the activation code when asked\. It is hidden while you type\.\n/,
      );
      assert.ok(result.output.includes(`\n${provider}\n`), result.output);
      assert.match(
        result.output,
        locale === "id"
          ? /\nPemasangan selesai\n  Kembali ke Konteks -> Sesuaikan -> Runtimes\.\n  Pastikan komputer ini terhubung\.\n/
          : /\nSetup complete\n  Return to Konteks -> Customize -> Runtimes\.\n  Confirm this computer is online\.\n/,
      );
    },
  );
  test(
    `POSIX bootstrap indents ${locale} recovery guidance while keeping download diagnostics verbatim`,
    posixOnly,
    () => {
      const result = runPosixBootstrap({ locale, downloadFailed: true });
      assert.equal(result.status, 4, result.output);
      assert.match(result.output, /\nFixture download unavailable; raw technical detail\n/);
      assert.match(
        result.output,
        locale === "id"
          ? /\nPemasangan belum selesai\n  kesalahan: tidak dapat mengunduh SHA256SUMS\n  Kembali ke Konteks dan salin perintah pemasangan baru sebelum mencoba ulang\.\n/
          : /\nSetup could not finish\n  error: could not download SHA256SUMS\n  Return to Konteks and copy a fresh setup command before trying again\.\n/,
      );
    },
  );
}

for (const locale of ["", "fr", "EN", "id-ID", " id ", "id&whoami"]) {
  test(
    `POSIX bootstrap rejects unsupported locale ${JSON.stringify(locale)} before any effects`,
    posixOnly,
    () => {
      const result = runPosixBootstrap({ locale });
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /Setup language must be en or id/);
      assert.deepEqual(result.effects, []);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.temporary, []);
    },
  );
}

for (const locale of ["en", "id"]) {
  for (const [scenario, options, status, english, indonesian] of [
    ["download", { downloadFailed: true }, 4, /Setup could not finish/, /Pemasangan belum selesai/],
    ["checksum", { tampered: true }, 4, /package checksum mismatch/, /checksum paket tidak cocok/],
    [
      "package install",
      { installCode: 19 },
      19,
      /Setup could not finish/,
      /Pemasangan belum selesai/,
    ],
    ["launcher", { launcherCode: 8 }, 8, /Setup needs attention/, /Pemasangan perlu perhatian/],
    [
      "argument refusal",
      { args: ["--unexpected"] },
      2,
      /unknown argument/,
      /argumen tidak dikenal/,
    ],
  ]) {
    test(
      `POSIX bootstrap localizes ${locale} ${scenario} while preserving refusal or failure`,
      posixOnly,
      () => {
        const result = runPosixBootstrap({ locale, ...options });
        assert.equal(result.status, status, result.output);
        assert.match(result.output, locale === "id" ? indonesian : english);
        assert.deepEqual(result.temporary, []);
        if (scenario !== "launcher") assert.deepEqual(result.calls, []);
        if (["download", "package install", "launcher"].includes(scenario))
          assert.match(result.output, locale === "id" ? /Kembali ke Konteks/ : /Return to Konteks/);
      },
    );
  }
}

function saveFixtureTranscript(scenario, output, status) {
  const directory = process.env.KONTEKS_BOOTSTRAP_FIXTURE_OUTPUT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${scenario}.txt`),
    `SIGNED FIXTURE OUTPUT ONLY - no actual installation or connected runtime\nShell: ${powershell}\nFixture exit: ${status}\n\n${output}`,
  );
}

function runWindowsBootstrap(options = {}) {
  const {
    msiCode,
    cancelled,
    tampered,
    downloadFailed,
    downloadError,
    directoryFailed,
    temporaryCase,
    launcherThrow,
    update,
    updateCode,
    startCode,
    locale,
    verifyOnly,
    hashUnavailable,
    authenticodeUnavailable,
  } = {
    msiCode: 0,
    cancelled: false,
    tampered: false,
    downloadFailed: false,
    downloadError: "Fixture download unavailable",
    directoryFailed: false,
    temporaryCase: "original",
    launcherThrow: "none",
    update: true,
    updateCode: 0,
    startCode: 0,
    locale: undefined,
    verifyOnly: false,
    hashUnavailable: false,
    authenticodeUnavailable: false,
    ...options,
  };
  const fixture = mkdtempSync(join(root, "windows bootstrap "));
  const profile = join(fixture, "profile");
  const temporaryRoot = join(fixture, "temporary downloads");
  const temporaryPath = { original: temporaryRoot, uppercase: temporaryRoot.toUpperCase() }[
    temporaryCase
  ];
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
    SHA256SUMS: sums,
    "SHA256SUMS.sig": sign(null, sums, privateKey),
    "konteks-remote-x64.msi": tampered ? Buffer.from("changed installer") : msi,
  }))
    writeFileSync(join(fixture, name), bytes);
  const callsPath = join(fixture, "launcher-calls.jsonl");
  const effectsPath = join(fixture, "effect-calls.txt");
  const localesPath = join(fixture, "launcher-locales.txt");
  const msiCallPath = join(fixture, "msi-call.json");
  const harnessPath = join(fixture, "run.ps1");
  writeFileSync(
    harnessPath,
    `
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
${fixtureLocale(locale)}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  'download' | Add-Content -LiteralPath ${psLiteral(effectsPath)} -Encoding UTF8
  if ($${downloadFailed}) { throw ${psLiteral(downloadError)} }
  Copy-Item -LiteralPath (Join-Path ${psLiteral(fixture)} ([Uri]$Uri).Segments[-1]) -Destination $OutFile
}
function New-Item {
  param([string]$ItemType, [string]$Path, [switch]$Force)
  'directory' | Add-Content -LiteralPath ${psLiteral(effectsPath)} -Encoding UTF8
  # The first New-Item prepares downloads. Equivalent Windows path spellings
  # must not prevent this explicit fault from being injected.
  if ($${directoryFailed}) { throw 'Fixture temporary directory unavailable' }
  Microsoft.PowerShell.Management\\New-Item @PSBoundParameters
}
function Get-AuthenticodeSignature { param([string]$FilePath); ${authenticodeUnavailable ? "throw [System.Management.Automation.CommandNotFoundException]::new('Get-AuthenticodeSignature is unavailable in this fixture')" : "return @{ Status = 'NotSigned' }"} }
${hashUnavailable ? "function Get-FileHash { throw [System.Management.Automation.CommandNotFoundException]::new('Get-FileHash is not recognized in this fixture') }" : ""}
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
  $env:KONTEKS_SETUP_LOCALE | Add-Content -LiteralPath ${psLiteral(localesPath)} -Encoding UTF8
  if ($args[0] -eq ${psLiteral(launcherThrow)}) { throw 'Fixture launcher could not start' }
  $global:LASTEXITCODE = switch ($args[0]) { 'update' { ${updateCode} }; 'start' { ${startCode} }; default { 0 } }
}
# Match the App starter's inline scriptblock entry; no catch may hide raw errors.
& ([scriptblock]::Create([IO.File]::ReadAllText(${psLiteral(join(process.cwd(), "bootstrap", "install.ps1"))}))) ${fixtureInvocation({ verifyOnly, update })}
`,
  );
  const command = `& ([scriptblock]::Create([IO.File]::ReadAllText(${psLiteral(harnessPath)})))`;
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, TEMP: temporaryPath, TMP: temporaryPath },
    },
  );
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`.replaceAll("\r\n", "\n");
  const scenario = `msi-${msiCode}-cancel-${cancelled}-tampered-${tampered}-download-failed-${downloadFailed}-update-${update}-update-exit-${updateCode}-start-exit-${startCode}-${sha256(JSON.stringify(options)).slice(0, 8)}`;
  saveFixtureTranscript(scenario, output, result.status);
  const json = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  return {
    status: result.status,
    output,
    stderr: result.stderr,
    remainingDownloadDirectories: readdirSync(temporaryRoot).filter((name) =>
      name.startsWith("konteks-remote-"),
    ),
    calls: fixtureLines(callsPath).map((line) => JSON.parse(line.replace(/^\uFEFF/, ""))),
    effects: fixtureLines(effectsPath),
    launcherLocales: fixtureLines(localesPath),
    msiCall: existsSync(msiCallPath) ? json(msiCallPath) : null,
    runtimeRoot,
  };
}

for (const update of [true, false]) {
  for (const locale of ["en", "id"]) {
    test(
      `Windows bootstrap follows ${locale} for ${update ? "update" : "activation"} without changing launcher arguments`,
      windowsOnly,
      () => {
        const result = runWindowsBootstrap({ locale, update });
        assert.equal(result.status, 0, result.output);
        assert.deepEqual(
          result.calls,
          update ? [["update"], ["start"]] : [["install", "--activation-id", "activation-test-id"]],
        );
        assert.deepEqual(result.launcherLocales, update ? [locale, locale] : [locale]);
        if (locale === "en") {
          assert.match(result.output, /\n\n1 of [34] - Download and verify\n/);
          assert.match(result.output, /\n\nSetup complete\n/);
          return;
        }
        assert.match(result.output, /^\nPemasangan runtime Konteks\n/);
        assert.match(
          result.output,
          /\n\n1 dari [34] - Unduh dan verifikasi\n  Mengambil manifes rilis bertanda tangan/,
        );
        assert.match(
          result.output,
          /\n\n2 dari [34] - Pasang perintah Konteks\n  Setujui permintaan izin Windows/,
        );
        assert.match(result.output, /Windows mungkin menampilkan 'Unknown publisher'/);
        assert.match(result.output, /\n\nPemasangan selesai\n/);
        assert.match(
          result.output,
          /\n  Kembali ke Konteks -> Sesuaikan -> Runtimes\.\n  Pastikan komputer ini terhubung\./,
        );
        assert.doesNotMatch(
          result.output,
          /Setup complete|Keep this window|Approve the Windows elevation prompt/,
        );
        assert.match(
          result.output,
          update
            ? /\n\n3 dari 4 - Perbarui runtime yang terhubung\n/
            : /\n  Masukkan kode aktivasi saat diminta\.\n  Kode disembunyikan saat Anda mengetik\./,
        );
      },
    );
  }
}

for (const locale of ["fr", "EN", "id-ID", " id ", "id&whoami"]) {
  test(
    `Windows bootstrap rejects unsupported locale ${JSON.stringify(locale)} before any install effects`,
    windowsOnly,
    () => {
      const result = runWindowsBootstrap({ locale });
      assert.equal(result.status, 2, result.output);
      assert.match(result.output, /Setup language must be en or id/);
      assert.equal(result.stderr, "");
      assert.deepEqual(result.effects, []);
      assert.equal(result.msiCall, null);
      assert.deepEqual(result.calls, []);
    },
  );
}

test(
  "Windows bootstrap VerifyOnly remains effect-free with an unsupported presentation locale",
  windowsOnly,
  () => {
    const result = runWindowsBootstrap({ locale: "fr", verifyOnly: true });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output, "");
    assert.deepEqual(result.effects, []);
    assert.equal(result.msiCall, null);
    assert.deepEqual(result.calls, []);
  },
);

for (const [scenario, options, expected, status] of [
  ["MSI reboot", { msiCode: 3010 }, /Mulai ulang Windows saat memungkinkan/, 0],
  [
    "MSI restart",
    { msiCode: 1641 },
    /Windows Installer melaporkan bahwa Windows akan dimulai ulang/,
    0,
  ],
  [
    "elevation cancellation",
    { cancelled: true },
    /Pemasangan dibatalkan pada permintaan izin Windows/,
    1,
  ],
  ["MSI failure", { msiCode: 1603 }, /Windows Installer gagal \(kode keluar 1603\)/, 1],
  ["tampered MSI", { tampered: true }, /checksum paket tidak cocok; tidak ada yang dipasang/, 1],
  ["update failure", { updateCode: 8 }, /Pembaruan runtime belum selesai \(kode keluar 8\)/, 8],
]) {
  test(`Windows bootstrap localizes ${scenario} while preserving its outcome`, windowsOnly, () => {
    const result = runWindowsBootstrap({ locale: "id", ...options });
    assert.equal(result.status, status, result.output);
    assert.match(result.output, expected);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.remainingDownloadDirectories, []);
    if (status !== 0)
      assert.match(result.output, /\n\nPemasangan (?:belum selesai|perlu perhatian)\n/);
    if (options.msiCode === 1603) {
      const logIndex = result.msiCall.Arguments.indexOf("/L*v");
      const logPath = result.msiCall.Arguments[logIndex + 1].replace(/^"|"$/g, "");
      assert.ok(existsSync(logPath));
      assert.ok(result.output.includes(logPath));
      assert.match(result.output, /\n  Log pemasang:\n    /);
    }
  });
}

test(
  "Windows bootstrap keeps raw multiline diagnostics accurate under Indonesian guidance",
  windowsOnly,
  () => {
    const diagnostic =
      "Fixture unavailable at C:\\Users\\Dr. Smith\\release.log\nTechnical detail remains unchanged";
    const result = runWindowsBootstrap({
      locale: "id",
      downloadFailed: true,
      downloadError: diagnostic,
    });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /\n\nPemasangan belum selesai\n  Fixture unavailable at C:\\Users\\Dr\. Smith\\release\.log\n  Technical detail remains unchanged/,
    );
    assert.match(result.output, /\n  Berhenti saat: Unduh dan verifikasi\./);
    assert.match(
      result.output,
      /\n  Kembali ke Konteks dan unduh berkas pemasangan baru jika perlu mencoba ulang\./,
    );
    assert.equal(result.stderr, "");
  },
);

test(
  "Windows bootstrap verifies signed bytes when Get-FileHash is unavailable",
  windowsOnly,
  () => {
    const result = runWindowsBootstrap({ hashUnavailable: true });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.calls, [["update"], ["start"]]);
    assert.ok(result.msiCall);
  },
);

test("Windows bootstrap still rejects tampered MSI bytes without Get-FileHash", windowsOnly, () => {
  const result = runWindowsBootstrap({ hashUnavailable: true, tampered: true });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /package checksum mismatch/);
  assert.equal(result.msiCall, null);
  assert.deepEqual(result.calls, []);
});

for (const locale of ["en", "id"]) {
  test(
    `Windows bootstrap refuses an unavailable Authenticode check in ${locale}`,
    windowsOnly,
    () => {
      const result = runWindowsBootstrap({
        locale,
        hashUnavailable: true,
        authenticodeUnavailable: true,
      });
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /Get-AuthenticodeSignature is unavailable in this fixture/);
      assert.match(
        result.output,
        locale === "id" ? /Pemasangan belum selesai/ : /Setup could not finish/,
      );
      assert.equal(result.stderr, "");
      assert.equal(result.msiCall, null);
      assert.deepEqual(result.calls, []);
    },
  );
}

for (const msiCode of [3010, 1641]) {
  test(
    `Windows bootstrap continues after successful MSI reboot result ${msiCode}`,
    windowsOnly,
    () => {
      const result = runWindowsBootstrap({ msiCode });
      assert.equal(result.status, 0, result.output);
      assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
      assert.match(result.output, /restart Windows/i);
      assert.match(result.output, /\n\nSetup complete\n  Konteks runtime update completed\./);
      assert.match(result.output, /\n  Restart Windows/);
    },
  );
}

test(
  "Windows bootstrap retains an MSI failure log with a useful recovery message",
  windowsOnly,
  () => {
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
    assert.match(
      result.output,
      /\n\nSetup could not finish\n  Windows Installer failed \(exit 1603\)/,
    );
    assert.match(result.output, /\n  Installer log:\n    /);
    assert.match(result.output, /open the downloaded setup file again/i);
    assert.match(
      result.output,
      /\n  Check the installer log for the cause\.\n  After resolving it, open the downloaded setup file again\./,
    );
  },
);

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
  assert.match(
    result.output,
    /\n\n1 of 4 - Download and verify\n  Fetching the signed release manifest/,
  );
  assert.match(
    result.output,
    /\n\n2 of 4 - Install the Konteks command\n  Approve the Windows elevation prompt/,
  );
  assert.match(
    result.output,
    /\n\n3 of 4 - Update the connected runtime\n  Updating the connected runtime/,
  );
  assert.match(result.output, /\n\n4 of 4 - Start and reconnect\n  Starting the runtime/);
  assert.match(result.output, /\n\nSetup complete\n  Konteks runtime update completed\./);
  assert.match(
    result.output,
    /\n  Return to Konteks -> Customize -> Runtimes\.\n  Confirm this computer is online\./,
  );
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
  assert.match(
    result.output,
    /\n  Return to Konteks and download a fresh setup file if a retry is needed\./,
  );
});

test("Windows bootstrap formats a failed download with a safe return action", windowsOnly, () => {
  const result = runWindowsBootstrap({ downloadFailed: true });
  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.msiCall, null);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /\n\nSetup could not finish\n  Fixture download unavailable/);
  assert.match(result.output, /\n  Stopped during: Download and verify\./);
  assert.match(
    result.output,
    /\n  Return to Konteks and download a fresh setup file if a retry is needed\./,
  );
});

for (const [name, options] of Object.entries({
  download: { downloadFailed: true },
  checksum: { tampered: true },
  cancellation: { cancelled: true },
  installer: { msiCode: 1603 },
})) {
  test(
    `Windows bootstrap keeps production ${name} failure free of raw PowerShell errors`,
    windowsOnly,
    () => {
      const result = runWindowsBootstrap(options);
      assert.equal(result.status, 1, result.output);
      assert.equal(
        result.stderr,
        "",
        "the real starter must not append a raw ErrorRecord after recovery guidance",
      );
      assert.doesNotMatch(result.output, /CategoryInfo|FullyQualifiedErrorId|At line:\d+ char:/);
      assert.match(result.output, /\n\nSetup could not finish\n  /);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(
        result.remainingDownloadDirectories,
        [],
        "finally must remove temporary downloads on explicit failure exit",
      );
    },
  );
}

test(
  "Windows bootstrap preserves diagnostic paths and indents physical error lines",
  windowsOnly,
  () => {
    const message =
      "Fixture could not read C:\\Users\\Dr. Smith\\release.log\nThe next physical line has no period";
    const result = runWindowsBootstrap({ downloadFailed: true, downloadError: message });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /\n  Fixture could not read C:\\Users\\Dr\. Smith\\release\.log\n  The next physical line has no period\n/,
    );
    assert.equal(result.stderr, "");
    assert.deepEqual(result.remainingDownloadDirectories, []);
  },
);

test("Windows bootstrap explains temporary directory creation failure", windowsOnly, () => {
  const result = runWindowsBootstrap({ directoryFailed: true });
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /\n\nSetup could not finish\n  Fixture temporary directory unavailable/,
  );
  assert.match(result.output, /\n  Stopped during: Prepare secure downloads\./);
  assert.equal(result.stderr, "");
  assert.equal(result.msiCall, null);
  assert.deepEqual(result.calls, []);
});

test(
  "Windows bootstrap directory failure fixture accepts equivalent uppercase TEMP paths",
  windowsOnly,
  () => {
    const result = runWindowsBootstrap({ directoryFailed: true, temporaryCase: "uppercase" });
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /\n\nSetup could not finish\n  Fixture temporary directory unavailable/,
    );
    assert.match(result.output, /\n  Stopped during: Prepare secure downloads\./);
    assert.equal(result.stderr, "");
    assert.equal(result.msiCall, null);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.remainingDownloadDirectories, []);
  },
);

for (const [name, options, code, calls] of [
  ["update", { launcherThrow: "update" }, 1, [["update"]]],
  ["start", { launcherThrow: "start" }, 1, [["update"], ["start"]]],
  [
    "failed update then start",
    { updateCode: 8, launcherThrow: "start" },
    8,
    [["update"], ["start"]],
  ],
  [
    "connection",
    { update: false, launcherThrow: "install" },
    1,
    [["install", "--activation-id", "activation-test-id"]],
  ],
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
  assert.deepEqual(
    result.calls,
    [["install", "--activation-id", "activation-test-id"]],
    result.output,
  );
  assert.match(result.output, /installation completed/i);
  assert.match(result.output, /\n\n1 of 3 - Download and verify\n  /);
  assert.match(result.output, /\n\n2 of 3 - Install the Konteks command\n  /);
  assert.match(result.output, /\n\n3 of 3 - Connect this computer\n  /);
  assert.match(
    result.output,
    /\n  Enter the activation code when asked\.\n  It is hidden while you type\./,
  );
});

test(
  "Windows bootstrap preserves a failed update while recovering the runtime",
  windowsOnly,
  () => {
    const result = runWindowsBootstrap({ updateCode: 8 });
    assert.equal(result.status, 8, result.output);
    assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
    assert.doesNotMatch(result.output, /update completed/i);
    assert.match(
      result.output,
      /\n\nSetup needs attention\n  The runtime update did not complete \(exit 8\)\./,
    );
    assert.match(result.output, /\n  Failure in: Update the connected runtime\./);
    assert.match(result.output, /\n  Keep this window open to review the message above\./);
    assert.match(result.output, /\n  If a retry is needed, open the downloaded setup file again\./);
  },
);

test("Windows bootstrap reports a failed runtime start after an update", windowsOnly, () => {
  const result = runWindowsBootstrap({ startCode: 9 });
  assert.equal(result.status, 9, result.output);
  assert.deepEqual(result.calls, [["update"], ["start"]], result.output);
  assert.doesNotMatch(result.output, /update completed/i);
  assert.match(
    result.output,
    /\n\nSetup needs attention\n  The runtime update did not complete \(exit 9\)\./,
  );
  assert.match(result.output, /\n  Failure in: Start and reconnect\./);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
