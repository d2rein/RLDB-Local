param(
  [string]$Root = "C:\RLDB"
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $Root "config\service.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Stage 3 service configuration not found: $configPath"
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$appRoot = [string]$config.appRoot
$dataRoot = [string]$config.dataRoot
$logRoot = [string]$config.logRoot
$runtimeRoot = [string]$config.runtimeRoot
$backendPort = [int]$config.backendPort
$telemetryPort = [int]$config.telemetryPort
$version = [string]$config.applicationVersion
$wranglerCli = Join-Path $appRoot "node_modules\wrangler\bin\wrangler.js"
$telemetryScript = Join-Path $appRoot "scripts\query-telemetry-server.mjs"
$stateDirectory = Join-Path $dataRoot "wrangler-state"
$telemetryDatabase = Join-Path $dataRoot "telemetry\query-performance.sqlite"
$controlDirectory = Join-Path $runtimeRoot "control"
$statusPath = Join-Path $runtimeRoot "service-status.json"
$serviceLogPath = Join-Path $logRoot "service-controller.log"

New-Item -ItemType Directory -Force -Path $logRoot, $runtimeRoot, $controlDirectory, (Split-Path -Parent $telemetryDatabase) | Out-Null

$backendProcess = $null
$telemetryProcess = $null
$desiredState = "running"
$consecutiveHealthFailures = 0
$healthFailureLimit = 8

function Write-ServiceLog([string]$Message) {
  $line = "{0} {1}" -f [datetime]::UtcNow.ToString("o"), $Message
  Add-Content -LiteralPath $serviceLogPath -Value $line -Encoding utf8
}

function Write-ServiceStatus([string]$State, [string]$Detail = "") {
  $payload = [ordered]@{
    checkedAtUtc = [datetime]::UtcNow.ToString("o")
    state = $State
    detail = $Detail
    desiredState = $desiredState
    controllerPid = $PID
    backendPid = if ($backendProcess) { $backendProcess.Id } else { $null }
    telemetryPid = if ($telemetryProcess) { $telemetryProcess.Id } else { $null }
    backendPort = $backendPort
    telemetryPort = $telemetryPort
    applicationVersion = $version
  } | ConvertTo-Json
  $temporaryPath = "$statusPath.tmp"
  Set-Content -LiteralPath $temporaryPath -Value $payload -Encoding utf8
  Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
}

function Test-ProcessAlive($Process) {
  if (-not $Process) { return $false }
  return $null -ne (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue)
}

function Stop-ProcessTree($Process) {
  if (-not (Test-ProcessAlive $Process)) { return }
  & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
}

function Test-HttpHealth([int]$Port, [string]$Path) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$Port$Path"
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-TcpListener([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $connection.AsyncWaitHandle.WaitOne(2000)) {
      return $false
    }
    $client.EndConnect($connection)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Start-Telemetry {
  if (Test-ProcessAlive $telemetryProcess) { return }
  $timestamp = [datetime]::UtcNow.ToString("yyyyMMdd-HHmmss")
  $stdoutPath = Join-Path $logRoot "telemetry-$timestamp.out.log"
  $stderrPath = Join-Path $logRoot "telemetry-$timestamp.err.log"
  $oldEnvironment = @{}
  $values = @{
    RLDB_TELEMETRY_HOST = "127.0.0.1"
    RLDB_TELEMETRY_PORT = [string]$telemetryPort
    RLDB_TELEMETRY_DB_PATH = $telemetryDatabase
    RLDB_APPLICATION_VERSION = $version
    RLDB_SCHEMA_VERSION = [string]$config.schemaVersion
  }
  foreach ($key in $values.Keys) {
    $oldEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $values[$key], "Process")
  }
  try {
    $script:telemetryProcess = Start-Process -FilePath "node.exe" `
      -ArgumentList @($telemetryScript) `
      -WorkingDirectory $appRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    foreach ($key in $oldEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $oldEnvironment[$key], "Process")
    }
  }
  Write-ServiceLog "Started telemetry PID $($telemetryProcess.Id) on 127.0.0.1:$telemetryPort."
}

