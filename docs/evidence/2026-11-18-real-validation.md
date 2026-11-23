# Real validation diagnostic — 2026-11-18

This is a diagnostic record, not a final effectiveness result.

## Environment gate

`pnpm eval doctor --driver eval/runtime-driver.ts --mode real` passed for all three variants: `hard-only`, `tiered`, and `tiered-finalize`. The check created and destroyed a real OpenSandbox sandbox for each variant. Credentials were loaded from the local environment and are not recorded here.

## Fifteen-slot run

- Output: `.runtime/evaluation-validation-20261118-portfix`
- Report: `.runtime/evaluation-validation-20261118-portfix-report`
- Slots: 15/15 recorded
- Sandbox failures: 0
- Outcomes: 15 `partial`
- Artifacts: no committed `statistics.json`, `report.md`, or `chart.svg`

Trace inspection shows the model could create and execute sandboxes. The incomplete runs spent turns inspecting paths or reading `input.csv`; some attempts timed out at the 60-second command limit or exited with a script error. The pre-fix host surfaced a generic host failure while the independent validator found missing artifacts, so the report labels these records as `provider`. This is a task-completion/validation issue, not an OpenSandbox startup issue.

## Changes made after inspection

- Added a bounded runtime system prompt that states the input/output directories, requires artifact verification, and discourages container-wide probing.
- Added one bounded completion nudge after an independent validation miss; a second miss ends the run without an unbounded retry loop.
- Classified independent acceptance failure as `VALIDATION_FAILED`/`validation` in the evaluation driver instead of `provider` for future runs.
- Added application-host regression assertions for the runtime prompt.

The 15-slot run started before these task-completion changes, so it is evidence for the infrastructure diagnosis only; it does not measure the nudge's effectiveness.

## Limits and next gate

The old 180-slot run remains at `.runtime/evaluation-final-20261117` and remains ineligible. The 15-slot diagnostic run does not qualify as the final evaluation. Do not start the 180-slot rerun until a fresh, small real smoke demonstrates that the model commits the required artifacts.

## Subsequent smoke: no dispatched tools

The user-run smoke at `.runtime/evaluation-smoke-20261118-042348-aa7a7a6f` recorded run `eval-580a4a2c-c32a-402b-824f-6c2d4924c544` as `partial / validation` with zero artifacts. Its two provider calls each reported 2048 output tokens. The original ledger settled 6954 tokens in total, with 43046 still available and no unknown calls. The trace contains no tool-attempt events. This run therefore did not exhaust its total token budget, and missing artifacts are not evidence of an OpenSandbox creation failure.

The old adapter omitted the `thinking` parameter and ignored incoming `reasoning_content`. The official DeepSeek thinking-mode guide, inspected on 2026-11-18, documents an enabled/high default and a separate reasoning response field:

```text
https://api-docs.deepseek.com/guides/thinking_mode
```

Those facts and the exact per-call cap usage make output truncation before any tool call a strong hypothesis. The historical trace did not persist finish reasons or reasoning counts, so it cannot prove the provider returned a particular finish reason or how those 2048 tokens were allocated. Stronger prompts alone did not resolve this smoke.

The follow-up repair explicitly disables thinking in all three evaluation profiles, raises their shared per-call output cap to 8192, and keeps the original 50000-token total budget. It separately maps/replays reasoning blocks, records bounded `model.response` metadata without response/secret contents, and preserves provider/truncation failure classification instead of masking it with missing-artifact errors. The smoke wrapper now displays these diagnostics. These code/config changes require a fresh output directory; neither old records nor the frozen task fixtures are rewritten. A new real-model artifact pass remains the next gate.

Validation after this repair: `pnpm check` passed typecheck, 575 tests (12 skipped), build/client assets and the fixed-input verifier. Regression coverage includes reasoning-only length stops, separate reasoning/tool history replay, bounded host truncation handling, exact original-ledger settlement and provider-versus-validation classification from persisted response metadata. `run-evaluation-smoke.ps1 -CheckOnly` passed environment/fixture checks without model or sandbox calls. These are offline checks, not a new effectiveness result.

## Passing single-slot smoke and post-run integration repair

The user-run smoke at `.runtime/evaluation-smoke-20261118-043721-19968078` recorded `eval-e1543861-ccb5-4530-8c7e-e914dc83af6b` as `complete`, with no failure kind. The independent validator passed statistics, report and SVG checks with no problems. Evidence is retained under `.runtime/evaluation-evidence/eval-e1543861-ccb5-4530-8c7e-e914dc83af6b/` (`validation.json`, `artifacts.json`, `trace.json`, `ledger.json`).

