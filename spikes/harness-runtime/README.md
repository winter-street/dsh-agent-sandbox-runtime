# Harness → budget → RuntimeService → OpenSandbox acceptance

This entry runs the published Cordis 4.0.1 / DSH rc.6 host, the locally patched original budget plugin, this repository's RuntimeService and a real OpenSandbox Python container. It is an integration probe, not a complete application or Harness Loader profile.

## Modes and limits

| Mode | Model transport | What it verifies |
| --- | --- | --- |
| `controlled` | Deterministic local adapter; synthetic usage | Actual AgentLoop tool dispatch, original budget automatic reservation/settlement, shared root/child scope, real sandbox, artifact validation, receipt replay |
| `deepseek` | HTTPS DeepSeek Chat Completions, buffered response | Same chain plus external provider response usage, when run with credentials; **not yet executed in the recorded acceptance** |
| `-AdapterTestsOnly` | Mock `fetch`, no model or sandbox | Six local tests for wire mapping, disjoint usage, rejection behavior, cancellation and call limit; not external provider acceptance |
| `-PluginDisposal` | No model call | Real tool registry and plugin unload with the original budget plugin, RuntimeService and OpenSandbox; confirms remote command stop and sandbox deletion |

Both execution modes cap calls at 4, output at 1024 tokens per call, budget at 50,000 tokens (including 2,500 reserved for trusted finalization), sandbox TTL at 300 seconds, and command timeout at 120 seconds. The input estimate is byte-based; the budget limit is not a proof against token or monetary overshoot. The probe makes no currency-price conversion or invoice reconciliation; `monetaryCost` is explicitly `null`.

## Preparation

1. Reproduce and build the pinned budget-plugin patch using [`integrations/budget/README.md`](../../integrations/budget/README.md). The required ignored local output is `.sources/budget/lib/index.js`.
2. Start the real service and configure the isolated Docker network using [`spikes/sandbox-smoke/README.md`](../sandbox-smoke/README.md). Defaults are network `sandbox-smoke_opensandbox-net` and container URL `http://opensandbox-server:8090`.
3. Run from the repository root with PowerShell and a running Docker engine. `run-docker.ps1` prefers this machine's Docker Desktop CLI path and otherwise looks up `docker` on PATH.

```powershell
.\spikes\harness-runtime\run-docker.ps1 -PrepareOnly
.\spikes\harness-runtime\run-docker.ps1 -AdapterTestsOnly
```

The wrapper installs the independent, committed `package-lock.json` with `npm ci --legacy-peer-deps --ignore-scripts`. Published rc.6 host packages pull rc.8 peer packages with incompatible declared peer ranges; this isolated probe fixes those peer versions explicitly to the root lockfile's resolved versions. It does not replace the runtime's root dependency installation. The named volume `harness-runtime-node-modules` holds the spike dependencies; every run still uses `npm ci`.

## Real sandbox with controlled provider

The API key goes into the process environment. Do not paste its value into scripts, reports or command-line arguments.

```powershell
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
try {
  .\spikes\harness-runtime\run-docker.ps1 -Mode controlled
} finally {
  Remove-Item Env:OPEN_SANDBOX_API_KEY -ErrorAction SilentlyContinue
}
```

Use `-Network`, `-ServiceDomain` or `-PythonImage` when the deployment differs. The default Python image is pinned by digest in the wrapper. The root `package.json`, `pnpm-lock.yaml`, `src`, config and patched budget build are mounted read-only; dependency installation occurs under `/deps`, preserving the original manifests for runtime code-identity hashing.

The real root AgentLoop calls `runtime_python` with a script that reads the provided input `[2,3]` and writes `result.json`. A host-side independent validator checks the sole artifact's sum equals `5`, then finalizes the task. A real child agent makes one text call and resolves to the same original budget scope. The plugin's own model lifecycle hooks reserve and settle each request; the probe does not debit a second runtime ledger. Receipts are imported into runtime SQLite, then the database closes/reopens and its cursor is checked for duplicate-free replay.

For the plugin disposal probe use the same environment and `-PluginDisposal` instead of `-Mode controlled`. It invokes the registered tool directly without an AgentLoop model call, independently observes that the sandbox command is running, disposes the runtime plugin and checks the stopped command, persisted cancellation and 404 sandbox lookup. The unique report is written inside `.runtime/harness-runtime/plugin-disposal-<uuid>/`. This does not exercise provider cancellation, model usage settlement, an entire process tree, or an operating-system process crash.

## Optional external DeepSeek run

Configure `DEEPSEEK_API_KEY` in the calling process beforehand through your usual credential mechanism. `DEEPSEEK_MODEL` optionally overrides `deepseek-chat`. The script fails if the required key is missing and never silently falls back to `controlled`.

```powershell
$env:OPEN_SANDBOX_API_KEY = (Get-Content -Raw .runtime/sandbox-smoke/api-key.txt).Trim()
try {
  .\spikes\harness-runtime\run-docker.ps1 -Mode deepseek
} finally {
  Remove-Item Env:OPEN_SANDBOX_API_KEY -ErrorAction SilentlyContinue
}
```

This narrow adapter accepts text, function calls and function results. It uses `stream:false`, then converts the response into Harness block events. It validates response usage and maps `prompt_tokens - prompt_cache_hit_tokens` to input, hit tokens to cache read, and completion tokens to output, preventing overlapping prompt/cache accounting. Local tests cover these mappings; real provider usage and error behavior remain unverified until the external command actually succeeds.

## Evidence and remaining acceptance

Each run gets its own UUID, SQLite/artifact/budget directory under `.runtime/harness-runtime/`, and overwrites the mode's summary `harness-runtime-controlled.json` or `harness-runtime-deepseek.json`. The tracked [`controlled-result.json`](controlled-result.json) is a credential-free captured report, including code/config identity, sandbox/attempt IDs, usage and artifact hash. Synthetic token usage is clearly labeled.

The successful controlled run is evidence for a real host / original plugin / runtime / sandbox chain. It does not verify external inference, provider-native SSE/error/disconnection metering, currency billing, full process-kill recovery, Harness profile restart, or configuration reload. P1-06, P2-04 and the corresponding phase gates stay open where those checks are required. The wrapper cleans up the run's sandbox; the shared OpenSandbox server remains available.
