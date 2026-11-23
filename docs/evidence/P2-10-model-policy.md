# P2-10 supplement — model request policy

Date: 2026-11-16. Root implementation is in the coordinating worktree. Budget dependency commit: `b640a3a15daf520c78c61303200bca23a601d9ea`. This evidence covers the model-side policy hooks and bridge; it does not close full P2-10/11 runtime persistence or external-provider gates by itself.

Delivered `src/adapters/harness/model-policy.ts`, `tests/adapters/model-policy.test.ts`, integration contract, and the budget service bridge/tests. Initial tests exposed that real Harness normalizes provider exceptions into finish(error), and that AgentRegistry requires AgentLoop to create an agent. Both fixtures were corrected to match actual host behavior, rather than assuming a nonexistent lifecycle.

Final command in root: set `RUNTIME_BUDGET_INTEGRATION=1`, run `pnpm exec vitest run tests/adapters/model-policy.test.ts tests/adapters/budget.test.ts`. Exit 0: **17 passed** (14 policy, 3 bridge). [Raw output](logs/model-policy-check.txt). Typecheck at an earlier parallel checkpoint found only a separate RuntimeService Uint8Array generic mismatch, reported to its owner; coordinating task records aggregate checks.

Covered: enforce/observe prose cap, immutable request header, no cumulative shrinking, code-output minimum, full-input reestimate, final cap bypass rejection, actual iterator count and simultaneous-slot competition, bounded wait errors, unknown/cancel/deadline prohibition, workflow spawning gate, and concurrency cleanup after consumer cancellation or provider error.

Two opt-in tests load real Cordis/DSH modules and the patched budget plugin with a controlled provider. Two successful calls produce exactly two reservations and two settlements (15 tokens each, one in finalize). Consumer interruption leaves one unknown reservation and blocks the next call without another provider attempt. No second budget ledger or policy-side settlement is created.

Remaining composition obligations: persist decision/state/events atomically, supply trusted current run metadata, call assertCanSpawn from workflow creation, and route all managed model calls through the policy. External models, real token estimate error, real sandbox and task completion benefits remain unverified.
