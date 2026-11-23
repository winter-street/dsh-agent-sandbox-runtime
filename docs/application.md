# Application host

Failed and successful tool executions now both receive bounded independent diagnostics. A model can name failed step IDs in `repairOf`; only the host binds the acceptance obligation. A successful replacement must pass byte verification and independent task validation before its explicitly linked failures are superseded. Original failures remain in history. Cross-run/obligation repairs, unknown accounting, unsettled work, cancellation and stale revisions remain blocked. See [implementation evidence](evidence/2026-11-18-followups.md).

Trusted `ApplicationHostOptions.dataDirectory` changes storage placement only. The two-worker evaluator uses it for independent per-worker runtime databases and original budget logs; no model tool can choose that path or reset a budget.

`src/app/index.ts` is the production composition root. It starts Cordis/Harness, loads the pinned original budget plugin, opens the durable `RuntimeStore` and `ArtifactStore`, and connects `RuntimeService` to `OpenSandboxAdapter`. Model calls use `DeepSeekAdapter` and therefore stream provider SSE directly; the model never selects a budget scope, sandbox, or filesystem path.

The host API used by the evaluation driver is:

- `submit({ runId, task, inputs })` creates a durable run and starts the configured root-agent or serial workflow.
- `pause`, `resume`, and `cancel` use persisted command IDs and the original run revision/deadline.
- `decideApproval(runId, approvalId, decisionId, approved)` records the decision and schedules an approved serial continuation.
- `wait(runId, { timeoutMs })` observes that run until it is terminal or requires recovery.
- `get(runId)` reads the durable snapshot and does not dispatch work.
- `reconcile(runId)` calls the runtime recovery path for an existing run; it never submits a new task.
- `close()` aborts local agents, waits briefly for cancellation, disposes Cordis, and closes SQLite.

Use `config/app.example.json` as a template. It contains environment-variable names only; credentials are never stored in JSON or evidence files. `dataDir` and `runtimeConfigPath` are resolved relative to the application configuration file. The sandbox domain must be an HTTP(S) URL without credentials or query parameters.

The real host requires `.sources/budget/lib/index.js`, `DEEPSEEK_API_KEY`, and `OPEN_SANDBOX_API_KEY`. For a local Docker server whose sandbox endpoints are not reachable from the application host, set `sandbox.useServerProxy` to `true`; otherwise prefer the direct ingress path. Controlled tests may inject a provider and sandbox explicitly; those hosts report `injectedProvider` or `injectedSandbox` and are not valid real-model evidence.

Set `model.thinking` explicitly to `disabled` or `enabled`; the host and adapter default to `disabled`. `model.maxOutputTokens` sets the per-call cap shared by the agent and runtime admission policy (default 8192, bounded by the total budget). The evaluation profiles all use `thinking: disabled`, `maxOutputTokens: 8192` and the same original 50000-token total budget. Raising the per-call cap does not grant a new budget. Reasoning deltas are preserved as separate in-memory blocks for provider history replay; they are never flattened into visible response text.

Each bound model stream appends a `model.response` trace event with the finish reason, requested cap, text/reasoning character counts, tool-call count and usage-presence flag. A known runtime model-policy admission rejection instead appends `model.admission-rejected` with its decision codes; it is not an empty provider response. Other stream failures retain response diagnostics so missing usage remains visible. These diagnostics do not persist prompts, response bodies, reasoning text or credentials. Exhausting the one allowed completion nudge after a `max-tokens` stop sets `MODEL_OUTPUT_TRUNCATED`; the evaluation driver classifies this as a provider failure, including when only the persisted trace remains. Missing artifacts alone no longer mask an explicit provider failure.

The runtime tool projects internal artifact records to the public `artifactId/path/size/sha256` fields before checking the strict Harness output schema. Internal `runId/attemptId` metadata remains in the durable store. Valid committed artifacts must not become model-visible tool errors merely because storage records include those fields.

After each successful tool call with committed artifacts, the host invokes the trusted independent validator. Passing acceptance records `validation.completed` and `delivery.accepted`, then marks the successful Harness tool result with `concludeTurn()`. The result commits normally and no extra work response is needed; queued sibling calls cannot dispatch once acceptance is committed. The same completion rule applies to all budget strategies. Optional budgeted reporting happens afterward. Completion readiness is checked before that spending and rechecked at finalization: earlier failed required steps, unresolved execution, unknown usage or cancellation cannot be turned into complete success by valid artifacts alone.

Each call has fresh input/output directories. Earlier committed artifacts are attached at `AGENT_INPUT_DIR/artifacts/<artifactId>/<path>`; a later call must not try to read them from its new `AGENT_OUTPUT_DIR`. Programs verify outputs within the writing call. The prompt and bounded completion nudge follow the task's output contract; an invalid input may require only an error `statistics.json`, with no report or chart.

