# N04 - MCP, approvals and serial workflow local composition

Date: 2026-11-18; updated 2026-11-19 (Asia/Shanghai). Status: **production serial routing, browser approval/restart and controlled application failure paths verified; external-service acceptance remains open**.

This evidence refers to the current working tree, not a new implementation commit. Node `22.22.2`, Vitest `4.0.18`. It does not change any historical evaluation records or `finalEvaluationEligible`.

## Automatic execution approval

`src/workflow/approved-executor.ts` exports `ApprovedCodeExecutor`, a `RuntimeCodeExecutor` for injection into `SerialWorkflow`. It combines the actual `RuntimeService`, `DurableRetryExecutor` and `DurableToolRules`. A host supplies the approval reason, TTL and existing execution bounds.

- Before requesting approval, it durably admits the tool against the existing quota/no-progress rules. Repeated entry uses the same call ID and admission; restarting the wrapper does not reset counts. A denied call creates no approval.
- The approval binds the code hash, copied input bytes, required/repair metadata, root session, original scope/input/deadline, runtime identity/configuration, retry configuration fingerprint and approval configuration. Changed code, input, retry bounds or approval configuration is rejected before consumption. Tool-rule drift is also rejected through the existing persisted rules fingerprint.
- The first call pauses through `RuntimeService.requestApproval` and returns `APPROVAL_REQUIRED`, without dispatching Python. When the host invokes the workflow again after approval, the wrapper consumes the stored decision itself; callers no longer need a manual `consumeApproval` callback. Hard budget, accounting, task status and original deadline are rechecked by the service. Rejected decisions do not create another prompt.
- One approval covers the existing bounded retry wrapper. Automatic fresh attempts require persisted evidence of a sandbox-creation failure before code dispatch; a script failure or unknown execution is not blindly retried.
- A consumed approval without a dispatch marker, or a marker without a retry receipt, returns `EXECUTION_UNKNOWN`. There is no automatic reset or management command for these windows. A committed execution can replay the same verified artifacts and complete the tool-policy outcome once.

The 17 approval-executor cases exercise actual RuntimeService/SQLite/artifact handling, with fake budget and sandbox ports. They include HTTP approval and duplicate decision, actual SQLite close/reopen, cached role continuation, rejection, expiry/cancellation, argument/configuration drift, unknown accounting, quota/no-progress stops, bounded unsent retry, two ambiguous crash windows, gate-commit failure replay and competing consumers. Three cases specifically vary retry attempt/backoff bounds after approval and assert no consumption or sandbox activity.

## Actual local Harness composition

`tests/adapters/serial-harness.test.ts` uses the actual local rc.6 Harness, original budget plugin, role adapter, context assembly, SQLite and artifact store. A real local MCP stdio child process provides the ranking reference through the durable Tool Registry and durable tool rules. The trusted host retrieves it for context; its source/call ID stays in a required tool-layer entry, never system instructions. This is not a free-form model-driven MCP tool loop.

The test forces one budgeted summary, completes Planner and Executor, automatically pauses before Python, approves once, then injects an exception after the execution/artifact commit but before Reviewer. It disposes Harness, closes SQLite, reopens the original ledger/database and reconstructs the agent tree. Continuation reuses the original role responses, MCP result, approval and execution; only Reviewer calls the provider.

Observed assertions:

- Four provider calls: summary, Planner, Executor, Reviewer. Four reserves and four settlements remain in the original root scope, correlated to their actual modelCallIds. Synthetic usage is 120 tokens, reserved=0, unknown=0.
- The MCP registry commits one tool call, the approval is consumed once and the sandbox port records one Python execute. Each of the two tools has one durable policy admission.
- Independent acceptance reads the committed result bytes and checks `verified=true`. Artifact identity/checksum is preserved across reopening. Reinvoking the completed workflow adds no model or Python call.
- Context compression retains summary coverage and reference provenance. Reference output and hostile-looking historical text stay out of system instructions.

The provider and sandbox are controlled substitutes. The Python program is not executed by this regression, token usage is synthetic, and recreation occurs inside one Node test process. No external model, real OpenSandbox or process kill is claimed for this N04 composition.

## Earlier component verification

Component commands actually run on 2026-11-18, before the application-host extension below:

```powershell
$env:RUNTIME_BUDGET_INTEGRATION = '1'
.\node_modules\.bin\vitest.cmd run tests/workflow/approved-executor.test.ts tests/workflow/serial.test.ts tests/workflow/retry-executor.test.ts tests/workflow/retry.test.ts tests/core/approvals.test.ts tests/tools/durable.test.ts tests/tools/registry.test.ts tests/tools/mcp.test.ts tests/policy/tool-rules.test.ts tests/adapters/serial-harness.test.ts tests/adapters/roles-context.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
npm run build
```

| Verification | Result |
| --- | --- |
| Related regression suite | Exit 0; 127/127 tests across 11 files, none skipped |
| Approval executor | 17 tests |
| Serial / retry executor / retry controller | 19 / 31 / 19 tests |
| Approvals / durable tools / registry / MCP / tool rules | 5 / 4 / 8 / 3 / 9 tests |
| Actual local Harness composition / role context | 1 / 11 tests |
| Typecheck and build, including client asset copy | Both exit 0 |

The opt-in composition requires the locally built original plugin at `.sources/budget`, as described in [P3-05](P3-05.md). It fails when explicitly enabled without that dependency. The environment switch above belongs to the command process; it does not enable any external model calls.

