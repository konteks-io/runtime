# CI (windows-2022): the Windows bootstrap's Ed25519 verifier, loaded with
# -VerifyOnly so nothing is downloaded for, or installed by, the installer.
# Checks RFC 8032 7.1 vectors 1-3, malformed and tampered inputs, and a real
# release manifest against the key install.ps1 pins.
$ErrorActionPreference = 'Stop'
Write-Host "PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
$installer = Join-Path $PSScriptRoot '..\bootstrap\install.ps1'
. $installer -VerifyOnly
if (-not (Get-Command Test-Ed25519Signature -ErrorAction SilentlyContinue)) { Write-Host 'FAIL  install.ps1 -VerifyOnly did not define the verifier'; exit 1 }

function ConvertFrom-Hex([string]$Text) {
  if (-not $Text) { return , [byte[]]@() }
  return , [byte[]]@(($Text -split '(..)' -ne '') | ForEach-Object { [Convert]::ToByte($_, 16) })
}
function Copy-Flipped([byte[]]$Bytes, [int]$Index) {
  $copy = [byte[]]$Bytes.Clone()
  $copy[$Index] = $copy[$Index] -bxor 1
  return , $copy
}

$v1 = @{ Key = ConvertFrom-Hex 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'; Message = ConvertFrom-Hex ''
  Signature = ConvertFrom-Hex 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b' }
$v2 = @{ Key = ConvertFrom-Hex '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'; Message = ConvertFrom-Hex '72'
  Signature = ConvertFrom-Hex '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00' }
$v3 = @{ Key = ConvertFrom-Hex 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025'; Message = ConvertFrom-Hex 'af82'
  Signature = ConvertFrom-Hex '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a' }
# Vector 1's signature with S replaced by S + L: the same point, but non-canonical.
$sPlusL = ConvertFrom-Hex 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901554c8c7872aa064e049dbb3013fbf29380d25bf5f0595bbe24655141438e7a101b'

# The real release manifest, checked against the pinned key.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$release = 'https://github.com/konteks-io/runtime/releases/download/v0.10.7'
$work = Join-Path ([IO.Path]::GetTempPath()) ('verifier-' + [Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $work | Out-Null
foreach ($name in 'SHA256SUMS', 'SHA256SUMS.sig', 'release-signing.pub') {
  Invoke-WebRequest -UseBasicParsing -Uri "$release/$name" -OutFile (Join-Path $work $name)
}
$sums = [IO.File]::ReadAllBytes((Join-Path $work 'SHA256SUMS'))
$sumsSig = [IO.File]::ReadAllBytes((Join-Path $work 'SHA256SUMS.sig'))
$pinned = ConvertFrom-Ed25519Spki $PinnedReleaseKey
$published = ConvertFrom-Ed25519Spki ([IO.File]::ReadAllText((Join-Path $work 'release-signing.pub')))

$cases = @(
  @('RFC 8032 test 1 (empty message)', $true, $v1.Key, $v1.Message, $v1.Signature),
  @('RFC 8032 test 2 (one byte)', $true, $v2.Key, $v2.Message, $v2.Signature),
  @('RFC 8032 test 3 (two bytes)', $true, $v3.Key, $v3.Message, $v3.Signature),
  @('test 1, one bit of R flipped', $false, $v1.Key, $v1.Message, (Copy-Flipped $v1.Signature 0)),
  @('test 1, one bit of S flipped', $false, $v1.Key, $v1.Message, (Copy-Flipped $v1.Signature 40)),
  @('test 2, one bit of the message flipped', $false, $v2.Key, (Copy-Flipped $v2.Message 0), $v2.Signature),
  @('test 3, one bit of the key flipped', $false, (Copy-Flipped $v3.Key 0), $v3.Message, $v3.Signature),
  @('test 1, non-canonical S (S + L)', $false, $v1.Key, $v1.Message, $sPlusL),
  @('key not on the curve (y = 2)', $false, (ConvertFrom-Hex ('02' + ('00' * 31))), $v1.Message, $v1.Signature),
  @('key with non-canonical y (y = p)', $false, (ConvertFrom-Hex ('ed' + ('ff' * 30) + '7f')), $v1.Message, $v1.Signature),
  @('63-byte signature', $false, $v1.Key, $v1.Message, [byte[]]$v1.Signature[0..62]),
  @('31-byte key', $false, [byte[]]$v1.Key[0..30], $v1.Message, $v1.Signature),
  @('v0.10.7 SHA256SUMS with the pinned key', $true, $pinned, $sums, $sumsSig),
  @('v0.10.7 SHA256SUMS, one byte changed', $false, $pinned, (Copy-Flipped $sums 0), $sumsSig)
)

$failed = 0
foreach ($case in $cases) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $got = Test-Ed25519Signature $case[2] $case[3] $case[4]
  $ok = ($got -is [bool]) -and ($got -eq $case[1])
  if (-not $ok) { $failed++ }
  Write-Host ('{0}  {1} (expected {2}, got {3}, {4} ms)' -f $(if ($ok) { 'ok  ' } else { 'FAIL' }), $case[0], $case[1], $got, $timer.ElapsedMilliseconds)
}
if ($null -eq $pinned -or $null -eq $published -or (Compare-Object $pinned $published -SyncWindow 0)) {
  $failed++
  Write-Host 'FAIL  the published release-signing.pub is not the key install.ps1 pins'
} else {
  Write-Host 'ok    the published release-signing.pub is the key install.ps1 pins'
}
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
if ($failed) { Write-Host "$failed check(s) failed"; exit 1 }
Write-Host 'all verifier checks passed'
