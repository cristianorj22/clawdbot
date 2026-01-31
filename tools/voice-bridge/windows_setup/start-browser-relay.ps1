# Clawdbot Browser Relay - start script (Windows)
# This is invoked by the Scheduled Task.
# It starts the browser control server (18791) and the extension relay (18792).
# Token source:
# - Prefer CLAWDBOT_BROWSER_RELAY_TOKEN env var (set by setup script)
# - Fallback: read from repo .env (CLAWDBOT_GATEWAY_TOKEN)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    $here = $PSScriptRoot
    return (Resolve-Path (Join-Path $here "..\..\..")).Path
}

function Read-EnvValue([string]$envPath, [string]$key) {
    if (-not (Test-Path $envPath)) {
        throw "Missing .env file at: $envPath"
    }
    $line = Get-Content $envPath | Where-Object { $_ -like "$key=*" } | Select-Object -First 1
    if (-not $line) {
        throw "Missing $key in .env"
    }
    return $line.Split("=", 2)[1].Trim()
}

$logDir = Join-Path $env:LOCALAPPDATA "clawdbot-browser-relay"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "relay.log"

function Log([string]$msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value ("[" + $ts + "] " + $msg) -Encoding UTF8
}

$repo = Get-RepoRoot
Set-Location $repo

$token = $env:CLAWDBOT_BROWSER_RELAY_TOKEN
if (-not $token) { $token = "" }
$token = $token.Trim()
if (-not $token) {
    $token = Read-EnvValue (Join-Path $repo ".env") "CLAWDBOT_GATEWAY_TOKEN"
}

try {
    Log "Starting Clawdbot browser relay"
    $distIndex = Join-Path $repo "dist\\index.js"
    if (-not (Test-Path $distIndex)) {
        Log "ERROR: dist/index.js missing. Run setup-browser-relay.ps1 first (it installs deps and builds dist)."
        exit 1
    }

    Log "Running node dist/index.js browser serve (127.0.0.1:18791)"
    node $distIndex browser serve --bind 127.0.0.1 --port 18791 --token $token 2>&1 | ForEach-Object { Log $_; $_ }
}
catch {
    Log ("ERROR: " + $_.Exception.Message)
    throw
}

