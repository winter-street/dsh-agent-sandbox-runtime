# QA-06 — Infrastructure guard and failure evidence

Date: 2026-11-18 (America/Los_Angeles). Status: **implemented and verified against the local Docker/OpenSandbox service; final effectiveness evaluation remains open**.

## Implemented behavior

- `OpenSandboxAdapter.preflight()` performs a bounded create, execute, collect and destroy probe.
- `pnpm eval doctor --driver eval/runtime-driver.ts --mode real` runs the probe for all three evaluation configurations before a slot is persisted.
- `RuntimeService` records sanitized `sandbox.failure` evidence, opens a host-local circuit after infrastructure signatures, pauses the run, and marks the failed exploratory step optional. Ordinary retryable adapter errors retain the existing retry controller behavior.
- Harness model admission checks the same circuit before dispatch, preventing a sandbox outage from producing another provider call.
- The evaluation driver writes `failure.json`, classifies Docker/OpenSandbox failures as `sandbox`, and the durable runner stops the current batch after the first sandbox failure.
- Classification also falls back to persisted `attempt.failed` sandbox-create codes when an SDK wrapper does not expose the nested service error to the host.
- A trusted `setDeliveryManifest()` API and manifest-aware validation prevent a later exploratory attempt from silently replacing a previously committed delivery.
- Runtime and upstream budget estimates use the same 25% safety margin; usage remains settled from provider receipts rather than estimates.
- The application host now contributes a bounded execution system section: it directs the model to use `AGENT_INPUT_DIR`/`AGENT_OUTPUT_DIR`, verify artifacts, and avoid container-wide probing.
- Acceptance failures are surfaced by the host as `VALIDATION_FAILED` and classified as `validation`, rather than being mistaken for provider failures.

## Verification

```text
pnpm typecheck                         # passed
pnpm build                             # passed
pnpm --dir .sources/budget typecheck   # passed
pnpm test                              # 45 files, 566 passed, 12 skipped
```

With the configured credentials and Docker service, `pnpm eval doctor --driver eval/runtime-driver.ts --mode real` passed for `hard-only`, `tiered`, and `tiered-finalize`. The authorized 15-slot diagnostic run is preserved under `.runtime/evaluation-validation-20261118-portfix`; all 15 slots reached the sandbox, while all 15 ended as partial artifact/acceptance failures because the model did not commit the required artifacts. The pre-fix report labels those host failures as `provider`; the classification fix above maps the same condition to `validation` for future runs. No slot reported `SANDBOX_CREATE_FAILED` after the Windows port-range fix. The independent report is `.runtime/evaluation-validation-20261118-portfix-report`.

The existing 180-slot failure experiment remains preserved under `.runtime/evaluation-final-20261117`; it is not reinterpreted as an effectiveness result, and the final-evaluation script refuses to reuse a full but ineligible report. A new final evaluation requires fixing the model task-completion behavior and then explicitly starting a fresh output directory.
