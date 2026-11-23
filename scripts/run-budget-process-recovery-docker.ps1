[CmdletBinding()]
param(
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535',
  [ValidateSet('after-dispatch-intent', 'after-execute', 'after-publish')]
  [string]$CrashPoint = 'after-publish'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'evaluation-env.ps1')
Initialize-EvaluationEnvironment $repositoryRoot

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExe = if ($dockerCommand) { $dockerCommand.Source } else { 'D:\Docker\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerExe)) { throw 'Docker CLI was not found.' }
if ([string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) { throw 'Set OPEN_SANDBOX_API_KEY in this PowerShell process before running.' }

$reportDirectory = Join-Path $repositoryRoot '.runtime\sandbox-smoke'
$budgetLib = Join-Path $repositoryRoot '.sources\budget\lib'
if (-not (Test-Path -LiteralPath (Join-Path $budgetLib 'index.js'))) { throw 'Build the pinned patched budget plugin first; see integrations/budget/README.md.' }
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null

$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldOutput = $env:RUNTIME_BUDGET_RECOVERY_OUTPUT
$oldCrashPoint = $env:RUNTIME_BUDGET_RECOVERY_CRASH_POINT
try {
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:RUNTIME_BUDGET_RECOVERY_CRASH_POINT = $CrashPoint
  $reportName = if ($CrashPoint -eq 'after-publish') { 'budget-process-recovery-smoke.json' } else { "budget-process-recovery-$CrashPoint.json" }
  $env:RUNTIME_BUDGET_RECOVERY_OUTPUT = "/reports/$reportName"
  $setup = 'mkdir -p /deps /workspace && cp /entry/package.json /deps/package.json && cp /entry/package.json /workspace/package.json && cd /deps && (npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund >/tmp/budget-recovery-install.log 2>&1 || (cat /tmp/budget-recovery-install.log; exit 1)) && (npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund --no-save @deepseek-ai/dsh-attachment@0.1.0-rc.8 @deepseek-ai/dsh-brand@0.1.0-rc.8 @deepseek-ai/dsh-code-runtime@0.1.0-rc.8 @deepseek-ai/dsh-invariants@0.1.0-rc.8 @deepseek-ai/dsh-scope@0.1.0-rc.8 @deepseek-ai/dsh-session-persistence@0.1.0-rc.8 @deepseek-ai/dsh-settings@0.1.0-rc.8 @deepseek-ai/dsh-timeout@0.1.0-rc.8 @deepseek-ai/dsh-typert-protocol@0.1.0-rc.6 @deepseek-ai/dsh-user-approval@0.1.0-rc.8 >/tmp/budget-recovery-peers.log 2>&1 || (cat /tmp/budget-recovery-peers.log; exit 1)) && ln -s /deps/node_modules /workspace/node_modules'
  $command = $setup + ' && mkdir -p /workspace/spikes/sandbox-smoke && cp /entry/budget-process-recovery-smoke.ts /workspace/spikes/sandbox-smoke/ && cd /workspace && ./node_modules/.bin/tsx spikes/sandbox-smoke/budget-process-recovery-smoke.ts'
  $dockerArgs = @(
    'run', '--rm', '--network', $Network,
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'OPEN_SANDBOX_DOMAIN', '-e', 'OPEN_SANDBOX_IMAGE', '-e', 'OPEN_SANDBOX_API_KEY', '-e', 'RUNTIME_BUDGET_RECOVERY_OUTPUT', '-e', 'RUNTIME_BUDGET_RECOVERY_CRASH_POINT',
    '-v', "${repositoryRoot}\package.json:/entry/package.json:ro",
    '-v', "${repositoryRoot}\pnpm-lock.yaml:/workspace/pnpm-lock.yaml:ro",
    '-v', "${repositoryRoot}\src:/workspace/src:ro",
    '-v', "${repositoryRoot}\config:/workspace/config:ro",
    '-v', "${budgetLib}:/workspace/.sources/budget/lib:ro",
    '-v', "${repositoryRoot}\spikes\sandbox-smoke\budget-process-recovery-smoke.ts:/entry/budget-process-recovery-smoke.ts:ro",
    '-v', "${reportDirectory}:/reports",
    'node:22-bookworm', 'sh', '-lc', $command
  )
  & $dockerExe @dockerArgs
  $exitCode = $LASTEXITCODE
} finally {
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:RUNTIME_BUDGET_RECOVERY_OUTPUT = $oldOutput
  $env:RUNTIME_BUDGET_RECOVERY_CRASH_POINT = $oldCrashPoint
}
exit $exitCode
