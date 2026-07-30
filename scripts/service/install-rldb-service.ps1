param(
  [string]$SourceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$SeedDatabase = "C:\Users\d2rei\My_Site\rldb-direct-node-runtime\data\rldb.sqlite",
  [string]$InstallRoot = "C:\RLDB",
  [string]$ServiceUser = "$env:COMPUTERNAME\rldbsvc",
  [string]$ControlUser = "$env:COMPUTERNAME\d2rei",
  [string]$TaskName = "RLDB-Direct-Node-Supervisor",
  [int]$BackendPort = 8899,
  [int]$TelemetryPort = 8890,
  [switch]$PreserveServiceAccountPassword
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this installer from an elevated PowerShell window."
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

if (-not $PreserveServiceAccountPassword) {
  $passwordBytes = [byte[]]::new(48)
  [Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
  $unattendedPassword = [Convert]::ToBase64String($passwordBytes)
  $securePassword = ConvertTo-SecureString $unattendedPassword -AsPlainText -Force
  Set-LocalUser `
    -Name $serviceAccountName `
    -Password $securePassword `
    -PasswordNeverExpires $true `
    -UserMayChangePassword $false `
    -AccountNeverExpires `
    -Description "Restricted unattended account for the local RLDB candidate service."
  $unattendedPassword = $null
  $securePassword = $null
  Write-Host "Hardened the service account with an unknown random password."
}

$gitCommit = (& git -c "safe.directory=$SourceRoot" -C $SourceRoot rev-parse HEAD).Trim()
if (-not $gitCommit) { throw "Unable to determine candidate Git commit." }
$gitDirty = [bool](& git -c "safe.directory=$SourceRoot" -C $SourceRoot status --porcelain)
$applicationVersion = "$gitCommit-$(if ($gitDirty) { 'dirty' } else { 'clean' })"
$releaseRoot = Join-Path $InstallRoot "app\releases\$gitCommit"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
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
  Service = Join-Path $InstallRoot "service"
}
New-Item -ItemType Directory -Force -Path $paths.Values | Out-Null

Write-Host "Installing release $gitCommit..."
New-Item -ItemType Directory -Force -Path (Join-Path $releaseRoot "dist"), (Join-Path $releaseRoot "scripts"), (Join-Path $releaseRoot "migrations\telemetry") | Out-Null
Copy-Item -LiteralPath (Join-Path $SourceRoot "dist\server.mjs") -Destination (Join-Path $releaseRoot "dist\server.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\query-telemetry-server.mjs") -Destination (Join-Path $releaseRoot "scripts\query-telemetry-server.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\report-query-telemetry.mjs") -Destination (Join-Path $releaseRoot "scripts\report-query-telemetry.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "migrations\telemetry\0001_query_performance.sql") -Destination (Join-Path $releaseRoot "migrations\telemetry\0001_query_performance.sql") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\service\supervisor.mjs") -Destination (Join-Path $paths.Service "supervisor.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot "scripts\service\run-supervisor.ps1") -Destination (Join-Path $paths.Service "run-supervisor.ps1") -Force
Copy-Item -Path (Join-Path $SourceRoot "scripts\service\control\*.ps1") -Destination $paths.Control -Force

$databasePath = Join-Path $paths.Data "rldb.sqlite"
if (-not (Test-Path -LiteralPath $databasePath)) {
  Write-Host "Seeding independent database. This 2.3 GB copy can take several minutes..."
  Copy-Item -LiteralPath $SeedDatabase -Destination $databasePath
}

$existingConfigPath = Join-Path $paths.Config "service.json"
$existingConfig = if (Test-Path -LiteralPath $existingConfigPath) {
  Get-Content -LiteralPath $existingConfigPath -Raw | ConvertFrom-Json
} else {
  $null
}
$sessionSecret = [string]$existingConfig.siteSessionSecret
if (-not $sessionSecret) {
  $sessionSecretBytes = [byte[]]::new(48)
  [Security.Cryptography.RandomNumberGenerator]::Fill($sessionSecretBytes)
  $sessionSecret = [Convert]::ToBase64String($sessionSecretBytes)
}
$serviceConfig = [ordered]@{
  applicationVersion = $applicationVersion
  schemaVersion = "0007_team_season_aggregates"
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
  sitePasswordHash = [string]$existingConfig.sitePasswordHash
  siteSessionSecret = $sessionSecret
}
$serviceConfig | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $paths.Config "service.json") -Encoding utf8
Set-Content -LiteralPath (Join-Path $paths.Control "desired-state.txt") -Value "running" -Encoding ascii

Write-Host "Applying restricted filesystem permissions..."
& icacls.exe $InstallRoot "/inheritance:r" "/grant:r" "SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "${ServiceUser}:(OI)(CI)RX" "${ControlUser}:(OI)(CI)RX" | Out-Null
foreach ($writePath in @($paths.Data, $paths.Logs, $paths.Runtime, $paths.Telemetry, $paths.Backups)) {
  & icacls.exe $writePath "/grant:r" "${ServiceUser}:(OI)(CI)M" "${ControlUser}:(OI)(CI)R" | Out-Null
}
& icacls.exe $paths.Control "/grant:r" "${ServiceUser}:(OI)(CI)M" "${ControlUser}:(OI)(CI)M" | Out-Null
& icacls.exe $paths.Config "/inheritance:r" "/grant:r" "SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "${ServiceUser}:(OI)(CI)R" | Out-Null
& icacls.exe $paths.Release "/grant:r" "${ServiceUser}:(OI)(CI)RX" "${ControlUser}:(OI)(CI)R" | Out-Null

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
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $ServiceUser -LogonType S4U -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $taskPrincipal `
  -Description "Isolated direct-Node RLDB candidate. Does not use Wrangler or production ports." `
  -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

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
