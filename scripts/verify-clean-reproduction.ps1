[CmdletBinding()]
param([string]$OutDir = '', [string]$BudgetSource = '', [switch]$Online)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $repoRoot ('.runtime\clean-reproduction-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)) }
$target = [IO.Path]::GetFullPath($OutDir)
if (Test-Path -LiteralPath $target) { throw 'Clean reproduction target must be new; no existing directory is modified.' }
New-Item -ItemType Directory -Path $target | Out-Null
# Copy only non-ignored files inside the public source allowlist. Include local changes in the snapshot.
$sourceEntries = @('src', 'tests', 'config', 'eval', 'examples', 'integrations', 'scripts', 'docs', 'spikes', '.github',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts',
  '.env.example', '.gitattributes', '.gitignore', 'README.md', 'AGENT_RUNTIME_PLAN.md', 'AGENT_RUNTIME_TASKS.md')
$gitBase = & git -C $repoRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Cannot identify source Git base in $repoRoot" }
$paths = & git -C $repoRoot -c core.quotepath=false ls-files --cached --others --exclude-standard -- @sourceEntries
if ($LASTEXITCODE -ne 0) { throw "Cannot enumerate public source in $repoRoot" }
$sourceFiles = @(foreach ($relative in ($paths | Sort-Object -Unique)) {
  if ($relative -ne '.env.example' -and $relative -match '(^|/)\.env(?:\.|$)') { continue }
  $source = Join-Path $repoRoot $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
  $destination = Join-Path $target $relative
  [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
  [pscustomobject]@{ Path = $relative; Sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() }
})
if ($sourceFiles.Count -eq 0) { throw 'No public source files found for reproduction.' }
$manifest = Join-Path $target 'source-manifest.json'
[pscustomobject]@{ SchemaVersion = 1; GitBase = $gitBase; Source = 'working tree'; Files = $sourceFiles } |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifest -Encoding UTF8
Set-Location $target
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE); evidence kept in $target" }
}
$baseline = '28c77462aa20ceb27acc0cec99db0dea11087dbc'
if ([string]::IsNullOrWhiteSpace($BudgetSource)) { $BudgetSource = Join-Path $repoRoot '.sources\budget' }
New-Item -ItemType Directory -Path (Join-Path $target '.sources') | Out-Null
# Local Git object source avoids network; a clean detached checkout receives only the tracked patch.
Invoke-Checked 'git' @('clone', '--no-hardlinks', '--no-checkout', $BudgetSource, '.sources/budget')
Invoke-Checked 'git' @('-C', '.sources/budget', '-c', 'core.autocrlf=false', 'checkout', '--detach', $baseline)
$patch = Join-Path $target 'integrations\budget\reservations.patch'
Invoke-Checked 'git' @('-C', '.sources/budget', 'apply', '--check', $patch)
Invoke-Checked 'git' @('-C', '.sources/budget', 'apply', $patch)
# Git attributes added by a patch do not rewrite files already checked out on Windows.
# Keep executable shebang scripts LF even when the source archive was stored with CRLF.
foreach ($scriptPath in Get-ChildItem -LiteralPath (Join-Path $target '.sources\budget\scripts') -Filter '*.mjs' -File) {
  $scriptText = [IO.File]::ReadAllText($scriptPath.FullName).Replace("`r`n", "`n")
  [IO.File]::WriteAllText($scriptPath.FullName, $scriptText, [Text.UTF8Encoding]::new($false))
}
$installArgs = @('install', '--frozen-lockfile', '--ignore-scripts')
if (-not $Online) { $installArgs += '--offline' }
# A provider smoke from the pinned budget source is enabled by the presence of a key.
# Exercise the local budget integration suites while preventing credential inheritance.
$savedEnvironment = @{}
foreach ($key in @('DEEPSEEK_API_KEY', 'OPEN_SANDBOX_API_KEY', 'RUNTIME_BUDGET_INTEGRATION')) {
  $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
  [Environment]::SetEnvironmentVariable($key, $null, 'Process')
}
try {
  $env:RUNTIME_BUDGET_INTEGRATION = '1'
  Invoke-Checked 'pnpm.cmd' (@('--dir', '.sources/budget') + $installArgs)
  Invoke-Checked 'pnpm.cmd' @('--dir', '.sources/budget', 'check')
  Invoke-Checked 'pnpm.cmd' $installArgs
  Invoke-Checked 'pnpm.cmd' @('check')
  Invoke-Checked 'node' @('--import', 'tsx', 'eval/cli.ts', 'verify-fixtures', '--suite', 'eval/suite-n05-v2.json')
} finally {
  foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
}
[pscustomobject]@{
  Passed = $true
  Output = $target
  GitBase = $gitBase
  SourceFileCount = $sourceFiles.Count
  SourceManifestSha256 = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
  BudgetBaseline = $baseline
  PatchSha256 = (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant()
  RuntimeLockSha256 = (Get-FileHash -LiteralPath 'pnpm-lock.yaml' -Algorithm SHA256).Hash.ToLowerInvariant()
  BudgetLockSha256 = (Get-FileHash -LiteralPath '.sources/budget/pnpm-lock.yaml' -Algorithm SHA256).Hash.ToLowerInvariant()
  DependencyInstall = $(if ($Online) { 'locked online' } else { 'locked offline store' })
  BudgetIntegrationEnabled = $true
  LiveServices = $false
  Limitation = 'Fresh source and dependency directories on the same host with local Git objects and pnpm store.'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'reproduction.json') -Encoding UTF8
Write-Host "Clean source reproduction passed. Evidence: $target\reproduction.json"
