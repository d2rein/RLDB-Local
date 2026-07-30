param([string]$InstallRoot = "C:\RLDB")
$ErrorActionPreference = "Stop"
Set-Content -LiteralPath (Join-Path $InstallRoot "control\desired-state.txt") -Value "running" -Encoding ascii
Write-Host "RLDB candidate start requested."
