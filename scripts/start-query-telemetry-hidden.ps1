param(
  [int]$Port = 8798
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeLogDirectory = Join-Path $projectRoot "runtime-logs"
$runtimeDataDirectory = Join-Path $projectRoot "runtime-data\telemetry"
$stdoutPath = Join-Path $runtimeLogDirectory "telemetry.out.log"
$stderrPath = Join-Path $runtimeLogDirectory "telemetry.err.log"
$databasePath = Join-Path $runtimeDataDirectory "query-performance.sqlite"

New-Item -ItemType Directory -Force -Path $runtimeLogDirectory, $runtimeDataDirectory | Out-Null

try {
  $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/health"
  if ($health.StatusCode -eq 200) {
    Write-Host "Query telemetry already healthy on port $Port."
    exit 0
  }
} catch {
  # A missing sidecar is expected on first installation or after a full stop.
}

$versionJson = & node (Join-Path $PSScriptRoot "runtime-version.mjs") $projectRoot
$version = $versionJson | ConvertFrom-Json
$oldValues = @{}
$telemetryEnvironment = @{
  RLDB_TELEMETRY_HOST = "127.0.0.1"
  RLDB_TELEMETRY_PORT = [string]$Port
  RLDB_TELEMETRY_DB_PATH = $databasePath
  RLDB_APPLICATION_VERSION = $version.applicationVersion
  RLDB_SCHEMA_VERSION = $version.schemaVersion
}
foreach ($key in $telemetryEnvironment.Keys) {
  $oldValues[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
  [Environment]::SetEnvironmentVariable($key, $telemetryEnvironment[$key], "Process")
}
try {
  $process = Start-Process -FilePath "node.exe" `
    -ArgumentList @(".\scripts\query-telemetry-server.mjs") `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru
} finally {
  foreach ($key in $telemetryEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($key, $oldValues[$key], "Process")
  }
}

Start-Sleep -Milliseconds 500
if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
  throw "Query telemetry exited during startup. Check $stderrPath."
}
Write-Host "Started hidden query telemetry on port $Port."
