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

# Presentation is confined to this setup process and its launcher children.
# VerifyOnly returned above; an unsupported value cannot download or install.
$SetupLocale = $env:KONTEKS_SETUP_LOCALE
if ($null -eq $SetupLocale) { $SetupLocale = 'en' }
if (@('en', 'id') -cnotcontains $SetupLocale) {
  Write-SetupStage 'Setup needs attention' @('Setup language must be en or id.', 'Return to Konteks and download a fresh setup file.')
  exit 2
}
$env:KONTEKS_SETUP_LOCALE = $SetupLocale
$SetupIndonesian = @{
  'Konteks runtime setup' = 'Pemasangan runtime Konteks'
  "Updating this computer's existing Konteks connection." = 'Memperbarui koneksi Konteks yang sudah ada pada komputer ini.'
  'Connecting this computer to Konteks.' = 'Menghubungkan komputer ini ke Konteks.'
  'Keep this window open until setup finishes.' = 'Biarkan jendela ini terbuka sampai pemasangan selesai.'
  'Setup needs an activation' = 'Pemasangan memerlukan aktivasi'
  'The user-local install is not available on Windows yet.' = 'Pemasangan khusus pengguna belum tersedia pada Windows.'
  'Return to Konteks -> Customize -> Runtimes and connect this computer.' = 'Kembali ke Konteks -> Sesuaikan -> Runtimes dan hubungkan komputer ini.'
  'Download and open the Windows setup file offered there.' = 'Unduh dan buka berkas pemasangan Windows yang ditawarkan di sana.'
  'Setup needs attention' = 'Pemasangan perlu perhatian'
  'Choose either an update or a new connection in Konteks.' = 'Pilih pembaruan atau koneksi baru di Konteks.'
  'Then download and open its setup file.' = 'Lalu unduh dan buka berkas pemasangannya.'
  '-Update and -ActivationId cannot be used together' = '-Update dan -ActivationId tidak dapat digunakan bersamaan'
  'This computer is not connected yet' = 'Komputer ini belum terhubung'
  'Download and open its Windows setup file.' = 'Unduh dan buka berkas pemasangan Windows untuk koneksi itu.'
  'Return to Konteks -> Customize -> Runtimes.' = 'Kembali ke Konteks -> Sesuaikan -> Runtimes.'
  'Download and open the setup file for this connection.' = 'Unduh dan buka berkas pemasangan untuk koneksi ini.'
  '-ActivationId <id> is required for a new connection' = '-ActivationId <id> diperlukan untuk koneksi baru'
  'This Windows computer is not supported' = 'Komputer Windows ini tidak didukung'
  'Setup requires Windows 10/11 x64. Windows on ARM is not supported.' = 'Pemasangan memerlukan Windows 10/11 x64. Windows pada ARM tidak didukung.'
  'konteks-remote supports Windows 10/11 x64 only (Windows on ARM is not supported)' = 'konteks-remote hanya mendukung Windows 10/11 x64 (Windows pada ARM tidak didukung)'
  'Prepare secure downloads' = 'Siapkan unduhan aman'
  'Download and verify' = 'Unduh dan verifikasi'
  '{0} of {1} - {2}' = '{0} dari {1} - {2}'
  'Fetching the signed release manifest...' = 'Mengambil manifes rilis bertanda tangan...'
  'release signing key digest mismatch; nothing was installed' = 'digest kunci penandatanganan rilis tidak cocok; tidak ada yang dipasang'
  "the release manifest's signature is not valid; nothing was installed" = 'tanda tangan manifes rilis tidak valid; tidak ada yang dipasang'
  'the release manifest lists no single {0}; nothing was installed' = 'manifes rilis tidak mencantumkan tepat satu {0}; tidak ada yang dipasang'
  'Downloading the Windows installer...' = 'Mengunduh pemasang Windows...'
  'package checksum mismatch; nothing was installed' = 'checksum paket tidak cocok; tidak ada yang dipasang'
  "This release is verified by Konteks' signed checksums." = 'Rilis ini diverifikasi dengan checksum bertanda tangan milik Konteks.'
  "Windows may show 'Unknown publisher' at the approval prompt." = "Windows mungkin menampilkan 'Unknown publisher' pada permintaan persetujuan."
  'package Authenticode signature is {0}; nothing was installed' = 'tanda tangan Authenticode paket berstatus {0}; tidak ada yang dipasang'
  'package signer is not the expected publisher; nothing was installed' = 'penandatangan paket bukan penerbit yang diharapkan; tidak ada yang dipasang'
  'package signer thumbprint mismatch; nothing was installed' = 'thumbprint penandatangan paket tidak cocok; tidak ada yang dipasang'
  'Verified the Windows installer and signed release manifest.' = 'Pemasang Windows dan manifes rilis bertanda tangan sudah diverifikasi.'
  'Install the Konteks command' = 'Pasang perintah Konteks'
  'Approve the Windows elevation prompt if it appears.' = 'Setujui permintaan izin Windows jika muncul.'
  'Installation can take a minute.' = 'Pemasangan dapat memerlukan satu menit.'
  'Keep this setup window open.' = 'Biarkan jendela pemasangan ini terbuka.'
  'Open the downloaded setup file again and approve the prompt to continue.' = 'Buka kembali berkas pemasangan yang diunduh dan setujui permintaan izin untuk melanjutkan.'
  'The installation was cancelled at the Windows elevation prompt.' = 'Pemasangan dibatalkan pada permintaan izin Windows.'
  'Open the downloaded setup file again to retry.' = 'Buka kembali berkas pemasangan yang diunduh untuk mencoba ulang.'
  'Windows Installer could not start: {0}' = 'Windows Installer tidak dapat dimulai: {0}'
  'Restart Windows when convenient to finish the Windows Installer changes.' = 'Mulai ulang Windows saat memungkinkan untuk menyelesaikan perubahan Windows Installer.'
  'The Konteks command was installed.' = 'Perintah Konteks sudah dipasang.'
  'Restart Windows as requested by Windows Installer.' = 'Mulai ulang Windows sesuai permintaan Windows Installer.'
  'Windows Installer reported that it will restart Windows.' = 'Windows Installer melaporkan bahwa Windows akan dimulai ulang.'
  'If this window closes, wait for Windows to restart.' = 'Jika jendela ini tertutup, tunggu sampai Windows dimulai ulang.'
  'Then open the downloaded setup file again.' = 'Lalu buka kembali berkas pemasangan yang diunduh.'
  'The installation was cancelled.' = 'Pemasangan dibatalkan.'
  'Open the downloaded setup file again to continue.' = 'Buka kembali berkas pemasangan yang diunduh untuk melanjutkan.'
  'Another Windows installation is running.' = 'Pemasangan Windows lain sedang berjalan.'
  'Wait for it to finish, then open the downloaded setup file again.' = 'Tunggu sampai selesai, lalu buka kembali berkas pemasangan yang diunduh.'
  'Windows already has a newer Konteks command installed.' = 'Windows sudah memiliki perintah Konteks dengan versi yang lebih baru.'
  'Return to Konteks and check this computer.' = 'Kembali ke Konteks dan periksa komputer ini.'
  'Use its current setup file if an update is still offered.' = 'Gunakan berkas pemasangan saat ini jika pembaruan masih ditawarkan.'
  'Check the installer log for the cause.' = 'Periksa log pemasang untuk mengetahui penyebabnya.'
  'After resolving it, open the downloaded setup file again.' = 'Setelah menyelesaikan masalahnya, buka kembali berkas pemasangan yang diunduh.'
  'Installer log:' = 'Log pemasang:'
  'Windows Installer failed (exit {0}).' = 'Windows Installer gagal (kode keluar {0}).'
  'Setup could not finish' = 'Pemasangan belum selesai'
  'Stopped during: {0}.' = 'Berhenti saat: {0}.'
  'Keep this window open to review the message above.' = 'Biarkan jendela ini terbuka untuk membaca pesan di atas.'
  'Return to Konteks and download a fresh setup file if a retry is needed.' = 'Kembali ke Konteks dan unduh berkas pemasangan baru jika perlu mencoba ulang.'
  'Update the connected runtime' = 'Perbarui runtime yang terhubung'
  'Updating the connected runtime...' = 'Memperbarui runtime yang terhubung...'
  'Downloading and checking the release can take a few minutes.' = 'Mengunduh dan memeriksa rilis dapat memerlukan beberapa menit.'
  'Start and reconnect' = 'Mulai dan hubungkan kembali'
  'Starting the runtime...' = 'Memulai runtime...'
  'Connect this computer' = 'Hubungkan komputer ini'
  'Connecting this computer to Konteks...' = 'Menghubungkan komputer ini ke Konteks...'
  'Enter the activation code when asked.' = 'Masukkan kode aktivasi saat diminta.'
  'It is hidden while you type.' = 'Kode disembunyikan saat Anda mengetik.'
  'Konteks runtime update completed.' = 'Pembaruan runtime Konteks selesai.'
  'Konteks runtime installation completed.' = 'Pemasangan runtime Konteks selesai.'
  'Setup complete' = 'Pemasangan selesai'
  'Confirm this computer is online.' = 'Pastikan komputer ini terhubung.'
  'You can close this setup window.' = 'Anda dapat menutup jendela pemasangan ini.'
  'The runtime update did not complete (exit {0}).' = 'Pembaruan runtime belum selesai (kode keluar {0}).'
  'The runtime connection did not complete (exit {0}).' = 'Koneksi runtime belum selesai (kode keluar {0}).'
  'Failure in: {0}.' = 'Kegagalan pada: {0}.'
  'Could not run the command for: {0}.' = 'Tidak dapat menjalankan perintah untuk: {0}.'
  'Return to Konteks and check this computer before trying setup again.' = 'Kembali ke Konteks dan periksa komputer ini sebelum mencoba pemasangan lagi.'
  'If a retry is needed, open the downloaded setup file again.' = 'Jika perlu mencoba ulang, buka kembali berkas pemasangan yang diunduh.'
  'Optional terminal commands: open a new PowerShell window.' = 'Perintah terminal opsional: buka jendela PowerShell baru.'
}

