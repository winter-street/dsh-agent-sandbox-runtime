[CmdletBinding()]
param(
  [string]$OutDir = '',
  [string]$EnvFile = '.env.local',
  [string]$Suite = 'eval/suite.json',
  [ValidateSet('calibration', 'evaluation')][string]$Split = 'calibration',
  [ValidateRange(1, 100)][int]$Repetitions = 1,
  [ValidateRange(1, 1000)][int]$MaxRunsPerWorker = 1,
  [ValidateRange(1, 2)][int]$ProviderConcurrency = 2,
  [ValidateRange(1, 2)][int]$SandboxConcurrency = 2,
  [switch]$Reconcile,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot
$tsx = Join-Path $repoRoot 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path -LiteralPath $tsx -PathType Leaf)) { throw "Local tsx executable not found: $tsx" }
. (Join-Path $PSScriptRoot 'evaluation-env.ps1')
Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  if ($Reconcile) { throw '-Reconcile requires the original -OutDir.' }
  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $OutDir = ".runtime\parallel-$Split-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$suffix"
}
$outPath = Resolve-EvaluationPath $repoRoot $OutDir
$suitePath = Resolve-EvaluationPath $repoRoot $Suite
if (-not (Test-Path -LiteralPath $suitePath -PathType Leaf)) { throw "Suite file not found: $suitePath" }
& $tsx eval/cli.ts verify-fixtures --suite $suitePath
if ($LASTEXITCODE -ne 0) { throw "Fixture verification failed (exit $LASTEXITCODE)." }
if ($CheckOnly) {
  Write-Host "Checked credentials/config paths and fixtures. Planned at most $($MaxRunsPerWorker * 2) slots in $outPath; global provider=$ProviderConcurrency sandbox=$SandboxConcurrency. No model or sandbox call."
  exit 0
}
$command = if ($Reconcile) { 'parallel-reconcile' } else { 'parallel-run' }
Write-Host "Two workers in one Node process; separate runner/application/budget/evidence directories: $outPath"
& $tsx eval/cli.ts $command --suite $suitePath --split $Split --repetitions $Repetitions --max-runs-per-worker $MaxRunsPerWorker `
  --provider-concurrency $ProviderConcurrency --sandbox-concurrency $SandboxConcurrency --out $outPath
$runExitCode = [int]$LASTEXITCODE
if ($runExitCode -ne 0) { Write-Host "Stopped. Preserve $outPath and inspect progress.json; no automatic retry."; exit $runExitCode }
Write-Host "To merge only when every slot is committed: pnpm eval merge-shards --suite `"$suitePath`" --root `"$outPath`" --split $Split --repetitions $Repetitions --mode real --out `"$outPath-merged`""

