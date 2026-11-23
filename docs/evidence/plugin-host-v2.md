# P6-02 · 插件增强验收记录（任务作用域/附件/审批/取消/恢复）

更新：2026-11-20。本记录区分“已实际执行”与“未验证”。

## 1. 范围与环境

- DSH Desktop `0.2.2-rc.3` / Cordis `4.1.0`，Node 24.21（Electron 44.7）。
- 运行时 bundle `agent-sandbox-runtime@0.4.0-dev.0`，预算 bundle `dsh-plugin-agent-budget@0.4.0`。
- 改动入口：[src/plugin/index.ts](../../src/plugin/index.ts)、[src/adapters/harness/index.ts](../../src/adapters/harness/index.ts)、[src/adapters/harness/composition.ts](../../src/adapters/harness/composition.ts)、[src/storage/index.ts](../../src/storage/index.ts)、[src/client/dsh-panel.js](../../src/client/dsh-panel.js)、`tests/plugin/*`。

## 2. 实现结果

| 能力 | 实现 |
| --- | --- |
| 任务作用域 run | `SessionBinding` 记录 `messageId/generation/boundAt`；run ID 由根会话 + 人类消息 + generation 决定；交付验收后新消息轮换，未完成续跑复用；注入的 system-prompt 伪用户消息不定义任务 |
| 会话附件 | 读取用户消息的 `file`/`image` 块，经 `ctx.attachments` 取字节；文件名清洗、重名去重；`inputLimits` 数量/单文件/总字节上限；超限在 `createRun` 与沙箱前失败 |
| DSH 审批 | `authorize` hook 在工具规则之后、执行之前调用 `ctx.approval.request`；每 run 首次沙箱执行一次；拒绝/取消/不可用返回 `POLICY_TOOL_BLOCKED`，无 attempt |
| 取消/停止 | 工具 signal 取消走既有 `RuntimeService` 清理；`workspace/session-stop` 对活动根 run 调用幂等 `cancelRun`；已验收交付不取消 |
| 恢复/并发 | 启动时后台恢复 boot 期 run；复用前 await 对应恢复；插件重开复用原 attempt/execution；同 run 并发在沙箱前拒绝；双根会话 run/sandbox 隔离 |

## 3. 自动化检查（已执行）

```text
pnpm typecheck
pnpm test
```

结果：**70 个测试文件，66 passed + 4 skipped；790 passed + 12 skipped = 802**。设置 `RUNTIME_BUDGET_INTEGRATION=1` 后为 **802/802 全部通过**。新增 `tests/plugin/{binding,attachments,approval,cancellation,recovery}.test.ts`。

- `binding.test.ts`（6）：未完成复用、验收后轮换、终态同消息重试、子会话共享、注入消息过滤、legacy 回填。
- `attachments.test.ts`（6）：文件/图片入沙箱、重名、超限、附件服务缺失、配置冲突。
- `approval.test.ts`（6）：allowed-once 一次、拒绝/取消/不可用、mode none、缺服务激活失败。
- `cancellation.test.ts`（4）：signal 取消、session-stop、已验收保留、子会话停止不取消根。
- `recovery.test.ts`（3）：重开不重复派发、同 run 并发拒绝、双会话隔离。

## 4. 真实 profile 探针（已执行）

- 运行：`run-f2eef404650894e091ac27f7b90e081f`，session `session-aa5f692f-a35f-414f-ba47-413703a56b66`。
- `task` 为最近一条**人类**消息“为建议的增强完善写相关计划。”；绑定记录：
  `{"messageId":"9b170f97-66f3-4968-9fb0-f216c4f3f5aa","generation":0,"boundAt":1795122820972}`。
- 真实 OpenSandbox 执行一次探针，`exitCode 0`；因只交 `statistics.json`，`validation: failed`（`problems: ["report.md","chart"]`），未触发验收/结束回合；沙箱已清理。
- 这次探针验证了新绑定元数据、真实沙箱与结构化验收失败路径；不构成完整交付验收。

## 5. 完整交付验收（状态）

- 2026-11-20 的真实完整交付验收记录仍是 [plugin-host-v1.md](plugin-host-v1.md)：三份产物、结构化验收、`verify.py` PASS、沙箱清理。
- P6-02 在本轮只完成了同一根 run 上的真实沙箱探针（第 4 节），以及全部轮换/附件/审批/取消/恢复的自动化测试。
- 两次尝试用子代理在当前根 run 上补一次完整交付均未产生工具调用（子代理在调用前结束，无错误文本）；因此**没有**新的完整交付记录。
- profile 级“第二个人类消息触发新 run”尚未执行：需要用户在新会话或后续消息中触发，当前只有单元/集成测试覆盖。

## 6. 预算插件迁移与补丁（已完成）

- `.sources/budget` 测试已迁移到 0.2.2：`allEvents()` 使用 `session.seq` + `eventAt(SessionSeq(i))`；fork/seed header 补 `isSeeded`、用 `inheritedEventCount`；声明测试需要的 `LlmRequestPurposeMap`。
- 结果：`pnpm --dir .sources\budget run typecheck`、`run test`（10 files passed / 1 skipped，135 passed / 1 skipped）、`run lint`、`run build`、`run check` 全部 exit 0。
- `integrations/budget/reservations.patch` 已按基线 `28c77462aa20ceb27acc0cec99db0dea11087dbc` 重生成：165,975 bytes、纯 LF、SHA-256 `1f569967f1c63f1603a39a6f952c9d00342dfbab1874c018027b58454777b60a`。
- 干净 clone 中 `git apply --check` 与 `git apply` 均 exit 0；预算阶段 `run check` 通过（10 files passed / 1 skipped，135 passed / 1 skipped）。
- 干净重放脚本 `scripts/verify-clean-reproduction.ps1 -OutDir .runtime/clean-final` 已实际执行并以 exit 0 完成：预算阶段通过，主仓库 `pnpm check` **802/802 passed**，fixture 验证 PASS；证据 `D:\1GISwork\11-OPENSANDBOX+runtime\.runtime\clean-final\reproduction.json`。

## 7. 限制

- profile 级“第二个人类消息触发新 run”需要用户在**新会话/后续消息**中操作；当前只有单元/集成测试覆盖轮换，尚无第二次人工消息的真实 profile 记录。
- 客户端视觉与卸载检查见 [visual.md](plugin-host-v1/visual.md)，目前仅注册与接口已验证。
- 完整交付的 profile 记录仍引用 v1；本文件不声称新的完整交付验收。
