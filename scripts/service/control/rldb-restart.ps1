param([string]$InstallRoot = "C:\RLDB")
$ErrorActionPreference = "Stop"
Set-Content -LiteralPath (Join-Path $InstallRoot "control\desired-state.txt") -Value "running" -Encoding ascii
Set-Content -LiteralPath (Join-Path $InstallRoot "control\restart.request") -Value ([guid]::NewGuid().ToString()) -Encoding ascii
Write-Host "RLDB candidate restart requested."
