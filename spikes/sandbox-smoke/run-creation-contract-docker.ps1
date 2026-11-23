param(
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535'
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) { throw 'Set OPEN_SANDBOX_API_KEY in this PowerShell process before running the creation contract smoke.' }
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExe = if ($dockerCommand) { $dockerCommand.Source } else { 'D:\Docker\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerExe)) { throw 'Docker CLI was not found.' }
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$reportDirectory = Join-Path $repositoryRoot '.runtime\sandbox-smoke'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldOutput = $env:CREATION_CONTRACT_SMOKE_OUTPUT
try {
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:CREATION_CONTRACT_SMOKE_OUTPUT = '/reports/creation-contract-smoke.json'
  $dockerArgs = @(
    'run', '--rm', '--network', $Network,
    '-e', 'OPEN_SANDBOX_DOMAIN', '-e', 'OPEN_SANDBOX_IMAGE', '-e', 'OPEN_SANDBOX_API_KEY', '-e', 'CREATION_CONTRACT_SMOKE_OUTPUT',
    '-v', 'sandbox-smoke-contract-node-modules:/workspace/node_modules',
    '-v', "${repositoryRoot}\spikes\sandbox-smoke:/workspace/spikes/sandbox-smoke:ro",
    '-v', "${reportDirectory}:/reports",
    'node:22-bookworm', 'sh', '-lc', 'cd /workspace && npm init -y >/tmp/npm-init.log 2>&1 && npm install --no-audit --no-fund --no-save @alibaba-group/opensandbox@1.2.1 tsx@4.23.15 >/tmp/npm-install.log 2>&1 && npm pkg set type=module && ./node_modules/.bin/tsx spikes/sandbox-smoke/creation-contract-smoke.ts'
  )
  & $dockerExe @dockerArgs
  $exitCode = $LASTEXITCODE
} finally {
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:CREATION_CONTRACT_SMOKE_OUTPUT = $oldOutput
}
exit $exitCode
