param(
  [string]$TaskName = "RugbyLeagueStatsWeeklyRefresh",
  [string]$Day = "MON",
  [string]$Time = "04:00",
  [int]$Port = 8797,
  [string]$TunnelName = "rldb-backend"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot "scripts\refresh-hybrid-site.ps1"
$action = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Port $Port -TunnelName `"$TunnelName`""

schtasks /Create /F /SC WEEKLY /D $Day /TN $TaskName /TR $action /ST $Time
Write-Host "Scheduled task '$TaskName' created for $Day at $Time."
