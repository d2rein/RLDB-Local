param(
  [int]$Season = (Get-Date).Year,
  [string[]]$Selections = @("NRL", "NRLW"),
  [string]$Selection,
  [int]$RecentRoundCount = 2,
  [int]$LookaheadRounds = 2,
  [switch]$SkipScrape
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if ($Selection) {
  $Selections = @($Selection)
}

$Selections = @(
  $Selections |
    Where-Object { $_ } |
    ForEach-Object { $_.Trim().ToUpperInvariant() } |
    Select-Object -Unique
)

function Invoke-Step {
  param(
    [string]$Label,
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Label"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

if (-not $SkipScrape) {
  Push-Location ".\docs\NRL-Data-main_duplicate\scraping"
  try {
    foreach ($selectionName in $Selections) {
      Invoke-Step "Refreshing scraped round data ($selectionName $Season)" {
        python refresh_recent_rounds.py --selection $selectionName --year $Season --recent-round-count $RecentRoundCount --lookahead-rounds $LookaheadRounds
      }
    }
  }
  finally {
    Pop-Location
  }
}

Invoke-Step "Syncing reconciled match backbone" { node .\scripts\sync-nrl-match-backbone.mjs --season=$Season }
Invoke-Step "Building reference seed" { npm run seed:reference }
Invoke-Step "Building core import bundle" { npm run seed:core }
Invoke-Step "Building core seed SQL" { npm run seed:core-sql }
Invoke-Step "Building legacy scoring seed SQL" { npm run seed:legacy-sql }
Invoke-Step "Building player stat aggregate seed SQL" { npm run seed:player-stats-sql }
Invoke-Step "Building match summary seed SQL" { npm run seed:match-summaries-sql }
Invoke-Step "Applying local D1 SQLite database" { node .\scripts\apply-local-d1-sqlite.mjs }
Invoke-Step "Aligning player aggregates with canonical match summaries" { node .\scripts\rebuild-player-stat-aggregates-from-summaries.mjs --operational }
Invoke-Step "Building current-season refresh SQL" { node .\scripts\build-current-season-refresh-sql.mjs --season=$Season }

Write-Host ""
Write-Host "Local data refresh complete."
