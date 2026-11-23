# P0-04/G1 — Deployment isolation acceptance

Date: 2026-11-17 (Asia/Shanghai). Status: **all eight bounded deployment checks passed after authorized dns+nft remediation. The initial dns-only bypass is preserved as failure evidence; broader exposure and isolation limits remain below.**

Deployment: existing Docker Desktop Linux engine, OpenSandbox server/execd/egress 1.2.1 release digests recorded in `docs/environment.md`. Docker bridge sandboxes share an egress sidecar network namespace. SDK client runs on `sandbox-smoke_opensandbox-net`. The running server's `get_config()` projection confirmed `egress.mode=dns`, `docker.network_mode=bridge`, `publish_host=0.0.0.0`, and `no_new_privileges=true`.

## Reproducible probe

Files: `spikes/sandbox-isolation/run.ps1`, `isolation.ts`, `probe.py`. The helper requires the API key via `OPEN_SANDBOX_API_KEY`; it never passes its value as a command argument, prints full environment/labels, or mounts control-plane secrets into sandbox workloads. It creates a bounded synthetic local HTTP peer on Docker bridge, then runs allow and deny controls against that same peer IP. `example.com` DNS and HTTP provide a separate domain control. No external model is used.

```powershell
$probeExit = 1
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
try { .\spikes\sandbox-isolation\run.ps1; $probeExit = $LASTEXITCODE }
finally { Remove-Item Env:OPEN_SANDBOX_API_KEY -ErrorAction SilentlyContinue }
exit $probeExit
```

Reports: ignored `.runtime/sandbox-isolation/isolation.json`, `inventory.json`, `orchestrator.json`, and projected `deployment.json`. Initial reports are preserved in its `dns/` directory, and final reports in `dns-nft/`. The helper exits 1 when any required check fails; this is expected for the initial dns profile. It inspects only needed Docker host-config/mount/port fields and confirms sandbox deletion through lifecycle 404.

## Initial actual results

- Allow control: domain resolution and HTTP succeeded; direct-IP HTTP to the controlled peer succeeded.
- Deny-default: domain resolution/HTTP failed, but direct-IP HTTP to the same controlled peer still succeeded. This is an actual policy bypass, consistent with the pinned upstream network-security guide: dns gates names; dns+nft adds packet enforcement.
- Work commands run as UID/GID 65534, matching the project adapter. Process reports `CapEff=0`, `NoNewPrivs=1`, and `Seccomp=2`; writing a harmless file under `/etc`, reading `/root`, and writing cgroup limits are denied, while temporary work files are writable. Docker socket is absent. Docker inventory finds no host bind mount in the workload, only its own `opensandbox-runtime-<sandboxId>` volume at `/opt/opensandbox`.
- CPU: requested 0.5 CPU, actual Docker NanoCpus 500000000 and cgroup `cpu.max=50000 100000`. Two short CPU workers trigger throttling; cgroup CPU time divided by elapsed wall time is approximately 0.5.
- Memory: Docker memory limit and cgroup `memory.max` both equal 201326592 bytes (192MiB). The first 320MiB allocation hit the memory limit but completed through swap. The corrected bounded probe reads `memory.swap.max` first, only stresses when combined memory+swap is at most 384MiB, and requests at most 512MiB in an expendable child with raised OOM preference. It observes child SIGKILL, cgroup oom_kill increment, and memory peak exactly 201326592. This verifies a resident-memory bound with permitted swap, not a total 192MiB address-space bound.

Initial cleanup: both created sandboxes returned lifecycle 404; peer/client containers were removed, and only `opensandbox-server` remained. Initial reports are preserved before remediation.

The corrected initial run started at `2026-11-16T16:57:09.650Z`; allow sandbox `313530e7-8c76-4f13-9378-28f230b31e9e`, deny sandbox `d8d15179-fb7b-4da2-b16f-0f160275c0ac`. Seven checks passed and direct-IP denial failed; client and outer command exited 1.

## Authorized remediation and final actual results

After verifying no other workload existed, the coordinating task authorized changing only the ignored local Compose embedded TOML `egress.mode` to `dns+nft` and recreating only `opensandbox-server`. `set-local-egress-mode.py` made that edit, backed up the original locally, and compared parsed TOML/Compose structures to ensure all other fields and secrets were preserved. A normal Compose up did not recreate the service or apply the inline config change; `up -d --no-deps --force-recreate opensandbox-server` did. The running server's own projected `get_config()` then confirmed dns+nft. publish_host and all other settings were retained.

The successful final run started at `2026-11-16T17:01:31.448Z` (2026-11-17 01:01:31 Asia/Shanghai). It used one controlled peer at **172.17.0.2:8765** for both allow and deny calls within this run.

| Actual check | Result |
| --- | --- |
| Allow domain DNS and HTTP | Passed |
| Allow direct-IP HTTP to controlled peer | Passed |
| Deny domain DNS and HTTP | Blocked by resolution failure |
| Deny direct-IP HTTP to that same peer | Blocked; connection timed out |
| Nonroot identity and ordinary filesystem permissions | Passed; UID/GID 65534, CapEff 0, NoNewPrivs 1, Seccomp 2 |
| Workload mounts | Only its own runtime volume; no host binds or docker.sock |
| CPU quota and finite saturation | 0.5 CPU kernel quota; 3.08375s wall, 1.56233 CPU seconds, 31 throttled periods |
| Memory and finite over-limit allocation | memory.max and peak 192MiB, swap.max 192MiB; child exit -9, oom_kill +1 |

All eight required checks passed. Client exit and outer command exit were **0**. Allow sandbox `96129e6f-63b4-4051-b60f-5e41481871d1` (execution `c16d79112ea548df9e6bd6558614d79c`) and deny sandbox `9cc9db4a-1403-4f46-9aef-fcf5d0808d88` (execution `841a88aedd9a434a95c0a531f4190c87`) both returned lifecycle 404 after deletion. The peer and SDK client were removed; `docker ps -a` showed only the server, and `docker volume ls --filter name=opensandbox-runtime` was empty.

Probe TypeScript was independently checked with `pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck spikes/sandbox-isolation/isolation.ts`, exit 0. This validates probe types, not additional isolation behavior. The helper subsequently gained the same minimal deployment-config projection already executed above; no further server restart was performed.

## Limits

The container control process defaults to root, and its root filesystem is writable. The tested code uses the nonroot execution identity; this establishes ordinary file permissions and absence of host mounts, not per-run workspace path confinement or a read-only root filesystem. The runtime volume is writable and the sandbox is not a defense against kernel vulnerabilities. PIDs limit 4096 is observed but no fork-bomb test is run. No IPv6, UDP, DNS-over-HTTPS, cross-tenant attack, or arbitrary root-code assessment is claimed.

The egress/execd ports are published on 0.0.0.0; exposure/firewall/auth assessment remains open. The server's own docker.sock mount is a privileged control-plane boundary, not a workload mount. Changing publish_host is deferred because the current SDK client depends on Docker-published host routing.

Implementation is in the current working tree. Upstream inspection: `.sources/opensandbox` commit `4ae99691ff0a62594614df90a86ecbee07add966`, `docs/guides/network-security.md`. Matching source/image version names alone are not proof; runtime observations above establish the tested behavior.
