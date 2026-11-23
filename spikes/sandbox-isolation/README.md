# Deployment isolation probe

`run.ps1` tests the existing local Docker-backed OpenSandbox deployment. It does not change the server. It requires the installed Docker CLI, Node client image/dependency volume from the lifecycle smoke, the pinned Python image, and an API key supplied through the current process environment.

Run from the repository root:

```powershell
$probeExit = 1
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
try { .\spikes\sandbox-isolation\run.ps1; $probeExit = $LASTEXITCODE }
finally { Remove-Item Env:OPEN_SANDBOX_API_KEY -ErrorAction SilentlyContinue }
exit $probeExit
```

The helper creates one synthetic HTTP peer, then tests allow and deny sandboxes against the **same peer IP and port**. A separate public `example.com` DNS/HTTP control verifies domain handling. Work commands run as UID/GID 65534. Filesystem checks touch only synthetic files. Short CPU pressure runs only after observing the expected 0.5 CPU cgroup quota. Memory pressure runs only after observing the expected 192MiB memory limit and finite swap limit at most 192MiB; an expendable child requests at most 512MiB and prefers itself for OOM termination. No unbounded allocation or process-fanout stress is used.

The host projects only necessary Docker deployment, mounts, limits, capabilities and published-port fields; it never prints all labels, environment variables or the Compose document. The API key belongs only to the trusted SDK client and is not sent to code workloads. Sandbox deletion is confirmed by lifecycle 404, and helper containers are removed in `finally`. Reports are written under ignored `.runtime/sandbox-isolation/`; preserve that directory before a repeat because named report files are overwritten. Client exit 1 means at least one required check failed, not necessarily a harness error. A dns-only deployment is expected to fail direct-IP denial.

`set-local-egress-mode.py <ignored-compose-path>` is a separate, explicitly authorized operator action. It needs Python 3.11+ and PyYAML. It backs up the original document, changes only the embedded TOML `egress.mode` from dns to dns+nft, and verifies both TOML and Compose semantics for unrelated fields. It does not restart the service. Once all existing workloads are finished, an operator can recreate **only** the server with:

```powershell
docker compose -f .runtime/sandbox-smoke/opensandbox-compose.yaml up -d --no-deps --force-recreate opensandbox-server
```

This recreation is separate from routine probing. Do not run it while other workloads are active. Keep API keys and local Compose backups ignored. See `docs/evidence/P0-04-isolation.md` for observed behavior and remaining limits.
