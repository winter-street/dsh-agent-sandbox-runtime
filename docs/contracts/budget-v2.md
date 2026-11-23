# Budget reservation service v2

Implementation: unreleased patch to budget-plugin baseline `28c77462aa20ceb27acc0cec99db0dea11087dbc` (package 0.4.0); reproduced through `integrations/budget/reservations.patch`. Parent runtime remains a separate repository. Exact implementation commit is recorded in `integrations/budget/README.md` after commit.

## Ownership and integration

The plugin owns `ledger.jsonl`, scope index, writer lock and accounting. `connectBudgetService(ctx)` reads `ctx.get('agentBudget')`, validates required methods and binds them without copying a balance. `reader` exposes snapshot/event lookup and non-creating scope lookup; `port` exposes lifecycle methods; `operator` exposes allocate/withPurpose; `control` combines the latter two. None is registered as a model tool. The existing budget_status tool remains read-only.

The host must load LlmRuntime, SessionStore, SystemPrompt, ToolRuntime and AgentRegistry with the pinned dependencies and await plugin activation. Tested baseline: Cordis 4.0.1, DSH 0.1.0-rc.6, Node 22.22.2. Newer Harness master is not the selected integration baseline.

## API

| Method | Contract |
| --- | --- |
| scopeForSession(sessionId, { create }) | Original root/owner resolution; create:false does not open credit. Runtime validates equality with its existing budgetScopeKey. |
| snapshot(scopeKey) | Settled/reserved/available totals, four usage buckets, work/finalize allocation, unknown count, global ledgerSeq. Unknown scope throws. |
| reserve(request) | Session/scope validation, global and purpose capacity, concurrency check and durable reserve in one single-writer operation. Duplicate modelCallId returns same reservation; conflicting request rejects. |
| markDispatched(id) | Durable send intent before invoking provider; not proof that the server received it. |
| settle(id, usage) | Final disjoint input/cacheRead/cacheWrite/output usage. Equal duplicate is a no-op; conflict rejects. Actual overshoot remains fully recorded. |
| releaseUnsent(id, reason) | Only reserved, never dispatched or unknown. Explicit reason persisted. |
| markUnknown(id, reason) | Keep reservation, block further root model calls; authoritative late usage can settle later. |
| eventsAfter(cursor) | Cloned receipts after global cursor; old sample history receives stable legacy cursor IDs. Runtime persists receipt IDs and cursor for notification recovery. |
| allocate(scopeKey, finalizeTokens, reason) | Trusted host/operator allocation inside the existing total. Reject unresolved reservations and allocations below already committed class usage. |
| withPurpose(sessionId, purpose, callback) | Trusted asynchronous context. Consume the model stream inside callback; returning an unconsumed lazy iterable is not sufficient. |

The runtime structural contract permits synchronous or asynchronous service methods. Current in-process plugin writes synchronously under the existing exclusive lease and flushes before admitting calls. This is not a distributed transaction or multi-process accounting service.

## Automatic model lifecycle

Set `reservationMode: true` on the patched plugin. `agent/request` supplies a bounded output cap (2048 by default or maxOutputTokens); reservation happens when the final frozen llm/stream request is iterated. Direct calls must provide sessionId and maxTokens. Input estimate = ceil(UTF-8 JSON bytes of messages/system/tools / 3) + 256; total estimate adds maxTokens. This is deliberately an estimate, not a billing guarantee.

Automatic mode owns reserve -> dispatch -> settle/unknown. Runtime must **not** manually reserve the same call. It reads snapshots/receipts and sets trusted purpose for the limited final report. Manual lifecycle calls are only for a separately owned provider path. Final cumulative usage is settled once on completion; no legacy sample double debit occurs. Interrupted streams or missing final usage remain unknown even when legacy missingUsage is ignore.

`reserved -> dispatched -> settled`; `reserved -> released_unsent`; `dispatched -> unknown -> settled`. Reloaded dispatched calls become unknown. Never turn a timeout, cancellation or restart into a refund. Finalize remains within the same global limit and also needs enough capacity for input plus output; the runtime must use its no-model template when it does not fit.

## Upgrade and recovery

1. Stop writers and back up the full budget storage directory. Verify the old v1 ledger before upgrade.
2. Apply the pinned patch and enable reservationMode explicitly. First v2 append also copies old history to ledger.v1-backup.jsonl. Old v1 cumulative samples retain replacement semantics.
3. The old 0.4.0 reader rejects v2 records. Do not strip records or allow an older writer to ignore reservations. Downgrade requires stopped writers, reconciliation of new consumption, preserved full history and a verified compatible backup.
4. After a process crash, read writer.lock and invoke `node scripts/recover-writer-lock.mjs --dir <local-storage-directory> --expected-pid <recorded-pid>`. Only a matching dead PID (ESRCH) allows removal. A live/reused/inaccessible PID, corrupt lock or recovery guard remains blocked. This explicit command is tested with an actual terminated local child process; no network-filesystem claim is made.
5. Restart the plugin, replay receipts and reconcile unknown calls. Lock recovery does not settle usage, reset budget or automatically resume tasks.

Tests use deterministic providers through both controlled harnesses and real Cordis/DSH modules. Real paid-provider usage, runtime receipt persistence, complete sandbox recovery and task-level final-report policy remain separate integration gates; see P2-04 evidence.
