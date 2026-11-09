#Requires -Version 5.1
<#
  One-shot local setup for the StriideAi local lab on Windows.

  Run from the project root (the folder that contains package.json):
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1

  What it does (safe to run again):
    1. Checks Node 22.13+, npm, ffmpeg, ffprobe, git and Docker Desktop.
    2. Creates .env from .env.example if missing: generates a local FalkorDB password (never printed)
       and sets the Claude-folder Docker project name and ports (docs/07). API keys stay blank for you.
    3. Creates config.local.yaml from config.example.yaml if missing: server port 8788, videos in .\videos.
    4. npm ci, then starts FalkorDB, imports and verifies the ontology.
    5. Runs the offline build and tests, then doctor (doctor reports missing keys until you add them).

  Options: -SkipDocker (no database steps), -SkipTests (skip npm run build / npm test).
#>
[CmdletBinding()]
param([switch]$SkipDocker, [switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Step([string]$Message) { Write-Host ""; Write-Host "== $Message" -ForegroundColor Cyan }
function Info([string]$Message) { Write-Host "   $Message" }
function Warn([string]$Message) { Write-Host "   WARNING: $Message" -ForegroundColor Yellow }
function Need([string]$Command, [string]$Hint) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) { throw "$Command was not found on PATH. $Hint" }
}
function Run([string]$Label, [scriptblock]$Block) {
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE). See the output above." }
}
function Set-EnvLine([string]$Text, [string]$Key, [string]$Value) {
  $pattern = "(?m)^" + [regex]::Escape($Key) + "=[^\r\n]*"
  if ([regex]::IsMatch($Text, $pattern)) { return [regex]::Replace($Text, $pattern, ($Key + '=' + $Value).Replace('$', '$$')) }
  return $Text.TrimEnd() + "`r`n" + $Key + '=' + $Value + "`r`n"
}
function Get-EnvValue([string]$Text, [string]$Key) {
  $m = [regex]::Match($Text, "(?m)^" + [regex]::Escape($Key) + "=([^\r\n]*)")
  if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return $null }
}

Write-Host "StriideAi local lab setup" -ForegroundColor Green
Info "Project root: $Root"
if ($Root -match 'OneDrive') {
  Warn "This folder is inside OneDrive. It works, but OneDrive will sync node_modules (several hundred MB),"
  Warn "videos and run outputs, and can briefly lock files (including runs\lab.sqlite) while syncing."
  Warn "Recommended: right-click the folder > 'Always keep on this device', and pause syncing during analysis runs."
}

Step "1/5 Checking prerequisites"
Need node 'Install Node.js 22 LTS: winget install OpenJS.NodeJS.LTS (then open a new terminal).'
$nodeVersion = (& node -p "process.versions.node").Trim()
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) { throw "Node $nodeVersion found; 22.13 or newer is required." }
Info "Node $nodeVersion"
Need npm 'npm is installed with Node.js.'
Need ffmpeg 'Install FFmpeg: winget install Gyan.FFmpeg (then open a new terminal).'
Need ffprobe 'ffprobe is installed with FFmpeg: winget install Gyan.FFmpeg.'
Info ((& ffmpeg -hide_banner -version | Select-Object -First 1))
$encoders = (& ffmpeg -hide_banner -encoders) -join "`n"
if ($encoders -notmatch 'libx264') { throw 'This ffmpeg build has no libx264 encoder. Install the full build: winget install Gyan.FFmpeg' }
Need git 'Install Git: winget install Git.Git'
if (-not $SkipDocker) {
  Need docker 'Install Docker Desktop (winget install Docker.DockerDesktop) and start it.'
  # Windows PowerShell turns redirected stderr into errors under 'Stop'; relax it for this probe only.
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prev
  if (-not $dockerOk) { throw 'Docker Desktop is not running. Start it, wait until it says "Engine running", then run this script again.' }
  Info 'Docker Desktop is running'
}

