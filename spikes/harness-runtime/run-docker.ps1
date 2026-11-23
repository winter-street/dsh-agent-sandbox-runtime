param(
  [ValidateSet('controlled', 'deepseek')][string]$Mode = 'controlled',
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535',
  [switch]$PrepareOnly,
  [switch]$AdapterTestsOnly,
  [switch]$PluginDisposal
)
$ErrorActionPreference = 'Stop'
$dockerExe = 'D:\Docker\DockerDesktop\resources\bin\docker.exe'
if (-not (Test-Path -LiteralPath $dockerExe)) { $dockerExe = (Get-Command docker -ErrorAction Stop).Source }
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$budgetLib = Join-Path $repositoryRoot '.sources\budget\lib'
if (-not (Test-Path -LiteralPath (Join-Path $budgetLib 'index.js'))) { throw 'Build the pinned patched budget plugin first; see integrations/budget/README.md.' }
$runIntegration = -not $PrepareOnly -and -not $AdapterTestsOnly
if ($runIntegration -and [string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) { throw 'Set OPEN_SANDBOX_API_KEY in this process before running.' }
if ($runIntegration -and $Mode -eq 'deepseek' -and [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) { throw 'DeepSeek mode requires DEEPSEEK_API_KEY; it never falls back to controlled mode.' }
$reports = Join-Path $repositoryRoot '.runtime\harness-runtime'
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldMode = $env:HARNESS_RUNTIME_MODE
try {
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:HARNESS_RUNTIME_MODE = $Mode
  $setup = 'mkdir -p /deps /workspace && cp /entry/package.json /deps/package.json && cd /deps && if [ -f /entry/package-lock.json ]; then cp /entry/package-lock.json package-lock.json && npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund >/tmp/harness-runtime-install.log 2>&1; else npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund >/tmp/harness-runtime-install.log 2>&1 && cp package-lock.json /entry/package-lock.json; fi && ln -s /deps/node_modules /workspace/node_modules'
  $command = if ($PrepareOnly) { $setup } else {
    $entryCommand = if ($AdapterTestsOnly) { 'node --test /workspace/spikes/harness-runtime/deepseek-adapter.test.mjs' } elseif ($PluginDisposal) { './node_modules/.bin/tsx /workspace/spikes/harness-runtime/plugin-disposal.mjs' } else { './node_modules/.bin/tsx /workspace/spikes/harness-runtime/run.mjs' }
    $setup + ' && mkdir -p /workspace/spikes/harness-runtime && cp /entry/*.mjs /workspace/spikes/harness-runtime/ && cd /workspace && ' + $entryCommand
  }
  $containerNetwork = if ($runIntegration) { $Network } else { 'bridge' }
  $arguments = @('run', '--rm', '--network', $containerNetwork, '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'OPEN_SANDBOX_DOMAIN', '-e', 'OPEN_SANDBOX_IMAGE', '-e', 'HARNESS_RUNTIME_MODE',
    '-v', 'harness-runtime-node-modules:/deps/node_modules',
    '-v', "${repositoryRoot}\package.json:/workspace/package.json:ro",
    '-v', "${repositoryRoot}\pnpm-lock.yaml:/workspace/pnpm-lock.yaml:ro",
    '-v', "${repositoryRoot}\src:/workspace/src:ro", '-v', "${repositoryRoot}\config:/workspace/config:ro",
    '-v', "${budgetLib}:/workspace/.sources/budget/lib:ro",
    '-v', "${PSScriptRoot}:/entry", '-v', "${reports}:/reports")
  # Pass secret names, never secret values on the command line or in the report.
  if ($runIntegration) { $arguments += @('-e', 'OPEN_SANDBOX_API_KEY') }
  if ($runIntegration -and $Mode -eq 'deepseek') { $arguments += @('-e', 'DEEPSEEK_API_KEY', '-e', 'DEEPSEEK_MODEL') }
  $arguments += @('node:22-bookworm', 'sh', '-lc', $command)
  & $dockerExe @arguments
  $smokeExit = $LASTEXITCODE
} finally {
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:HARNESS_RUNTIME_MODE = $oldMode
}
exit $smokeExit
