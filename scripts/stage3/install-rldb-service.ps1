param(
  [string]$Root = "C:\RLDB",
  [string]$ServiceUser = "$env:COMPUTERNAME\rldbsvc",
  [string]$SourceRoot = "",
  [string]$SnapshotStateDirectory = "",
  [string]$TaskName = "RLDB-Stage3-Parallel"
)

$ErrorActionPreference = "Stop"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this installer from an Administrator PowerShell window."
}

if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
  $SourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if ([string]::IsNullOrWhiteSpace($SnapshotStateDirectory)) {
  $SnapshotStateDirectory = Join-Path $SourceRoot "runtime-data\parallel\wrangler-state"
}
$SnapshotStateDirectory = (Resolve-Path -LiteralPath $SnapshotStateDirectory).Path

$serviceAccountName = ($ServiceUser -split "\\")[-1].Replace("'", "''")
$account = Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True AND Name='$serviceAccountName'"
if (-not $account) {
  throw "The local $ServiceUser account does not exist."
}
& (Join-Path $PSScriptRoot "grant-rldbsvc-batch-logon.ps1") -ServiceUser $ServiceUser

$commit = (& git -C $SourceRoot rev-parse HEAD).Trim()
if (-not $commit) { throw "Unable to identify the Stage 3 Git commit." }
$shortCommit = $commit.Substring(0, 12)
$appBaseRoot = Join-Path $Root "app"
$releaseRoot = Join-Path $appBaseRoot "releases\$shortCommit"
$dataRoot = Join-Path $Root "data"
$logRoot = Join-Path $Root "logs"
$backupRoot = Join-Path $Root "backups"
$runtimeRoot = Join-Path $Root "runtime"
$configRoot = Join-Path $Root "config"
$controlRoot = Join-Path $Root "control"
$targetStateDirectory = Join-Path $dataRoot "wrangler-state"
$primaryUser = "$env:USERDOMAIN\$env:USERNAME"
$releaseRuntimeDirectories = @(
  (Join-Path $releaseRoot ".wrangler"),
  (Join-Path $releaseRoot "node_modules\.mf")
)

Write-Host "Installing isolated Stage 3 release $shortCommit."
New-Item -ItemType Directory -Force -Path $releaseRoot, $dataRoot, $logRoot, $backupRoot, $runtimeRoot, $configRoot, $controlRoot | Out-Null

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq "Running") {
  Write-Host "Stopping the current isolated Stage 3 task before verifying the database..."
  $existingStopScript = Join-Path $controlRoot "rldb-stop.ps1"
  if (Test-Path -LiteralPath $existingStopScript) {
    & $existingStopScript
    Start-Sleep -Seconds 7
  }
  Stop-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
}

$archivePath = Join-Path $env:TEMP "rldb-stage3-$shortCommit.zip"
if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}
& git -C $SourceRoot archive --format=zip --output=$archivePath $commit
if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
Expand-Archive -LiteralPath $archivePath -DestinationPath $releaseRoot -Force
Remove-Item -LiteralPath $archivePath -Force

Push-Location $releaseRoot
try {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed in the Stage 3 release." }
} finally {
  Pop-Location
}
New-Item -ItemType Directory -Force -Path $releaseRuntimeDirectories | Out-Null

if (-not (Test-Path -LiteralPath $targetStateDirectory)) {
  Write-Host "Copying the frozen 2.32 GB SQLite state. This can take several minutes."
  Copy-Item -LiteralPath $SnapshotStateDirectory -Destination $targetStateDirectory -Recurse
} else {
  Write-Host "Existing Stage 3 database state retained at $targetStateDirectory."
}

$sourceDatabase = Get-ChildItem -LiteralPath (Join-Path $SnapshotStateDirectory "v3\d1\miniflare-D1DatabaseObject") -Filter "*.sqlite" -File |
  Where-Object { $_.Name -ne "metadata.sqlite" } |
  Sort-Object Length -Descending |
  Select-Object -First 1
