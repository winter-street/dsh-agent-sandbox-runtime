[CmdletBinding()]
param(
  [string]$DataDir = '',
  [string]$EnvFile = '.env.local',
  [ValidateRange(30000, 900000)][int]$TimeoutMs = 420000,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  . (Join-Path $PSScriptRoot 'evaluation-env.ps1')
  Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile
  if (-not $env:RUNTIME_PLAYWRIGHT_MODULE) {
    $env:RUNTIME_PLAYWRIGHT_MODULE = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright-core\index.mjs'
  }
  if (-not $env:RUNTIME_BROWSER_EXECUTABLE) {
    $env:RUNTIME_BROWSER_EXECUTABLE = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
  }
  foreach ($file in @($env:RUNTIME_PLAYWRIGHT_MODULE, $env:RUNTIME_BROWSER_EXECUTABLE)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "N03 browser dependency does not exist: $file" }
  }
  if ($CheckOnly) {
    & pnpm.cmd exec tsx spikes/n03/long-task-recovery.ts --check-only
    exit ([int]$LASTEXITCODE)
  }
  if (-not $DataDir) { $DataDir = ".runtime\n03-long-task-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))" }
  $dataPath = Resolve-EvaluationPath $repoRoot $DataDir
  if (Test-Path -LiteralPath $dataPath) { throw "N03 data directory already exists: $dataPath" }
  Write-Host "N03 real run (at most five DeepSeek requests). Evidence: $dataPath"
  & pnpm.cmd exec tsx spikes/n03/long-task-recovery.ts --run $dataPath $TimeoutMs
  exit ([int]$LASTEXITCODE)
} finally { Pop-Location }
