[CmdletBinding()]
param(
  [string]$OutDir = '.runtime\evaluation-final-20261117',
  [string]$ReportDir = '.runtime\evaluation-final-report',
  [string]$EnvFile = '.env.local',
  [ValidateRange(1, 180)]
  [int]$BatchSize = 45,
  [ValidateRange(1, 20)]
  [int]$MaxCycles = 20
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

. (Join-Path $PSScriptRoot 'evaluation-env.ps1')
Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile

$suite = Get-Content 'eval\suite.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $suite.frozenForFinalEvaluation -or $suite.phase -ne 'frozen-for-final-evaluation') {
  throw 'eval/suite.json is not frozen-for-final-evaluation.'
}

$outPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutDir))
$reportPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $ReportDir))
$planPath = [IO.Path]::GetFullPath((Join-Path $repoRoot '.runtime\evaluation-plan-final.json'))

if (Test-Path -LiteralPath $planPath) {
  $plan = Get-Content $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($plan.split -ne 'evaluation' -or $plan.repetitions -ne 3 -or $plan.runs.Count -ne 180 -or -not $plan.frozenForFinalEvaluation) {
    throw 'Existing final evaluation plan is not the expected frozen 180-slot plan.'
  }
} else {
  & pnpm eval plan --split evaluation --repetitions 3 --out $planPath
  if ($LASTEXITCODE -ne 0) { throw "Could not create final evaluation plan (exit $LASTEXITCODE)." }
}

function Get-RecordCount {
  $recordsPath = Join-Path $outPath 'records.jsonl'
  if (-not (Test-Path -LiteralPath $recordsPath)) { return 0 }
  return @((Get-Content -LiteralPath $recordsPath | Where-Object { $_.Trim() })).Count
}

function Invoke-Evaluation([string]$Command, [int]$Limit) {
  $output = & pnpm eval $Command `
    --driver eval/runtime-driver.ts `
    --mode real `
    --split evaluation `
    --repetitions 3 `
    --max-runs $Limit `
    --out $outPath
  foreach ($line in $output) { Write-Host $line }
  $exitCode = [int]$LASTEXITCODE
  return $exitCode
}

& pnpm eval verify-fixtures
if ($LASTEXITCODE -ne 0) { throw "Fixture verification failed (exit $LASTEXITCODE)." }

$target = 180
for ($cycle = 1; $cycle -le $MaxCycles -and (Get-RecordCount) -lt $target; $cycle++) {
  $before = Get-RecordCount
  $exit = Invoke-Evaluation 'run' $BatchSize
  $afterRun = Get-RecordCount

  if ($exit -eq 2) {
    Write-Host "Evaluation stopped by the runtime infrastructure circuit. No reconciliation or automatic retry will be attempted. Keep $outPath, restore sandbox health, then resume deliberately."
    exit 2
  }

  if ($exit -ne 0) {
    Write-Host "run exited with $exit; reconciling pending slots in the same directory."
    $reconcileExit = Invoke-Evaluation 'reconcile' $target
    if ($reconcileExit -ne 0) { throw "Reconciliation failed (exit $reconcileExit). Keep $outPath for investigation." }
  }

  $after = Get-RecordCount
  Write-Host "cycle=$cycle records=$after/$target (before=$before, afterRun=$afterRun)"
  if ($after -le $before) {
    throw "No evaluation progress in cycle $cycle. Keep $outPath and inspect pending slots before retrying."
  }
}

if ((Get-RecordCount) -ne $target) {
  throw "Final evaluation is incomplete: $(Get-RecordCount)/$target records. Keep $outPath and resume with the same script."
}

if (Test-Path -LiteralPath $reportPath) {
  $existingReport = Join-Path $reportPath 'report.json'
  if (-not (Test-Path -LiteralPath $existingReport)) { throw "Report directory already exists without report.json: $reportPath" }
  $report = Get-Content $existingReport -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($report.recordedRuns -ne $target -or $report.expectedRuns -ne $target) { throw "Report directory contains a different evaluation: $reportPath" }
  if (-not $report.finalEvaluationEligible) { throw "Existing report has complete coverage but finalEvaluationEligible=false: $reportPath. Preserve all records and inspect task outcomes and eligibilityBlockers. Failed tasks are evaluation results; do not rerun the batch merely to make this flag true. Generate any expanded offline report in a new ReportDir." }
  Write-Host "Existing complete report retained: $reportPath"
} else {
  & pnpm eval report `
    --mode real `
    --split evaluation `
    --repetitions 3 `
    --records (Join-Path $outPath 'records.jsonl') `
    --out $reportPath
  if ($LASTEXITCODE -ne 0) { throw "Report generation failed (exit $LASTEXITCODE)." }
}

$final = Get-Content (Join-Path $reportPath 'report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[pscustomobject]@{
  Records = $final.recordedRuns
  Expected = $final.expectedRuns
  EvaluationDataComplete = $final.evaluationDataComplete
  Acceptance = $final.acceptance
  EligibilityBlockers = $final.eligibilityBlockers
  FinalEvaluationEligible = $final.finalEvaluationEligible
  Report = $reportPath
} | ConvertTo-Json