$targetDatabase = Join-Path $targetStateDirectory "v3\d1\miniflare-D1DatabaseObject\$($sourceDatabase.Name)"
if (-not (Test-Path -LiteralPath $targetDatabase)) {
  throw "Copied Stage 3 database was not found: $targetDatabase"
}
Write-Host "Verifying source SQLite checksum..."
$sourceHash = (Get-FileHash -LiteralPath $sourceDatabase.FullName -Algorithm SHA256).Hash
Write-Host "Verifying retained Stage 3 SQLite checksum..."
$targetHash = (Get-FileHash -LiteralPath $targetDatabase -Algorithm SHA256).Hash
if ($sourceHash -ne $targetHash) {
  throw "Stage 3 database checksum mismatch. The task has not been registered."
}
Write-Host "SQLite checksum verified. Preparing isolated service configuration..."

$tokenPath = Join-Path $configRoot "backend-token.txt"
if (-not (Test-Path -LiteralPath $tokenPath)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_") |
    Set-Content -LiteralPath $tokenPath -Encoding ascii
}
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
@"
LOCAL_API_TOKEN=$token
"@ | Set-Content -LiteralPath (Join-Path $releaseRoot ".dev.vars.local") -Encoding ascii

$schemaVersion = (Get-ChildItem -LiteralPath (Join-Path $releaseRoot "migrations") -Filter "*.sql" -File |
  Sort-Object Name |
  Select-Object -Last 1).BaseName
$serviceConfig = [ordered]@{
  appRoot = $releaseRoot
  dataRoot = $dataRoot
  logRoot = $logRoot
  runtimeRoot = $runtimeRoot
  backendPort = 8899
  telemetryPort = 8890
  applicationVersion = "${commit}-clean"
  schemaVersion = $schemaVersion
  installedAtUtc = [datetime]::UtcNow.ToString("o")
  databaseSha256 = $targetHash
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $configRoot "service.json") -Value $serviceConfig -Encoding utf8

Copy-Item -LiteralPath (Join-Path $releaseRoot "scripts\stage3\launch-current.ps1") -Destination $controlRoot -Force
Copy-Item -LiteralPath (Join-Path $releaseRoot "scripts\stage3\rldb-control.ps1") -Destination $controlRoot -Force
foreach ($name in @("rldb-status.ps1", "rldb-start.ps1", "rldb-stop.ps1", "rldb-restart.ps1", "rldb-logs.ps1")) {
  Copy-Item -LiteralPath (Join-Path $releaseRoot "scripts\stage3\$name") -Destination $controlRoot -Force
}

Write-Host "Applying isolated service permissions..."
& icacls.exe $Root /inheritance:r | Out-Null
& icacls.exe $Root /grant:r "${primaryUser}:(OI)(CI)F" "${ServiceUser}:(RX)" "SYSTEM:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" | Out-Null
& icacls.exe $appBaseRoot /grant:r "${ServiceUser}:(OI)(CI)RX" | Out-Null
foreach ($path in @($dataRoot, $logRoot, $runtimeRoot)) {
  & icacls.exe $path /grant:r "${ServiceUser}:(OI)(CI)M" | Out-Null
}
& icacls.exe $backupRoot /grant:r "${ServiceUser}:(OI)(CI)R" | Out-Null
& icacls.exe $releaseRoot /grant:r "${ServiceUser}:(OI)(CI)RX" | Out-Null
foreach ($path in $releaseRuntimeDirectories) {
  & icacls.exe $path /grant:r "${ServiceUser}:(OI)(CI)M" | Out-Null
}
& icacls.exe $configRoot /grant:r "${ServiceUser}:(OI)(CI)R" | Out-Null
& icacls.exe $controlRoot /grant:r "${ServiceUser}:(OI)(CI)RX" | Out-Null

Write-Host "Opening the rldbsvc credential prompt to register the Stage 3 task..."
$credential = Get-Credential -UserName $ServiceUser -Message "Enter the rldbsvc password to register the isolated Stage 3 startup task."
$password = $credential.GetNetworkCredential().Password
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$controlRoot\launch-current.ps1`" -Root `"$Root`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT30S"
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([timespan]::Zero) `
  -StartWhenAvailable
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User $credential.UserName `
  -Password $password `
  -RunLevel Limited `
  -Description "Isolated RLDB Stage 3 parallel backend; does not serve rldb.drein.net." `
  -Force | Out-Null
$password = $null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Stage 3 task registered and started. Production port 8797 was not changed."
Write-Host "Status command: $controlRoot\rldb-status.ps1"
