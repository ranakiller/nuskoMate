# Nuskomate device-identification native messaging host.
#
# Chrome/Edge launch this once per chrome.runtime.sendNativeMessage() call and
# talk to it over stdin/stdout using the Native Messaging protocol: a 4-byte
# little-endian length prefix, followed by that many bytes of UTF-8 JSON. This
# script reads exactly one request, replies with the machine's stable Windows
# MachineGuid (identical for every browser on this PC, unlike a per-extension-
# install random id), and exits — no request parsing needed since there's only
# one thing this host ever does.

$ErrorActionPreference = "Stop"

try {
    $stdin  = [Console]::OpenStandardInput()
    $stdout = [Console]::OpenStandardOutput()

    $lengthBytes = New-Object byte[] 4
    $stdin.Read($lengthBytes, 0, 4) | Out-Null
    $length = [BitConverter]::ToInt32($lengthBytes, 0)

    if ($length -gt 0) {
        $msgBytes = New-Object byte[] $length
        $stdin.Read($msgBytes, 0, $length) | Out-Null
        # Request body is intentionally unused — this host answers one way only.
    }

    $machineGuid = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -ErrorAction Stop).MachineGuid
    $response = @{ ok = $true; machineId = $machineGuid } | ConvertTo-Json -Compress
} catch {
    $response = (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)
}

$responseBytes  = [System.Text.Encoding]::UTF8.GetBytes($response)
$responseLength = [BitConverter]::GetBytes($responseBytes.Length)

$stdout.Write($responseLength, 0, 4)
$stdout.Write($responseBytes, 0, $responseBytes.Length)
$stdout.Flush()
