param(
  [string]$SourceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$SeedDatabase = "C:\Users\d2rei\My_Site\rldb-direct-node-runtime\data\rldb.sqlite",
  [string]$SeedUpdateDataRoot = "C:\Users\d2rei\My_Site\rugby-league-stats-db-local\docs\NRL-Data-main_duplicate\data",
  [string]$InstallRoot = "C:\RLDB",
  [string]$ServiceUser = "$env:COMPUTERNAME\rldbsvc",
  [string]$ControlUser = "$env:COMPUTERNAME\d2rei",
  [string]$TaskName = "RLDB-Direct-Node-Supervisor",
  [int]$BackendPort = 8899,
  [int]$TelemetryPort = 8890,
  [ValidateRange(16, 1024)]
  [int]$SqliteCacheMiB = 256,
  [ValidateRange(0, 2047)]
  [int]$SqliteMmapMiB = 0,
  [string]$CandidateTunnelId = "",
  [string]$CandidateTunnelHostname = "",
  [string]$CandidateTunnelCredentialsPath = "",
  [string]$CloudflaredSourcePath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this installer from an elevated PowerShell window."
}

function New-CryptographicRandomBytes([int]$Length) {
  $bytes = New-Object byte[] $Length
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return $bytes
}

function Get-Sha256Hex([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

if ($BackendPort -in @(8797, 8798) -or $TelemetryPort -in @(8797, 8798)) {
  throw "The candidate cannot use operational ports 8797 or 8798."
}
$serviceAccountName = $ServiceUser.Split("\")[-1]
$serviceAccount = Get-LocalUser -Name $serviceAccountName -ErrorAction SilentlyContinue
if (-not $serviceAccount) {
  throw "Service account does not exist: $ServiceUser"
}
if (-not (Test-Path -LiteralPath $SeedDatabase)) {
  throw "Seed database not found: $SeedDatabase"
}

$production = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "http://127.0.0.1:8797/api/health"
if ($production.StatusCode -ne 200) {
  throw "Operational health check failed before installation."
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$buildScript = Join-Path $SourceRoot "scripts\build.mjs"
if (-not (Test-Path -LiteralPath $buildScript)) {
  throw "Candidate build script not found: $buildScript"
}

Write-Host "Building candidate release..."
& $nodePath $buildScript
if ($LASTEXITCODE -ne 0) {
  throw "Candidate build failed with exit code $LASTEXITCODE. Installation was not attempted."
}
foreach ($outputName in @("server.mjs", "request-worker.mjs")) {
  $outputPath = Join-Path $SourceRoot "dist\$outputName"
  if (-not (Test-Path -LiteralPath $outputPath)) {
    throw "Candidate build did not produce required output: $outputPath"
  }
}

$gitCommit = (& git -c "safe.directory=$SourceRoot" -C $SourceRoot rev-parse HEAD).Trim()
if (-not $gitCommit) { throw "Unable to determine candidate Git commit." }
$gitDirty = [bool](& git -c "safe.directory=$SourceRoot" -C $SourceRoot status --porcelain)
$applicationVersion = "$gitCommit-$(if ($gitDirty) { 'dirty' } else { 'clean' })"
$releaseRoot = Join-Path $InstallRoot "app\releases\$gitCommit"
$paths = @{
  App = Join-Path $InstallRoot "app"
  Release = $releaseRoot
  Data = Join-Path $InstallRoot "data"
  Logs = Join-Path $InstallRoot "logs"
  Runtime = Join-Path $InstallRoot "runtime"
  Telemetry = Join-Path $InstallRoot "telemetry"
  Backups = Join-Path $InstallRoot "backups"
  Control = Join-Path $InstallRoot "control"
  Config = Join-Path $InstallRoot "config"
  Bin = Join-Path $InstallRoot "bin"
  Service = Join-Path $InstallRoot "service"
  UpdateData = Join-Path $InstallRoot "update-data"
}
foreach ($directoryPath in $paths.Values) {
  New-Item -ItemType Directory -Force -Path ([string]$directoryPath) | Out-Null
}

Write-Host "Installing release $gitCommit..."
foreach ($releaseDirectory in @("dist", "scripts", "scripts\update", "migrations\telemetry", "migrations\application")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $releaseRoot $releaseDirectory) | Out-Null
}
Copy-Item -LiteralPath (Join-Path $SourceRoot "dist\server.mjs") -Destination (Join-Path $releaseRoot "dist\server.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "dist\request-worker.mjs") -Destination (Join-Path $releaseRoot "dist\request-worker.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\query-telemetry-server.mjs") -Destination (Join-Path $releaseRoot "scripts\query-telemetry-server.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\report-query-telemetry.mjs") -Destination (Join-Path $releaseRoot "scripts\report-query-telemetry.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\apply-application-migrations.mjs") -Destination (Join-Path $releaseRoot "scripts\apply-application-migrations.mjs") -Force
Copy-Item -Path (Join-Path $SourceRoot "scripts\update\*.mjs") -Destination (Join-Path $releaseRoot "scripts\update") -Force
Copy-Item -Path (Join-Path $SourceRoot "migrations\telemetry\*.sql") -Destination (Join-Path $releaseRoot "migrations\telemetry") -Force
Copy-Item -Path (Join-Path $SourceRoot "migrations\application\*.sql") -Destination (Join-Path $releaseRoot "migrations\application") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\service\supervisor.mjs") -Destination (Join-Path $paths.Service "supervisor.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\service\run-supervisor.ps1") -Destination (Join-Path $paths.Service "run-supervisor.ps1") -Force
Copy-Item -Path (Join-Path $SourceRoot "scripts\service\control\*.ps1") -Destination $paths.Control -Force

$databasePath = Join-Path $paths.Data "rldb.sqlite"
if (-not (Test-Path -LiteralPath $databasePath)) {
  Write-Host "Seeding independent database. This 2.3 GB copy can take several minutes..."
  Copy-Item -LiteralPath $SeedDatabase -Destination $databasePath
}

foreach ($competition in @("NRL", "NRLW")) {
  $sourceDirectory = Join-Path $SeedUpdateDataRoot "$competition\2026"
  $destinationDirectory = Join-Path $paths.UpdateData "$competition\2026"
  if (-not (Test-Path -LiteralPath $destinationDirectory)) {
    if (-not (Test-Path -LiteralPath $sourceDirectory)) {
      throw "Initial updater source data not found: $sourceDirectory"
    }
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceDirectory "${competition}_data_2026.json") -Destination $destinationDirectory
    Copy-Item -LiteralPath (Join-Path $sourceDirectory "${competition}_detailed_match_data_2026.json") -Destination $destinationDirectory
    Copy-Item -LiteralPath (Join-Path $sourceDirectory "${competition}_player_statistics_2026.json") -Destination $destinationDirectory
  }
}

# DatabaseSync.close() can wait indefinitely when the running candidate still
# owns SQLite resources. Quiesce only the candidate before applying migrations;
# the operational service on 8797 remains untouched.
$candidateQuiescedForMigration = $false
$existingTaskBeforeMigration = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$legacyCandidateTasks = @(Get-ScheduledTask -TaskName "RLDBCandidateSupervisor" -ErrorAction SilentlyContinue)
$candidateListenerBeforeMigration = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
if ($existingTaskBeforeMigration -or $legacyCandidateTasks.Count -gt 0 -or $candidateListenerBeforeMigration) {
  Write-Host "Stopping the existing candidate before database migrations..."
  # Ask the supervisor to close SQLite and its children before stopping the
  # scheduled-task host. Stopping the host first can orphan Node processes.
  Set-Content -LiteralPath (Join-Path $paths.Control "desired-state.txt") -Value "stopped" -Encoding ascii
  foreach ($legacyCandidateTask in $legacyCandidateTasks) {
    Write-Host "Disabling legacy duplicate candidate task $($legacyCandidateTask.TaskName)..."
    Stop-ScheduledTask -TaskName $legacyCandidateTask.TaskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $legacyCandidateTask.TaskName -ErrorAction Stop | Out-Null
  }
  for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
    if (-not $listener) { break }
    Start-Sleep -Seconds 1
  }
  if ($existingTaskBeforeMigration) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }

  # The scheduled-task host does not own the detached Node supervisor process,
  # so stop every still-running process rooted under this candidate even when
  # backend children already closed gracefully. Validate executable and command
  # line before terminating anything.
  $normalizedInstallRoot = ([IO.Path]::GetFullPath($InstallRoot)).TrimEnd("\") + "\"
  $candidateProcesses = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $candidateName = [string]$_.Name
    $candidateCommandLine = [string]$_.CommandLine
    ($candidateName -in @("node.exe", "powershell.exe", "cloudflared.exe")) -and
      ($candidateCommandLine.IndexOf($normalizedInstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  }
  $candidatePortProcessIds = @(
    foreach ($candidatePort in @($BackendPort, $TelemetryPort)) {
      Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $candidatePort -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { [int]$_.OwningProcess }
    }
  ) | Where-Object { $_ -gt 0 } | Select-Object -Unique
  foreach ($candidatePortProcessId in $candidatePortProcessIds) {
    $candidatePortProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $candidatePortProcessId" -ErrorAction SilentlyContinue
    if ($candidatePortProcess -and [string]$candidatePortProcess.Name -eq "node.exe") {
      $candidateProcesses += $candidatePortProcess
    }
  }
  foreach ($candidateProcess in @($candidateProcesses | Sort-Object ProcessId -Unique)) {
    $candidateProcessId = [int]$candidateProcess.ProcessId
    $candidateCommandLine = [string]$candidateProcess.CommandLine
    $candidateName = [string]$candidateProcess.Name
    $candidateExecutableAllowed = $candidateName -in @("node.exe", "powershell.exe", "cloudflared.exe")
    $candidatePathMatches = $candidateCommandLine.IndexOf($normalizedInstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $candidatePortMatches = ($candidateName -eq "node.exe") -and ($candidateProcessId -in $candidatePortProcessIds)
    if (-not ($candidateExecutableAllowed -and ($candidatePathMatches -or $candidatePortMatches))) {
      Write-Warning "Refusing to stop PID $candidateProcessId because it is not a validated $InstallRoot candidate process."
      continue
    }
    Stop-Process -Id $candidateProcessId -Force -ErrorAction SilentlyContinue
  }
  for ($attempt = 1; $attempt -le 10; $attempt += 1) {
    $backendListener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
    $telemetryListener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $TelemetryPort -State Listen -ErrorAction SilentlyContinue
    if (-not $backendListener -and -not $telemetryListener) { break }
    Start-Sleep -Seconds 1
  }
  if ((Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue) -or
      (Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $TelemetryPort -State Listen -ErrorAction SilentlyContinue)) {
    throw "The candidate did not stop before database migrations."
  }
  $candidateQuiescedForMigration = $true
}

try {
  & $nodePath (Join-Path $releaseRoot "scripts\apply-application-migrations.mjs") $databasePath
  if ($LASTEXITCODE -ne 0) {
    throw "Application migrations exited with code $LASTEXITCODE."
  }
} catch {
  if ($candidateQuiescedForMigration) {
    Set-Content -LiteralPath (Join-Path $paths.Control "desired-state.txt") -Value "running" -Encoding ascii
    Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  throw
}

$existingConfigPath = Join-Path $paths.Config "service.json"
$existingConfig = if (Test-Path -LiteralPath $existingConfigPath) {
  Get-Content -LiteralPath $existingConfigPath -Raw | ConvertFrom-Json
} else {
  $null
}
$existingTunnelEnabled = [bool]$existingConfig.tunnelEnabled
$effectiveTunnelId = if ($CandidateTunnelId) { $CandidateTunnelId } else { [string]$existingConfig.tunnelId }
$effectiveTunnelHostname = if ($CandidateTunnelHostname) { $CandidateTunnelHostname } else { [string]$existingConfig.tunnelHostname }
$tunnelRequested = [bool]($effectiveTunnelId -or $effectiveTunnelHostname -or $CandidateTunnelCredentialsPath -or $existingTunnelEnabled)
$installedCloudflaredPath = Join-Path $paths.Bin "cloudflared.exe"
$installedTunnelCredentialsPath = Join-Path $paths.Config "candidate-tunnel.json"
$installedTunnelConfigPath = Join-Path $paths.Config "candidate-tunnel.yml"

if ($tunnelRequested) {
  if (-not $effectiveTunnelId -or -not $effectiveTunnelHostname) {
    throw "Candidate tunnel requires both a tunnel ID and hostname."
  }
  if ($effectiveTunnelHostname -in @("rldb.drein.net", "rldb-origin.drein.net")) {
    throw "The candidate installer refuses to use a production hostname."
  }
  if (-not (Test-Path -LiteralPath $installedTunnelCredentialsPath)) {
    if (-not $CandidateTunnelCredentialsPath -or -not (Test-Path -LiteralPath $CandidateTunnelCredentialsPath)) {
      throw "Candidate tunnel credentials were not found. Supply -CandidateTunnelCredentialsPath for the first tunnel installation."
    }
    Copy-Item -LiteralPath $CandidateTunnelCredentialsPath -Destination $installedTunnelCredentialsPath -Force
  }
  if (-not (Test-Path -LiteralPath $CloudflaredSourcePath)) {
    throw "cloudflared executable not found: $CloudflaredSourcePath"
  }
  if (-not (Test-Path -LiteralPath $installedCloudflaredPath)) {
    Copy-Item -LiteralPath $CloudflaredSourcePath -Destination $installedCloudflaredPath
  }
  @"
tunnel: $effectiveTunnelId
credentials-file: $installedTunnelCredentialsPath

ingress:
  - hostname: $effectiveTunnelHostname
    service: http://127.0.0.1:$BackendPort
  - service: http_status:404
"@ | Set-Content -LiteralPath $installedTunnelConfigPath -Encoding ascii
}

$sessionSecret = [string]$existingConfig.siteSessionSecret
if (-not $sessionSecret) {
  $sessionSecretBytes = New-CryptographicRandomBytes 48
  $sessionSecret = [Convert]::ToBase64String($sessionSecretBytes)
}
$sitePasswordHash = [string]$existingConfig.sitePasswordHash
if ($tunnelRequested -and -not $sitePasswordHash) {
  Write-Host "The public test hostname requires the shared site password."
  $secureSitePassword = Read-Host "Enter the existing shared RLDB site password" -AsSecureString
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSitePassword)
  try {
    $plainSitePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if (-not $plainSitePassword) { throw "The shared site password cannot be empty." }
    $sitePasswordHash = Get-Sha256Hex $plainSitePassword
  } finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $plainSitePassword = $null
    $secureSitePassword = $null
  }
}
$localApiToken = [string]$existingConfig.localApiToken
if (-not $localApiToken) {
  $localApiToken = [Environment]::GetEnvironmentVariable("LOCAL_API_TOKEN", "User")
}
if ($tunnelRequested -and -not $localApiToken) {
  throw "Candidate public-origin routing requires LOCAL_API_TOKEN in the existing config or installer user's environment."
}
$telemetryToken = [string]$existingConfig.telemetryToken
if (-not $telemetryToken) {
  $telemetryTokenBytes = New-CryptographicRandomBytes 32
  $telemetryToken = [Convert]::ToBase64String($telemetryTokenBytes)
}
$serviceConfig = [ordered]@{
  applicationVersion = $applicationVersion
  schemaVersion = "0010_normalize_query_component_presence"
  releaseRoot = $releaseRoot
  nodePath = $nodePath
  databasePath = $databasePath
  telemetryDatabasePath = (Join-Path $paths.Telemetry "query-performance.sqlite")
  logRoot = $paths.Logs
  runtimeRoot = $paths.Runtime
  controlRoot = $paths.Control
  backendPort = $BackendPort
  telemetryPort = $TelemetryPort
  maxRequestBodyBytes = 1048576
  maxQueryExecutionMs = 150000
  sqliteCacheMiB = $SqliteCacheMiB
  sqliteMmapMiB = $SqliteMmapMiB
  updateEnabled = $true
  updateDayOfWeek = 1
  updateHourLocal = 1
  updateSeason = 0
  updateCompetitions = @("NRL", "NRLW")
  updateDataRoot = $paths.UpdateData
  sitePasswordHash = $sitePasswordHash
  siteSessionSecret = $sessionSecret
  localApiToken = $localApiToken
  telemetryToken = $telemetryToken
  tunnelEnabled = $tunnelRequested
  tunnelId = $effectiveTunnelId
  tunnelHostname = $effectiveTunnelHostname
  tunnelConfigPath = $(if ($tunnelRequested) { $installedTunnelConfigPath } else { "" })
  cloudflaredPath = $(if ($tunnelRequested) { $installedCloudflaredPath } else { "" })
}
$serviceConfig | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $paths.Config "service.json") -Encoding utf8
Set-Content -LiteralPath (Join-Path $paths.Control "desired-state.txt") -Value "running" -Encoding ascii

Write-Host "Applying restricted filesystem permissions..."
& icacls.exe $InstallRoot "/inheritance:r" "/grant:r" "SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "${ServiceUser}:(OI)(CI)RX" "${ControlUser}:(OI)(CI)RX" | Out-Null
foreach ($writePath in @($paths.Data, $paths.Logs, $paths.Runtime, $paths.Telemetry, $paths.Backups, $paths.UpdateData)) {
  & icacls.exe $writePath "/grant:r" "${ServiceUser}:(OI)(CI)M" "${ControlUser}:(OI)(CI)R" | Out-Null
}
& icacls.exe $paths.Control "/grant:r" "${ServiceUser}:(OI)(CI)M" "${ControlUser}:(OI)(CI)M" | Out-Null
& icacls.exe $paths.Config "/inheritance:r" "/grant:r" "SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "${ServiceUser}:(OI)(CI)R" | Out-Null
& icacls.exe $paths.Release "/grant:r" "${ServiceUser}:(OI)(CI)RX" "${ControlUser}:(OI)(CI)R" | Out-Null

& (Join-Path $PSScriptRoot "grant-logon-as-batch-job.ps1") -Account $ServiceUser

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($paths.Service)\run-supervisor.ps1`" -InstallRoot `"$InstallRoot`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -ExecutionTimeLimit ([timespan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existingTask) {
  Write-Host "Windows requires the existing $ServiceUser password once to register the task."
  $credential = Get-Credential `
    -UserName $ServiceUser `
    -Message "Enter the existing password for the restricted RLDB service account."
  if (-not $credential) {
    throw "Task registration was cancelled."
  }

  $taskPassword = $credential.GetNetworkCredential().Password
  try {
    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -User $ServiceUser `
      -Password $taskPassword `
      -RunLevel Limited `
      -Description "Isolated direct-Node RLDB candidate. Does not use Wrangler or production ports." `
      -Force `
      -ErrorAction Stop | Out-Null
  } finally {
    $taskPassword = $null
    $credential = $null
  }
} else {
  Write-Host "Retaining existing scheduled-task credentials."
  Write-Host "Restarting the existing candidate task to load the new release."
  if (-not $candidateQuiescedForMigration) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    for ($attempt = 1; $attempt -le 30; $attempt += 1) {
      $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
      if (-not $listener) { break }
      Start-Sleep -Seconds 1
    }
    $staleListener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
    if ($staleListener) {
      throw "The previous candidate process did not stop listening on port $BackendPort."
    }
  }
}
Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop

Write-Host "Waiting for the candidate service..."
$healthy = $false
for ($attempt = 1; $attempt -le 30; $attempt += 1) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$BackendPort/api/health"
    if ($health.StatusCode -eq 200) { $healthy = $true; break }
  } catch {}
}
if (-not $healthy) {
  throw "The scheduled task was installed, but the candidate health endpoint did not become ready."
}

$productionAfter = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "http://127.0.0.1:8797/api/health"
if ($productionAfter.StatusCode -ne 200) {
  throw "Operational health check failed after candidate installation."
}

Write-Host "Installed isolated RLDB candidate under $ServiceUser."
Write-Host "Candidate health: HTTP 200 on 127.0.0.1:$BackendPort"
Write-Host "Operational health: HTTP 200 on 127.0.0.1:8797"
