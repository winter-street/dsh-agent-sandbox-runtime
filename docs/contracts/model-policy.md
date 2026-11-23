# Harness model policy integration

`createHarnessModelPolicy` in `src/adapters/harness/model-policy.ts` installs actual agent/request and llm/stream hooks. Load it after the patched budget plugin; its prepend hooks wrap the downstream budget hook. The budget plugin remains the sole reservation/settlement owner.

The trusted composition root supplies session-to-run/root-budget binding, current cancellation/deadline and monotonic step/settlement counters, purpose/intent, required-work flag and an output profile. User/model text must not choose these fields. `readState` reloads the saved PolicyState; `commitDecision` must persist state and decision/notification events in one runtime transaction. All calls for a managed root, including children and auxiliary summaries, must flow through this plugin for its concurrency counter to cover them.

The request hook adjusts output before Harness freezes its request. Prose reductions use the trusted default output cap as baseline and do not repeatedly shrink a previously reduced header. Code and structured-output caps are preserved; a cap below the trusted minimum rejects. The final stream hook estimates complete messages/system/tools plus output, rechecks policy and refuses cap changes that bypass the request hook. It cannot mutate the frozen request; a disallowed final configuration must be rebuilt through the request lifecycle.

Concurrent admission is serialized per root scope and counted from admitted iterator start to downstream finalization, not guessed from reserved token amounts. A wait decision throws ModelPolicyError with retryable=true immediately. Runtime owns bounded retry/backoff and exposes waiting to the user; the hook does not run an unbounded waiting loop. Unknown usage, cancellation and elapsed deadlines remain prohibited in observe mode. Observe records proposed soft actions without applying reductions.

Host-assigned purpose is propagated through the downstream hook and every iterator next/return operation using the budget service's trusted context. Finalize requires a final-report intent and policy's finalize stage. An interrupted stream finalizes the downstream iterator before releasing its concurrency slot, allowing the budget plugin to preserve unknown usage.

`assertCanSpawn(sessionId, required)` is an explicit workflow admission gate. The workflow must call it before creating a new Agent. This module does not claim to intercept arbitrary third-party agent factories. Model-switch selection remains separate and must occur before complete-request estimation/reservation.

Verification: 14 actual Harness hook tests, including 2 opt-in patched-budget tests, passed; 3 bridge tests also passed. The opt-in environment switch is `RUNTIME_BUDGET_INTEGRATION=1`; default tests skip integration with the ignored checkout. Test providers are controlled and no external model was called. See P2-10-model-policy evidence.