| Fact | Recorded value |
| --- | --- |
| Coverage | e01 / hard-only / repetition 1; 1 of 60 slots in the one-repetition plan |
| Duration | 31,111 ms |
| Actual provider calls | 4, each ending in `tool-calls`, with reported usage |
| Committed artifacts | 12 records: four attempts, each publishing the three required paths |
| Original ledger | 26,514 of 50,000 tokens used; 23,486 available; 0 reserved; 0 unknown calls |
| Acceptance | statistics.json, report.md and chart.svg independently passed |

Inspection found a bridge defect despite the passing outputs. Every sandbox execution exited 0 and committed valid artifacts, but `tool.policy-outcome` recorded `ok: false`. RuntimeService returned full stored artifact records including `runId/attemptId`; the bridge's strict nested schema accepted only public artifact-reference fields. The extra metadata caused a tool error after the side effects had already succeeded. This error feedback explains why the run repeatedly produced the same deliverables. Offline regressions reproduced the rejection from the full record shape and from the real RuntimeService-to-Harness composition before the fix.

The fifth apparent `model.response` entry had no finish reason, content, tools or usage because runtime policy rejected the next complete-request estimate before provider dispatch. Trace sequence 75 records `GLOBAL_BUDGET_UNAVAILABLE` and `WORK_BUDGET_UNAVAILABLE`: growing accumulated context plus the requested output reserve no longer fit the remaining allocation. The ledger contains no fifth provider call or unknown usage. An admission estimate exceeding the remaining allocation does not mean the ledger spent all 50,000 tokens.

The follow-up repair projects storage artifact metadata to the public reference fields while retaining semantic validation and the strict Harness output contract. It also makes the execution prompt conditional on missing outputs/failed validation and asks for a brief completion message after delivery. Known runtime model-policy rejections now produce `model.admission-rejected` trace events and appear separately in the smoke summary's `ModelAdmissionRejections`; they are not logged as empty provider responses.

The passing real run predates this bridge repair. It proves one task's independent artifact acceptance, not post-repair model efficiency, all three strategies, or final evaluation eligibility. Preserve the old evidence. Next gate: a fresh one-slot real smoke checking successful tool feedback, valid outputs and accounting, followed by small representative coverage of all strategies before any 180-slot run. No additional provider call was made while implementing or testing this repair.

Post-repair local validation: `pnpm check` passed typecheck, 577 tests (12 skipped), build/client assets and the fixed-input verifier. The new regressions and strengthened composition assertion failed before the fixes and passed afterward: stored-record projection, successful model-visible tool feedback, durable `ok: true`, and local admission rejection without a second provider call or ledger reservation.

## Post-repair real smoke: successful delivery and normal stop

The user-run `.runtime/evaluation-smoke-20261118-045452-12c8db64` recorded `eval-d1a9981b-a19b-496b-a15b-d861c0d3377f` as `complete`, with `failureKind: null`. Statistics, report and SVG independently passed and `problems` is empty. Its evidence directory is `.runtime/evaluation-evidence/eval-d1a9981b-a19b-496b-a15b-d861c0d3377f/`.

| Fact | Recorded value |
| --- | --- |
| Coverage | e01 / hard-only / repetition 1 |
| Duration | 13,113 ms |
| Model responses | Two: one `tool-calls`, then one normal `stop`; both include reported usage |
| Sandbox work | One attempt, exit 0; durable tool feedback `ok: true` |
| Artifacts | Exactly three committed records: statistics.json, report.md and chart.svg |
| Usage | 2,512 uncached input + 3,200 cached input + 2,065 output = 7,777 tokens |
| Ledger | 42,223 available of 50,000; 0 reserved; 0 unknown calls; metering complete |
| Local model admission rejections | None |

This verifies the bridge repair on one real model/sandbox task. Two observations of one task are not a statistically valid cost or latency benchmark; no aggregate improvement is claimed. `finalEvaluationEligible: false` remains expected at 1/60 evaluation slots. No additional paid call was made while inspecting these files.

The next diagnostic is five calibration tasks across three strategies, one repetition (15 slots). `scripts/run-evaluation-smoke.ps1 -Calibration` uses the shared environment loader, a new output directory and one bounded CLI run. It verifies exact task/variant/repetition coverage, reads each independent validation, and writes `smoke-summary.json`; any failed task returns exit 1. Infrastructure stop codes are preserved without automatic reconciliation or retry. `-Calibration -CheckOnly` only validates the local setup and frozen fixture hashes. Calibration evidence cannot be counted as a complete final evaluation.

