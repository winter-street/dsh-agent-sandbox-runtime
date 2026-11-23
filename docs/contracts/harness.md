# Harness integration contract — P0-02

Verified on 2026-11-16 using published Harness packages `0.1.0-rc.6`, Cordis `4.0.1`, schemastery `3.18.1`, Node `22.22.2`. Exact dependencies are locked in `spikes/harness-hooks/pnpm-lock.yaml`.

## Version choice

The original budget plugin pins the rc.6 generation. The inspected upstream master snapshot is `39163dd30f703a79079e2d2446545cff3c453738`, package `0.2.2-rc.3`, with Node `>=24.9.0` and Cordis `4.1.0`. It is stored in `.sources/harness` for reference and is not the code executed by the probe. Do not mix current-master APIs into the rc.6 adapter or install floating `latest` tags.

Reference repositories: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [the fixed inspected source](https://github.com/deepseek-ai/deepseek-harness/tree/39163dd30f703a79079e2d2446545cff3c453738). The compatibility baseline for runtime integration remains the published rc.6 package declarations and executable probe.

## Verified extension points

| Need | rc.6 API | Integration consequence |
| --- | --- | --- |
| Configure model requests | `ctx.on('agent/request', async (payload, next) => replacementConfig)` | Await `next()` and return a replacement config. The output cap appears in the durable request header. |
| Observe actual model dispatch and usage | `ctx.on('llm/stream', (options, next) => wrappedAsyncIterable)` | Options are frozen. Reserve using the final request at iteration time; wrap consumption and handle `finally`. Do not mutate options. |
| Register a runtime tool | `ctx.tools.register(definition)` | Supply JSON Schema for both parameters and canonical output, an output renderer, and an async execute function. Registration returns a disposer. |
| Attribute tool work | `exec.agent.session.id`, `exec.callId`, `exec.rootCallId` | Resolve the run through trusted session mappings. Do not take run, budget scope or privilege from model arguments. |
| Observe cancellation | `exec.signal`, model `options.signal` | Forward the signal and await owned work reaching a known state. An abort signal alone is not confirmation that a remote process stopped. |
| Create a root/child | `ctx.agents.create({ sessionId, meta, agentOptions, setup })` | Await creation; only then enqueue messages. For child ownership use the parent agent context and durable `meta.parentSession`. |
| Send work | `agent.followup(createUserMessage(...))`, `await agent.whenIdle()` | Host owns the model loop; the adapter must not create another hidden loop. |
| Cancel a conversation | `agent.cancel({ kind: 'user' })` | Tested cancellation reaches the provider adapter; runtime cancellation still needs remote-execution confirmation. |
| Persist and resume | `ctx.sessions.flush(session)`, `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` | Requires a persistence plugin. Resume preserves the session ID and existing messages; recover the same budget binding separately. |
| Unload contributions | `fiber.dispose()`, registration disposers | Await plugin startup with `ctx.plugin(...).await()`. Root probe teardown uses `ctx.fiber.dispose()`, not nonexistent `ctx.dispose()`. |

The probe uses actual AgentRegistry, AgentLoop, LlmRuntime, SessionStore, SystemPrompt, ToolRuntime and JSONL persistence modules. Only the provider implementation is synthetic.

## Call lifecycle and accounting

```text
agent/request -> final frozen llm/stream options -> iterate stream
  -> reservation (budget plugin) -> dispatch intent -> provider chunks
  -> usage -> finish -> settle exactly once
                     -> missing usage: unknown, retain reservation
```

Reservation and settlement remain owned by the budget plugin. The runtime tool bridge only resolves a run, executes code through RuntimeService and returns the canonical result. It must not reserve or settle the same model call again.

Exceptions are normalized to an error finish by the tested host. Cancellation yields an aborted finish. An error/aborted finish does not establish zero usage: in the probe's before-usage and partial-stream failures no usage arrives. Preserve that distinction when replaying or settling the budget.

`inputTokens`, `cacheReadTokens`, `cacheWriteTokens` and `outputTokens` are disjoint rc.6 usage buckets. The reasoning counter is a breakdown of output and must not be added a second time. A provider adapter must normalize its own upstream format before budget settlement; synthetic probe counts are not provider billing evidence.

## Trusted work/finalize purpose

rc.6 `GenerateOptions.purpose` accepts only `compaction` and `session-title`; ordinary conversation omits it. `work` and `finalize` must not be inserted into that host field or accepted as model tool arguments.

The budget service should use its own trusted per-call/session binding for work versus finalize, with explicit cleanup and concurrency isolation. An AsyncLocalStorage wrapper is one candidate, but a wrapper around `followup()` alone is insufficient evidence: the queued model loop may execute later under another async context. Verify the binding at the actual `llm/stream` hook. Auxiliary calls such as compaction and session title still consume the owning root budget and need an explicit allocation policy.

## Runtime bridge boundary

The runtime integration receives an executor and a trusted `resolveRun(sessionId, parentSession?)` mapping from the composition root. The model-visible tool accepts code and an optional repairOf list. Input files, root-session mapping, step identity and budget ownership come from trusted runtime state; no arbitrary host-file path, budget reset or permission escalation is exposed.

The tool is exclusive by default; it does not opt into concurrent mutation. Result data must be lossless JSON matching the declared schema. Include bounded stdout/stderr, exit code, attempt ID and committed artifact references. Unloading must remove registrations and stop/await the adapter's active work through the executor's cancellation contract.

Storage artifact records include `runId` and `attemptId`, while model-visible references contain only `artifactId`, `path`, `size` and `sha256`. The bridge projects those records through its artifact schema before the strict Harness output check; semantic constraints still reject invalid sizes or hashes. This projection also applies to records returned by RuntimeService replay and does not change the stored manifest.

Implemented bridge: `src/adapters/harness/index.ts`, factory `createHarnessRuntimePlugin({ executor, resolveRun, maxCodeBytes? })`, tool `runtime_python`. The resolver returns `{ runId, inputs }` or undefined. It is called with the active session and durable parent session; an unresolved session is denied. `runtimeStepId(sessionId, callId)` hashes the tuple to a stable step key. The RuntimeService must use that key plus its own request/input/code hashes for replay conflict detection; a step key by itself is not sufficient proof that work is safe to repeat.

rc.6 accepts a limited JSON Schema subset. Numeric and length constraints such as `minimum`, `minLength` and `maxLength` are not supported by its output schema checker. The bridge therefore uses supported object/type/required/additionalProperties keywords for the host contract, checks code length in UTF-8 bytes, and validates semantic output constraints with Zod before returning the value. Validation of an output cannot undo side effects already executed; the executor owns the authoritative committed result and recovery state.

`tests/adapters/harness.test.ts` exercises the actual registry and agent modules with a fake runtime executor: 15 cases passed. They cover authority-bearing argument rejection, missing bindings/agents, immutable input copies, child lineage, internal artifact projection, result validation, caller cancellation, plugin unload, and a binding-resolution/unload race. The application-host regression additionally runs the real RuntimeService and original budget plugin with controlled provider/sandbox seams and checks the model receives a successful tool result and the durable policy records `ok: true`. Cancellation tests explicitly delay executor cleanup to assert the tool does not settle prematurely.

## Integration acceptance updated 2026-11-19

The published-host probe establishes hook order, tool registration, bounded requests, interruption and conversation-log resume. Follow-up [P1-06](../evidence/P1-06-harness.md) and [QA-02](../evidence/QA-02.md) link root/child shared ownership, original-ledger accounting, tool authority checks and the real external-model and sandbox delivery. Four runtime integration files passed 49 tests with zero skips in the acceptance review.

[N01](../evidence/N01-fault-matrix.md) records local transport faults with the real host and original plugin, plus bounded external authentication rejection and stream interruption. [N02](../evidence/N02-budget-process-recovery.md) records independent-worker termination and original-ledger and remote-execution recovery.

The original G1 requirements are accepted in QA-02. Full Loader/profile configuration reload, provider invoice reconciliation and broader external failure statistics remain follow-up capabilities. Each report retains its own environment, synthetic inputs and observed limitations.
