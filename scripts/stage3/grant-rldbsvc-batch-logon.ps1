param(
  [Parameter(Mandatory = $true)]
  [string]$ServiceUser
)

$ErrorActionPreference = "Stop"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an Administrator PowerShell window."
}

$serviceSid = ([Security.Principal.NTAccount]$ServiceUser).Translate([Security.Principal.SecurityIdentifier]).Value
$servicePrincipal = "*$serviceSid"
$workRoot = Join-Path $env:TEMP ("rldb-batch-logon-" + [guid]::NewGuid().ToString("N"))
$exportPath = Join-Path $workRoot "current.inf"
$configurePath = Join-Path $workRoot "grant-batch-logon.inf"
$databasePath = Join-Path $workRoot "policy.sdb"

New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
try {
  & secedit.exe /export /cfg $exportPath /areas USER_RIGHTS | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not export the local user-rights policy." }

  $lines = Get-Content -LiteralPath $exportPath
  $rightLine = $lines | Where-Object { $_ -match '^SeBatchLogonRight\s*=' } | Select-Object -First 1
  $denyLine = $lines | Where-Object { $_ -match '^SeDenyBatchLogonRight\s*=' } | Select-Object -First 1
  $assigned = if ($rightLine) { (($rightLine -split '=', 2)[1] -split ',').Trim() | Where-Object { $_ } } else { @() }
  $denied = if ($denyLine) { (($denyLine -split '=', 2)[1] -split ',').Trim() | Where-Object { $_ } } else { @() }

  if ($denied -contains $servicePrincipal) {
    throw "$ServiceUser is explicitly denied 'Log on as a batch job'. Remove that deny assignment before continuing."
  }

  if ($assigned -contains $servicePrincipal) {
    Write-Host "$ServiceUser already has 'Log on as a batch job'."
    exit 0
  }

  $updated = @($assigned + $servicePrincipal) -join ','
  @"
[Unicode]
Unicode=yes
[Version]
signature="`$CHICAGO`$"
Revision=1
[Privilege Rights]
SeBatchLogonRight = $updated
"@ | Set-Content -LiteralPath $configurePath -Encoding ascii

  & secedit.exe /configure /db $databasePath /cfg $configurePath /areas USER_RIGHTS /quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not grant 'Log on as a batch job' to $ServiceUser." }
  Write-Host "Granted 'Log on as a batch job' to $ServiceUser."
} finally {
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
