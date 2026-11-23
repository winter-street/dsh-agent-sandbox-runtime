[CmdletBinding()]
param(
  [string]$OutDir = '',
  [string]$EnvFile = '.env.local',
  [switch]$Calibration,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot
. (Join-Path $PSScriptRoot 'evaluation-env.ps1')
Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile

$split = 'evaluation'
$maxRuns = 1
$suite = Get-Content -LiteralPath (Join-Path $repoRoot 'eval\suite.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$variants = @('hard-only', 'tiered', 'tiered-finalize')
$evaluationTasks = @($suite.tasks | Where-Object { $_.split -eq 'evaluation' })
if ($evaluationTasks.Count -eq 0) { throw 'No evaluation task is available for the single-slot smoke.' }
$expectedSlots = @("$($evaluationTasks[0].id)/hard-only/1")
if ($Calibration) {
  $split = 'calibration'
  $calibrationTasks = @($suite.tasks | Where-Object { $_.split -eq 'calibration' })
  if ($calibrationTasks.Count -ne 5) { throw 'The bounded calibration smoke requires exactly five calibration tasks.' }
  $maxRuns = 15
  $expectedSlots = @($variants | ForEach-Object {
    $variant = $_
    foreach ($task in $calibrationTasks) { "$($task.id)/$variant/1" }
  })
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $prefix = if ($Calibration) { 'calibration-smoke' } else { 'evaluation-smoke' }
  $OutDir = ".runtime\$prefix-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$suffix"
}
$outPath = Resolve-EvaluationPath $repoRoot $OutDir
if (Test-Path -LiteralPath $outPath) {
  throw "Smoke output directory already exists: $outPath. Keep its evidence and choose a new -OutDir."
}

& pnpm eval verify-fixtures
if ($LASTEXITCODE -ne 0) { throw "Fixture verification failed (exit $LASTEXITCODE)." }

if ($CheckOnly) {
  Write-Host 'Configuration paths, required credentials and fixture hashes checked. No model or sandbox was called.'
  Write-Host "Planned smoke: $maxRuns $split slot(s), one repetition."
  Write-Host "Proposed output directory: $outPath"
  exit 0
}

Write-Host "Running $maxRuns real $split slot(s), one repetition. Output: $outPath"
& pnpm eval run `
  --driver eval/runtime-driver.ts `
  --mode real `
  --split $split `
  --repetitions 1 `
  --max-runs $maxRuns `
  --out $outPath
$runExitCode = [int]$LASTEXITCODE
if ($runExitCode -ne 0) {
  Write-Host "Smoke stopped (exit $runExitCode). Keep $outPath; no automatic retry was attempted."
  exit $runExitCode
}

$recordsPath = Join-Path $outPath 'records.jsonl'
if (-not (Test-Path -LiteralPath $recordsPath -PathType Leaf)) {
  throw "Smoke produced no committed record. Inspect $outPath before retrying."
}
$records = @(Get-Content -LiteralPath $recordsPath -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
if ($records.Count -ne $maxRuns) { throw "Expected $maxRuns committed smoke record(s), found $($records.Count). Keep $outPath." }
$actualSlots = @($records | ForEach-Object { "$($_.taskId)/$($_.variant)/$($_.repetition)" })
if (@($actualSlots | Select-Object -Unique).Count -ne $maxRuns -or @(Compare-Object $expectedSlots $actualSlots).Count -gt 0) {
  throw "Smoke records do not match the requested task/variant/repetition coverage. Keep $outPath."
}
$results = @(foreach ($record in $records) {
  $validation = Get-Content -LiteralPath $record.evidence.validation -Raw -Encoding UTF8 | ConvertFrom-Json
  $modelResponses = @()
  $modelAdmissionRejections = @()
  if ($record.evidence.trace -and (Test-Path -LiteralPath $record.evidence.trace -PathType Leaf)) {
    $trace = Get-Content -LiteralPath $record.evidence.trace -Raw -Encoding UTF8 | ConvertFrom-Json
    $modelResponses = @($trace | Where-Object { $_.type -eq 'model.response' } | ForEach-Object { $_.payload } |
      Select-Object finishReason, requestedMaxTokens, textChars, reasoningChars, toolCalls, usageReported)
    $modelAdmissionRejections = @($trace | Where-Object { $_.type -eq 'model.admission-rejected' } | ForEach-Object { $_.payload } |
      Select-Object code, disposition, reasons, requestedMaxTokens)
  }
  [pscustomobject]@{
    Passed = $record.outcome -eq 'complete' -and $validation.passed -eq $true
    TaskId = $record.taskId
    Variant = $record.variant
    Outcome = $record.outcome
    FailureKind = $record.failureKind
    StatisticsPassed = $validation.statistics
    ReportPassed = $validation.checks.report
    ChartPassed = $validation.checks.chart
    ArtifactCount = @($record.evidence.artifacts).Count
    Problems = @($validation.problems)
    ModelResponses = $modelResponses
    ModelAdmissionRejections = $modelAdmissionRejections
    Records = $recordsPath
    Validation = $record.evidence.validation
    Trace = $record.evidence.trace
  }
})
$passed = @($results | Where-Object { -not $_.Passed }).Count -eq 0
if ($Calibration) {
  $summaryPath = Join-Path $outPath 'smoke-summary.json'
  [pscustomobject]@{ Passed = $passed; Split = $split; RecordedSlots = $records.Count; ExpectedSlots = $maxRuns; Results = $results } |
    ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
  $results | Format-Table TaskId, Variant, Passed, Outcome, FailureKind, ArtifactCount -AutoSize | Out-Host
  [pscustomobject]@{
    Passed = $passed
    Split = $split
    RecordedSlots = $records.Count
    ExpectedSlots = $maxRuns
    PassedSlots = @($results | Where-Object { $_.Passed }).Count
    FailedSlots = @($results | Where-Object { -not $_.Passed }).Count
    Records = $recordsPath
    Summary = $summaryPath
  } | ConvertTo-Json
} else {
  $results[0] | ConvertTo-Json -Depth 5
}
Write-Host 'This diagnostic smoke does not qualify as a complete final evaluation.'
if (-not $passed) { exit 1 }
