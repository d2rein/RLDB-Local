param(
  [string]$InstallRoot = "C:\RLDB"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $InstallRoot "config\service.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "RLDB service configuration is missing: $configPath"
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
& ([string]$config.nodePath) (Join-Path $InstallRoot "service\supervisor.mjs") $configPath
exit $LASTEXITCODE
