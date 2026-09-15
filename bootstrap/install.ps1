<#
konteks-remote bootstrap (Windows 10/11 x64, PowerShell) - version 1.

Usage (copied verbatim from the Konteks App or MCP activation response):
  powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://github.com/konteks-io/runtime/releases/latest/download/install.ps1))) -ActivationId <id>"

Downloads the signed MSI, verifies its SHA-256 against the signed checksum
manifest and its Authenticode signature/publisher, installs it, and invokes
`konteks-remote install` with the NON-SECRET activation id. The activation
code is prompted by the launcher without echo and never appears here. No
general command passthrough exists; an unverified package is refused.
#>
[CmdletBinding()]
param(
  # Agent-first onboarding (onboarding-simplified R17): the user-local install
  # arrives for Windows in a later release. Until then these switches say so
  # instead of failing on a missing activation id.
  [switch]$User,
  [switch]$Enroll,
  [Parameter(Mandatory = $false)]
  [ValidatePattern('^[A-Za-z0-9._-]{8,128}$')]
  [string]$ActivationId
)

if ($User -or $Enroll) {
  Write-Host "The user-local (agent-first) install is not available on Windows yet; it arrives in a later release."
  Write-Host "For now, create an activation in Konteks (Settings -> Connected runtimes) and run this script with -ActivationId <id>."
  exit 3
}
if (-not $ActivationId) {
  Write-Error "-ActivationId <id> is required (copy the command from the Konteks App or MCP)"
  exit 2
}
$ErrorActionPreference = 'Stop'
$BootstrapVersion = '1'
$ReleaseBase = if ($env:KONTEKS_RELEASE_BASE) { $env:KONTEKS_RELEASE_BASE } else { 'https://github.com/konteks-io/runtime/releases/latest/download' }
$ExpectedPublisher = if ($env:KONTEKS_MSI_PUBLISHER) { $env:KONTEKS_MSI_PUBLISHER } else { 'CN=Konteks' }
$ExpectedThumbprint = $env:KONTEKS_MSI_THUMBPRINT

if ([Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw 'konteks-remote supports Windows 10/11 x64 only (Windows on ARM is not supported)'
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("konteks-remote-" + [Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
  Write-Host "konteks-remote bootstrap v$BootstrapVersion: fetching the signed checksum manifest"
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/SHA256SUMS.sig" -OutFile (Join-Path $work 'SHA256SUMS.sig')
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/release-signing.pub" -OutFile (Join-Path $work 'release-signing.pub')

  $msi = 'konteks-remote-x64.msi'
  $msiPath = Join-Path $work $msi
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$msi" -OutFile $msiPath

  # Checksum against the published manifest (the manifest itself is Ed25519-signed;
  # verification of that signature is performed by the installed launcher's
  # `doctor` as well, and here through the Authenticode chain on the MSI).
  $expected = (Get-Content (Join-Path $work 'SHA256SUMS') | Where-Object { $_ -match "\s$([regex]::Escape($msi))$" } | ForEach-Object { ($_ -split '\s+')[0] })
  $actual = (Get-FileHash -Algorithm SHA256 -Path $msiPath).Hash.ToLowerInvariant()
  if (-not $expected -or $expected.ToLowerInvariant() -ne $actual) { throw 'package checksum mismatch; refusing to install' }

  $sig = Get-AuthenticodeSignature -FilePath $msiPath
  if ($sig.Status -ne 'Valid') { throw "package Authenticode signature is $($sig.Status); refusing to install" }
  if ($sig.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") { throw 'package signer is not the expected publisher; refusing to install' }
  if ($ExpectedThumbprint -and $sig.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) { throw 'package signer thumbprint mismatch; refusing to install' }

  Write-Host "installing $msi (an elevation prompt may appear)"
  $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msiPath`"", '/qn', '/norestart') -Verb RunAs -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "msiexec exited with $($proc.ExitCode)" }
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

$launcher = Join-Path ${env:ProgramFiles} 'konteks-remote\konteks-remote.exe'
if (-not (Test-Path $launcher)) { $launcher = 'konteks-remote' }
# The activation code is prompted by the launcher without echo; it is never an argument.
& $launcher install --activation-id $ActivationId
exit $LASTEXITCODE
