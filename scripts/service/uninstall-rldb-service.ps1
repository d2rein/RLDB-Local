param(
  [string]$TaskName = "RLDB-Direct-Node-Supervisor",
  [switch]$RemoveApplication,
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this uninstaller from an elevated PowerShell window."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if ($RemoveApplication -and (Test-Path -LiteralPath "C:\RLDB\app")) {
  Remove-Item -LiteralPath "C:\RLDB\app" -Recurse -Force
}
if ($RemoveData -and (Test-Path -LiteralPath "C:\RLDB")) {
  $resolved = (Resolve-Path -LiteralPath "C:\RLDB").Path
  if ($resolved -ne "C:\RLDB") { throw "Refusing to delete unexpected path: $resolved" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

Write-Host "RLDB candidate task removed. Data was retained unless -RemoveData was supplied."
