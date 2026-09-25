param([switch]$NoBrowser, [switch]$ShowConsole)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:4327"
$healthUrl = "$url/api/health"
$pidFile = Join-Path $root ".server.pid"

function Test-TranslationLibrary {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 1
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

if (Test-TranslationLibrary) {
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host "Translation Library is already running."
    exit 0
}

$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $node)) {
    $node = (Get-Command node -ErrorAction Stop).Source
}

# Honor HTTPS_PROXY / HTTP_PROXY when the user has configured a proxy in Windows.
$env:NODE_USE_ENV_PROXY = "1"

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
if ($ShowConsole) {
    $process = Start-Process -FilePath $node -ArgumentList @("server.mjs") -WorkingDirectory $root -WindowStyle Normal -PassThru
} else {
    $process = Start-Process -FilePath $node -ArgumentList @("server.mjs") -WorkingDirectory $root `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "server.stdout.log") `
        -RedirectStandardError (Join-Path $logDir "server.stderr.log") -PassThru
}

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-TranslationLibrary) {
        if (-not $NoBrowser) { Start-Process $url }
        Write-Host "Translation Library started: $url"
        exit 0
    }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 250
}

throw "Translation Library could not start. Check that port 4327 is available."
