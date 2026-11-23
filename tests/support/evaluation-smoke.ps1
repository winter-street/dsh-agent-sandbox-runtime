param([string]$RepoRoot, [string]$CheckRoot, [string]$Scenario, [switch]$Calibration)
$ErrorActionPreference = 'Stop'
foreach ($name in @('DEEPSEEK_API_KEY', 'OPEN_SANDBOX_API_KEY', 'ASR_EVAL_CONFIG_HARD_ONLY', 'ASR_EVAL_CONFIG_TIERED', 'ASR_EVAL_CONFIG_FINALIZE')) {
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$fakeEnv = Join-Path $CheckRoot 'dummy.env'
[IO.File]::WriteAllText($fakeEnv, "DEEPSEEK_API_KEY=offline-placeholder`nOPEN_SANDBOX_API_KEY=offline-placeholder`n")
$outPath = Join-Path $CheckRoot 'out'
$commandLog = Join-Path $CheckRoot 'commands.jsonl'
if ($Scenario -eq 'existing') { [void](New-Item -ItemType Directory -Path $outPath) }
function global:pnpm {
  [IO.File]::AppendAllText($commandLog, ((@{ args = @($args) } | ConvertTo-Json -Compress) + "`n"))
  if ($args[0] -ne 'eval') { throw 'Unexpected package command' }
  if ($args[1] -eq 'verify-fixtures') { $global:LASTEXITCODE = 0; return }
  if ($args[1] -ne 'run') { throw 'Unexpected evaluation command' }
  $limit = if ($Calibration) { '15' } else { '1' }
  $split = if ($Calibration) { 'calibration' } else { 'evaluation' }
  foreach ($pair in @(@('--max-runs', $limit), @('--repetitions', '1'), @('--mode', 'real'), @('--split', $split))) {
    $argIndex = [Array]::IndexOf($args, $pair[0])
    if ($argIndex -lt 0 -or [string]$args[$argIndex + 1] -ne $pair[1]) { throw 'Unexpected evaluation limit/mode/split' }
  }
  foreach ($name in @('ASR_EVAL_CONFIG_HARD_ONLY', 'ASR_EVAL_CONFIG_TIERED', 'ASR_EVAL_CONFIG_FINALIZE')) {
    $configPath = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not [IO.Path]::IsPathRooted($configPath) -or -not (Test-Path -LiteralPath $configPath)) { throw 'Missing initialized configuration' }
  }
  if ($Scenario -eq 'infrastructure') { $global:LASTEXITCODE = 2; return }
  [void](New-Item -ItemType Directory -Path $outPath)
  $suite = Get-Content -LiteralPath (Join-Path $RepoRoot 'eval\suite.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $tasks = @($suite.tasks | Where-Object { $_.split -eq $split })
  if (-not $Calibration) { $tasks = @($tasks[0]) }
  $variants = if ($Calibration) { @('hard-only', 'tiered', 'tiered-finalize') } else { @('hard-only') }
  $index = 0
  foreach ($variant in $variants) {
    foreach ($task in $tasks) {
      $index++
      $passed = -not ($Scenario -eq 'validation' -and $index -eq [int]$limit)
      $validationPath = Join-Path $outPath "validation-$index.json"
      @{ statistics = $passed; passed = $passed; checks = @{ report = $passed; chart = $passed }; problems = @() } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $validationPath -Encoding UTF8
      $taskId = if ($Scenario -eq 'coverage' -and $index -eq 15) { $tasks[0].id } else { $task.id }
      @{ taskId = $taskId; variant = $variant; repetition = 1; outcome = $(if ($passed) { 'complete' } else { 'partial' });
        failureKind = $(if ($passed) { $null } else { 'validation' }); evidence = @{ validation = $validationPath; artifacts = @('statistics', 'report', 'chart') } } |
        ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath (Join-Path $outPath 'records.jsonl') -Encoding UTF8
    }
  }
  $global:LASTEXITCODE = 0
}
& (Join-Path $RepoRoot 'scripts\run-evaluation-smoke.ps1') -EnvFile $fakeEnv -OutDir $outPath -Calibration:$Calibration -CheckOnly:($Scenario -eq 'check-only')
exit $LASTEXITCODE
