# Nuskomate device-identification helper — installer
# --------------------------------------------------
# Run this ONCE (from the same folder as nuskomate-host.ps1) to let Chrome and
# Edge on this PC share one stable device id, instead of each browser getting
# its own — this is what lets a single activation key work correctly across
# both browsers on the same computer.
#
# What this does (all under your own user account — no admin rights needed):
#   1. Copies the helper script into %LOCALAPPDATA%\Nuskomate\NativeHost
#   2. Writes a small launcher + the Native Messaging manifest Chrome/Edge
#      require to know this helper exists and is allowed to talk to the
#      Nuskomate extension specifically (nothing else can use it)
#   3. Registers that manifest with both Chrome and Edge (HKCU registry only)
#
# It does NOT modify the browser itself, does NOT need internet access, and
# only ever reports one value back to the extension: this Windows install's
# machine id (the same value Windows itself already uses internally — nothing
# new is generated or collected).

$ErrorActionPreference = "Stop"

$ExtensionId = "mcikbecdcddegpbonhndegmpjgbangdl"
$HostName    = "com.nuskomate.devicehost"

$sourceDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceHost = Join-Path $sourceDir "nuskomate-host.ps1"
if (-not (Test-Path $sourceHost)) {
    Write-Host "ERROR: nuskomate-host.ps1 must be in the same folder as install.ps1." -ForegroundColor Red
    exit 1
}

$installDir = Join-Path $env:LOCALAPPDATA "Nuskomate\NativeHost"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

Copy-Item -Path $sourceHost -Destination (Join-Path $installDir "nuskomate-host.ps1") -Force

$launcherPath = Join-Path $installDir "launcher.bat"
$launcherContent = "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0nuskomate-host.ps1`"`r`n"
Set-Content -Path $launcherPath -Value $launcherContent -Encoding ASCII -NoNewline

$manifestPath = Join-Path $installDir "$HostName.json"
$manifestObj = [ordered]@{
    name            = $HostName
    description     = "Nuskomate device identification helper"
    path            = $launcherPath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestObj | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8

# Every Chromium-based browser keeps its OWN native-messaging-host registry
# namespace — none of them read Chrome's entries, even though they share the
# same underlying engine. So each one needs its own registration pointing at
# the same manifest file. A key for a browser that isn't installed is
# harmless — it just sits there unused.
foreach ($browserKey in @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Opera Software\NativeMessagingHosts\$HostName"
)) {
    New-Item -Path $browserKey -Force | Out-Null
    Set-ItemProperty -Path $browserKey -Name "(default)" -Value $manifestPath
}

Write-Host ""
Write-Host "Nuskomate device helper installed." -ForegroundColor Green
Write-Host "Installed to: $installDir"
Write-Host ""
Write-Host "Now restart Chrome and Edge (fully close, not just the window) and reopen the Nuskomate extension." -ForegroundColor Yellow
