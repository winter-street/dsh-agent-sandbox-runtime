# OpenSandbox service probe

This probe uses the published `@alibaba-group/opensandbox@1.2.1` package. It never substitutes a local shell for sandbox execution.

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm doctor
```

`doctor` prints dependency availability and whether connection settings exist, never their values. On this Windows machine it also checks the registered Ubuntu distribution. A process exit code of 2 means there is no detected usable local engine or explicitly configured service. This is an environment diagnosis, not an isolation test.

For a real smoke, configure `OPEN_SANDBOX_DOMAIN` with a working service URL and `OPEN_SANDBOX_IMAGE` with a fixed Python-enabled image, preferably pinned by digest. Set `OPEN_SANDBOX_API_KEY` only if that service requires it. `OPEN_SANDBOX_USE_SERVER_PROXY=1` is optional and must match the deployment; the SDK documents server proxy mode as maintenance-only. Do not put credentials in the domain URL. Then run:

```powershell
pnpm smoke
```

With the local Docker Desktop Compose profile documented in [environment.md](../../docs/environment.md), the service returns `host.docker.internal` sandbox endpoints. Run the SDK client on the same Docker network so it can reach those endpoints:

```powershell
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
.\spikes\sandbox-smoke\run-docker-client.ps1
Remove-Item Env:OPEN_SANDBOX_API_KEY
```

The helper reads the key only from the current process environment and writes its report to `.runtime/sandbox-smoke/smoke.json`; it does not print or persist the key.

The script creates a sandbox with a 300-second lifetime, one CPU, 512 MiB of memory, and a deny-default network policy request. It uploads a Python script and input, runs a calculation, checks the returned result, starts and cancels a long command, checks a timeout, and finally deletes the sandbox. Cancellation is only considered confirmed after the remote status reports stopped. Deletion is confirmed by a lifecycle lookup returning HTTP 404. A timeout or lost connection remains a failure, not a successful cancellation.

Reports go to `.runtime/sandbox-smoke/smoke.json` at the repository root by default; override with `SANDBOX_SMOKE_OUTPUT`. The report contains resource IDs and verification results, not API keys. If cleanup fails, inspect the recorded sandbox ID; the script requested TTL but cannot prove expiry after a lost connection.

Network, filesystem and actual resource-enforcement checks remain deployment-specific and deliberately unpassed by this generic smoke. Configuration being accepted does not establish isolation. The script does not contact arbitrary external targets to infer network policy effectiveness.

The RuntimeService integration probe runs the repository core, SQLite, ArtifactStore and real OpenSandboxAdapter together:

```powershell
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
try { .\spikes\sandbox-smoke\run-runtime-service-docker.ps1 }
finally { Remove-Item Env:OPEN_SANDBOX_API_KEY -ErrorAction SilentlyContinue }
```

It verifies output publication and finalization, a fault after publication followed by SQLite close/reopen and remote reconciliation, reuse of the original attempt, and confirmed active cancellation. It uses an explicitly labeled in-memory budget double, with no model/provider calls. The report is `.runtime/sandbox-smoke/runtime-service-smoke.json`. Exception injection and reopen are not a real process-kill demonstration. Sandbox deletion is attempted on both success and failure, with TTL as a fallback whose expiry must be checked separately.

Use `-Scenario process-recovery` with that same helper for a separate actual OS-process termination experiment. A parent process SIGKILLs its worker after publication/before SQLite result commit, opens the database after recovering the dead PID lock, reconnects to the original remote execution, commits/replays its original attempt, and checks the original deadline. The report is `.runtime/sandbox-smoke/process-recovery-smoke.json`. Budget is still explicitly FakeBudget; the experiment does not establish real-plugin/model ledger recovery. Source/build code and configuration fingerprints must remain unchanged between worker and replacement service.

Use `-Scenario deadline` to check task deadline handling against a separate real sandbox. After independently observing a running command, it advances only the RuntimeService test clock past the deadline; a fresh SDK connection observes the command stopped, and another lookup checks that the sandbox was deleted. The report uses a unique `deadline-smoke-*.json` name.

Use `-Scenario deadline-wall-clock` for a separate real-time check. It waits for the configured 30-second task deadline to elapse while a command runs, then verifies the remote command stopped, the attempt reached `TIMED_OUT`, the run reached `CANCELLED`, and a fresh SDK lookup returns 404 after sandbox deletion. Both deadline scenarios use FakeBudget and make no model/provider calls. They verify one command and sandbox lifecycle, not complete process-tree cleanup, provider cancellation/billing behavior, or recovery from an unknown sandbox-creation result. If sandbox creation or cleanup is uncertain, inspect the recorded failure and remote resources rather than assuming TTL proves cleanup.

Bounded deployment enforcement is exercised by [sandbox-isolation](../sandbox-isolation/README.md), with failure evidence for dns-only direct-IP bypass and a passing dns+nft rerun. The generic lifecycle probe's intentionally false isolation flag does not change retrospectively.

Current host evidence is in [P0-04](../../docs/evidence/P0-04.md). A blocked preflight or smoke must not be counted as real execution validation.

The process-tree cancellation probe uses `run-process-tree-docker.ps1` with the same local API-key setup. It records a parent, child and grandchild in the command process group, independently checks PID/start-time identities via `/proc` before and after adapter cancellation, then destroys the sandbox. Each report has a unique `process-tree-*.json` name. The observer regards an identified zombie as no longer executing, and records the observed state. This bounded probe does not cover a process that leaves the process group, a host crash or provider billing.

`-Detached` has the child call `setsid()` before starting its child. A failed `cancel-process-tree` check records surviving identities before the `finally` cleanup destroys the sandbox. This is an intentional regression probe for a known gap, and must not be reported as a successful cancellation of the entire process tree.

`-Detached -VerifyDestroy` runs the client in Docker's host PID namespace for a bounded destruction probe. It matches the sandbox parent, child and grandchild to host PIDs using namespace PID and process start time, confirms the detached descendants are running after adapter cancellation, then destroys the sandbox and checks their original host PID identities until they disappear or become zombies. This probe requires access to the host PID namespace and makes no model calls. It covers this process tree and deployment only.