function Get-SetupText([string]$English, [object[]]$Values = @()) {
  $text = if ($SetupLocale -ceq 'id') { $SetupIndonesian[$English] } else { $English }
  return [string]::Format([Globalization.CultureInfo]::InvariantCulture, $text, $Values)
}

# Hash verification does not depend on PowerShell module discovery.
function Get-SetupSha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [IO.File]::OpenRead($Path)
    return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $sha.Dispose()
  }
}

$setupAction = if ($Update) { Get-SetupText "Updating this computer's existing Konteks connection." } else { Get-SetupText 'Connecting this computer to Konteks.' }
$stageCount = if ($Update) { 4 } else { 3 }
$restartNotice = $null
Write-SetupStage (Get-SetupText 'Konteks runtime setup') @($setupAction, (Get-SetupText 'Keep this window open until setup finishes.'))

if ($User -or $Enroll) {
  Write-SetupStage (Get-SetupText 'Setup needs an activation') @(
    (Get-SetupText 'The user-local install is not available on Windows yet.'),
    (Get-SetupText 'Return to Konteks -> Customize -> Runtimes and connect this computer.'),
    (Get-SetupText 'Download and open the Windows setup file offered there.')
  )
  exit 3
}
if ($Update -and $ActivationId) {
  Write-SetupStage (Get-SetupText 'Setup needs attention') @(
    (Get-SetupText 'Choose either an update or a new connection in Konteks.'),
    (Get-SetupText 'Then download and open its setup file.')
  )
  Write-Error (Get-SetupText '-Update and -ActivationId cannot be used together')
  exit 2
}
$RuntimeRoot = Join-Path ${env:USERPROFILE} 'AppData\Local\konteks-remote'
if ($Update -and -not (Test-Path (Join-Path $RuntimeRoot 'native-runtime.json'))) {
  Write-SetupStage (Get-SetupText 'This computer is not connected yet') @(
    (Get-SetupText 'Return to Konteks -> Customize -> Runtimes and connect this computer.'),
    (Get-SetupText 'Download and open its Windows setup file.')
  )
  exit 2
}
if (-not $Update -and -not $ActivationId) {
  Write-SetupStage (Get-SetupText 'Setup needs an activation') @(
    (Get-SetupText 'Return to Konteks -> Customize -> Runtimes.'),
    (Get-SetupText 'Download and open the setup file for this connection.')
  )
  Write-Error (Get-SetupText '-ActivationId <id> is required for a new connection')
  exit 2
}
$ErrorActionPreference = 'Stop'
$ReleaseBase = if ($env:KONTEKS_RELEASE_BASE) { $env:KONTEKS_RELEASE_BASE } else { 'https://github.com/konteks-io/runtime/releases/latest/download' }
$ExpectedPublisher = if ($env:KONTEKS_MSI_PUBLISHER) { $env:KONTEKS_MSI_PUBLISHER } else { 'CN=Konteks' }
$ExpectedThumbprint = $env:KONTEKS_MSI_THUMBPRINT

