$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\bootstrap\install.ps1') -VerifyOnly

$cases = @(
  @('Windows 10 x64', 'AMD64', 19045, $true, $true),
  @('Windows 11 x64', 'AMD64', 26100, $true, $true),
  @('Windows 11 ARM64 with x64 emulation', 'ARM64', 22000, $true, $true),
  @('Windows 11 ARM64 current', 'ARM64', 26200, $true, $true),
  @('Windows 10 ARM64 has no supported x64 emulation', 'ARM64', 19045, $true, $false),
  @('Windows 7 x64', 'AMD64', 7601, $true, $false),
  @('32-bit Windows', 'x86', 19045, $false, $false),
  @('Unknown architecture', 'unknown', 26100, $true, $false)
)
foreach ($case in $cases) {
  $actual = Test-SetupPlatform -Architecture $case[1] -Build $case[2] -Is64Bit $case[3]
  if ($actual -isnot [bool] -or $actual -ne $case[4]) { throw "FAIL: $($case[0]) (expected $($case[4]), got $actual)" }
  Write-Output "PASS: $($case[0])"
}
