param(
  [string]$Network = 'sandbox-smoke_opensandbox-net',
  [string]$ServerContainer = 'opensandbox-server',
  [string]$ServiceDomain = 'http://opensandbox-server:8090',
  [string]$PythonImage = 'python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535'
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:OPEN_SANDBOX_API_KEY)) { throw 'Set OPEN_SANDBOX_API_KEY in this process; never pass it as a command argument.' }
$dockerExe = 'D:\Docker\DockerDesktop\resources\bin\docker.exe'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$reportDirectory = Join-Path $repositoryRoot '.runtime\sandbox-isolation'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
foreach ($file in @('inventory-request.json','inventory-done.json','inventory.json','isolation.json','orchestrator.json')) {
  $path = Join-Path $reportDirectory $file
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
}
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 10)
$peerName = 'runtime-isolation-peer-' + $suffix
$clientName = 'runtime-isolation-client-' + $suffix
$createdNames = @()
$oldDomain = $env:OPEN_SANDBOX_DOMAIN
$oldImage = $env:OPEN_SANDBOX_IMAGE
$oldPeer = $env:ISOLATION_PEER_IP
$exitCode = 1
try {
  $deploymentProjection = @'
import json
from opensandbox_server.config import get_config
c=get_config()
print(json.dumps({'egressMode':c.egress.mode,'publishHost':c.docker.publish_host,'networkMode':c.docker.network_mode,'noNewPrivileges':c.docker.no_new_privileges}))
'@
  $deploymentJson = $deploymentProjection | & $dockerExe exec -i $ServerContainer python -
  if ($LASTEXITCODE -ne 0) { throw 'Deployment projection unavailable' }
  $deploymentJson | Set-Content -LiteralPath (Join-Path $reportDirectory 'deployment.json') -Encoding utf8
  & $dockerExe run -d --name $peerName --network bridge --read-only --tmpfs /tmp:rw,size=8m --memory 48m --cpus 0.1 --pids-limit 32 --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 --workdir /tmp $PythonImage python -m http.server 8765 --bind 0.0.0.0 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Controlled peer could not start' }
  $createdNames += $peerName
  $peerIp = (& $dockerExe inspect $peerName --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}').Trim()
  if ($peerIp -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Peer address unavailable' }
  $env:OPEN_SANDBOX_DOMAIN = $ServiceDomain
  $env:OPEN_SANDBOX_IMAGE = $PythonImage
  $env:ISOLATION_PEER_IP = $peerIp
  $clientScript = 'cd /probe && ./node_modules/.bin/tsx isolation.mts'
  $dockerArgs = @('run','-d','--name',$clientName,'--network',$Network,'--add-host','host.docker.internal:host-gateway',
    '-e','OPEN_SANDBOX_API_KEY','-e','OPEN_SANDBOX_DOMAIN','-e','OPEN_SANDBOX_IMAGE','-e','ISOLATION_PEER_IP',
    '-v','sandbox-smoke-node-modules:/probe/node_modules:ro',
    '-v',"${PSScriptRoot}\isolation.ts:/probe/isolation.mts:ro",'-v',"${PSScriptRoot}\probe.py:/probe/probe.py:ro",
    '-v',"${reportDirectory}:/reports",'node:22-bookworm','sh','-lc',$clientScript)
  & $dockerExe @dockerArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Isolation client could not start' }
  $createdNames += $clientName
  $deadline = [DateTime]::UtcNow.AddSeconds(210)
  $inventoryCaptured = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    $requestFile = Join-Path $reportDirectory 'inventory-request.json'
    if (-not $inventoryCaptured -and (Test-Path -LiteralPath $requestFile)) {
      $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
      if ($request.sandboxId -notmatch '^[a-f0-9-]{36}$') { throw 'Unexpected sandbox identity' }
      $workload = 'sandbox-' + $request.sandboxId
      $egress = 'sandbox-egress-' + $request.sandboxId
      $projection = '{{json .HostConfig.Memory}}|{{json .HostConfig.NanoCpus}}|{{json .HostConfig.Privileged}}|{{json .HostConfig.NetworkMode}}|{{json .HostConfig.CapAdd}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.PidsLimit}}|{{json .HostConfig.ReadonlyRootfs}}|{{json .Config.User}}'
      $fields = (& $dockerExe inspect $workload --format $projection) -split '\|'
      if ($LASTEXITCODE -ne 0 -or $fields.Count -ne 10) { throw 'Workload inventory unavailable' }
      # Cap arrays flatten under PowerShell pipelines; retain separately projected raw JSON fields instead.
      $hostConfig = [ordered]@{ memoryBytes=($fields[0] | ConvertFrom-Json); nanoCpus=($fields[1] | ConvertFrom-Json);
        privileged=($fields[2] | ConvertFrom-Json); networkMode=($fields[3] | ConvertFrom-Json);
        capAdd=($fields[4] | ConvertFrom-Json); capDrop=($fields[5] | ConvertFrom-Json);
        securityOpt=($fields[6] | ConvertFrom-Json); pidsLimit=($fields[7] | ConvertFrom-Json);
        readonlyRootfs=($fields[8] | ConvertFrom-Json); containerUser=($fields[9] | ConvertFrom-Json) }
      $mounts = @((& $dockerExe inspect $workload --format '{{json .Mounts}}') | ConvertFrom-Json)
      $ports = (& $dockerExe inspect $egress --format '{{json .HostConfig.PortBindings}}') | ConvertFrom-Json
      $inventory = [ordered]@{ sandboxId=$request.sandboxId; workload=$workload; hostConfig=$hostConfig; mounts=$mounts; egressPortBindings=$ports }
      $inventory | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $reportDirectory 'inventory.json') -Encoding utf8
      '{}' | Set-Content -LiteralPath (Join-Path $reportDirectory 'inventory-done.json') -Encoding utf8
      $inventoryCaptured = $true
    }
    $state = (& $dockerExe inspect $clientName --format '{{.State.Status}}').Trim()
    if ($state -eq 'exited') {
      $exitCode = [int](& $dockerExe inspect $clientName --format '{{.State.ExitCode}}')
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if ($state -ne 'exited') { throw 'Client exceeded the bounded probe deadline; sandbox TTL remains 240 seconds' }
  & $dockerExe logs $clientName
} finally {
  foreach ($name in $createdNames) { & $dockerExe rm -f $name | Out-Null }
  $env:OPEN_SANDBOX_DOMAIN = $oldDomain
  $env:OPEN_SANDBOX_IMAGE = $oldImage
  $env:ISOLATION_PEER_IP = $oldPeer
  [ordered]@{ finishedAt=[DateTime]::UtcNow.ToString('o'); clientExitCode=$exitCode;
    controlledPeerName=$peerName; controlledPeerIp=$peerIp;
    controlledContainersRemoved=$createdNames; remainingTestContainers=(& $dockerExe ps -a --filter "name=runtime-isolation-" --format '{{.Names}}') } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reportDirectory 'orchestrator.json') -Encoding utf8
}
exit $exitCode
