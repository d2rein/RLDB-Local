param(
  [int]$Port = 8797,
  [string]$TunnelName = "rldb-backend"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$startupFolder = [Environment]::GetFolderPath("Startup")
$backendScript = Join-Path $projectRoot "scripts\start-hybrid-backend-hidden.ps1"
$tunnelScript = Join-Path $projectRoot "scripts\start-cloudflared-tunnel-hidden.ps1"
$watchdogScript = Join-Path $projectRoot "scripts\start-hybrid-watchdog-hidden.ps1"

$backendLauncherPath = Join-Path $startupFolder "RugbyLeagueStatsBackend.vbs"
$tunnelLauncherPath = Join-Path $startupFolder "RugbyLeagueStatsTunnel.vbs"
$watchdogLauncherPath = Join-Path $startupFolder "RugbyLeagueStatsWatchdog.vbs"

$backendCommand = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$backendScript"" -Port $Port"
$tunnelCommand = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$tunnelScript"" -TunnelName " + $TunnelName
$watchdogCommand = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$watchdogScript"" -Port $Port -TunnelName " + $TunnelName

$backendCommandVbs = $backendCommand.Replace('"', '""')
$tunnelCommandVbs = $tunnelCommand.Replace('"', '""')
$watchdogCommandVbs = $watchdogCommand.Replace('"', '""')

$backendLauncher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "$backendCommandVbs", 0, False
"@

$tunnelLauncher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "$tunnelCommandVbs", 0, False
"@

$watchdogLauncher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "$watchdogCommandVbs", 0, False
"@

$backendLauncher | Set-Content -LiteralPath $backendLauncherPath -Encoding ascii
$tunnelLauncher | Set-Content -LiteralPath $tunnelLauncherPath -Encoding ascii
$watchdogLauncher | Set-Content -LiteralPath $watchdogLauncherPath -Encoding ascii

Write-Host "Startup launchers written to $startupFolder"
