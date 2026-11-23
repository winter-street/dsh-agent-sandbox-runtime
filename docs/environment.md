# OpenSandbox environment baseline

Updated on 2026-11-17 (Asia/Shanghai). The earlier preflight recorded Docker and WSL as unavailable. The user later configured Docker and asked to retry; SDK/adapter/RuntimeService lifecycle and recovery probes now pass. A separate bounded deployment probe exposed the dns-mode direct-IP bypass, then passed all eight checks after the authorized change to dns+nft. P0-04 accepts these bounded observations; complete tenant isolation and all phase gates remain separate.

## Verified environment

| Item | Observed value |
| --- | --- |
| Host | Windows, PowerShell, Docker Desktop Linux engine |
| Docker CLI | `D:\Docker\DockerDesktop\resources\bin\docker.exe` |
| Docker Engine / Compose | 29.9.3 / 5.7.0 |
| Node / pnpm | v22.22.2 / 11.7.0 |
| OpenSandbox JS SDK | `@alibaba-group/opensandbox@1.2.1` |
| Server image | `opensandbox/server@sha256:07f9b39adb8cadf68357dd1b86367068210e960fc4cb50e11b75176387557ea7` |
| execd image | `sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/execd@sha256:6b12d17844ac7167271488302c71934e47f76abb9ddab19ec8529bd1c1c56b23` |
| Egress image | `sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/opensandbox/egress@sha256:84b98d3b5989a87389c977f6433f8cd3c7998d03aa15aaae41ebcb15b7eb8000` |
| Python test image | `python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535` |
| OpenSandbox source | `.sources/opensandbox`, commit `4ae99691ff0a62594614df90a86ecbee07add966` |

The local Compose file, API key, and smoke report live under the ignored `.runtime/sandbox-smoke/` directory. The service listens on `127.0.0.1:8090`. Since the server returns sandbox endpoints using `host.docker.internal`, the SDK client ran on `sandbox-smoke_opensandbox-net` with a `host-gateway` mapping; this keeps the client able to reach Docker-published sandbox ports. The service uses `[proxy].resolve_internal = false` and `[docker].host_ip = "host.docker.internal"` for this server-in-container topology.

To repeat the smoke from the repository root, load the local key into the current PowerShell process and run the checked-in helper:

```powershell
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
try { powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\spikes\sandbox-smoke\run-docker-client.ps1 }
finally { Remove-Item Env:OPEN_SANDBOX_API_KEY -ErrorAction SilentlyContinue }
```

The helper pins the Python image digest, uses the locked SDK version, and writes a key-free JSON report to `.runtime/sandbox-smoke/smoke.json`. The temporary Node client dependencies are cached in a Docker volume named `sandbox-smoke-node-modules`.

To exercise the repository's `OpenSandboxAdapter` itself, use the adapter helper with the same key:

```powershell
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
try { powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\spikes\sandbox-smoke\run-adapter-docker.ps1 }
finally { Remove-Item Env:OPEN_SANDBOX_API_KEY -ErrorAction SilentlyContinue }
```

It mounts the checked-in source read-only into the Docker SDK client and writes a separate key-free report to `.runtime/sandbox-smoke/adapter-smoke.json`. The SDK dependencies are cached in `sandbox-smoke-adapter-node-modules`.

## Real smoke result

The checked run completed at `2026-11-16T12:06:10Z` (`20:06:10` Asia/Shanghai), with SDK 1.2.1 and sandbox `a12d199d-bfc6-49d8-beed-7b8820db1c4d`.

| Check | Result |
| --- | --- |
| Create | Passed |
| Upload files, execute Python, download result | Passed; exit code 0; result SHA-256 `420c5756d42ff797279777699843c67e7cd292bcc1168bcbb4c797ea24c0d1f0` |
| Cancel long-running command | Passed; remote status confirmed stopped (`signal: terminated`) |
| Command timeout | Passed; remote status confirmed stopped (`signal: killed`) |
| Delete | Passed; lifecycle lookup returned HTTP 404 |
| Network/filesystem/resource isolation | Not verified; the smoke records this check as false by design |

After the run, `docker ps -a` showed only the OpenSandbox service; the sandbox and egress containers had been removed. Full execution IDs and timestamps are in the ignored smoke report. A second run using `run-docker-client.ps1` passed the same lifecycle checks.

The repository adapter's separate real-service result and execution identifiers are recorded in [P1-03](evidence/P1-03.md). Both smoke reports are ignored local evidence and contain no API key.

## Findings and limits

- The first local profile used `host_ip = "127.0.0.1"`. Because OpenSandbox runs inside a Compose container, its egress readiness probe could not reach the Docker host-published sidecar port. The official Compose topology uses `host.docker.internal`; changing the ignored local config to that setting resolved egress startup.
- The initial 1.1.0 service configuration did not match the SDK's 1.2.1 execution request in this profile. Pinning the server, execd, and egress images to 1.2.1 release digests resolved the `argv` request validation error.
- A deny-default policy request does not prove enforcement. The separate [deployment evidence](evidence/P0-04-isolation.md) records allow/deny domain and direct-IP controls against the same synthetic peer, nonroot permissions, workload mounts, CPU throttling and bounded memory OOM. Initial dns mode failed direct-IP denial; after changing only local egress.mode to dns+nft and force-recreating the server, all eight checks passed. The current published sandbox ports still use 0.0.0.0; control processes/root layers and untested protocols remain explicit limits.
- The generic probe uses the published SDK directly. The adapter-level probe exercises `OpenSandboxAdapter`, including reconnect, output collection, nonzero exit, cancellation and repeat destroy. A subsequent real RuntimeService smoke passed artifact publication, close/reopen reconciliation of a publication-before-database fault, result replay without a new attempt, and active user cancellation; see P1-05/P1-07. Its budget remains a test double and no provider was invoked.
- The exact project adapter requires Python >=3.9 and Linux pidfd support for its process cleanup behavior. The adapter smoke confirms UID/GID 65534 and completes runner cancellation in this image. Bounded deployment checks are now documented separately; arbitrary process-tree cleanup and broader isolation remain unproven.

## Actual worker-process termination and recovery

`spikes/sandbox-smoke/run-runtime-service-docker.ps1 -Scenario process-recovery` forks a separate Node worker in the Docker client, sends SIGKILL after artifact publication but before the SQLite result commit, recovers the dead PID writer lock, reconnects to the original remote execution and commits the same attempt. The final-source rerun at `2026-11-16T17:24:58.926Z` recorded one attempt, preserved the original deadline and finalized SUCCEEDED. See [P2-06](evidence/P2-06.md) for exact identifiers. This probe uses FakeBudget and no model, so it is not real budget-ledger/provider recovery evidence.

The source checkout is for API inspection. The probe consumes the separately locked published SDK; matching version strings alone do not prove source and package equivalence. Type checking validates the API symbols used by the probe.

Sources: [pinned SDK](https://github.com/opensandbox-group/OpenSandbox/tree/4ae99691ff0a62594614df90a86ecbee07add966/sdks/sandbox/javascript), [pinned network guide](https://github.com/opensandbox-group/OpenSandbox/blob/4ae99691ff0a62594614df90a86ecbee07add966/docs/guides/network-security.md).
