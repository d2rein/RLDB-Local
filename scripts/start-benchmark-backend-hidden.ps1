param(
  [int]$Port = 8897,
  [string]$StateDirectory = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($StateDirectory)) {
  $StateDirectory = Join-Path $projectRoot "runtime-data\benchmarks\wrangler-state"
}
$logDirectory = Join-Path $projectRoot "runtime-data\benchmarks\logs"
$stdoutPath = Join-Path $logDirectory "backend-$Port.out.log"
$stderrPath = Join-Path $logDirectory "backend-$Port.err.log"
$wranglerCli = Join-Path $projectRoot "node_modules\wrangler\bin\wrangler.js"
New-Item -ItemType Directory -Force -Path $StateDirectory, $logDirectory | Out-Null

try {
  $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/health"
  if ($health.StatusCode -eq 200) {
    Write-Host "Benchmark backend already healthy on port $Port."
    exit 0
  }
} catch {
  # Start or replace only the isolated benchmark listener.
}

$portNeedle = "--port $Port"
$stateNeedle = $StateDirectory.ToLowerInvariant()
$benchmarkParents = Get-CimInstance Win32_Process | Where-Object {
  $commandLine = ([string]$_.CommandLine).ToLowerInvariant()
  $_.ProcessId -ne $PID -and
  $_.Name -eq "node.exe" -and (
    ($commandLine.Contains("wrangler") -and $commandLine.Contains($portNeedle)) -or
    $commandLine.Contains($stateNeedle)
  )
}
foreach ($process in $benchmarkParents) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($benchmarkParents) { Start-Sleep -Seconds 2 }

$listener = netstat -ano | Select-String -Pattern "127.0.0.1:$Port\s+.*LISTENING\s+(\d+)" | Select-Object -First 1
if ($listener) {
  $match = [regex]::Match($listener.ToString(), "LISTENING\s+(\d+)")
  if ($match.Success) {
    Stop-Process -Id ([int]$match.Groups[1].Value) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
}

$env:CI = "1"
Start-Process -FilePath "node.exe" `
  -ArgumentList @(
    $wranglerCli, "dev", "--env", "local", "--local",
    "--ip", "127.0.0.1", "--port", [string]$Port,
    "--persist-to", $StateDirectory
  ) `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/health"
    if ($health.StatusCode -eq 200) {
      Write-Host "Started isolated benchmark backend on port $Port."
      exit 0
    }
  } catch {
    # Continue through the bounded startup window.
  }
}
throw "Benchmark backend did not become healthy on port $Port. Check $stderrPath."
