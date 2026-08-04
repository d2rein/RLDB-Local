param([string]$InstallRoot = "C:\RLDB")
$ErrorActionPreference = "Stop"
$controlRoot = Join-Path $InstallRoot "control"
$requestPath = Join-Path $controlRoot "update.request"
Set-Content -LiteralPath $requestPath -Value ([DateTime]::UtcNow.ToString("o")) -Encoding ascii
Write-Host "Candidate weekly update requested. The live database stays online while staging is prepared."
Write-Host "Run .\rldb-status.ps1 to inspect progress."
