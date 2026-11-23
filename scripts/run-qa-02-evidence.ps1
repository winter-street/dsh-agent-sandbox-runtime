param(
  [string]$Out = ""
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
if ([string]::IsNullOrWhiteSpace($Out)) {
  $Out = Join-Path $repo (".runtime/qa-02-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
}

Write-Host "Running controlled QA-02 evidence. Output: $Out"
& node --import tsx eval/cli.ts qa-02 --out $Out
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) { exit $exitCode }
Write-Host "QA-02 evidence written to $Out"
