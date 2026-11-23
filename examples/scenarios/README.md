# Repeatable budget/runtime scenarios

Run from the repository root after reproducing and building the original budget-plugin patch in [`integrations/budget/README.md`](../../integrations/budget/README.md):

```powershell
.\examples\scenarios\run.ps1
```

Equivalent command: `pnpm exec vitest run tests/scenarios/budget-runtime.test.ts`. The wrapper fails when the patched plugin build is missing; the regular full test suite may skip these optional integration cases without it.

These executable fixtures compose the real Cordis/DSH hook registry, patched original budget ledger, runtime Harness composition, RuntimeService, ArtifactStore and SQLite. The provider emits deterministic text with **synthetic** 10 input + 5 output tokens. The sandbox is `FakeSandbox`; no code, container, external model, provider SSE or invoice is involved. The separate [`real OpenSandbox probe`](../../spikes/harness-runtime/README.md) provides real sandbox evidence with a controlled provider.

| Scenario | Observable checks |
| --- | --- |
| Ordinary completion | Controlled model settles once; independent host validation accepts the sandbox fixture artifact; same tool call replays without a second execution |
| Enforce at 70% usage | Complete frozen provider request receives cap 750 from baseline 1000; the original plugin settles one automatic model call |
| Observe at 70% usage | Actual request keeps 1000; proposed reduction 750 is persisted |
| Component reconstruction | Cordis/plugin and SQLite are closed/recreated in the same process; budget and policy state survive; threshold notification is not repeated |
| Finalize allocation 0 or 500 | Full model request cannot fit; provider never starts; trusted finalization coordinator automatically selects the zero-call partial template, with pending required acceptance recorded |
| Bounded report enhancement | One affordable finalize call passes the actual original budget hook; reserve/dispatch/settle receipts are verified before accepting optional prose; interruption retains unknown and returns explicit partial output |
| Trusted budget adjustment and resume | Original local administration HTTP rejects an unmarked request, appends the accepted limit change, and explicit runtime resume releases the finalize latch. Reopen and replay retain scope, usage history, deadline and artifacts. The next real Harness model hook settles controlled usage and a new controlled sandbox step commits an artifact. |
| Unknown usage | Consumer stops before usage; original ledger retains unknown reservation; runtime pauses accounting before new sandbox work; component reconstruction retains scope, receipt cursor and artifact; resume requires explicit trusted fixture reconciliation |

The 70%/95% starting usage is injected through trusted reservation/dispatch/settle calls and is labeled synthetic. Actual scenario model requests still use the original plugin's automatic lifecycle; runtime does not debit a second ledger. The unknown-reconciliation step supplies trusted fixture usage, not a real provider billing guarantee.

The coordinator is [`src/core/finalize.ts`](../../src/core/finalize.ts). Hosts supply a trusted report port using the original plugin's automatic model hook; the coordinator does not reserve, settle or enlarge credit. It estimates a copy of the full frozen request, verifies new matching ledger receipts, and keeps model prose separate from the authoritative task template and status. Its durable report intent prevents a silent retry after interruption/reconstruction. The fixtures invoke this helper directly; the application's default bootstrap has not been extended into a complete optional-report product flow.

These scenarios provide the controlled combination evidence for P2-12. Real process termination, OpenSandbox recovery and model/chart delivery are mapped separately in the accepted [QA-03 evidence](../../docs/evidence/QA-03.md) and [v0.2 release](../../docs/releases/v0.2.md). The new budget-adjustment/resume branch still needs an external-model and Docker combination run. Full Harness Loader profile recovery remains a later enhancement. Source and scenario details are in [`tests/scenarios/budget-runtime.test.ts`](../../tests/scenarios/budget-runtime.test.ts) and [`docs/evidence/P2-12.md`](../../docs/evidence/P2-12.md).
