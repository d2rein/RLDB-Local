param(
  [string]$Root = "C:\RLDB"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $Root "config\service.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Stage 3 service configuration not found: $configPath"
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
& (Join-Path ([string]$config.appRoot) "scripts\stage3\run-rldb-service.ps1") -Root $Root
