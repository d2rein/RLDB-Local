param(
  [int]$Port = 8787,
  [switch]$RefreshData,
  [string]$BindAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if ($RefreshData) {
  & ".\scripts\refresh-local-data.ps1"
}

$env:CI = "1"
npx wrangler dev --env local --local --ip $BindAddress --port $Port
