# Budget integration contract — P0-03

Verified 2026-11-16 against `winter-street/dsh-plugin-agent-budget` commit `28c77462aa20ceb27acc0cec99db0dea11087dbc`, package 0.4.0.

Checkout: `.sources/budget` (separate Git repository). It was newly cloned with clean `main`; no previous user checkout was found by package-file search in `D:/1GISwork`.

## Upstream 0.4.0 baseline contract

- Public package exports `name`, `inject`, `Config`, `apply`; it does not yet publish a BudgetPort service.
- Required services: `llm`, `sessions`, `tools`, `agents`. System prompt and web administration are optional.
- Host peers: Cordis 4.0.1, dsh-agent/llm/session/system-prompt/tools 0.1.0-rc.6, schemastery 3.18.1. Node 22.22.2 satisfies the declared `^22.19.0 || >=24` range.
- Ledger state is owned by the plugin's `LedgerStore`, inside `apply`. Sidecar: `ledger.jsonl`, `scope-index.json`, exclusive `writer.lock`. Runtime SQLite must not become a second budget owner.
- Scope resolution: runtime creator/owner chain, persisted scope index, live durable parent lineage, then explicit fallback to a session budget. The runtime must pin and validate the returned scope when creating/resuming a run; a fallback must not silently create fresh credit for an old task.
- Usage has four disjoint buckets: input, cache read, cache write, output (including reasoning). A sample with the same callId replaces the earlier sample, not an extra debit.
- Current admission reads settled usage. Concurrent admitted calls can overshoot. `start`/`end` track calls; unfinished recovered calls and unmetered calls fail closed under default settings.
- `agent/request` can return a replacement frozen LlmCallConfig. `llm/stream` options cannot be mutated. Admission is rechecked at iteration, before provider execution.
- `budget_status` is read-only. Web adjustment and reset are operator actions; the runtime must never use reset to resume.

## Upgrade boundary

The local unreleased extension now provides `ctx.get('agentBudget')` through the original plugin and reuses the same writer lease/ledger. It offers scope resolution, snapshots, atomic reservation, pre-send dispatch intent, settlement, known-unsent release, unknown marking, trusted purpose context, allocation and event replay. Runtime receives the service through `src/adapters/budget/index.ts`; it does not import source from the ignored checkout. See [implemented v2 contract](budget-v2.md) and [reproducible patch](../../integrations/budget/README.md). The published 0.4.0 package does not include these additions.

Version 2 reservation events coexist with readable version 1 history. The old plugin rejects v2 records, deliberately preventing a downgrade writer from ignoring reservations. Upgrade takes an exclusive lock, backs up the original ledger once before first v2 append and documents restoration. No concurrent old/new writer is supported.

Atomicity means one synchronous checked append under the plugin's existing single-process writer lock, with persistence before provider admission. It does not claim a distributed transaction with a remote provider.

Unknown usage is never zero. If dispatch may have happened, keep the reservation and deny additional model calls for that root scope until verified usage or an explicit audited reconciliation arrives. Repeated settlement must be idempotent, with conflicting duplicate usage rejected rather than silently changing an already final reservation.

Actual token use may exceed an estimate: store the full real amount and block future admission. Finalize allocation is within the same total; purpose is assigned by trusted application code, not model tool arguments.

## Validation and limits

Baseline typecheck/build succeeded. Baseline tests after fixing Windows script EOL: 104 passed, one optional DeepSeek smoke skipped. The existing integration tests use real Cordis/DSH modules with a deterministic mock model adapter. They are not paid/remote-model tests.

No DeepSeek/OpenAI/DSH credential variable names were present in this process; values were not inspected or printed. Remote provider usage behavior remains unverified.
