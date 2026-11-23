[CmdletBinding()]
param(
  [string]$DataDir = '',
  [string]$EnvFile = '.env.local',
  [ValidateRange(120000, 300000)][int]$TimeoutMs = 240000,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  . (Join-Path $PSScriptRoot 'evaluation-env.ps1')
  Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile
  if ($CheckOnly) {
    & node --import tsx spikes/workflow-branches/real-smoke.ts --check-only
    exit ([int]$LASTEXITCODE)
  }
  if (-not $DataDir) { $DataDir = ".runtime\workflow-branches-real-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" }
  $dataPath = Resolve-EvaluationPath $repoRoot $DataDir
  if (Test-Path -LiteralPath $dataPath) { throw "Workflow evidence directory already exists: $dataPath" }
  Write-Host "P5-02 real branches: five sandboxes total, at most two live, fixed Python and controlled token usage. Evidence: $dataPath"
  & node --import tsx spikes/workflow-branches/real-smoke.ts --run $dataPath $TimeoutMs
  exit ([int]$LASTEXITCODE)
} finally { Pop-Location }
