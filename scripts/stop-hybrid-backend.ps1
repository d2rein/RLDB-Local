param(
  [int]$Port = 8797,
  [switch]$IncludeTunnel,
  [switch]$IncludeWatchdog
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

function Get-ProjectProcesses([string]$RootPath, [int]$TargetPort) {
  $rootNeedle = $RootPath.ToLowerInvariant()
  Get-CimInstance Win32_Process | Where-Object {
    $name = $_.Name
    if ($name -notin @("node.exe", "workerd.exe", "esbuild.exe", "powershell.exe", "cloudflared.exe")) { return $false }
    $cmd = [string]$_.CommandLine
    $exe = [string]$_.ExecutablePath
    $cmdLower = $cmd.ToLowerInvariant()
    $exeLower = $exe.ToLowerInvariant()
    return $cmdLower.Contains($rootNeedle) `
      -or $exeLower.Contains($rootNeedle) `
      -or $cmdLower.Contains("wrangler.js dev --env local --local --ip 127.0.0.1 --port $TargetPort") `
      -or $exeLower.Contains("\@cloudflare\workerd-windows-64\bin\workerd.exe") `
      -or $exeLower.Contains("\@esbuild\win32-x64\esbuild.exe") `
      -or $cmdLower.Contains("cloudflared.exe tunnel run")
  }
}

function Stop-Processes($Processes) {
  $currentPid = $PID
  $stopped = 0
  $processList = @($Processes) | Where-Object { $null -ne $_ }
  foreach ($process in ($processList | Where-Object { $_.ProcessId -ne $currentPid } | Sort-Object ProcessId -Unique)) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      $stopped += 1
    } catch {
      # Ignore already-gone or protected processes.
    }
  }
  return $stopped
}

$allProcesses = @(Get-ProjectProcesses -RootPath $projectRoot -TargetPort $Port)

$backendProcesses = $allProcesses | Where-Object {
  $_.Name -ne "cloudflared.exe" -and (
    ([string]$_.CommandLine).ToLowerInvariant().Contains("wrangler.js dev --env local --local --ip 127.0.0.1 --port $Port") `
    -or ([string]$_.ExecutablePath).ToLowerInvariant().Contains("\@cloudflare\workerd-windows-64\bin\workerd.exe") `
    -or ([string]$_.ExecutablePath).ToLowerInvariant().Contains("\@esbuild\win32-x64\esbuild.exe") `
    -or ([string]$_.CommandLine).ToLowerInvariant().Contains($projectRoot.ToLowerInvariant())
  )
}

$watchdogProcesses = $allProcesses | Where-Object {
  ([string]$_.CommandLine).ToLowerInvariant().Contains("start-hybrid-watchdog-hidden.ps1")
}

$tunnelProcesses = $allProcesses | Where-Object {
  $_.Name -eq "cloudflared.exe" -or ([string]$_.CommandLine).ToLowerInvariant().Contains("start-cloudflared-tunnel-hidden.ps1")
}

$stoppedWatchdog = 0
$stoppedBackend = 0
$stoppedTunnel = 0

if ($IncludeWatchdog) {
  $stoppedWatchdog = Stop-Processes -Processes $watchdogProcesses
}

$stoppedBackend = Stop-Processes -Processes $backendProcesses

if ($IncludeTunnel) {
  $stoppedTunnel = Stop-Processes -Processes $tunnelProcesses
}

Start-Sleep -Seconds 2

Write-Host "Stopped backend-related processes: $stoppedBackend"
if ($IncludeWatchdog) {
  Write-Host "Stopped watchdog processes: $stoppedWatchdog"
}
if ($IncludeTunnel) {
  Write-Host "Stopped tunnel processes: $stoppedTunnel"
}