if ([Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  Write-SetupStage (Get-SetupText 'This Windows computer is not supported') @((Get-SetupText 'Setup requires Windows 10/11 x64. Windows on ARM is not supported.'))
  throw (Get-SetupText 'konteks-remote supports Windows 10/11 x64 only (Windows on ARM is not supported)')
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
  Write-SetupStage (Get-SetupText '{0} of {1} - {2}' @(1, $stageCount, (Get-SetupText $activeStage))) @((Get-SetupText 'Fetching the signed release manifest...'))
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
    if ((Get-SetupSha256 $keyPath) -ne $env:KONTEKS_RELEASE_PUBKEY_SHA256.ToLowerInvariant()) { throw (Get-SetupText 'release signing key digest mismatch; nothing was installed') }
    $keyText = [IO.File]::ReadAllText($keyPath)
  }
  $releaseKey = ConvertFrom-Ed25519Spki $keyText
  $sums = [IO.File]::ReadAllBytes($sumsPath)
  $signature = [IO.File]::ReadAllBytes($sigPath)
  if ($null -eq $releaseKey -or -not (Test-Ed25519Signature $releaseKey $sums $signature)) { throw (Get-SetupText "the release manifest's signature is not valid; nothing was installed") }

  # Only the verified bytes are read for the MSI's checksum.
  $msi = 'konteks-remote-x64.msi'
  $expected = @([Text.Encoding]::UTF8.GetString($sums) -split "`r?`n" | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($msi))$" } | ForEach-Object { ($_ -split '\s+')[0].ToLowerInvariant() })
  if ($expected.Count -ne 1) { throw (Get-SetupText 'the release manifest lists no single {0}; nothing was installed' @($msi)) }
  $msiPath = Join-Path $work $msi
  Write-SetupDetail (Get-SetupText 'Downloading the Windows installer...')
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$msi" -OutFile $msiPath
  $actual = Get-SetupSha256 $msiPath
  if ($expected[0] -ne $actual) { throw (Get-SetupText 'package checksum mismatch; nothing was installed') }

  # A signed MSI is still held to its signature and publisher; an unsigned one
  # is already proven by the signed checksums above.
  $authenticode = Get-AuthenticodeSignature -FilePath $msiPath
  if ($authenticode.Status -eq 'NotSigned') {
    Write-SetupDetail (Get-SetupText "This release is verified by Konteks' signed checksums.")
    Write-SetupDetail (Get-SetupText "Windows may show 'Unknown publisher' at the approval prompt.")
  } else {
    if ($authenticode.Status -ne 'Valid') { throw (Get-SetupText 'package Authenticode signature is {0}; nothing was installed' @($authenticode.Status)) }
    if ($authenticode.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") { throw (Get-SetupText 'package signer is not the expected publisher; nothing was installed') }
    if ($ExpectedThumbprint -and $authenticode.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) { throw (Get-SetupText 'package signer thumbprint mismatch; nothing was installed') }
  }

  Write-SetupDetail (Get-SetupText 'Verified the Windows installer and signed release manifest.')
  $activeStage = 'Install the Konteks command'
  # Windows Installer does not create the log's directory. Keep diagnostics
  # outside the temporary download folder so a failed install is inspectable.
  $logDirectory = Join-Path $RuntimeRoot 'logs'
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $installerLog = Join-Path $logDirectory ("installer-" + [Guid]::NewGuid().ToString('n') + '.log')
  Write-SetupStage (Get-SetupText '{0} of {1} - {2}' @(2, $stageCount, (Get-SetupText $activeStage))) @(
    (Get-SetupText 'Approve the Windows elevation prompt if it appears.'),
    (Get-SetupText 'Installation can take a minute.'),
    (Get-SetupText 'Keep this setup window open.')
  )
  try {
    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msiPath`"", '/qn', '/norestart', '/L*v', "`"$installerLog`"") -Verb RunAs -Wait -PassThru
  } catch {
    $failure = $_.Exception
    while ($null -ne $failure -and -not ($failure -is [System.ComponentModel.Win32Exception])) { $failure = $failure.InnerException }
    if ($null -ne $failure -and $failure.NativeErrorCode -eq 1223) {
      $failureActions = @((Get-SetupText 'Open the downloaded setup file again and approve the prompt to continue.'))
      throw (Get-SetupText 'The installation was cancelled at the Windows elevation prompt.')
    }
    $failureActions = @((Get-SetupText 'Open the downloaded setup file again to retry.'))
    throw (Get-SetupText 'Windows Installer could not start: {0}' @($_.Exception.Message))
  }
  # Both reboot codes mean the MSI succeeded; do not report a successful
  # install as a failure or skip enrollment. /norestart requests no restart.
  if ($proc.ExitCode -eq 3010) {
    $restartNotice = Get-SetupText 'Restart Windows when convenient to finish the Windows Installer changes.'
    Write-SetupDetail (Get-SetupText 'The Konteks command was installed.')
    Write-SetupDetail $restartNotice
  } elseif ($proc.ExitCode -eq 1641) {
    $restartNotice = Get-SetupText 'Restart Windows as requested by Windows Installer.'
    Write-SetupDetail (Get-SetupText 'The Konteks command was installed.')
    Write-SetupDetail (Get-SetupText 'Windows Installer reported that it will restart Windows.')
    Write-SetupDetail (Get-SetupText 'If this window closes, wait for Windows to restart.')
    Write-SetupDetail (Get-SetupText 'Then open the downloaded setup file again.')
  } elseif ($proc.ExitCode -ne 0) {
    $failureActions = switch ($proc.ExitCode) {
      1602 { @((Get-SetupText 'The installation was cancelled.'), (Get-SetupText 'Open the downloaded setup file again to continue.')) }
      1618 { @((Get-SetupText 'Another Windows installation is running.'), (Get-SetupText 'Wait for it to finish, then open the downloaded setup file again.')) }
      1638 { @((Get-SetupText 'Windows already has a newer Konteks command installed.'), (Get-SetupText 'Return to Konteks and check this computer.'), (Get-SetupText 'Use its current setup file if an update is still offered.')) }
      default { @((Get-SetupText 'Check the installer log for the cause.'), (Get-SetupText 'After resolving it, open the downloaded setup file again.')) }
    }
    Write-SetupDetail (Get-SetupText 'Installer log:')
    Write-Host "    $installerLog"
    throw (Get-SetupText 'Windows Installer failed (exit {0}).' @($proc.ExitCode))
  }
} catch {
  Write-SetupStage (Get-SetupText 'Setup could not finish') (@(
    $_.Exception.Message,
    (Get-SetupText 'Stopped during: {0}.' @((Get-SetupText $activeStage)))
  ) + $failureActions + @(
    (Get-SetupText 'Keep this window open to review the message above.'),
    (Get-SetupText 'Return to Konteks and download a fresh setup file if a retry is needed.')
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
    Write-SetupStage (Get-SetupText '{0} of {1} - {2}' @(3, 4, (Get-SetupText $activeStage))) @(
      (Get-SetupText 'Updating the connected runtime...'),
      (Get-SetupText 'Downloading and checking the release can take a few minutes.')
    )
    & $launcher update
    $code = $LASTEXITCODE
    $failedStage = if ($code -eq 0) { 'Start and reconnect' } else { 'Update the connected runtime' }
    $activeStage = 'Start and reconnect'
    Write-SetupStage (Get-SetupText '{0} of {1} - {2}' @(4, 4, (Get-SetupText $activeStage))) @((Get-SetupText 'Starting the runtime...'))
    & $launcher start
    if ($code -eq 0) { $code = $LASTEXITCODE }
  } else {
    # The activation code is prompted by the launcher without echo; it is never an argument.
    $activeStage = 'Connect this computer'
    $failedStage = $activeStage
    Write-SetupStage (Get-SetupText '{0} of {1} - {2}' @(3, 3, (Get-SetupText $activeStage))) @(
      (Get-SetupText 'Connecting this computer to Konteks...'),
      (Get-SetupText 'Enter the activation code when asked.'),
      (Get-SetupText 'It is hidden while you type.')
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
  $resultText = if ($Update) { Get-SetupText 'Konteks runtime update completed.' } else { Get-SetupText 'Konteks runtime installation completed.' }
  Write-SetupStage (Get-SetupText 'Setup complete') @(
    $resultText,
    (Get-SetupText 'Return to Konteks -> Customize -> Runtimes.'),
    (Get-SetupText 'Confirm this computer is online.')
  )
  if ($restartNotice) { Write-SetupDetail $restartNotice }
  Write-SetupDetail (Get-SetupText 'You can close this setup window.')
} else {
  $resultText = if ($Update) { Get-SetupText 'The runtime update did not complete (exit {0}).' @($code) } else { Get-SetupText 'The runtime connection did not complete (exit {0}).' @($code) }
  Write-SetupStage (Get-SetupText 'Setup needs attention') @(
    $resultText,
    (Get-SetupText 'Failure in: {0}.' @((Get-SetupText $failedStage)))
  )
  if ($commandFailure) {
    Write-SetupDetail (Get-SetupText 'Could not run the command for: {0}.' @((Get-SetupText $activeStage)))
    Write-SetupDetail $commandFailure
  }
  Write-SetupDetail (Get-SetupText 'Keep this window open to review the message above.')
  Write-SetupDetail (Get-SetupText 'Return to Konteks and check this computer before trying setup again.')
  Write-SetupDetail (Get-SetupText 'If a retry is needed, open the downloaded setup file again.')
}
# The MSI put konteks-remote on the machine PATH, which this window cannot see
# yet; the commands the launcher just named work in a new one.
if (-not (Get-Command konteks-remote -ErrorAction SilentlyContinue)) {
  Write-SetupDetail (Get-SetupText 'Optional terminal commands: open a new PowerShell window.')
}
exit $code
