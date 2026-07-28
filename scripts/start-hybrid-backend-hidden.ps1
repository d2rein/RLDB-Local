param(
  [int]$Port = 8797
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$userToken = [Environment]::GetEnvironmentVariable("LOCAL_API_TOKEN", "User")
$logDir = Join-Path $projectRoot "runtime-logs"
$stdoutPath = Join-Path $logDir "backend.out.log"
$stderrPath = Join-Path $logDir "backend.err.log"
$launchStatePath = Join-Path $logDir "backend-launch-state.json"
$localWranglerCli = Join-Path $projectRoot "node_modules\wrangler\bin\wrangler.js"
$globalWranglerCli = Join-Path $env:APPDATA "npm\node_modules\wrangler\wrangler-dist\cli.js"
$telemetryScript = Join-Path $projectRoot "scripts\start-query-telemetry-hidden.ps1"
$startupGraceSeconds = 180
$mutexName = "Local\RugbyLeagueStatsBackendStarter"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
  Write-Host "Backend starter already running."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($userToken)) {
  throw "LOCAL_API_TOKEN is not set in the user environment."
}

if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

& $telemetryScript -Port 8798

function Get-ListeningPid([int]$TargetPort) {
  $line = netstat -ano | Select-String -Pattern "127.0.0.1:$TargetPort\s+.*LISTENING\s+(\d+)" | Select-Object -First 1
  if ($null -eq $line) { return $null }
  $match = [regex]::Match($line.ToString(), "LISTENING\s+(\d+)")
  if (-not $match.Success) { return $null }
  return [int]$match.Groups[1].Value
}

function Test-BackendHealth([int]$TargetPort) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://127.0.0.1:$TargetPort/api/health"
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-RecentLaunchAgeSeconds([string]$StatePath) {
  if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    if (-not $raw.lastLaunchUtc) { return $null }
    $lastLaunch = [datetime]::Parse($raw.lastLaunchUtc)
    return [int]([datetime]::UtcNow - $lastLaunch.ToUniversalTime()).TotalSeconds
  } catch {
    return $null
  }
}

function Set-LaunchState([string]$StatePath, [string]$Status) {
  $payload = @{
    lastLaunchUtc = [datetime]::UtcNow.ToString("o")
    status = $Status
  } | ConvertTo-Json -Compress
  $payload | Set-Content -LiteralPath $StatePath -Encoding ascii
}

function Get-ProjectBackendProcesses([string]$RootPath, [int]$TargetPort) {
  $rootNeedle = $RootPath.ToLowerInvariant()
  Get-CimInstance Win32_Process | Where-Object {
    $name = $_.Name
    if ($name -notin @("node.exe", "workerd.exe", "esbuild.exe", "powershell.exe")) { return $false }
    $cmd = [string]$_.CommandLine
    $exe = [string]$_.ExecutablePath
    $cmdLower = $cmd.ToLowerInvariant()
    $exeLower = $exe.ToLowerInvariant()
    return $cmdLower.Contains($rootNeedle) `
      -or $exeLower.Contains($rootNeedle) `
      -or $cmdLower.Contains("wrangler.js dev --env local --local --ip 127.0.0.1 --port $TargetPort") `
      -or $exeLower.Contains("\@cloudflare\workerd-windows-64\bin\workerd.exe") `
      -or $exeLower.Contains("\@esbuild\win32-x64\esbuild.exe")
  }
}

function Test-BackendLaunchInProgress([string]$RootPath, [int]$TargetPort) {
  $rootNeedle = $RootPath.ToLowerInvariant()
  $portNeedle = "--port $TargetPort"
  $process = Get-CimInstance Win32_Process | Where-Object {
    if ($_.Name -ne "node.exe") { return $false }
    $commandLine = ([string]$_.CommandLine).ToLowerInvariant()
    return $commandLine.Contains($rootNeedle) `
      -and $commandLine.Contains("wrangler") `
      -and $commandLine.Contains(" dev ") `
      -and $commandLine.Contains($portNeedle)
  } | Select-Object -First 1
  return $null -ne $process
}

function Stop-ProjectBackendProcesses([string]$RootPath, [int]$TargetPort) {
  $currentPid = $PID
  $processes = Get-ProjectBackendProcesses -RootPath $RootPath -TargetPort $TargetPort |
    Where-Object { $_.ProcessId -ne $currentPid } |
    Sort-Object ProcessId -Unique

  foreach ($process in $processes) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      # Ignore if already gone or protected by ownership; next cycle can retry.
    }
  }
}

$recentLaunchAgeSeconds = Get-RecentLaunchAgeSeconds -StatePath $launchStatePath
$existingPid = Get-ListeningPid -TargetPort $Port
if ($null -ne $existingPid) {
  if (Test-BackendHealth -TargetPort $Port) {
    Write-Host "Backend already listening and healthy on port $Port."
    exit 0
  }

  if ($null -ne $recentLaunchAgeSeconds -and $recentLaunchAgeSeconds -lt $startupGraceSeconds) {
    Write-Host "Backend is still within its startup grace period. Leaving process $existingPid running."
    exit 0
  }

  Write-Host "Backend listener on port $Port is unhealthy. Restarting process $existingPid."
  Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

if (
  $null -ne $recentLaunchAgeSeconds `
  -and $recentLaunchAgeSeconds -lt $startupGraceSeconds `
  -and (Test-BackendLaunchInProgress -RootPath $projectRoot -TargetPort $Port)
) {
  Write-Host "Recent backend launch detected $recentLaunchAgeSeconds second(s) ago. Waiting before relaunch."
  exit 0
}

Stop-ProjectBackendProcesses -RootPath $projectRoot -TargetPort $Port

$wranglerCli = if (Test-Path -LiteralPath $localWranglerCli) { $localWranglerCli } else { $globalWranglerCli }
if (-not (Test-Path -LiteralPath $wranglerCli)) {
  throw "Wrangler CLI not found."
}

$env:CI = "1"
Set-LaunchState -StatePath $launchStatePath -Status "starting"
Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -Command `"Set-Location '$projectRoot'; `$env:CI='1'; node '$wranglerCli' dev --env local --local --ip 127.0.0.1 --port $Port`"" `
  -WindowStyle Hidden `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath

Write-Host "Started hidden backend on port $Port."
$mutex.ReleaseMutex() | Out-Null
