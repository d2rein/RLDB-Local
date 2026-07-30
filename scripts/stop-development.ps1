param(
  [string]$RuntimeRoot = "C:\Users\d2rei\My_Site\rldb-direct-node-runtime"
)

$ErrorActionPreference = "Stop"
$pidRoot = Join-Path $RuntimeRoot "runtime"
foreach ($name in @("backend", "telemetry")) {
  $pidPath = Join-Path $pidRoot "$name.pid"
  if (-not (Test-Path -LiteralPath $pidPath)) { continue }
  $processId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq "node") {
    Stop-Process -Id $processId -Force
    Write-Host "Stopped $name PID $processId."
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}