## Production application integration

`src/app/serial.ts` now composes the same role/context, durable MCP registry, tool rules, approval and bounded retry implementations inside the production application host. `config/app.serial.example.json` selects the explicit `workflow.mode=serial`; omitting it retains the root-agent mode. The execution mode and configuration fingerprint are persisted with the original run. Changed model, retry configuration or mode, and changed original input bytes block continuation before approval consumption or dispatch. The validator module path is fingerprinted, but its contents are not attested.

The CLI wires the HTTP decision route to `host.decideApproval`. An approved decision schedules continuation automatically, including when it arrives before the previous waiting turn unwinds. Startup resumes an approved decision that was persisted before scheduling. Pending and rejected decisions stay paused. Duplicate decisions are idempotent; a changed duplicate conflicts. User pause/resume preserves the completed role, original scope and deadline, while cancellation prevents later roles and asks RuntimeService to confirm remote cancellation and cleanup. Unknown role accounting and ambiguous sandbox dispatch remain recovery-required after reopening rather than being replayed.

Two durability/admission corrections were required:

- Empty root and child sessions had no model-loop messages to persist. They now receive an informational, ignorable `runtime/application-session` seed through the actual Harness session factory before flush and binding. This keeps the same sessions reopenable without a root model call; SQLite retains the authoritative run/session bindings.
- Approval consumption now rechecks the admitted budget snapshot and requires positive total and work availability. A zero-cost tool admission under observe policy cannot consume an approval when work tokens are exhausted; the approved decision remains unconsumed and Python is not dispatched.

`tests/app/serial.test.ts` now has **27 production-host integration cases** using the actual Harness, original budget plugin, SQLite/artifact store and MCP stdio subprocess, with a controlled provider and sandbox. Coverage includes HTTP approve/reject, duplicate decisions, the approval scheduling race, pending/approved restart windows, role-boundary pause/resume, cancellation during execution, configuration/input drift, expiry, exhausted work tokens, unknown role/dispatch recovery, independent-validator rejection and strict workflow configuration. Nine additional cases cover creation retry success/exhaustion, invalid output from each role, durable tool quotas, repeated no-progress failure, MCP timeout and forced MCP disconnection. The disconnect case required fixing trusted wrapped-error classification so an unknown required reference remains recovery-required.

For a normal run the original root ledger records three reserves and three settlements, one for each role: synthetic usage is 3 x (20 input + 10 output) = 90 tokens, reserved=0 and unknown=0. With optional reporting enabled, its fourth call settles 30 tokens in the original finalize allocation; work remains 90 and total usage is 120. Independent artifact acceptance precedes that optional spending, and Reviewer cannot override the validator. MCP and sandbox work are not assigned invented provider-token charges.

These application tests close and reopen the host, Harness, sessions, SQLite and original ledger within one Node test process. They do not kill a backend process, launch a browser, execute generated Python or call an external model/OpenSandbox service. The separate N02 real process-recovery evidence does not establish this entire serial composition. See [application usage](../application.md#serial-application-mode) for configuration and startup.

## Complete local verification

Command completed again after the application failure-path changes on 2026-11-19:

```powershell
$env:RUNTIME_BUDGET_INTEGRATION = '1'
node scripts/check.mjs
```

Result: **exit 0; 712/712 tests across 62 files, none skipped**, including the 27 application cases and the opt-in local Harness/original-budget composition. Typecheck, build, client asset copy and the Python frozen-fixture self-test (five fixtures and mutation rejection) also passed. Log: `.runtime/n04-local-check-20261119.log`. This supersedes the earlier 703-test complete check and 127-test component result; it does not change historical evaluation results or close external-service acceptance.

The added serial example also passed an offline configuration check using the actual application parser and strict workflow schema. Its runtime configuration loads, its relative validator path resolves to a callable export, and its independent data directory resolves correctly. Supplying an empty environment deliberately stopped startup at the missing credential check before host creation; no credentials were read and no network request was made.

## Browser and application failure acceptance (2026-11-19)

The production-host browser runner now passes seven checks: approve with exact artifact download, duplicate/conflicting decisions, rejection/cancellation, pending-approval recovery after forced backend termination, running cancellation, mobile controls and in-memory authentication with zero page errors. It uses actual HTTP/SSE, Harness, original budget, SQLite and MCP, with controlled provider/sandbox ports. After verifying the killed backend exited, the test explicitly recovers its stale original-budget writer lock before restart; no unattended automatic lock recovery is claimed. Six screenshots and before/after ledger evidence are retained. The shared client root-agent browser regression also passes.

Detailed commands, evidence paths, token/call counts, trust boundaries and the nine added application failure cases are in [N04 browser and failures](N04-browser-and-failures.md). Browser evidence supersedes the earlier lack of process/browser coverage; application unit integration reopening itself still occurs within one process.

## Remaining acceptance

1. Run a bounded fixed task with the actual external model, original ledger and OpenSandbox; verify all role settlements, independent artifacts, deadlines, approval waiting and cleanup in that composition.
2. Observe bounded real remote failures and recovery in that same composition. Controlled application failure coverage does not establish external-service behavior.
3. Review prerequisite P2/P3/P4 and QA evidence, including the single-agent comparison, before closing G4. This document does not close P4-04, P4-05, P4-07 or G4.
