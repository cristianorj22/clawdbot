<# 
  docker-setup.ps1
  Setup/maintenance helper for Docker Compose on Windows (PowerShell).

  Goals:
  - Simple "one command" flows for up/down/rebuild/logs/cli.
  - Keep your existing compat compose service names (clawdbot-*).
  - DO NOT modify or overwrite .env automatically.

  Examples:
    .\docker-setup.ps1 up
    .\docker-setup.ps1 rebuild
    .\docker-setup.ps1 up -IncludeVoiceBridge
    .\docker-setup.ps1 logs -Service clawdbot-gateway
    .\docker-setup.ps1 cli -- channels status --probe
#>

[CmdletBinding(PositionalBinding = $true)]
param(
  [Parameter(Position = 0)]
  [ValidateSet("up", "down", "rebuild", "ps", "logs", "cli")]
  [string]$Action = "up",

  [switch]$IncludeVoiceBridge,
  [switch]$IncludeBrowserServe,

  [string]$Service = "clawdbot-gateway",
  [int]$Tail = 120,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Dependência ausente: '$Name'. Instale e tente novamente."
  }
}

function Get-RepoRoot() {
  return (Resolve-Path -LiteralPath $PSScriptRoot).Path
}

function Compose-Files([string]$RepoRoot) {
  $files = @(
    (Join-Path $RepoRoot "docker-compose.yml")
  )

  if ($IncludeVoiceBridge) {
    $files += (Join-Path $RepoRoot "docker-compose.voice-bridge.yml")
  }

  if ($IncludeBrowserServe) {
    $files += (Join-Path $RepoRoot "docker-compose.browser-serve.yml")
  }

  foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath $f)) {
      throw "Arquivo compose não encontrado: $f"
    }
  }

  return $files
}

function Compose-Args([string[]]$Files) {
  $args = @()
  foreach ($f in $Files) {
    $args += @("-f", $f)
  }
  return $args
}

function Ensure-DockerCompose() {
  Require-Command "docker"
  & docker compose version *> $null
}

function Ensure-EnvFile([string]$RepoRoot) {
  $envPath = Join-Path $RepoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Warning "Arquivo .env não encontrado em '$RepoRoot'."
    Write-Warning "O Docker Compose pode subir, mas você provavelmente vai precisar setar chaves (ex.: CLAWDBOT_GATEWAY_TOKEN, OPENAI_API_KEY, BRAVE_API_KEY, ELEVENLABS_API_KEY)."
    Write-Warning "Se quiser, copie '.env.example' para '.env' e preencha os valores."
  }
}

function Run-Compose([string[]]$ComposeArgs, [string[]]$CmdArgs) {
  $full = @("compose") + $ComposeArgs + $CmdArgs
  & docker @full
  if ($LASTEXITCODE -ne 0) {
    throw "Falhou: docker $($full -join ' ')"
  }
}

$repoRoot = Get-RepoRoot
Ensure-DockerCompose
Ensure-EnvFile $repoRoot

$composeFiles = Compose-Files $repoRoot
$composeArgs = Compose-Args $composeFiles

switch ($Action) {
  "ps" {
    Run-Compose $composeArgs @("ps", "-a")
    break
  }

  "logs" {
    Run-Compose $composeArgs @("logs", "--tail", "$Tail", "$Service")
    break
  }

  "down" {
    Run-Compose $composeArgs @("down", "--remove-orphans")
    break
  }

  "up" {
    # Default: bring up long-running services only.
    # Note: clawdbot-cli is a one-shot container (prints help and exits) unless you run it via "cli".
    if ($IncludeVoiceBridge) {
      Run-Compose $composeArgs @("up", "-d", "clawdbot-gateway", "voice-router")
    } else {
      Run-Compose $composeArgs @("up", "-d", "clawdbot-gateway")
    }
    break
  }

  "rebuild" {
    Run-Compose $composeArgs @("down", "--remove-orphans")
    Run-Compose $composeArgs @("build", "--pull")
    if ($IncludeVoiceBridge) {
      Run-Compose $composeArgs @("up", "-d", "clawdbot-gateway", "voice-router")
    } else {
      Run-Compose $composeArgs @("up", "-d", "clawdbot-gateway")
    }
    break
  }

  "cli" {
    if (-not $Args -or $Args.Length -eq 0) {
      throw "Uso: .\docker-setup.ps1 cli -- <args do CLI>. Ex: .\docker-setup.ps1 cli -- channels status --probe"
    }

    # Run the CLI container on-demand with an interactive TTY.
    # PowerShell note: we keep args after "--" as-is.
    Run-Compose $composeArgs (@("run", "--rm", "-it", "clawdbot-cli", "--") + $Args)
    break
  }
}

