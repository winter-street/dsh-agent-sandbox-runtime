param(
  [switch]$Detached,
  [switch]$VerifyDestroy,
  [switch]$NormalExit,
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535'
)
$ErrorActionPreference = 'Stop'
if ($NormalExit -and (-not $Detached -or -not $VerifyDestroy)) { throw 'Use -Detached -VerifyDestroy with -NormalExit.' }
if ($VerifyDestroy -and -not $Detached) { throw 'Use -Detached with -VerifyDestroy.' }
if ([string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) { throw 'Set OPEN_SANDBOX_API_KEY in this process.' }
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExe = if ($dockerCommand) { $dockerCommand.Source } else { 'D:\Docker\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerExe)) { throw 'Docker CLI was not found.' }
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$reportDirectory = Join-Path $repositoryRoot '.runtime\sandbox-smoke'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldOutput = $env:PROCESS_TREE_OUTPUT
$oldDetached = $env:PROCESS_TREE_DETACHED
$oldVerifyDestroy = $env:PROCESS_TREE_VERIFY_DESTROY
$oldNormalExit = $env:PROCESS_TREE_NORMAL_EXIT
try {
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:PROCESS_TREE_DETACHED = if ($Detached) { '1' } else { '0' }
  $env:PROCESS_TREE_VERIFY_DESTROY = if ($VerifyDestroy) { '1' } else { '0' }
  $env:PROCESS_TREE_NORMAL_EXIT = if ($NormalExit) { '1' } else { '0' }
  $env:PROCESS_TREE_OUTPUT = '/reports/process-tree-' + [guid]::NewGuid().ToString('N') + '.json'
  $dockerArgs = @('run', '--rm')
  if ($VerifyDestroy) { $dockerArgs += @('--pid', 'host') }
  $dockerArgs += @('--network', $Network, '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'OPEN_SANDBOX_DOMAIN', '-e', 'OPEN_SANDBOX_IMAGE', '-e', 'OPEN_SANDBOX_API_KEY', '-e', 'PROCESS_TREE_OUTPUT', '-e', 'PROCESS_TREE_DETACHED', '-e', 'PROCESS_TREE_VERIFY_DESTROY', '-e', 'PROCESS_TREE_NORMAL_EXIT',
    '-v', 'sandbox-smoke-adapter-node-modules:/workspace/node_modules',
    '-v', "${repositoryRoot}\src:/workspace/src:ro", '-v', "${PSScriptRoot}:/workspace/spikes/sandbox-smoke:ro",
    '-v', "${reportDirectory}:/reports", 'node:22-bookworm', 'sh', '-lc',
    'cd /workspace && npm init -y >/tmp/npm-init.log 2>&1 && npm install --no-audit --no-fund --no-save @alibaba-group/opensandbox@1.2.1 tsx@4.20.3 typescript@5.8.3 >/tmp/npm-install.log 2>&1 && npm pkg set type=module && ./node_modules/.bin/tsx spikes/sandbox-smoke/process-tree-smoke.ts')
  & $dockerExe @dockerArgs
  $exitCode = $LASTEXITCODE
} finally {
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:PROCESS_TREE_OUTPUT = $oldOutput
  $env:PROCESS_TREE_DETACHED = $oldDetached
  $env:PROCESS_TREE_VERIFY_DESTROY = $oldVerifyDestroy
  $env:PROCESS_TREE_NORMAL_EXIT = $oldNormalExit
}
exit $exitCode
