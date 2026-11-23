[CmdletBinding()]
param(
  [string]$DataDir = '',
  [string]$EnvFile = '.env.local',
  [ValidateRange(120000, 600000)][int]$TimeoutMs = 420000,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  . (Join-Path $PSScriptRoot 'evaluation-env.ps1')
  Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile
  if ($CheckOnly) {
    & node --import tsx spikes/n04/compare.ts --check-only
    exit ([int]$LASTEXITCODE)
  }
  if (-not $DataDir) { $DataDir = ".runtime\n04-comparison-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" }
  $dataPath = Resolve-EvaluationPath $repoRoot $DataDir
  if (Test-Path -LiteralPath $dataPath) { throw "Comparison evidence directory already exists $dataPath" }
  Write-Host "P4-07 fixed real comparison. One run per mode, six provider calls and 30000 tokens per mode. Evidence $dataPath"
  & node --import tsx spikes/n04/compare.ts --run $dataPath $TimeoutMs
  exit ([int]$LASTEXITCODE)
} finally { Pop-Location }
