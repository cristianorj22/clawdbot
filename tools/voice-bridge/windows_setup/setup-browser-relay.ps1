# Clawdbot Browser Relay - Windows setup (Task Scheduler)
# Goals:
# - Ensure pnpm is available
# - Install repo deps (pnpm install)
# - Register a Scheduled Task to start `clawdbot browser serve` on logon
# - Start the task now (optional) and print validation steps
#
# Notes:
# - ASCII only (avoid unicode in scripts)
# - Do NOT print tokens

param(
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$NoStartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    # tools/voice-bridge/windows_setup -> repo root
    $here = $PSScriptRoot
    return (Resolve-Path (Join-Path $here "..\..\..")).Path
}

function Require-Command([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Missing required command: $name"
    }
}

function Ensure-Pnpm {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpm) { return }

    # Try corepack (Node 16+)
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if (-not $corepack) {
        throw "pnpm not found and corepack not available. Install Node.js 22+ (includes corepack)."
    }

    Write-Output "[INFO] pnpm not found; enabling via corepack"
    & corepack enable | Out-Null
    & corepack prepare pnpm@latest --activate | Out-Null

    Require-Command "pnpm"
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

function Ensure-Dependencies([string]$repoRoot) {
    Push-Location $repoRoot
    try {
        if ($SkipInstall) {
            Write-Output "[INFO] SkipInstall=true; skipping pnpm install"
            return
        }
        $nodeModules = Join-Path $repoRoot "node_modules"
        $tscCmd = Join-Path $nodeModules ".bin\\tsc.cmd"
        if ((Test-Path $nodeModules) -and (Test-Path $tscCmd)) {
            Write-Output "[INFO] node_modules and tsc exist; skipping pnpm install"
            return
        }
        if (Test-Path $nodeModules) {
            Write-Output "[WARN] node_modules exists but tsc is missing; running pnpm install to repair deps"
        }
        Write-Output "[INFO] Running pnpm install (first-time setup)"
        $ok = $false
        for ($i = 1; $i -le 3; $i++) {
            try {
                & pnpm install
                $ok = $true
                break
            }
            catch {
                Write-Warning ("pnpm install attempt " + $i + " failed (file lock/AV is common).")
                Start-Sleep -Seconds 2
            }
        }
        if (-not $ok) {
            Write-Warning "pnpm install did not complete. The relay cannot start until deps are installed."
        }
    }
    finally {
        Pop-Location
    }
}

function Ensure-Build([string]$repoRoot) {
    if ($SkipBuild) {
        Write-Output "[INFO] SkipBuild=true; skipping pnpm build"
        return
    }
    $distIndex = Join-Path $repoRoot "dist\\index.js"
    if (Test-Path $distIndex) {
        Write-Output "[INFO] dist/index.js exists; skipping pnpm build"
        return
    }
    Push-Location $repoRoot
    try {
        Write-Output "[INFO] Running pnpm build (to generate dist/index.js)"
        try {
            & pnpm build
        }
        catch {
            Write-Warning "pnpm build failed. Check Node toolchain and ensure pnpm install succeeded."
        }
    }
    finally {
        Pop-Location
    }
}

function Register-RelayTask([string]$repoRoot, [string]$token) {
    $taskName = "Clawdbot Browser Relay"
    $scriptPath = Join-Path $repoRoot "tools\voice-bridge\windows_setup\start-browser-relay.ps1"

    if (-not (Test-Path $scriptPath)) {
        throw "Missing start script: $scriptPath"
    }

    # Store token in a machine/user env var for the start script (avoid putting token in task args)
    [System.Environment]::SetEnvironmentVariable("CLAWDBOT_BROWSER_RELAY_TOKEN", $token, "User")
    Write-Output "[OK] Set user env var: CLAWDBOT_BROWSER_RELAY_TOKEN"

    # Try Scheduled Task first (best: restart on failure)
    try {
        # Recreate task to keep it idempotent
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
        }

        $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

        # Run as current user at logon (no admin required)
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
        Write-Output "[OK] Scheduled Task created: $taskName"
        return
    }
    catch {
        Write-Warning "Scheduled Task creation failed (access denied). Falling back to Startup folder."
    }

    # Fallback: Startup folder (no admin required)
    $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
    if (-not (Test-Path $startupDir)) {
        throw "Startup folder not found: $startupDir"
    }
    $cmdPath = Join-Path $startupDir "clawdbot-browser-relay.cmd"
    $cmd = "@echo off`r`n" +
      "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"" + $scriptPath + "`"`r`n"
    Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII
    Write-Output "[OK] Startup entry created: $cmdPath"
}

function Start-RelayTaskNow {
    $taskName = "Clawdbot Browser Relay"
    try {
        if ($NoStartNow) {
            Write-Output "[INFO] NoStartNow=true; not starting the task now"
            return
        }
        Start-ScheduledTask -TaskName $taskName | Out-Null
        Write-Output "[OK] Started task now: $taskName"
    }
    catch {
        Write-Warning "Could not start the task automatically. You can start it from Task Scheduler."
    }
}

function Print-NextSteps([string]$repoRoot) {
    Write-Output ""
    Write-Output "[NEXT] Validate relay is reachable:"
    Write-Output "  Invoke-WebRequest -Method Head http://127.0.0.1:18792/ | Select-Object StatusCode"
    Write-Output ""
    Write-Output "[INFO] Relay logs:"
    Write-Output "  $env:LOCALAPPDATA\\clawdbot-browser-relay\\relay.log"
    Write-Output ""
    Write-Output "[NEXT] Edge extension path (Load unpacked):"
    Write-Output "  $repoRoot\assets\chrome-extension"
    Write-Output ""
    Write-Output "[NEXT] Edge:"
    Write-Output "  1) edge://extensions"
    Write-Output "  2) Enable Developer mode"
    Write-Output "  3) Load unpacked -> select the path above"
    Write-Output "  4) Open Instagram tab and click the extension icon (badge shows ON)"
}

# Main
$repo = Get-RepoRoot
Require-Command "node"
Ensure-Pnpm

$envPath = Join-Path $repo ".env"
$token = Read-EnvValue $envPath "CLAWDBOT_GATEWAY_TOKEN"

Ensure-Dependencies $repo
Ensure-Build $repo
Register-RelayTask $repo $token
Start-RelayTaskNow
Print-NextSteps $repo

