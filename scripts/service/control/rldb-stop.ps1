param([string]$InstallRoot = "C:\RLDB")
$ErrorActionPreference = "Stop"
Set-Content -LiteralPath (Join-Path $InstallRoot "control\desired-state.txt") -Value "stopped" -Encoding ascii
Write-Host "RLDB candidate stop requested."
