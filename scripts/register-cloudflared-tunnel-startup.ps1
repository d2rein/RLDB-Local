param(
  [string]$TaskName = "RugbyLeagueStatsTunnel",
  [string]$TunnelName = "rldb-backend"
)

$ErrorActionPreference = "Stop"
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$action = New-ScheduledTaskAction -Execute $cloudflaredPath -Argument "tunnel run $TunnelName"
$trigger = New-ScheduledTaskTrigger -AtLogOn

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Force | Out-Null
Write-Host "Scheduled task '$TaskName' created."
