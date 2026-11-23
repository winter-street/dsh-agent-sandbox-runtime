# N04 - Serial application browser and failure acceptance

Date: 2026-11-19 (Asia/Shanghai). Status: **controlled production-host browser and application failure paths verified; complete external-model/OpenSandbox acceptance remains open**.

These checks use the production application, actual local Harness, original budget plugin, SQLite, HTTP/SSE and a real bundled MCP stdio subprocess. The model and sandbox ports are controlled. Provider usage is synthetic (20 input + 10 output tokens per role); no external inference, generated Python execution or provider billing is established by these checks.

## Browser acceptance

Entry points: `tests/client/serial-browser-smoke.mjs` and `tests/client/serial-browser-server.ts`. Completed command:

```powershell
$env:RUNTIME_PLAYWRIGHT_MODULE = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright-core\index.mjs'
$env:RUNTIME_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/client/serial-browser-smoke.mjs
```

Use the installed Playwright module and browser paths on another machine. This command injects both controlled ports and never reads application credentials.

Result: exit 0, seven checks, no page errors, Chrome `157.0.8103.79`; viewports 1440 x 1100 and 390 x 844. Evidence directory: `.runtime/n04-serial-browser-2026-11-18T16-18-53-621Z-e1fb699d` (UTC directory timestamp; local date is November 19). It contains `result.json`, `audit.jsonl`, durable application state and six screenshots. Backend PIDs were 24796 and 41040.

| Browser flow | Observed result |
| --- | --- |
| Approve once | Planner/Executor wait before execution; approval automatically schedules one execution and Reviewer. Downloaded `result.json` bytes equal `{"verified":true}`. Three original-scope reserves/settlements, 90 synthetic tokens, no unknown usage or remaining reservation |
| Duplicate decision | Same decision returns HTTP 200; conflicting duplicate returns 409; no repeated role, execution or consumption |
| Reject then cancel | Rejection stays paused, makes no execution and does not prompt again; cancellation completes with only the first two role calls |
| Force backend exit while approval is pending | Same scope, deadline, approval and ledger survive reopening; browser approval afterward invokes only Reviewer beyond the stored Planner/Executor and executes code once; MCP receipt is reused |
| Cancel running execution | Controlled remote cancel is confirmed and destroy observed; no Reviewer or artifact publication follows |
| Mobile controls | Approval/rejection controls usable; no horizontal overflow |
| Authentication and page errors | Token stays in memory, no token persisted by the client, no browser page errors |

The restart deliberately kills the test-owned backend process. After confirming it exited, the runner explicitly invokes the original plugin's checked dead-writer lock recovery before restarting. This is not unattended automatic lock recovery or a machine-reboot test. Remote cancellation/destroy observations refer to the controlled sandbox port.

Visual inspection of `approval-succeeded.png` and `mobile-pending.png` found legible controls and no incoherent overlap. The shared client now applies the latest revision consistently to both the task list and detail; delayed list data cannot regress a newer detail status. The existing root-agent browser regression also passed all 14 listed flows, with five screenshots in `.runtime/n04-client-regression-20261119`.

## Production application failure paths

`tests/app/serial.test.ts` passes 27 cases. Nine added cases extend the existing approval, cancellation, accounting, configuration, unknown-dispatch and independent-validation coverage:

| Injected condition | Required application behavior | Accounting and replay |
| --- | --- | --- |
| Proven unsent sandbox-creation failure | One approved operation admits a second service attempt and succeeds | Three role calls / 90 tokens; one execution; reopening does not repeat work |
| Creation failures exhaust the two-attempt bound | Partial completion and retained exhausted attempts | Two role calls / 60 tokens; no execution; repeated approval/reopening does not restart attempts |
| Schema-invalid Planner, Executor or Reviewer output (three cases) | Recovery required; original pending role evidence retained | 1/2/3 calls settle 30/60/90 tokens respectively; no role replay on reopening |
| Tool quota reached | `POLICY_TOOL_BLOCKED / TOOL_CALL_LIMIT` before approval | Two role calls / 60 tokens; no sandbox activity or approval; prior 32 admissions are seeded through the actual durable engine, not 32 executed scripts |
| Same script fails three times without changed input/progress | Fourth execution rejected with `NO_PROGRESS` before approval | Three consumed approvals and executions; eight role calls / 240 tokens; tool-policy state survives reopening |
| Required MCP request timeout | Failed `TOOL_TIMEOUT` receipt, partial completion | No role/provider call, reservation, settlement, approval or sandbox activity; failed receipt is not repeated on reopening |
| MCP subprocess forcibly disconnected | Failed `EXECUTION_UNKNOWN` receipt, recovery required | Same zero-call accounting; role marked `not-dispatched`; reopening preserves unknown tool result and does not repeat it |

The MCP cases use the actual SDK/stdio server, with a bounded delayed request. The disconnect test kills only its own known MCP child PID. All other injected remote failures use the controlled sandbox port. Each failure case checks the original ledger, exact call counts and persisted state after closing/reopening the application within the same test process.

The disconnect regression exposed and fixed a production classification bug: a trusted `RuntimeError` wrapped in `RoleNotDispatchedError` previously fell through to partial finalization. The application now preserves its recovery-required classification while retaining proof that the primary model role was unsent. Arbitrary error objects with a matching string code do not gain that trusted classification. The fixture does not provide a command to clear unknown tool receipts.

## Complete local verification

```powershell
$env:RUNTIME_BUDGET_INTEGRATION = '1'
node scripts/check.mjs
```

Result: exit 0; **712/712 tests across 62 files, none skipped**, including all 27 serial-application cases. Typecheck, build, client asset copy and the Python frozen-fixture self-test (five fixtures plus mutation rejection) pass. Generated check log: `.runtime/n04-local-check-20261119.log`. The opt-in switch enables local original-budget composition tests, not external provider calls.

## Remaining acceptance

1. Run one bounded fixed task using the external model, original ledger and real OpenSandbox together. Keep input/output contracts, original scope/deadline, individual role receipts, approval and cleanup evidence.
2. Observe bounded real remote failure/recovery in that composition; controlled fault injection does not establish external-service behavior.
3. Review the prerequisite P2/P3/P4 and QA evidence, including the single-agent comparison, before closing P4-07 or G4. Historical evaluation remains unchanged: 180 slots, 177 complete, 3 partial, `finalEvaluationEligible=false`.
