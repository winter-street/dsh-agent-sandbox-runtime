[CmdletBinding()]
param(
  [string]$DataDir = '',
  [string]$EnvFile = '.env.local',
  [ValidateRange(120000, 600000)][int]$TimeoutMs = 420000,
  [switch]$CheckOnly,
  [switch]$StatusFault
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  . (Join-Path $PSScriptRoot 'evaluation-env.ps1')
  Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile
  if ($CheckOnly) {
    & node --import tsx spikes/n04/real-serial.ts --check-only
    exit ([int]$LASTEXITCODE)
  }
  if (-not $DataDir) { $DataDir = ".runtime\n04-real-serial-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" }
  $dataPath = Resolve-EvaluationPath $repoRoot $DataDir
  if (Test-Path -LiteralPath $dataPath) { throw "N04 evidence directory already exists: $dataPath" }
  Write-Host "N04 fixed real task: at most three role calls plus one report; 30000 token cap. Evidence: $dataPath"
  $mode = if ($StatusFault) { '--fault-run' } else { '--run' }
  & node --import tsx spikes/n04/real-serial.ts $mode $dataPath $TimeoutMs
  exit ([int]$LASTEXITCODE)
} finally { Pop-Location }