The evaluation driver requires explicit provider finish/failure evidence to classify a provider error. Internal host conflicts use `other`; local budget and independent validation failures retain their own classifications. Failed runs also write a bounded `failure.json` with host code, validation state, incomplete required steps and evidence references, excluding raw host/provider messages. A generic `fetch failed` message without sandbox attribution is insufficient to classify a sandbox outage.

The CLI accepts an optional trusted `validatorModule` path in the application JSON. The module exports `(run, committedArtifacts, readArtifact) => { passed, evidence }`; `readArtifact` only reads committed manifest records. The example validator checks that `statistics.json`, `report.md`, and a chart exist and that the statistics object has the required fields. Semantic answers remain independently checked by `examples/charging-analysis/verify.py`.

## Serial application mode

`config/app.serial.example.json` enables the production `SerialApplicationWorkflow`. Leaving out `workflow` retains the root Agent loop. The serial host creates three durable child sessions for Planner, Executor and Reviewer under the existing root session and original budget scope. Empty sessions receive an informational, ignorable seed through the Harness factory so they survive reopening without launching a root model turn. Completed role responses and their exact accounting receipts are reused; pending role calls require reconciliation and are never automatically replayed.

From the repository root, after configuring the three named environment variables and starting the local OpenSandbox server:

```powershell
node --import tsx src/app/cli.ts --config config/app.serial.example.json
```

This command starts the real provider/sandbox application on loopback port 8787. It does not load an env file itself. Use a different `--port` if that port is occupied. The example uses an independent data directory and the structural charging-analysis validator; use a task-specific trusted validator for other output contracts. The CLI's task submission currently supplies no attached input files; file-backed tasks use the host `submit({ task, inputs })` API.

| Configuration | Behavior |
| --- | --- |
| `workflow.mode` | Must be `serial`; unknown workflow keys are rejected |
| `maxRepairs` | 0..5 additional Executor/Reviewer cycles; each changed execution requires its own bound approval |
| `approval.reason`, `ttlMs` | Mandatory reason and 1 second..24 hour TTL, capped at the original run deadline |
| `retry` | 1..5 attempts including the first, with bounded backoff; only proven unsent sandbox-creation failures admit a fresh attempt |
| `context` | Conservative full-request estimate, output/safety reserves and optional metered summary; these are local bounds, not a claim about the provider's tokenizer or context capacity |
| `reference.key` | Optional `ranking` or `missing_value` lookup from the bundled, read-only MCP stdio server |

MCP is a fixed trusted prefetch through the durable Tool Registry, not a model-selected external server. It has one durable call per run, JSON Schema validation, a 2-second timeout and 4096-byte output bound. Its source-linked result enters required tool context, never system instructions. A required-reference timeout ends with partial completion; a disconnected request whose result is unknown stays `RECOVERY_REQUIRED`. Both retain their tool receipt, record the role as not dispatched and make no model request. Python uses the existing durable quota/no-progress rules. Approval never changes those rules or the budget.

After Planner and Executor, the application pauses at `PAUSED_APPROVAL` before Python dispatch. The HTTP decision route calls the host scheduler; approval arriving while the prior wait is unwinding is coalesced. Startup schedules stored approved decisions, while pending and rejected decisions stay paused. Duplicate decisions remain idempotent, and a changed decision conflicts. Approval consumption rechecks accounting, remaining work budget, original deadline, arguments and configuration. Expired or rejected approvals never create another prompt automatically.

The application persists an execution-mode/configuration fingerprint, including model, budget, sandbox, workflow, runtime and validator-module path. Configuration drift or changed original input blocks continuation. The fingerprint does not attest the contents of a validator module. Do not point old root-agent data at serial mode. Unknown role usage, ambiguous dispatch or a consumed approval without a confirmed execution requires explicit reconciliation. A user pause waits for the active role to settle, then saves and disposes sessions; reopening/resuming reuses that role. Cancellation fences later roles and delegates remote confirmation/cleanup to RuntimeService.

Reviewer cannot override independent artifact acceptance. Optional reporting uses the root's original finalize allocation only after acceptance; `finalizeTokens: 0` disables the extra model report. Model-role usage, summary usage and final-report usage retain their own original-ledger receipts; MCP and sandbox operations do not receive invented provider-token costs.

Local evidence (2026-11-19): 27 application integration cases and the complete 712-test local suite pass with the actual Harness, original budget plugin and MCP child process. Seven production-host browser checks cover approval/rejection/cancellation, forced-backend restart and mobile controls; exact artifact download and original-ledger call counts are verified. The test explicitly recovers a confirmed-dead writer lock before restart. Provider and sandbox ports remain controlled, and external-model/OpenSandbox acceptance for this mode is still pending. See [N04 composition](evidence/N04-local-composition.md) and [browser/failure evidence](evidence/N04-browser-and-failures.md).
