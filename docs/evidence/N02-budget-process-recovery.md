# N02 · 真实预算账本与沙箱进程恢复

日期：2026-11-18。状态：**真实 Docker 三个崩溃窗口已通过；G2 的组合门槛仍开放**。

## 验证命令

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-budget-process-recovery-docker.ps1 -CrashPoint after-dispatch-intent
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-budget-process-recovery-docker.ps1 -CrashPoint after-execute
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-budget-process-recovery-docker.ps1 -CrashPoint after-publish
```

报告：`.runtime/sandbox-smoke/budget-process-recovery-after-dispatch-intent.json`、`.runtime/sandbox-smoke/budget-process-recovery-after-execute.json`、`.runtime/sandbox-smoke/budget-process-recovery-smoke.json`。

脚本通过 `scripts/evaluation-env.ps1` 从 `.env.local` 安全加载凭据，只向 Docker 传递环境变量，不打印或写入凭据。容器使用 OpenSandbox SDK 1.2.1、真实 `OpenSandboxAdapter` 和原预算插件；worker 内没有模型/provider 调用，迟到 usage 是受控核对输入。

## 实际结果

三个命令均退出码为 0。早期窗口各 3/3、`after-publish` 窗口 6/6 检查通过：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 独立 worker 在三个指定窗口被 `SIGKILL` | 通过 | 三份报告均记录 `signal=SIGKILL`，窗口分别为 `after-dispatch-intent`、`after-execute`、`after-publish` |
| 回收死亡 worker 的预算 writer lock | 通过 | 原锁安全回收 |
| 早期窗口保留未知 attempt 且不自动重发 | 通过 | `attemptStatus=UNKNOWN`、`runStatus=RECOVERY_REQUIRED`、attempt 数保持 1 |
| 早期窗口清理无法关联 execution 的远端沙箱 | 通过 | `sandboxCleaned=true`，未生成本地产物 |
| 重开原账本保留 scope，并将 dispatched usage 标为 unknown | 通过 | `unknownCalls=1`、`reservedTokens=100` |
| `after-publish` 使用原 execution/attempt 补交远端结果 | 通过 | attempt 数保持 1，未重复 dispatch，产物哈希已记录 |
| 迟到 usage 只结算一次，冲突重复 usage 被拒绝 | 通过 | `usedTokens=40`、`unknownCalls=0`、`reservedTokens=0` |
| 原 scope 下重放同一 attempt 并完成最终化 | 通过 | `finalStatus=SUCCEEDED`、原 deadline 保留、receipt cursor=5 |

## 覆盖边界

这次真实验证覆盖三类窗口：dispatch intent 已持久化但尚未执行、沙箱已派发但本地尚未写入 execution 身份、远端完成且产物已发布但本地 SQLite 尚未提交。前两类在无法关联远端 execution 时保守进入 `UNKNOWN + RECOVERY_REQUIRED` 并清理沙箱；后一类沿用原 execution/attempt 补交，不重复执行。它没有验证 provider invoice 或任意外部副作用的 exactly-once。

因此 P2-06 的进程恢复窗口已补齐；P2-12 仍需普通完成、软限制、预算暂停、未知 usage 和模板收尾的组合演示。该报告可以作为 QA-03/G2 的真实进程恢复证据之一，不能单独关闭 G2。