function Start-Backend {
  if (Test-ProcessAlive $backendProcess) { return }
  $timestamp = [datetime]::UtcNow.ToString("yyyyMMdd-HHmmss")
  $stdoutPath = Join-Path $logRoot "backend-$timestamp.out.log"
  $stderrPath = Join-Path $logRoot "backend-$timestamp.err.log"
  $wranglerLogPath = Join-Path $logRoot "wrangler-$timestamp.log"
  $wranglerConfigRoot = Join-Path $runtimeRoot "xdg"
  New-Item -ItemType Directory -Force -Path $wranglerConfigRoot | Out-Null
  $oldEnvironment = @{}
  $values = @{
    CI = "1"
    XDG_CONFIG_HOME = $wranglerConfigRoot
    WRANGLER_LOG_PATH = $wranglerLogPath
  }
  foreach ($key in $values.Keys) {
    $oldEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $values[$key], "Process")
  }
  try {
    $script:backendProcess = Start-Process -FilePath "node.exe" `
      -ArgumentList @(
        $wranglerCli, "dev", "--env", "local", "--local",
        "--ip", "127.0.0.1", "--port", [string]$backendPort,
        "--persist-to", $stateDirectory
      ) `
      -WorkingDirectory $appRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    foreach ($key in $oldEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $oldEnvironment[$key], "Process")
    }
  }
  $script:consecutiveHealthFailures = 0
  Write-ServiceLog "Started backend PID $($backendProcess.Id) on 127.0.0.1:$backendPort."
}

function Stop-Children {
  Stop-ProcessTree $backendProcess
  Stop-ProcessTree $telemetryProcess
  $script:backendProcess = $null
  $script:telemetryProcess = $null
  $script:consecutiveHealthFailures = 0
}

function Handle-ControlRequests {
  $restartPath = Join-Path $controlDirectory "restart.request"
  $stopPath = Join-Path $controlDirectory "stop.request"
  $startPath = Join-Path $controlDirectory "start.request"

  if (Test-Path -LiteralPath $restartPath) {
    Remove-Item -LiteralPath $restartPath -Force
    $script:desiredState = "running"
    Write-ServiceLog "Restart requested by maintenance account."
    Write-ServiceStatus "restarting"
    Stop-Children
    Start-Sleep -Seconds 2
    return
  }
  if (Test-Path -LiteralPath $stopPath) {
    Remove-Item -LiteralPath $stopPath -Force
    $script:desiredState = "stopped"
    Write-ServiceLog "Stop requested by maintenance account."
    Stop-Children
    Write-ServiceStatus "stopped"
    return
  }
  if (Test-Path -LiteralPath $startPath) {
    Remove-Item -LiteralPath $startPath -Force
    $script:desiredState = "running"
    Write-ServiceLog "Start requested by maintenance account."
  }
}

if (-not (Test-Path -LiteralPath $wranglerCli)) {
  throw "Wrangler CLI not found in installed release: $wranglerCli"
}
if (-not (Test-Path -LiteralPath $telemetryScript)) {
  throw "Telemetry server not found in installed release: $telemetryScript"
}

Write-ServiceLog "Stage 3 controller starting as $([Environment]::UserName), version $version."
Write-ServiceStatus "starting"

try {
  while ($true) {
    Handle-ControlRequests

    if ($desiredState -eq "stopped") {
      Write-ServiceStatus "stopped"
      Start-Sleep -Seconds 5
      continue
    }

    if (-not (Test-ProcessAlive $telemetryProcess)) {
      Start-Telemetry
    }
    if (-not (Test-ProcessAlive $backendProcess)) {
      Start-Backend
      Write-ServiceStatus "starting" "Waiting for backend health."
    }

    # Wrangler handles requests serially. A long analytical query can queue an
    # HTTP health request even though the worker process and listening socket
    # are healthy, so use the local listener for restart decisions.
    if (Test-ProcessAlive $backendProcess -and (Test-TcpListener -Port $backendPort)) {
      $consecutiveHealthFailures = 0
      Write-ServiceStatus "running"
    } else {
      $consecutiveHealthFailures++
      Write-ServiceStatus "degraded" "Health failure $consecutiveHealthFailures of $healthFailureLimit."
      if ($consecutiveHealthFailures -ge $healthFailureLimit) {
        Write-ServiceLog "Backend failed $healthFailureLimit consecutive health checks; restarting it."
        Stop-ProcessTree $backendProcess
        $backendProcess = $null
        $consecutiveHealthFailures = 0
        Start-Sleep -Seconds 5
      }
    }

    # Keep health checks inexpensive while still handling maintenance commands
    # within five seconds.
    for ($waitCycle = 0; $waitCycle -lt 3; $waitCycle++) {
      Start-Sleep -Seconds 5
      Handle-ControlRequests
      if ($desiredState -eq "stopped") { break }
    }
  }
} finally {
  Write-ServiceLog "Stage 3 controller stopping."
  Stop-Children
  Write-ServiceStatus "stopped" "Controller exited."
}
