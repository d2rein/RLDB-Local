param(
  [int]$WarmIterations = 5,
  [int]$RequestTimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$baseUrl = "http://127.0.0.1:8899"
$healthDeadline = (Get-Date).AddMinutes(5)
$startControl = "C:\RLDB\control\rldb-start.ps1"
$restartControl = "C:\RLDB\control\rldb-restart.ps1"

foreach ($controlScript in @($startControl, $restartControl)) {
  if (-not (Test-Path -LiteralPath $controlScript) -or (Get-Item -LiteralPath $controlScript).Length -eq 0) {
    throw "Stage 3 is not fully installed ($controlScript is missing or empty). Re-run scripts\\stage3\\install-rldb-service.ps1 as Administrator."
  }
}

& $startControl
do {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "$baseUrl/api/health"
    if ($response.StatusCode -eq 200) { break }
  } catch {
    Start-Sleep -Seconds 2
  }
} while ((Get-Date) -lt $healthDeadline)

if ((Get-Date) -ge $healthDeadline) {
  throw "Stage 3 did not become healthy within five minutes. Run C:\RLDB\control\rldb-logs.ps1 for details."
}

$timeoutMs = $RequestTimeoutSeconds * 1000
& node (Join-Path $projectRoot "scripts\run-query-benchmark.mjs") `
  --base-url $baseUrl `
  --baseline (Join-Path $projectRoot "benchmark\baselines\current-hybrid.json") `
  --run-db (Join-Path $projectRoot "runtime-data\benchmarks\stage3-comparison-runs.sqlite") `
  --report-dir (Join-Path $projectRoot "reports\benchmarks\stage3-8899") `
  --telemetry-db "C:\RLDB\data\telemetry\query-performance.sqlite" `
  --restart-script (Join-Path $projectRoot "scripts\stage3\restart-benchmark-backend.ps1") `
  --hosting-mode "stage3-isolated-local-origin" `
  --warm-iterations $WarmIterations `
  --request-timeout-ms $timeoutMs `
  --recovery-timeout-ms ($timeoutMs + 30000)
exit $LASTEXITCODE