Step "2/5 Local configuration (.env and config.local.yaml)"
$envPath = Join-Path $Root '.env'
if (-not (Test-Path $envPath)) { Copy-Item (Join-Path $Root '.env.example') $envPath; Info 'Created .env from .env.example' } else { Info '.env already exists; only empty or default values are filled in' }
$envText = [System.IO.File]::ReadAllText($envPath)
if (-not (Get-EnvValue $envText 'FALKORDB_PASSWORD')) {
  $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.ToCharArray()
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  $password = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
  $envText = Set-EnvLine $envText 'FALKORDB_PASSWORD' $password
  $password = $null
  Info 'Generated a local FalkorDB password (stored in .env, not printed)'
}
# Claude comparison folder values from docs/07 (only replaces the shared defaults).
if ((Get-EnvValue $envText 'COMPOSE_PROJECT_NAME') -in @($null, '', 'striideai-local-lab')) { $envText = Set-EnvLine $envText 'COMPOSE_PROJECT_NAME' 'striideai-claude-lab' }
if ((Get-EnvValue $envText 'FALKORDB_PORT') -in @($null, '', '6379')) { $envText = Set-EnvLine $envText 'FALKORDB_PORT' '6380' }
if ((Get-EnvValue $envText 'FALKORDB_BROWSER_PORT') -in @($null, '', '3000')) { $envText = Set-EnvLine $envText 'FALKORDB_BROWSER_PORT' '3001' }
[System.IO.File]::WriteAllText($envPath, $envText, $Utf8NoBom)
Info 'Docker project striideai-claude-lab, FalkorDB on 127.0.0.1:6380, browser on 127.0.0.1:3001'
$missing = @('TWELVE_LABS_API_KEY', 'GEMINI_API_KEY', 'GEMINI_PLANNER_MODEL', 'GEMINI_INSPECTOR_MODEL') | Where-Object { -not (Get-EnvValue $envText $_) }
$envText = $null

$cfgPath = Join-Path $Root 'config.local.yaml'
if (-not (Test-Path $cfgPath)) {
  $cfg = [System.IO.File]::ReadAllText((Join-Path $Root 'config.example.yaml'))
  $cfg = [regex]::Replace($cfg, '(?m)^  port: 8787[ \t]*$', '  port: 8788')
  $cfg = [regex]::Replace($cfg, '(?m)^  input_root: .*$', '  input_root: ./videos')
  [System.IO.File]::WriteAllText($cfgPath, $cfg, $Utf8NoBom)
  Info 'Created config.local.yaml (UI port 8788, videos folder .\videos, runs folder .\runs)'
} else { Info 'config.local.yaml already exists; left unchanged' }
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'videos') | Out-Null
Info "Put your clips in: $(Join-Path $Root 'videos')"

Step "3/5 Installing pinned dependencies (npm ci)"
Run 'npm ci' { npm ci --no-audit --no-fund }

if (-not $SkipDocker) {
  Step "4/5 FalkorDB: start, import and verify the ontology"
  Run 'FalkorDB start' { node bootstrap/falkordb.mjs up }
  Run 'Ontology import' { npm run ontology:import -- --config config.local.yaml }
  Run 'Ontology verify' { node bootstrap/falkordb.mjs verify }
} else { Step "4/5 Skipped database steps (-SkipDocker)" }

if (-not $SkipTests) {
  Step "5/5 Offline checks (no provider calls)"
  Run 'Build' { npm run build }
  Run 'Supplied telemetry tests' { npm run test:reference }
  if ($SkipDocker) { Warn 'Ontology, pipeline and UI tests skip themselves without the database.' }
  Run 'Test suite' { npm test }
} else { Step "5/5 Skipped offline checks (-SkipTests)" }

Step "Doctor"
& npm run doctor -- --config config.local.yaml
$doctorExit = $LASTEXITCODE

Write-Host ""
Write-Host "Setup finished." -ForegroundColor Green
if ($missing.Count -gt 0) {
  Write-Host "Next: add these to .env (notepad .env), then run doctor again:" -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "   - $_" }
} elseif ($doctorExit -ne 0) {
  Write-Host 'Doctor reported a failure; see the FAIL lines above.' -ForegroundColor Yellow
}
Write-Host "Then (billable) live check:  npm run provider:smoke -- --config config.local.yaml --yes"
Write-Host "Analyse a clip:              npm run analyse -- --config config.local.yaml --video videos\clip.mp4"
Write-Host "UI:                          npm run ui -- --config config.local.yaml   (http://127.0.0.1:8788/)"
