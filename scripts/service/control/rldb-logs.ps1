param(
  [ValidateSet("supervisor", "backend-out", "backend-error", "telemetry-out", "telemetry-error")]
  [string]$Log = "supervisor",
  [int]$Lines = 100,
  [string]$InstallRoot = "C:\RLDB"
)

$names = @{
  "supervisor" = "supervisor.log"
  "backend-out" = "backend.out.log"
  "backend-error" = "backend.err.log"
  "telemetry-out" = "telemetry.out.log"
  "telemetry-error" = "telemetry.err.log"
}
$path = Join-Path $InstallRoot "logs\$($names[$Log])"
if (-not (Test-Path -LiteralPath $path)) {
  Write-Host "Log is not available yet: $path"
  exit 0
}
Get-Content -LiteralPath $path -Tail $Lines
