# Harness hook / tool / resume probe

This probe runs published Harness `0.1.0-rc.6` modules and Cordis `4.0.1` with a deterministic local LLM adapter. It verifies the host integration surface without a provider key, paid inference, or a sandbox.

From this directory:

```powershell
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm probe
```

`--ignore-workspace` is necessary: this is a standalone probe with its own lockfile inside the runtime repository. Tested on Node `22.22.2`, pnpm `11.7.0`, Windows. A successful run exits 0 and writes `result.json` only after cleanup succeeds. Session JSONL files are written beneath the ignored `.runtime/harness-probe/` directory, each run in a fresh subdirectory.

## Covered assertions

1. Actual AgentLoop invokes a registered tool and records its result. `agent/request` changes the output cap before immutable `llm/stream` options are built; the request header records the cap.
2. Child calls carry their session ID, and their durable session header records the parent.
3. An adapter exception before usage becomes an error finish with unknown usage.
4. A stream disconnect after partial output also leaves usage unknown.
5. Agent cancellation reaches the adapter signal and ends with an aborted finish, without fabricating usage.
6. JSONL flush, agent disposal and same-session resume preserve existing message identities; subsequent work is appended.
7. The tool disposer removes its registration.
8. Agent handles and root fiber effects dispose cleanly.

## Boundaries

- The provider emits synthetic usage. External providers' billing, cache buckets, output limits and disconnect behavior still require a separate real-provider check.
- Durable parent lineage is a prerequisite for root budget resolution. This probe does not install the budget plugin and does not prove shared-budget accounting.
- Resume covers the Harness conversation log; it does not recover an OpenSandbox process, runtime checkpoint or external side effect.
- The probe composes published modules directly. It does not verify the shipped Loader/profile launch path or process-crash recovery.
- `.sources/harness` is a separately downloaded current-source reference. Its master version is not the version executed here.

API decisions and evidence are in `docs/contracts/harness.md` and `docs/evidence/P0-02.md` at the repository root.
