# 2026-11-17 real OpenSandbox smoke rerun

This evidence records real local Docker/OpenSandbox calls only. No DeepSeek request or external model was used.

Environment: Windows PowerShell, Docker Desktop Linux engine, OpenSandbox SDK 1.2.1, pinned Python image, repository working tree after the fractional-CPU policy fix and evaluation receipt validation fix. The API key was supplied only through the process environment and is not stored here.

## Commands and results

| Command | Result |
| --- | --- |
| `spikes/sandbox-smoke/run-adapter-docker.ps1` | Exit 0; create, execute, reconnect/inspect, artifact collection, nonzero exit, cancellation and idempotent destroy passed |
| `spikes/sandbox-isolation/run.ps1` | Exit 0; all eight bounded deployment checks passed, including DNS and direct-IP deny, nonroot permissions, mount inspection, CPU quota and memory OOM boundary |
| `spikes/sandbox-smoke/run-runtime-service-docker.ps1 -Scenario service` | Exit 0; artifact finalization, SQLite restart reconciliation and confirmed cancellation passed |
| `spikes/sandbox-smoke/run-runtime-service-docker.ps1 -Scenario process-recovery` | Exit 0; separate worker SIGKILL after publication, dead-writer recovery, same-attempt remote reconciliation and original deadline retention passed |
| `spikes/harness-runtime/run-docker.ps1 -Mode controlled` | Exit 0; real OpenSandbox plus controlled provider, original budget plugin, RuntimeService and artifact validator passed; usage is synthetic |

The latest adapter sample reported CPU utilization `0.003437433375059278`, memory `17,354,752 / 536,870,912` bytes and wall time `154 ms`; CPU time and peak memory remained explicitly unknown because the SDK does not support them. The isolation report observed `dns+nft`, CPU `0.5`, memory `192 MiB`, nonroot UID/GID `65534`, and both sandbox lifecycle lookups returned 404 after cleanup. Docker retained only `opensandbox-server`.

## Limits

These are real sandbox and runtime lifecycle observations, not external model evidence. The process-recovery probe uses `FakeBudget`, and the controlled Harness smoke uses synthetic usage. Sustained pressure-to-scheduler production enforcement, real provider usage/error/stream interruption, full charging-analysis execution, long-task model recovery and fixed-task evaluation remain open.
