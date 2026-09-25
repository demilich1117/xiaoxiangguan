$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".server.pid"

$serverPid = 0
if (Test-Path -LiteralPath $pidFile) {
    $rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if (-not [int]::TryParse($rawPid, [ref]$serverPid)) {
        throw "The startup record is invalid. Delete .server.pid and try again."
    }
} else {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4327 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { $serverPid = [int]$listener.OwningProcess }
}

if ($serverPid -le 0) {
    Write-Host "Translation Library is not running."
    exit 0
}

$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($process) {
    if ($process.ProcessName -notmatch '^node') {
        throw "Process $serverPid is not Node. Nothing was stopped."
    }
    $gracefulRequested = $false
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:4327/api/health" -TimeoutSec 2
        if ($health.shutdown -and $health.pid -eq $serverPid) {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:4327/api/shutdown" -Method Post -ContentType "application/json" -Body '{"confirm":true}' -TimeoutSec 12
            $gracefulRequested = $true
        }
    } catch { Write-Host "Graceful shutdown is unavailable; stopping the recorded process." }
    if ($gracefulRequested) { Wait-Process -Id $serverPid -Timeout 10 -ErrorAction SilentlyContinue }
    try { if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) { Stop-Process -Id $serverPid -Force -ErrorAction Stop } }
    catch {
        if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
            throw "Unable to stop the translation library process ($serverPid). Please run this launcher directly from Windows Explorer."
        }
    }
    Wait-Process -Id $serverPid -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Translation Library stopped."
