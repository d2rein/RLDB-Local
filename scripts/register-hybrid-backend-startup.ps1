param(
  [string]$TaskName = "RugbyLeagueStatsBackend",
  [int]$Port = 8797
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot "scripts\start-hybrid-backend-hidden.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Force | Out-Null
Write-Host "Scheduled task '$TaskName' created."
