param(
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) {
  throw 'Set OPEN_SANDBOX_API_KEY in this PowerShell process before running the Docker client smoke.'
}

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExe = if ($dockerCommand) { $dockerCommand.Source } else { 'D:\Docker\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerExe)) {
  throw 'Docker CLI was not found. Add Docker Desktop resources\bin to PATH or pass the installed CLI through PATH.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$smokeFile = (Resolve-Path (Join-Path $PSScriptRoot 'smoke.ts')).Path
$reportDirectory = Join-Path $repositoryRoot '.runtime\sandbox-smoke'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null

$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldOutput = $env:SANDBOX_SMOKE_OUTPUT
try {
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:SANDBOX_SMOKE_OUTPUT = '/reports'

  $dockerArgs = @(
    'run', '--rm', '--network', $Network,
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'OPEN_SANDBOX_DOMAIN',
    '-e', 'OPEN_SANDBOX_IMAGE',
    '-e', 'OPEN_SANDBOX_API_KEY',
    '-e', 'SANDBOX_SMOKE_OUTPUT',
    '-v', 'sandbox-smoke-node-modules:/probe/node_modules',
    '-v', "${smokeFile}:/tmp/smoke.ts:ro",
    '-v', "${reportDirectory}:/reports",
    'node:22-bookworm',
    'sh', '-lc', 'mkdir -p /probe && npm install --prefix /probe --no-audit --no-fund @alibaba-group/opensandbox@1.2.1 tsx@4.20.3 typescript@5.8.3 >/tmp/npm-install.log 2>&1 && npm pkg set type=module --prefix /probe && cp /tmp/smoke.ts /probe/smoke.ts && cd /probe && ./node_modules/.bin/tsx smoke.ts'
  )
  & $dockerExe @dockerArgs
  $exitCode = $LASTEXITCODE
} finally {
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:SANDBOX_SMOKE_OUTPUT = $oldOutput
}

exit $exitCode