## Fifteen-slot calibration: valid artifacts but two incomplete runs

The user-run `.runtime/calibration-smoke-20261118-050803-9651d117` recorded exactly 15/15 calibration slots. Thirteen reached `complete`; c05 / tiered and c05 / tiered-finalize reached `partial`, historically classified as `provider`. All fifteen independent artifact validations passed. This is a diagnostic result, not a complete final evaluation or a comparison of strategy effectiveness.

| c05 strategy | Outcome | Model calls | Ledger used tokens | Duration |
| --- | --- | --- | --- | --- |
| hard-only | complete | 2 work | 6814 | 12356 ms |
| tiered | partial / provider (historical classification) | 6 work | 33576 | 28810 ms |
| tiered-finalize | partial / provider (historical classification) | 5 work + 1 finalize | 25243 | 27920 ms |

Evidence directories are `.runtime/evaluation-evidence/eval-f44fa0f8-55f1-4e63-92e0-2e5edfcc0c95`, `eval-7a27f7c4-8f64-427e-b7d9-95b4fec8b92c` and `eval-18214b30-2e32-4e02-b4a6-ede3b719386e`. Both incomplete runs had complete metering, zero unknown calls and zero reservations. Their first Python attempt exited 0, committed `statistics.json` containing exactly `{"error":"INVALID_TIMESTAMP"}`, and produced successful tool feedback. Invalid timestamps require this error JSON only; report/chart checks are correctly null.

The model then issued a separate inspection using the next attempt's `AGENT_OUTPUT_DIR`. Each attempt has a fresh output directory; earlier committed artifacts are attached under `AGENT_INPUT_DIR/artifacts/<artifactId>/<path>`. The inspection therefore raised `FileNotFoundError`. The model alternated regeneration with failed inspection. Each incomplete run contains three copies of the error JSON; `ArtifactCount: 3` here does not mean statistics/report/chart. The tiered run had three successful and three failed tools; tiered-finalize had three successful and two failed tools.

Growing request context plus output reservation eventually caused local model admission to reject further work, while used tokens remained below the global limit. Independent acceptance later passed, but failed required inspection steps prevented complete finalization (`CONFLICT: Required work is incomplete`). The finalize variant also spent one optional report call before finding that conflict. No provider transport error is demonstrated by these traces; the driver's catch-all host-error attribution was incorrect. Original results remain unchanged.

### Completion-boundary repair and offline verification

- A trusted callback independently validates committed artifacts after each successful, nonempty tool delivery. Acceptance records `validation.completed` and `delivery.accepted`; the tool calls Harness rc.6's `ToolRunContext.concludeTurn()`. Its successful result commits normally before the turn ends. Further queued sibling tools cannot dispatch after acceptance. This applies equally to all three strategies.
- Execution instructions and the bounded nudge explain fresh directories and error-only output contracts. No frozen fixture, task prompt, reference answer or token allocation changed.
- Completion readiness checks artifact integrity, original accounting, required acceptance, required step statuses and unresolved attempts before optional report generation; finalization rechecks these conditions. A valid later artifact cannot silently clear a failed required step. Unknown usage and cancellation still prevent complete success.
- Future failure classification requires explicit model/provider finish evidence; internal conflicts remain `other`, local budget failures remain `budget`, and missing artifacts remain `validation` when no stronger cause exists. Generic fetch errors alone no longer prove a sandbox failure. Every failed result now writes `failure.json` with safe codes, validation state, incomplete required steps and evidence references, without raw provider error text.

The new application regression failed before the repair and passed afterward. `pnpm check` passed typecheck, **601 tests (12 skipped)**, build/client assets and the independent fixed-input verifier. Regressions cover c05 acceptance in all strategies, queued sibling inspection, failed required steps, cancellation during acceptance, unresolved execution, unknown accounting, validation before optional spending and internal-versus-provider failure attribution. These tests use controlled providers/sandboxes and the actual runtime/Harness/original budget composition where applicable. No additional paid model or real sandbox call was made during this repair.

Next gate: rerun `scripts/run-evaluation-smoke.ps1 -Calibration` in its automatically generated fresh directory. After this change, an accepted delivery can end with only a `tool-calls` response: the host concludes the turn without buying another work response. Full acceptance still requires the run's `complete` outcome and independent validation. A fresh 15/15 pass is pending; P1-08, QA-05, G1 and G5 remain open. Preserve both this historical calibration and `.runtime/evaluation-final-20261117`; new code fingerprints cannot be appended to those runs. Calibration always remains ineligible as a final effectiveness evaluation.

## Post-repair real calibration: 15/15 complete

