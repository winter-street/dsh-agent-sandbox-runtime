[CmdletBinding()]
param([string]$DataDir = '', [string]$EnvFile = '.env.local', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  . (Join-Path $PSScriptRoot 'evaluation-env.ps1')
  Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile
  if ($CheckOnly) {
    & node --import tsx spikes/model-routing/real-compare.ts --check-only
    exit ([int]$LASTEXITCODE)
  }
  if (-not $DataDir) { $DataDir = ".runtime\model-routing-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" }
  $dataPath = Resolve-EvaluationPath $repoRoot $DataDir
  if (Test-Path -LiteralPath $dataPath) { throw "Evidence directory already exists: $dataPath" }
  Write-Host "Fixed model comparison. At most five provider calls, 512 output tokens per call, 12000 token budget. Evidence: $dataPath"
  & node --import tsx spikes/model-routing/real-compare.ts --run $dataPath
  exit ([int]$LASTEXITCODE)
} finally { Pop-Location }
