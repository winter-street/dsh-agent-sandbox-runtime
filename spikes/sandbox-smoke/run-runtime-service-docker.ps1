param(
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535',
  [ValidateSet('service', 'process-recovery', 'process-recovery-after-destroy', 'destroy-transport-fault', 'create-response-loss', 'create-process-crash', 'deadline', 'deadline-wall-clock', 'normal-exit-tree', 'timeout-tree', 'timeout-order')][string]$Scenario = 'service'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) {
  throw 'Set OPEN_SANDBOX_API_KEY in this PowerShell process before running the RuntimeService smoke.'
}

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExe = if ($dockerCommand) { $dockerCommand.Source } else { 'D:\Docker\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerExe)) { throw 'Docker CLI was not found.' }

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$reportDirectory = Join-Path $repositoryRoot '.runtime\sandbox-smoke'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null

$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldOutput = $env:RUNTIME_SERVICE_SMOKE_OUTPUT
$oldProcessOutput = $env:RUNTIME_PROCESS_SMOKE_OUTPUT
$oldCrashWindow = $env:RUNTIME_PROCESS_CRASH_WINDOW
$oldDeadlineOutput = $env:RUNTIME_DEADLINE_SMOKE_OUTPUT
$oldDeadlineMode = $env:RUNTIME_DEADLINE_SMOKE_MODE
try {
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:RUNTIME_SERVICE_SMOKE_OUTPUT = if ($Scenario -in @('destroy-transport-fault', 'create-response-loss', 'create-process-crash')) { '/reports/' + $Scenario + '-' + [guid]::NewGuid().ToString('N') + '.json' } else { '/reports/runtime-service-smoke.json' }
  $env:RUNTIME_PROCESS_SMOKE_OUTPUT = if ($Scenario -eq 'process-recovery-after-destroy') { '/reports/process-recovery-after-destroy-smoke.json' } else { '/reports/process-recovery-smoke.json' }
  $env:RUNTIME_PROCESS_CRASH_WINDOW = if ($Scenario -eq 'process-recovery-after-destroy') { 'after-destroy' } else { 'after-publish' }
  $env:RUNTIME_DEADLINE_SMOKE_OUTPUT = '/reports/deadline-smoke-' + [guid]::NewGuid().ToString('N') + '.json'
  $env:RUNTIME_DEADLINE_SMOKE_MODE = if ($Scenario -eq 'deadline-wall-clock') { 'wall-clock' } else { 'advanced-clock' }
  $entrypoint = switch ($Scenario) {
    'process-recovery' { 'process-recovery-smoke.ts' }
    'process-recovery-after-destroy' { 'process-recovery-smoke.ts' }
    'normal-exit-tree' { 'runtime-normal-exit-tree.ts' }
    'timeout-tree' { 'runtime-timeout-tree.ts' }
    'timeout-order' { 'runtime-timeout-order.ts' }
    'destroy-transport-fault' { 'destroy-transport-fault-smoke.ts' }
    'create-response-loss' { 'create-response-loss-smoke.ts' }
    'create-process-crash' { 'create-process-crash-smoke.ts' }
    'deadline' { 'deadline-smoke.ts' }
    'deadline-wall-clock' { 'deadline-smoke.ts' }
    default { 'runtime-service-smoke.ts' }
  }
  $clientScript = 'mkdir -p /tmp/runtime-smoke-install && cd /tmp/runtime-smoke-install && npm init -y >/tmp/npm-init.log 2>&1 && ln -s /workspace/node_modules node_modules && npm install --no-audit --no-fund --no-save @alibaba-group/opensandbox@1.2.1 tsx@4.23.15 zod@4.6.7 >/tmp/npm-install.log 2>&1 && cd /workspace && ./node_modules/.bin/tsx spikes/sandbox-smoke/' + $entrypoint

  $dockerArgs = @('run', '--rm')
  if ($Scenario -in @('normal-exit-tree', 'timeout-tree')) { $dockerArgs += @('--pid', 'host') }
  $dockerArgs += @(
    '--network', $Network,
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'OPEN_SANDBOX_DOMAIN',
    '-e', 'OPEN_SANDBOX_IMAGE',
    '-e', 'OPEN_SANDBOX_API_KEY',
    '-e', 'RUNTIME_SERVICE_SMOKE_OUTPUT',
    '-e', 'RUNTIME_PROCESS_SMOKE_OUTPUT',
    '-e', 'RUNTIME_PROCESS_CRASH_WINDOW',
    '-e', 'RUNTIME_DEADLINE_SMOKE_OUTPUT',
    '-e', 'RUNTIME_DEADLINE_SMOKE_MODE',
    '-v', 'sandbox-smoke-runtime-node-modules:/workspace/node_modules',
    '-v', "${repositoryRoot}\src:/workspace/src:ro",
    '-v', "${repositoryRoot}\tests\support:/workspace/tests/support:ro",
    '-v', "${repositoryRoot}\config:/workspace/config:ro",
    '-v', "${repositoryRoot}\package.json:/workspace/package.json:ro",
    '-v', "${repositoryRoot}\pnpm-lock.yaml:/workspace/pnpm-lock.yaml:ro",
    '-v', "${PSScriptRoot}:/workspace/spikes/sandbox-smoke:ro",
    '-v', "${reportDirectory}:/reports",
    'node:22-bookworm',
    'sh', '-lc', $clientScript
  )
  & $dockerExe @dockerArgs
  $exitCode = $LASTEXITCODE
} finally {
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:RUNTIME_SERVICE_SMOKE_OUTPUT = $oldOutput
  $env:RUNTIME_PROCESS_SMOKE_OUTPUT = $oldProcessOutput
  $env:RUNTIME_PROCESS_CRASH_WINDOW = $oldCrashWindow
  $env:RUNTIME_DEADLINE_SMOKE_OUTPUT = $oldDeadlineOutput
  $env:RUNTIME_DEADLINE_SMOKE_MODE = $oldDeadlineMode
}

exit $exitCode
