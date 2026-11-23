[CmdletBinding()]
param(
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) {
  throw 'Set OPEN_SANDBOX_API_KEY in the current process before running the resource pressure probe.'
}

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExe = if ($dockerCommand) { $dockerCommand.Source } else { 'D:\Docker\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerExe)) { throw 'Docker CLI was not found.' }

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$reportName = "resource-pressure-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$suffix.json"
$reportDirectory = Join-Path $repositoryRoot '.runtime\sandbox-smoke'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null

$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldOutput = $env:RESOURCE_PRESSURE_SMOKE_OUTPUT
try {
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:RESOURCE_PRESSURE_SMOKE_OUTPUT = "/reports/$reportName"
  $client = 'cd /workspace && npm install --no-audit --no-fund --no-save @alibaba-group/opensandbox@1.2.1 tsx@4.23.15 && ./node_modules/.bin/tsx spikes/sandbox-smoke/resource-pressure-smoke.ts'
  Write-Host "Resource pressure report: $(Join-Path $reportDirectory $reportName)"
  $dockerArgs = @(
    'run', '--rm', '--network', $Network,
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', 'OPEN_SANDBOX_DOMAIN',
    '-e', 'OPEN_SANDBOX_IMAGE',
    '-e', 'OPEN_SANDBOX_API_KEY',
    '-e', 'RESOURCE_PRESSURE_SMOKE_OUTPUT',
    '-v', "${repositoryRoot}\src:/workspace/src:ro",
    '-v', "${PSScriptRoot}:/workspace/spikes/sandbox-smoke:ro",
    '-v', "${reportDirectory}:/reports",
    'node:22-bookworm',
    'sh', '-lc', ('mkdir -p /workspace && cd /workspace && npm init -y >/tmp/npm-init.log 2>&1 && npm pkg set type=module && ' + $client)
  )
  & $dockerExe @dockerArgs
  $exitCode = $LASTEXITCODE
} finally {
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:RESOURCE_PRESSURE_SMOKE_OUTPUT = $oldOutput
}
exit $exitCode
