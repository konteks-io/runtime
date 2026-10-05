import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const ps = readFileSync("bootstrap/install.ps1", "utf8");
const sh = readFileSync("bootstrap/install.sh", "utf8").replaceAll("\r\n", "\n");
const powershell = process.env.KONTEKS_TEST_POWERSHELL ?? "powershell.exe";
const windows = { skip: process.platform !== "win32" };
const posix = { skip: process.platform === "win32" && !process.env.KONTEKS_TEST_SH };
const quote = (text) => `'${text.replaceAll("'", "''")}'`;
const fixtureRoot = mkdtempSync(join(tmpdir(), "konteks-bootstrap-presentation-"));
test.after(() => {
  assert.equal(dirname(fixtureRoot), resolve(tmpdir()));
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function psPresentation(body) {
  const definitions = ps.slice(
    ps.indexOf("function Write-SetupDetail"),
    ps.indexOf("# Presentation is confined"),
  );
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; Remove-Item Env:KONTEKS_SETUP_HEADER_SHOWN -ErrorAction SilentlyContinue; ${definitions}\n${body}`,
    ],
    { encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

for (const [locale, title] of [
  ["en", "Runtime setup"],
  ["id", "Pemasangan runtime"],
]) {
  test(`PowerShell setup identity is ${locale}, separate from phase output`, windows, () => {
    const output = psPresentation(
      `Write-SetupIdentity ${quote(title)}; Write-SetupStage 'Downloading' @('Safe detail')`,
    );
    assert.match(output, new RegExp(`KONTEKS\\r?\\n${title}\\r?\\n`));
    assert.match(output, /Downloading\r?\n  Safe detail/);
    assert.doesNotMatch(output, /Ready/);
  });
}

test("PowerShell renderer animates a physical row and clears it on dispose", windows, () => {
  const output = psPresentation(
    `Initialize-SetupProgress; $writer = New-Object IO.StringWriter; $row = New-Object KonteksSetupProgress -ArgumentList $writer, 'Starting runtime', 80; Start-Sleep -Milliseconds 600; $row.Dispose(); [Console]::Write($writer.ToString())`,
  );
  assert.match(output, /\r[|/\\-] Starting runtime/);
  assert.match(output, /\r +\r$/);
  assert.doesNotMatch(output, /Ready/);
});

test("PowerShell noninteractive progress keeps readable lines", windows, () => {
  const output = psPresentation(
    "Start-SetupProgress 'Downloading and verifying'; Stop-SetupProgress",
  );
  assert.match(output, /Downloading and verifying/);
  assert.doesNotMatch(output.replaceAll("\r\n", "\n"), /[\r\u001b]/);
});

test("PowerShell row pauses for details and its disposed timer stays quiet", windows, () => {
  const output = psPresentation(
    `Initialize-SetupProgress; $writer = New-Object IO.StringWriter; $row = New-Object KonteksSetupProgress -ArgumentList $writer, 'Starting runtime', 80; Start-Sleep -Milliseconds 200; $row.Pause(); $before = $writer.ToString(); Start-Sleep -Milliseconds 350; if ($before -cne $writer.ToString()) { throw 'frames during pause' }; $row.Resume(); Start-Sleep -Milliseconds 200; $row.Dispose(); $finished = $writer.ToString(); Start-Sleep -Milliseconds 350; if ($finished -cne $writer.ToString()) { throw 'timer after disposal' }; [Console]::Write($finished)`,
  );
  assert.match(output, /\r[|/\\-] Starting runtime/);
  assert.match(output, /\r +\r$/);
});

test(
  "PowerShell exact prebranded marker preserves phase details without another identity",
  windows,
  () => {
    const output = psPresentation(
      "$env:KONTEKS_SETUP_HEADER_SHOWN = '1'; Write-SetupIdentity 'Runtime setup'; Write-SetupStage 'Downloading' @('safe diagnostic'); $env:KONTEKS_SETUP_HEADER_SHOWN = 'true'; Write-SetupIdentity 'Runtime setup'",
    );
    assert.equal(output.match(/KONTEKS/g)?.length, 1);
    assert.match(output, /Downloading\r?\n  safe diagnostic/);
  },
);

test(
  "PowerShell row disposal cannot replace an installer outcome when its output closes",
  windows,
  () => {
    const output = psPresentation(
      `Initialize-SetupProgress; Add-Type 'public sealed class ClosedRowWriter : System.IO.StringWriter { public override void Write(string text) { if (text.StartsWith("\\r ")) throw new System.IO.IOException("fixture closed output"); base.Write(text); } }'; $writer = New-Object ClosedRowWriter; $row = New-Object KonteksSetupProgress -ArgumentList $writer, 'Starting runtime', 80; Start-Sleep -Milliseconds 200; $row.Dispose(); Write-Host 'original outcome preserved'`,
    );
    assert.match(output, /original outcome preserved/);
  },
);

test("PowerShell row stays within a narrow console width", windows, () => {
  const output = psPresentation(
    "Initialize-SetupProgress; $writer = New-Object IO.StringWriter; $row = New-Object KonteksSetupProgress -ArgumentList $writer, 'Starting this computer', 12; Start-Sleep -Milliseconds 300; $row.Dispose(); [Console]::Write($writer.ToString())",
  );
  assert.match(output, /\r[|/\\-] Starting/);
  for (const row of output.split("\r")) assert.ok(row.length <= 11, row);
  assert.match(ps, /\[Console\]::BufferWidth/);
});

function shellPresentation(body) {
  const definitions = sh.slice(sh.indexOf("setup_text()"), sh.indexOf('BOOTSTRAP_VERSION="'));
  const script = join(fixtureRoot, "presentation.sh");
  writeFileSync(script, `set -eu\n${definitions}\n${body}`);
  const result = spawnSync(process.env.KONTEKS_TEST_SH ?? "sh", [script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

for (const [locale, title] of [
  ["en", "Runtime setup"],
  ["id", "Pemasangan runtime"],
]) {
  test(`POSIX setup identity and redirected phase are readable in ${locale}`, posix, () => {
    const output = shellPresentation(
      `KONTEKS_SETUP_LOCALE=${locale}; setup_identity; setup_progress_start 'Download and verify'; setup_progress_stop`,
    );
    assert.match(output, new RegExp(`KONTEKS\\n${title}\\n`));
    assert.doesNotMatch(output, /[\r\u001b]/);
    assert.doesNotMatch(output, /Ready/);
  });
}

test("POSIX interactive row has physical frames and cleanup", posix, () => {
  const output = shellPresentation(
    "KONTEKS_SETUP_LOCALE=en; setup_interactive() { return 0; }; setup_progress_start 'Download and verify'; sleep 0.5; setup_progress_stop; printf 'After\\n'",
  );
  assert.match(output, /\r[|/\\-] Download and verify/);
  assert.match(output, /\r +\rAfter\n$/);
});

test("POSIX details preserve the actual phase when its row resumes", posix, () => {
  const output = shellPresentation(
    "KONTEKS_SETUP_LOCALE=en; setup_interactive() { return 0; }; setup_progress_start 'Checking this computer'; sleep 0.2; setup_detail 'safe detail'; sleep 0.2; setup_progress_stop",
  );
  assert.match(output, /  safe detail\n\r[|/\\-] Checking this computer/);
  assert.doesNotMatch(output, /Download and verify/);
});

for (const locale of ["en", "id"]) {
  test(`POSIX ${locale} row and cleanup stay within a narrow terminal`, posix, () => {
    const output = shellPresentation(
      `KONTEKS_SETUP_LOCALE=${locale}; COLUMNS=12; setup_interactive() { return 0; }; setup_progress_start 'Download and verify'; sleep 0.2; setup_progress_stop; COLUMNS=80; setup_progress_start 'Download and verify'; sleep 0.2; setup_progress_stop; printf 'After\\n'`,
    );
    assert.match(output, /\r[|/\\-] /);
    for (const row of output.slice(0, output.lastIndexOf("After")).split("\r")) {
      assert.ok(row.length <= 11, JSON.stringify(row));
    }
    assert.match(output, /\r {11}\rAfter\n$/);
  });
}
