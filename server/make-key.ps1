# ============================================================
#  Nuskomate — Create a license key in Cloudflare KV
#  Run this, answer a couple of questions, and it posts the
#  key to wrangler and prints the key to give your customer.
# ============================================================
$ErrorActionPreference = "Stop"

# Always run from the server folder (where wrangler.toml lives)
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "====  Nuskomate  -  Create License Key  ====" -ForegroundColor Cyan
Write-Host ""

# 1) Customer name / note (just a label for you)
$name = Read-Host "Customer name / note (e.g. Lahore Office)"
if ([string]::IsNullOrWhiteSpace($name)) { $name = "Customer" }

# 2) Number of devices (seats)
$seatsInput = Read-Host "How many devices (seats)?  [press Enter for 4]"
if ([string]::IsNullOrWhiteSpace($seatsInput)) {
    $seats = 4
} elseif ($seatsInput -match '^\d+$' -and [int]$seatsInput -ge 1) {
    $seats = [int]$seatsInput
} else {
    Write-Host "  Not a valid number - using 4." -ForegroundColor Yellow
    $seats = 4
}

# 3) Key string: auto-generate, or type your own
$custom = Read-Host "Custom key? (press Enter to auto-generate NUSK-XXXX-XXXX)"
if ([string]::IsNullOrWhiteSpace($custom)) {
    $hex = -join ((1..8) | ForEach-Object { '{0:X}' -f (Get-Random -Maximum 16) })
    $key = "NUSK-" + $hex.Substring(0,4) + "-" + $hex.Substring(4,4)
} else {
    $key = $custom.Trim()
}

# Build the JSON value (escape \ and " in the name); devices always starts empty
$nameEsc = ($name -replace '\\', '\\') -replace '"', '\"'
$json = '{"name":"' + $nameEsc + '","seats":' + $seats + ',"devices":[]}'

# Write the value to a temp file as UTF-8 WITHOUT a BOM, then feed it to wrangler
# via --path (this sidesteps PowerShell mangling the quotes in the JSON).
$tmp = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Creating key..." -ForegroundColor Cyan
Write-Host "  Name : $name"
Write-Host "  Seats: $seats"
Write-Host "  Key  : $key"
Write-Host ""

npx wrangler kv key put --binding=LICENSES $key --path $tmp --remote
$code = $LASTEXITCODE

Remove-Item $tmp -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($code -eq 0) {
    Write-Host "====================  SUCCESS  ====================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Give this key to the customer:" -ForegroundColor Green
    Write-Host ""
    Write-Host "      $key" -ForegroundColor White
    Write-Host ""
    Write-Host "  ($name, $seats device$( if ($seats -ne 1) {'s'} ))" -ForegroundColor DarkGray
    Write-Host "===================================================" -ForegroundColor Green
} else {
    Write-Host "FAILED - wrangler exited with code $code. See the message above." -ForegroundColor Red
}
Write-Host ""
