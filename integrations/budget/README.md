# Reproduce the budget-plugin extension

2026-11-20 clean-source replay is automated by `scripts/verify-clean-reproduction.ps1`. It checks out the baseline, applies the tracked patch, normalizes executable `.mjs` line endings, installs locked dependencies and runs the plugin and runtime checks in fresh directories. The default uses local Git objects/pnpm cache; `-Online` permits downloading missing locked packages. It does not copy credentials or call live services. This is same-host clean-source evidence, not a fresh-machine deployment.

The runtime uses an unreleased change to the MIT-licensed [dsh-plugin-agent-budget](https://github.com/winter-street/dsh-plugin-agent-budget). The 0.4.0 baseline lacks the required reservation service. This tracked patch preserves the implementation even though `.sources/` is ignored.

| Item | Value |
| --- | --- |
| Upstream baseline | `28c77462aa20ceb27acc0cec99db0dea11087dbc` |
| Local implementation base | `b640a3a15daf520c78c61303200bca23a601d9ea` plus the 0.2.2/Cordis 4.1 test migration, request-estimate safety margin and trusted call identity |
| Patch | `integrations/budget/reservations.patch` |
| Current patch SHA-256 | `1f569967f1c63f1603a39a6f952c9d00342dfbab1874c018027b58454777b60a` |
| Patch size | 165,975 bytes (LF) |
| Verified host | Cordis 4.1.0; DSH agent/llm/session/session-projection/system-prompt/tools 0.2.2-rc.3 |
| Local runtime | Node 22.22.2; pnpm 11.7.0; Windows/PowerShell |

From a new checkout of this runtime, run the following from its root. If `.sources/budget` already exists, preserve local changes and inspect it before applying; do not reset an existing worktree.

```powershell
git clone https://github.com/winter-street/dsh-plugin-agent-budget.git .sources/budget
git -C .sources/budget checkout --detach 28c77462aa20ceb27acc0cec99db0dea11087dbc
git -C .sources/budget apply --check ../../integrations/budget/reservations.patch
git -C .sources/budget apply ../../integrations/budget/reservations.patch
pnpm --dir .sources/budget install --frozen-lockfile --ignore-scripts
pnpm --dir .sources/budget check
```

Run each command only after the preceding command succeeds. The patch includes `.gitattributes` to preserve LF in executable mjs scripts; if an existing Windows checkout had CRLF, renormalize `scripts/migrate-session-log.mjs` to LF before running migration tests. That file's Git content did not change because the repair was working-tree EOL only.

`lib/index.js` is produced by the check/build command and can be loaded as a local plugin using the host's supported plugin mechanism. Register the patched plugin with `reservationMode: true` and an explicit storageDir; set `maxTokens` only when the conversation should start locked (omitting it opens the scope unlocked), and keep `pressurePrompt: false` in the bundle patch. `pressurePrompt` is not supported on DSH 0.2.2 because `AssembleContext` no longer exposes the agent/session the pressure section needs; the plugin logs a warning instead of registering an empty section. Await activation before `connectBudgetService(ctx)`. Keep legacy and automatic-reservation model paths separate: the automatic llm/stream hook owns reservation/settlement and the runtime must not repeat them.

The extension retains the original package version for local development and has not been published. It adds version-2 events, `ctx.get('agentBudget')`, trusted work/finalize allocation/context, event receipts and a checked stale-lock recovery command. See [budget contract](../../docs/contracts/budget-v2.md) and patched SECURITY.md for migration/rollback details. Back up existing accounting before first use; never remove v2 events to downgrade or reset credit on task resume.

Validation: `pnpm --dir .sources/budget run check` exited 0 on 2026-11-20; typecheck, lint, 135 passed tests plus 1 real DeepSeek smoke skipped without credentials, build and package verification passed. A clean clone at the baseline with this patch applied (`git apply --check` and `git apply` both exited 0) also installed locked dependencies and ran the same check with the same result. Lock recovery includes an actual terminated child process. Model lifecycle tests use real host modules with controlled provider output. No external model or sandbox completion is claimed by these checks. Reverse application was checked against the implementation tree; patch replay against the baseline is also validated separately in P2-01 evidence.