The user-run `.runtime/calibration-smoke-20261118-053220-28b88aa2` completed all five calibration tasks in all three strategies, one repetition. All 15 records have `outcome: complete`, `failureKind: null`, passing independent validation, complete metering, zero unknown calls and zero reservations. Each trace contains exactly one successful `tool.policy-outcome` and one `delivery.accepted`; there is no repeated inspection cycle. The former c05 failures now complete with one error JSON each. Normal c01-c03 deliveries contain three artifacts; c04-c05 correctly contain one error JSON.

An offline audit reread the committed artifact copies, checked every size/SHA-256, and reran the input-derived validator for all 15 slots. It also checked exact task/strategy/repetition coverage, summed per-call usage against each original ledger, and compared current runtime/config fingerprints against the records. All checks passed. No external call was made by that audit.

| Strategy | Completed slots | Model calls | Successful tool executions | Total tokens | Sum of run durations |
| --- | --- | --- | --- | --- | --- |
| hard-only | 5/5 | 5 work | 5 | 17765 | 58198 ms |
| tiered | 5/5 | 5 work | 5 | 18006 | 59683 ms |
| tiered-finalize | 5/5 | 5 work + 5 finalize | 5 | 18381 | 62298 ms |

These are descriptive calibration totals only, not currency costs or evidence that one budget strategy is more effective. Every task completed after its first successful tool call, so this batch does not establish behavior under sustained budget pressure. The local check baseline remains 601 passing tests, 12 skipped; this evidence update changes documentation only.

Suite fingerprint remains `b832c76a98fad3919c974f9a44941d0482351a75551bf315723c3082ee014d80`; execution code revision is `5cdee9ded1f0b613d84c2f6decb3531a99446b58ef4234c2cd9a9ba399187d2c`. The calibration gate has passed. `finalEvaluationEligible: false` is expected for this split. At this stage the separate 180-slot evaluation was pending; the user subsequently completed it as recorded below. P1-08/QA-05 and G1/G5 remain open for their remaining acceptance requirements.

## Completed 180-slot evaluation and offline audit

The user completed `.runtime/evaluation-final-20261118-validated`: 180/180 recorded, 177 complete, 3 partial. Hard-only completed 58/60, tiered 59/60, tiered-finalize 60/60. All 180 submitted statistics and applicable report/chart checks independently pass. Offline inspection reread and checked size/SHA-256 for 407 saved artifacts, reran all 180 validators, verified coverage and saved-result identity, reconciled per-call original receipts with ledger snapshots, and checked current runtime/config fingerprints against the records. No unknown usage, unresolved reservations or known token overage was found. The audit invoked no external service.

Three first-repetition partial runs are e08/hard-only (`eval-c2cd7fd2-cb19-4c38-ba83-a48ec35fbaae`), e10/tiered (`eval-dffa2054-2afa-4f0a-bae0-ed1d60e0805b`), and e11/hard-only (`eval-a13f7b7b-8bcc-43e0-9327-643b3c469160`). Each first script wrote the correct error JSON then failed an unconditional `report.md` existence assertion. Subsequent calls repeated the assertion; e08/e11 also inspected the next attempt's empty output directory. There were respectively 5, 4 and 5 failed required Python steps. The successful-tool acceptance callback could not conclude a nonzero-exit execution. Further model admission was blocked when the full next request no longer fit; actual settled totals were 31704, 31727 and 29767 tokens, below the 50000 cap. Independent validation passed at idle, but required-step verification correctly preserved partial/CONFLICT. No provider transport or sandbox failure is established by these traces.

The historical report gate also requires 100% task success, beyond complete experiment records. Its previous documentation understated this. The gate and all original outcomes remain unchanged; the offline report now adds `evaluationDataComplete`, separate acceptance counts, explicit blockers and unaccepted-run details. In the expanded `.runtime/evaluation-final-20261118-audited-report`, data completeness is true, accepted is 177/180, strict eligibility remains false with three `RUN_NOT_ACCEPTED` rows. Original report `.runtime/evaluation-final-20261118-validated-report` is preserved. Audit summary is `.runtime/evaluation-final-20261118-validated-audit.json`.

After three focused report regressions, full `pnpm check` passed **604 tests, 12 skipped**, typecheck, build/client assets and the fixed-input verifier. No runtime, evaluation driver, validator, config or frozen suite changes were made during this audit. [Results and executable follow-up plan](../evaluation.md) document the next runtime repairs and a future two-worker evaluation plan. The observed token differences are descriptive, not a causal saving claim; denials have no independent review denominator. Another paid batch was not launched. G1/G5 remain open.
