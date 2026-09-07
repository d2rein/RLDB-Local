param(
  [string]$RuntimeRoot = "C:\Users\d2rei\My_Site\rldb-direct-node-runtime",
  [int]$BackendPort = 8899,
  [int]$TelemetryPort = 8890
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$databasePath = Join-Path $RuntimeRoot "data\rldb.sqlite"
$telemetryDatabasePath = Join-Path $RuntimeRoot "telemetry\query-performance.sqlite"
$logRoot = Join-Path $RuntimeRoot "logs"
$pidRoot = Join-Path $RuntimeRoot "runtime"

if ($BackendPort -in @(8797, 8798) -or $TelemetryPort -in @(8797, 8798)) {
  throw "Development controls refuse to use production ports 8797 or 8798."
}
if (-not (Test-Path -LiteralPath $databasePath)) {
  throw "Independent development database not found: $databasePath"
}

& node.exe (Join-Path $projectRoot "scripts\apply-application-migrations.mjs") $databasePath

New-Item -ItemType Directory -Force -Path $logRoot, $pidRoot, (Split-Path -Parent $telemetryDatabasePath) | Out-Null

function Get-ListeningPid([int]$Port) {
  $line = netstat -ano | Select-String -Pattern "127\.0\.0\.1:$Port\s+.*LISTENING\s+(\d+)" | Select-Object -First 1
  if (-not $line) { return $null }
  $match = [regex]::Match($line.Line, "LISTENING\s+(\d+)")
  if (-not $match.Success) { return $null }
  return [int]$match.Groups[1].Value
}

function Start-IsolatedNodeProcess(
  [string]$Script,
  [hashtable]$Environment,
  [string]$StdoutPath,
  [string]$StderrPath
) {
  $oldValues = @{}
  foreach ($key in $Environment.Keys) {
    $oldValues[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], "Process")
  }
  try {
    return Start-Process -FilePath "node.exe" `
      -ArgumentList @($Script) `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru
  } finally {
    foreach ($key in $oldValues.Keys) {
      [Environment]::SetEnvironmentVariable($key, $oldValues[$key], "Process")
    }
  }
}

$telemetryPid = Get-ListeningPid -Port $TelemetryPort
if (-not $telemetryPid) {
  $telemetryProcess = Start-IsolatedNodeProcess `
    -Script (Join-Path $projectRoot "scripts\query-telemetry-server.mjs") `
    -Environment @{
      RLDB_TELEMETRY_HOST = "127.0.0.1"
      RLDB_TELEMETRY_PORT = $TelemetryPort
      RLDB_TELEMETRY_DB_PATH = $telemetryDatabasePath
      RLDB_APPLICATION_VERSION = "direct-node-development"
      RLDB_SCHEMA_VERSION = "0011_query_covering_indexes"
    } `
    -StdoutPath (Join-Path $logRoot "telemetry.out.log") `
    -StderrPath (Join-Path $logRoot "telemetry.err.log")
  $telemetryProcess.Id | Set-Content -LiteralPath (Join-Path $pidRoot "telemetry.pid") -Encoding ascii
}

$backendPid = Get-ListeningPid -Port $BackendPort
if (-not $backendPid) {
  $backendProcess = Start-IsolatedNodeProcess `
    -Script (Join-Path $projectRoot "dist\server.mjs") `
    -Environment @{
      RLDB_HOST = "127.0.0.1"
      RLDB_PORT = $BackendPort
      RLDB_DATABASE_PATH = $databasePath
      TELEMETRY_ENDPOINT = "http://127.0.0.1:$TelemetryPort/events"
      RLDB_APPLICATION_VERSION = "direct-node-development"
      RLDB_SCHEMA_VERSION = "0011_query_covering_indexes"
      RLDB_RUNTIME_MODE = "development"
    } `
    -StdoutPath (Join-Path $logRoot "backend.out.log") `
    -StderrPath (Join-Path $logRoot "backend.err.log")
  $backendProcess.Id | Set-Content -LiteralPath (Join-Path $pidRoot "backend.pid") -Encoding ascii
}

Start-Sleep -Seconds 2
& (Join-Path $PSScriptRoot "status-development.ps1") `
  -RuntimeRoot $RuntimeRoot `
  -BackendPort $BackendPort `
  -TelemetryPort $TelemetryPort
