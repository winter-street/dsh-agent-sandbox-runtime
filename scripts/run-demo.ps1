[CmdletBinding()]
param([string]$OutDir = '', [string]$EnvFile = '.env.local', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot
. (Join-Path $PSScriptRoot 'evaluation-env.ps1')
Initialize-EvaluationEnvironment -RepoRoot $repoRoot -EnvFile $EnvFile
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $OutDir = ".runtime\demo-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$suffix"
}
$outPath = Resolve-EvaluationPath $repoRoot $OutDir
if (Test-Path -LiteralPath $outPath) { throw 'Demo directory already exists; preserve it and choose another -OutDir.' }
& pnpm eval verify-fixtures
if ($LASTEXITCODE -ne 0) { throw "Fixture verification failed (exit $LASTEXITCODE)." }
if ($CheckOnly) { Write-Host 'Configured one synthetic-input demo; no model/sandbox called.'; exit 0 }
& pnpm eval demo --out $outPath
$demoExitCode = [int]$LASTEXITCODE
if ($demoExitCode -ne 0) { Write-Host "Demo stopped. Preserve $outPath; no automatic retry."; exit $demoExitCode }
Write-Host "Open delivery files in: $outPath\delivery"
