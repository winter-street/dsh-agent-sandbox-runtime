# P1-06 — Harness runtime tool bridge evidence

Updated 2026-11-19. **P1-06 accepted against its original requirements.** The initial controlled-provider probe and later external-model, original-budget and runtime evidence are linked below.

Files: `src/adapters/harness/index.ts`, `tests/adapters/harness.test.ts`. Baseline runtime commit: `dff1a01`; coordinating task records the implementation commit.

## Behavior

- Cordis plugin `agent-sandbox-runtime` declares the `tools` dependency and registers `runtime_python` with explicit input/output JSON Schema.
- Model accepts only Python `code`. The composition root resolves trusted session/parent-session state to `{ runId, inputs }`; unknown bindings and agent-less calls are denied.
- Tool-call identity maps to a stable step ID. The executor remains responsible for transactional replay checks, attempt identity, budget binding, artifact commits and remote execution.
- Caller abort and plugin disposal reach the executor through a combined signal. Disposal unregisters the tool and waits for active work to settle.
- Input byte arrays are copied before execution. Returned data undergoes semantic validation and the host's canonical output validation.

## Commands executed

| Command | Result |
| --- | --- |
| Initial `pnpm exec vitest run tests/adapters/harness.test.ts` | Exit 1: rc.6 rejects unsupported `minimum` JSON Schema keyword; fixed by using its supported schema subset and separate business validation |
| `pnpm exec vitest run tests/adapters/harness.test.ts` after fix | Exit 0, **14 tests passed** |
| `pnpm typecheck` after fix | Exit 0 |
| `pnpm build` | Exit 0 |

## Coverage and limits

The tests install real published rc.6 ToolRuntime, AgentRegistry, AgentLoop, SessionStore, LlmRuntime and SystemPrompt modules. They call the real registry; the runtime executor is a test double. No model inference or container is involved.

Covered: valid result rendering; rejection of injected run/budget/host-path fields and invalid code; UTF-8 byte limits; missing agent/binding; child lineage; independent call step IDs; invalid result rejection; caller cancellation while cleanup is pending; disposal during execution; disposal racing with asynchronous binding resolution.

## Shared budget and receipt integration

`tests/adapters/budget-harness-integration.test.ts` installs the built, locally patched budget plugin into a real Cordis context with the real rc.6 Harness modules. It creates a root and child agent, verifies the child's read-only budget lookup resolves to the root scope, reserves/dispatches/settles a controlled call against the plugin's durable ledger, then imports its receipts into the runtime SQLite store. It closes and reopens that store and verifies replay restores the cursor without duplicating receipts. The setup uses temporary directories and a controlled accounting call; it makes no network provider request and executes no sandbox code.

Commands executed after this integration was added:

| Command | Result |
| --- | --- |
| `pnpm exec vitest run tests/adapters/budget-harness-integration.test.ts` | Exit 0, **1 test passed** |
| `pnpm typecheck` | Exit 0 |

The integration test requires the patched package build described in [`integrations/budget/README.md`](../../integrations/budget/README.md). It skips when that ignored local build is absent; it does not silently substitute a fake budget service.

## Real sandbox and automatic budget lifecycle (2026-11-17)

The reproducible entry [`spikes/harness-runtime/`](../../spikes/harness-runtime/README.md) now composes actual Cordis services and AgentLoop, original patched budget commit `b640a3a15daf520c78c61303200bca23a601d9ea`, `RuntimeService`, `ArtifactStore`, SQLite and `OpenSandboxAdapter`. The root AgentLoop dispatches `runtime_python` through the real registry; a Python container reads the provided fixture `[2,3]` and writes `result.json`. An independent trusted host validator requires its sole JSON artifact to contain sum `5` before finalization. A child agent resolves to the same original budget scope. The plugin's own `llm/stream` hooks reserve and settle automatically; the probe never manually debits model calls or creates another budget ledger.

Commands ran from the repository root, with the sandbox key supplied through the process environment and not printed:

