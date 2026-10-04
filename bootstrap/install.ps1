<#
konteks-remote bootstrap (Windows 10/11 x64, PowerShell) - version 1.

Usage (copied verbatim from the Konteks App or MCP activation response):
  powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://github.com/konteks-io/runtime/releases/latest/download/install.ps1))) -ActivationId <id>"
An already-connected computer, to bring its launcher up to date:
  powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://github.com/konteks-io/runtime/releases/latest/download/install.ps1))) -Update"

Trust model. Konteks has no Windows code-signing certificate yet, so the MSI
is not Authenticode-signed and Windows shows "Unknown publisher" at the
elevation prompt. What this script trusts instead is the release's checksum
manifest: SHA256SUMS carries an Ed25519 signature (SHA256SUMS.sig, RFC 8032,
over the file's exact bytes) by the Konteks release key, whose public half is
pinned below, in this script, and also in install.sh. The key is never taken
from the download location. The script verifies that signature itself (plain
PowerShell 5.1, no module), then checks the MSI's SHA-256 against the verified
manifest, and refuses anything that does not match. When a release does carry
an Authenticode signature it must also be Valid and from the expected
publisher. Nothing is installed unless all of that holds.

It then invokes `konteks-remote install` with the NON-SECRET activation id.
The activation code is prompted by the launcher without echo and never
appears here. No general command passthrough exists.

`-Update` (instead of -ActivationId) on a computer that is already connected
replaces the launcher with this release's, then runs `konteks-remote update`
and `konteks-remote start`. An MSI from before 0.10.11 runs its own old code
for every command, which no connector update replaces (D131); the launcher
from 0.10.11 on runs the installed release's code, or its own when that is
newer, so this is needed once.

`-VerifyOnly` defines the signature verifier and returns without installing
anything; CI dot-sources the script that way to test it.
#>
[CmdletBinding()]
param(
  # Agent-first onboarding: the user-local install
  # arrives for Windows in a later release. Until then these switches say so
  # instead of failing on a missing activation id.
  [switch]$User,
  [switch]$Enroll,
  [switch]$Update,
  [switch]$VerifyOnly,
  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[A-Za-z0-9._-]{8,128}$')]
  [string]$ActivationId
)

# The Konteks release key (Ed25519, SubjectPublicKeyInfo, base64), the same key
# install.sh pins. Rotating it is a change to both scripts.
$PinnedReleaseKey = 'MCowBQYDK2VwAyEA2gqrOjaUrsIxyVlXNJHhTFjQUqy4o1SsqhrovPecU64='

# --- Ed25519 signature verification (RFC 8032 5.1.7) -------------------------
# Verification only, over public data, with .NET's BigInteger and SHA-512.
# Points are in extended coordinates (X, Y, Z, T), as in the RFC's reference
# code. Any malformed input is a failed verification, never an exception.
Add-Type -AssemblyName System.Numerics
$Big = [System.Numerics.BigInteger]
$Ed = @{
  P = $Big::Subtract($Big::Pow(2, 255), 19)                                          # field prime
  L = $Big::Add($Big::Pow(2, 252), $Big::Parse('27742317777372353535851937790883648493'))  # group order
}

function Get-Mod($Value, $Modulus) {
  $r = $Big::Remainder($Value, $Modulus)
  if ($r.Sign -lt 0) { $r = $Big::Add($r, $Modulus) }
  return $r
}
# Field arithmetic mod p. Every value is kept in [0, p), so only a difference
# can go negative.
function FAdd($x, $y) { return $Big::Remainder($Big::Add($x, $y), $Ed.P) }
function FSub($x, $y) { return Get-Mod ($Big::Subtract($x, $y)) $Ed.P }
function FMul($x, $y) { return $Big::Remainder($Big::Multiply($x, $y), $Ed.P) }
function FInv($x) { return $Big::ModPow($x, $Big::Subtract($Ed.P, 2), $Ed.P) }

# Unsigned little-endian bytes to an integer (BigInteger reads two's
# complement, so a trailing zero byte keeps it non-negative).
function ConvertFrom-LittleEndian([byte[]]$Bytes) {
  return $Big::new([byte[]]($Bytes + [byte]0))
}

# The x for a given y and sign bit, or $null when y is not on the curve.
function Get-EdX($y, [int]$Sign) {
  $yy = FMul $y $y
  $x2 = FMul (FSub $yy 1) (FInv (FAdd (FMul $Ed.D $yy) 1))
  if ($x2.IsZero) { if ($Sign -eq 1) { return $null } else { return $Big::Zero } }
  $x = $Big::ModPow($x2, $Ed.SqrtExp, $Ed.P)
  if (-not (FSub (FMul $x $x) $x2).IsZero) { $x = FMul $x $Ed.SqrtM1 }
  if (-not (FSub (FMul $x $x) $x2).IsZero) { return $null }
  $odd = if ($x.IsEven) { 0 } else { 1 }
  if ($odd -ne $Sign) { $x = FSub 0 $x }
  return $x
}

# RFC 8032 5.1.3: 32 bytes, y little-endian, the sign of x in the top bit.
function ConvertFrom-EdPoint([byte[]]$Bytes) {
  if ($null -eq $Bytes -or $Bytes.Length -ne 32) { return $null }
  $yBytes = [byte[]]$Bytes.Clone()
  $sign = ($yBytes[31] -shr 7) -band 1
  $yBytes[31] = $yBytes[31] -band 0x7F
  $y = ConvertFrom-LittleEndian $yBytes
  if ($Big::Compare($y, $Ed.P) -ge 0) { return $null }   # non-canonical y
  $x = Get-EdX $y $sign
  if ($null -eq $x) { return $null }
  return , @($x, $y, $Big::One, (FMul $x $y))
}

function Add-EdPoint($P1, $P2) {
  $a = FMul (FSub $P1[1] $P1[0]) (FSub $P2[1] $P2[0])
  $b = FMul (FAdd $P1[1] $P1[0]) (FAdd $P2[1] $P2[0])
  $c = FMul (FMul 2 $P1[3]) (FMul $P2[3] $Ed.D)
  $zz = FMul (FMul 2 $P1[2]) $P2[2]
  $e = FSub $b $a; $f = FSub $zz $c; $g = FAdd $zz $c; $h = FAdd $b $a
  return , @((FMul $e $f), (FMul $g $h), (FMul $f $g), (FMul $e $h))
}

function Get-EdMultiple($Scalar, $Point) {
  $acc = @($Big::Zero, $Big::One, $Big::One, $Big::Zero)   # the neutral element
  while ($Scalar.Sign -gt 0) {
    if (-not $Scalar.IsEven) { $acc = Add-EdPoint $acc $Point }
    $Point = Add-EdPoint $Point $Point
    $Scalar = $Big::Divide($Scalar, 2)
  }
  return , $acc
}

$Ed.D = FSub 0 (FMul 121665 (FInv 121666))                      # -121665/121666
$Ed.SqrtExp = $Big::Divide($Big::Add($Ed.P, 3), 8)              # (p+3)/8
$Ed.SqrtM1 = $Big::ModPow(2, $Big::Divide($Big::Subtract($Ed.P, 1), 4), $Ed.P)  # sqrt(-1)
$baseY = FMul 4 (FInv 5)
$baseX = Get-EdX $baseY 0
$Ed.B = @($baseX, $baseY, $Big::One, (FMul $baseX $baseY))      # base point

# True only for a valid signature: 32-byte key, 64-byte signature, canonical
# points and S < L, and [S]B = R + [SHA-512(R || A || M) mod L]A.
function Test-Ed25519Signature([byte[]]$PublicKey, [byte[]]$Message, [byte[]]$Signature) {
  try {
    if ($null -eq $Message) { $Message = [byte[]]@() }
    if ($null -eq $PublicKey -or $PublicKey.Length -ne 32) { return $false }
    if ($null -eq $Signature -or $Signature.Length -ne 64) { return $false }
    $A = ConvertFrom-EdPoint $PublicKey
    if ($null -eq $A) { return $false }
    $rBytes = [byte[]]$Signature[0..31]
    $R = ConvertFrom-EdPoint $rBytes
    if ($null -eq $R) { return $false }
    $S = ConvertFrom-LittleEndian ([byte[]]$Signature[32..63])
    if ($Big::Compare($S, $Ed.L) -ge 0) { return $false }   # non-canonical S
    $sha = [System.Security.Cryptography.SHA512]::Create()
    try { $digest = $sha.ComputeHash([byte[]]($rBytes + $PublicKey + $Message)) } finally { $sha.Dispose() }
    $k = Get-Mod (ConvertFrom-LittleEndian $digest) $Ed.L
    $left = Get-EdMultiple $S $Ed.B
    $right = Add-EdPoint $R (Get-EdMultiple $k $A)
    # Equal in projective terms: X1*Z2 = X2*Z1 and Y1*Z2 = Y2*Z1.
    $sameX = (FSub (FMul $left[0] $right[2]) (FMul $right[0] $left[2])).IsZero
    $sameY = (FSub (FMul $left[1] $right[2]) (FMul $right[1] $left[2])).IsZero
    return [bool]($sameX -and $sameY)
  } catch {
    return $false
  }
}

# The raw 32-byte key from an Ed25519 SubjectPublicKeyInfo (base64 DER, or the
# same inside PEM armour), or $null for anything else.
function ConvertFrom-Ed25519Spki([string]$Text) {
  try {
    $base64 = ($Text -replace '-----[A-Z ]+-----', '') -replace '\s', ''
    $der = [Convert]::FromBase64String($base64)
    $prefix = '302a300506032b6570032100'
    if ($der.Length -ne 44 -or (($der[0..11] | ForEach-Object { $_.ToString('x2') }) -join '') -ne $prefix) { return $null }
    return , [byte[]]$der[12..43]
  } catch {
    return $null
  }
}

if ($VerifyOnly) { return }
# --- end of the verifier -------------------------------------------------------

function Write-SetupDetail([string]$Text) {
  foreach ($line in ($Text -split "`r?`n")) { Write-Host "  $line" }
}

function Write-SetupStage([string]$Title, [string[]]$Details) {
  Write-Host ''
  Write-Host $Title
  foreach ($detail in $Details) { Write-SetupDetail $detail }
}

$setupAction = if ($Update) { "Updating this computer's existing Konteks connection." } else { 'Connecting this computer to Konteks.' }
$stageCount = if ($Update) { 4 } else { 3 }
$restartNotice = $null
Write-SetupStage 'Konteks runtime setup' @($setupAction, 'Keep this window open until setup finishes.')

if ($User -or $Enroll) {
  Write-SetupStage 'Setup needs an activation' @(
    'The user-local install is not available on Windows yet.',
    'Return to Konteks -> Customize -> Runtimes and connect this computer.',
    'Download and open the Windows setup file offered there.'
  )
  exit 3
}
if ($Update -and $ActivationId) {
  Write-SetupStage 'Setup needs attention' @(
    'Choose either an update or a new connection in Konteks.',
    'Then download and open its setup file.'
  )
  Write-Error '-Update and -ActivationId cannot be used together'
  exit 2
}
$RuntimeRoot = Join-Path ${env:USERPROFILE} 'AppData\Local\konteks-remote'
if ($Update -and -not (Test-Path (Join-Path $RuntimeRoot 'native-runtime.json'))) {
  Write-SetupStage 'This computer is not connected yet' @(
    'Return to Konteks -> Customize -> Runtimes and connect this computer.',
    'Download and open its Windows setup file.'
  )
  exit 2
}
if (-not $Update -and -not $ActivationId) {
  Write-SetupStage 'Setup needs an activation' @(
    'Return to Konteks -> Customize -> Runtimes.',
    'Download and open the setup file for this connection.'
  )
  Write-Error '-ActivationId <id> is required for a new connection'
  exit 2
}
$ErrorActionPreference = 'Stop'
$ReleaseBase = if ($env:KONTEKS_RELEASE_BASE) { $env:KONTEKS_RELEASE_BASE } else { 'https://github.com/konteks-io/runtime/releases/latest/download' }
$ExpectedPublisher = if ($env:KONTEKS_MSI_PUBLISHER) { $env:KONTEKS_MSI_PUBLISHER } else { 'CN=Konteks' }
$ExpectedThumbprint = $env:KONTEKS_MSI_THUMBPRINT

if ([Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  Write-SetupStage 'This Windows computer is not supported' @('Setup requires Windows 10/11 x64. Windows on ARM is not supported.')
  throw 'konteks-remote supports Windows 10/11 x64 only (Windows on ARM is not supported)'
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("konteks-remote-" + [Guid]::NewGuid().ToString('n'))
$activeStage = 'Prepare secure downloads'
$failureActions = @()
try {
  New-Item -ItemType Directory -Path $work | Out-Null
  # TLS 1.2 always; TLS 1.3 only where this .NET knows it (older Windows 10
  # builds do not, and naming it there threw before anything ran).
  $protocols = [Net.SecurityProtocolType]::Tls12
  if ([Enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') { $protocols = $protocols -bor [Net.SecurityProtocolType]'Tls13' }
  [Net.ServicePointManager]::SecurityProtocol = $protocols
  $activeStage = 'Download and verify'
  Write-SetupStage "1 of $stageCount - $activeStage" @('Fetching the signed release manifest...')
  $sumsPath = Join-Path $work 'SHA256SUMS'
  $sigPath = Join-Path $work 'SHA256SUMS.sig'
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/SHA256SUMS" -OutFile $sumsPath
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/SHA256SUMS.sig" -OutFile $sigPath

  # The pinned key, unless the environment names another by the SHA-256 of its
  # key file (a local release channel signed by its own key), as install.sh
  # allows with KONTEKS_RELEASE_PUBKEY_SHA256.
  $keyText = $PinnedReleaseKey
  if ($env:KONTEKS_RELEASE_PUBKEY_SHA256) {
    $keyPath = Join-Path $work 'release-signing.pub'
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/release-signing.pub" -OutFile $keyPath
    if ((Get-FileHash -Algorithm SHA256 -Path $keyPath).Hash.ToLowerInvariant() -ne $env:KONTEKS_RELEASE_PUBKEY_SHA256.ToLowerInvariant()) { throw 'release signing key digest mismatch; nothing was installed' }
    $keyText = [IO.File]::ReadAllText($keyPath)
  }
  $releaseKey = ConvertFrom-Ed25519Spki $keyText
  $sums = [IO.File]::ReadAllBytes($sumsPath)
  $signature = [IO.File]::ReadAllBytes($sigPath)
  if ($null -eq $releaseKey -or -not (Test-Ed25519Signature $releaseKey $sums $signature)) { throw "the release manifest's signature is not valid; nothing was installed" }

  # Only the verified bytes are read for the MSI's checksum.
  $msi = 'konteks-remote-x64.msi'
  $expected = @([Text.Encoding]::UTF8.GetString($sums) -split "`r?`n" | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($msi))$" } | ForEach-Object { ($_ -split '\s+')[0].ToLowerInvariant() })
  if ($expected.Count -ne 1) { throw "the release manifest lists no single $msi; nothing was installed" }
  $msiPath = Join-Path $work $msi
  Write-SetupDetail 'Downloading the Windows installer...'
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$msi" -OutFile $msiPath
  $actual = (Get-FileHash -Algorithm SHA256 -Path $msiPath).Hash.ToLowerInvariant()
  if ($expected[0] -ne $actual) { throw 'package checksum mismatch; nothing was installed' }

  # A signed MSI is still held to its signature and publisher; an unsigned one
  # is already proven by the signed checksums above.
  $authenticode = Get-AuthenticodeSignature -FilePath $msiPath
  if ($authenticode.Status -eq 'NotSigned') {
    Write-SetupDetail "This release is verified by Konteks' signed checksums."
    Write-SetupDetail "Windows may show 'Unknown publisher' at the approval prompt."
  } else {
    if ($authenticode.Status -ne 'Valid') { throw "package Authenticode signature is $($authenticode.Status); nothing was installed" }
    if ($authenticode.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") { throw 'package signer is not the expected publisher; nothing was installed' }
    if ($ExpectedThumbprint -and $authenticode.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) { throw 'package signer thumbprint mismatch; nothing was installed' }
  }

  Write-SetupDetail 'Verified the Windows installer and signed release manifest.'
  $activeStage = 'Install the Konteks command'
  # Windows Installer does not create the log's directory. Keep diagnostics
  # outside the temporary download folder so a failed install is inspectable.
  $logDirectory = Join-Path $RuntimeRoot 'logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $installerLog = Join-Path $logDirectory ("installer-" + [Guid]::NewGuid().ToString('n') + '.log')
  Write-SetupStage "2 of $stageCount - $activeStage" @(
    'Approve the Windows elevation prompt if it appears.',
    'Installation can take a minute.',
    'Keep this setup window open.'
  )
  try {
    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msiPath`"", '/qn', '/norestart', '/L*v', "`"$installerLog`"") -Verb RunAs -Wait -PassThru
  } catch {
    $failure = $_.Exception
    while ($null -ne $failure -and -not ($failure -is [System.ComponentModel.Win32Exception])) { $failure = $failure.InnerException }
    if ($null -ne $failure -and $failure.NativeErrorCode -eq 1223) {
      $failureActions = @('Open the downloaded setup file again and approve the prompt to continue.')
      throw 'The installation was cancelled at the Windows elevation prompt.'
    }
    $failureActions = @('Open the downloaded setup file again to retry.')
    throw "Windows Installer could not start: $($_.Exception.Message)"
  }
  # Both reboot codes mean the MSI succeeded; do not report a successful
  # install as a failure or skip enrollment. /norestart requests no restart.
  if ($proc.ExitCode -eq 3010) {
    $restartNotice = 'Restart Windows when convenient to finish the Windows Installer changes.'
    Write-SetupDetail 'The Konteks command was installed.'
    Write-SetupDetail $restartNotice
  } elseif ($proc.ExitCode -eq 1641) {
    $restartNotice = 'Restart Windows as requested by Windows Installer.'
    Write-SetupDetail 'The Konteks command was installed.'
    Write-SetupDetail 'Windows Installer reported that it will restart Windows.'
    Write-SetupDetail 'If this window closes, wait for Windows to restart.'
    Write-SetupDetail 'Then open the downloaded setup file again.'
  } elseif ($proc.ExitCode -ne 0) {
    $failureActions = switch ($proc.ExitCode) {
      1602 { @('The installation was cancelled.', 'Open the downloaded setup file again to continue.') }
      1618 { @('Another Windows installation is running.', 'Wait for it to finish, then open the downloaded setup file again.') }
      1638 { @('Windows already has a newer Konteks command installed.', 'Return to Konteks and check this computer.', 'Use its current setup file if an update is still offered.') }
      default { @('Check the installer log for the cause.', 'After resolving it, open the downloaded setup file again.') }
    }
    Write-SetupDetail 'Installer log:'
    Write-Host "    $installerLog"
    throw "Windows Installer failed (exit $($proc.ExitCode))."
  }
} catch {
  Write-SetupStage 'Setup could not finish' (@(
    $_.Exception.Message,
    "Stopped during: $activeStage."
  ) + $failureActions + @(
    'Keep this window open to review the message above.',
    'Return to Konteks and download a fresh setup file if a retry is needed.'
  ))
  # This bootstrap is a process entry point: return failure without a raw
  # PowerShell ErrorRecord burying the actions. finally still removes downloads.
  exit 1
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

$launcher = Join-Path ${env:ProgramFiles} 'konteks-remote\konteks-remote.exe'
if (-not (Test-Path $launcher)) { $launcher = 'konteks-remote' }
$code = 0
$commandFailure = $null
try {
  if ($Update) {
    # This launcher runs the newer of its own code and the installed release's
    # code. A connector that could not start stays stopped through an update,
    # so start it after; start leaves a running one alone.
    $activeStage = 'Update the connected runtime'
    $failedStage = $activeStage
    Write-SetupStage '3 of 4 - Update the connected runtime' @(
      'Updating the connected runtime...',
      'Downloading and checking the release can take a few minutes.'
    )
    & $launcher update
    $code = $LASTEXITCODE
    $failedStage = if ($code -eq 0) { 'Start and reconnect' } else { 'Update the connected runtime' }
    $activeStage = 'Start and reconnect'
    Write-SetupStage '4 of 4 - Start and reconnect' @('Starting the runtime...')
    & $launcher start
    if ($code -eq 0) { $code = $LASTEXITCODE }
  } else {
    # The activation code is prompted by the launcher without echo; it is never an argument.
    $activeStage = 'Connect this computer'
    $failedStage = $activeStage
    Write-SetupStage '3 of 3 - Connect this computer' @(
      'Connecting this computer to Konteks...',
      'Enter the activation code when asked.',
      'It is hidden while you type.'
    )
    & $launcher install --activation-id $ActivationId
    $code = $LASTEXITCODE
    $failedStage = 'Connect this computer'
  }
} catch {
  $commandFailure = $_.Exception.Message
  if ($code -eq 0) { $code = 1; $failedStage = $activeStage }
}
if ($code -eq 0) {
  $resultText = if ($Update) { 'Konteks runtime update completed.' } else { 'Konteks runtime installation completed.' }
  Write-SetupStage 'Setup complete' @(
    $resultText,
    'Return to Konteks -> Customize -> Runtimes.',
    'Confirm this computer is online.'
  )
  if ($restartNotice) { Write-SetupDetail $restartNotice }
  Write-SetupDetail 'You can close this setup window.'
} else {
  $resultText = if ($Update) { "The runtime update did not complete (exit $code)." } else { "The runtime connection did not complete (exit $code)." }
  Write-SetupStage 'Setup needs attention' @(
    $resultText,
    "Failure in: $failedStage."
  )
  if ($commandFailure) {
    Write-SetupDetail "Could not run the command for: $activeStage."
    Write-SetupDetail $commandFailure
  }
  Write-SetupDetail 'Keep this window open to review the message above.'
  Write-SetupDetail 'Return to Konteks and check this computer before trying setup again.'
  Write-SetupDetail 'If a retry is needed, open the downloaded setup file again.'
}
# The MSI put konteks-remote on the machine PATH, which this window cannot see
# yet; the commands the launcher just named work in a new one.
if (-not (Get-Command konteks-remote -ErrorAction SilentlyContinue)) {
  Write-SetupDetail 'Optional terminal commands: open a new PowerShell window.'
}
exit $code