| Command | Result |
| --- | --- |
| `.\spikes\harness-runtime\run-docker.ps1 -AdapterTestsOnly` | Exit 0; 6 mock-HTTP adapter contract tests passed; no sandbox or external provider request |
| `.\spikes\harness-runtime\run-docker.ps1 -Mode controlled` | Exit 0; 5 integration checks passed; real sandbox, controlled provider |
| Docker `ps --format '{{.Names}}'` after completion | Only shared `opensandbox-server` remained; execution sandbox cleaned up |

Captured credential-free report: [`controlled-result.json`](../../spikes/harness-runtime/controlled-result.json), SHA-256 `3ab01749c763e5eb4f2fc49502b238371b0348341e2250527a7db082dfbbb60d`.

| Evidence | Value |
| --- | --- |
| Report timestamp | `2026-11-16T21:08:46.094Z` (2026-11-17 Asia/Shanghai) |
| Run / final status | `harness-c264499a-04b4-417d-afc2-f983c1722e2e` / `SUCCEEDED` |
| Sandbox | `0d1572f3-5fc3-4b04-8f11-2ecc155cc09b` |
| Attempt | `57783234-f1e1-411d-ae57-359a163adf5a` |
| Usage | 3 controlled calls; **48 synthetic tokens** = 32 input + 16 output; reserved 0, unknown 0 |
| Receipt replay | Cursor 11 persisted; reopening SQLite imported/scanned 0 additional receipts |
| Artifact | `result.json`, 10 bytes; SHA-256 `9dc6d101e9569a085108fa44b9c2bf14ae3bc13fb89f00a1cd634b3fd538b0d4` |
| Runtime source/manifest code identity | `6ae05c46db2b342901e0b372ce4a5a486eca6e2ae187f0636119c2ffbb2836c1` |
| Config identity | `8fb58bcd35fec1c981b578db8b4ae8600bc1d71c41aa253aef346b73eebfd05e` |

The wrapper preserves original root package/lock manifests in the container for identity hashing and locks the spike's own installation separately. It caps calls/output/TTL and cleans up the sandbox. Its optional `deepseek` mode uses buffered Chat Completions and refuses to run without a key; it does not silently substitute controlled responses. Six local HTTP contract tests verify text/tool-result/function-call serialization, disjoint prompt/cache usage, invalid or missing usage rejection, HTTP error-body privacy, call bounds, cancellation, and unsupported response rejection. They do not establish real provider behavior.

The 2026-11-17 controlled report covers SQLite close/reopen within one process and synthetic usage. Its monetaryCost is null. Later external-provider observations and process recovery are recorded in the acceptance update below. Profile configuration reload, price tables and invoice reconciliation remain follow-up capabilities.

2026-11-19: a separate `-PluginDisposal` probe passed using the real Harness tool registry, original budget plugin, RuntimeService and OpenSandbox. It invoked the tool directly without a model call and independently verified the command stopped and the sandbox lookup returned 404 after plugin unload. The result and limits are recorded in [P1-07](P1-07.md); this observation does not establish provider or process-restart behavior.

## Acceptance reconciliation on 2026-11-19

The runtime bridge, root/child budget, model-policy and controlled runtime scenario suites passed 49 tests in four files with RUNTIME_BUDGET_INTEGRATION=1, zero skips and exit 0. The original plugin reservation, automatic stream accounting and security suites separately passed 63 tests in three files. [QA-02](QA-02.md) records the exact commands and maps the original requirements to their evidence.

The tests verify inherited root ownership, stable run/session binding, one automatic reservation and settlement per completed call, unknown usage blocking new requests, and zero provider dispatch for an unaffordable report. The actual tool registry rejects model-supplied run, budget and input-path fields. Source review confirmed the plugin exposes the read-only budget_status model tool and keeps management operations in trusted host code.

[P1-08](P1-08.md) records the real DeepSeek → Harness → original budget → RuntimeService → OpenSandbox delivery with 3974 tokens and three verified files. [N01](N01-fault-matrix.md) records local transport faults with the original ledger and bounded external authentication rejection and stream interruption. [N02](N02-budget-process-recovery.md) records separate-worker termination with the original ledger and real sandbox. The local and external probes retain their individual scope and limitations. G1 acceptance is recorded in QA-02, while the complete G2 recovery requirements are assessed in QA-03.
