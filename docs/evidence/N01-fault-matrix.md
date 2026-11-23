# N01 · 统一 provider / sandbox 故障矩阵

日期为 2026-11-18，验收更新于 2026-11-19。**受控矩阵 10/10、本机 HTTP/SSE 6/6、外部 DeepSeek 探针 2/2 通过，原始 G1 已按 QA-02 逐项验收。**

## 受控验证

入口：`pnpm eval fault-matrix --out <新目录>`。

本次证据目录：`.runtime/fault-matrix-controlled-20261118-081152`。

命令退出码为 0，10/10 场景通过：

| 场景 | 结果 | 关键决策 |
| --- | --- | --- |
| provider HTTP 错误 | 通过 | provider，暂停，usage 保留未知，要求核对 |
| provider SSE 中断 | 通过 | provider，可重试性仅作候选，先核对原调用 |
| SSE 无 finish | 通过 | provider，先核对，不自动重发 |
| provider 缺少 usage | 通过 | accounting，暂停，不把 usage 当作 0 |
| provider 请求超时 | 通过 | provider，先核对，保留可能已发送的预留 |
| 客户端取消（发送前） | 通过 | cancelled，释放明确未发送的预留 |
| 沙箱创建失败 | 通过 | sandbox，进入 `RECOVERY_REQUIRED`，人工核对后恢复 |
| 沙箱命令超时且取消确认 | 通过 | sandbox，记录 `TIMED_OUT`，可由上层有限重试策略决定 |
| 远端取消未确认 | 通过 | sandbox，保留 `UNKNOWN`，不得报告已取消 |
| 远端结果未知 | 通过 | sandbox，保留执行身份和 `UNKNOWN`，要求核对 |

每个场景目录都写入 `evidence.json` 和受限 `failure.json`。失败文件只保存场景 ID、分类、代码、阶段、重试/动作/核对状态和证据引用；provider 响应正文不落盘。测试还确认不存在的 provider 原始错误正文不会出现在 `failure.json`。

测试：`pnpm exec vitest run tests/eval/fault-matrix.test.ts`，1 个文件、1 项通过；`pnpm typecheck` 通过。

## 边界

这次 runner 的 provider 传输故障使用受控 `fetch` 和真实 `DeepSeekAdapter`；沙箱层使用 `RuntimeService`、SQLite、`FakeSandbox` 和 `FakeBudget`。因此它证明错误分类、状态转换和证据落盘行为，不证明 DeepSeek 服务实际返回这些故障，也不证明 OpenSandbox 远端服务或原预算插件在故障时的真实行为。

## 本机 HTTP/SSE 与原预算账本

命令：`pnpm eval transport-faults --out .runtime/transport-faults-20261118-n01-v2`。报告为该目录下的 `report.json`，SHA-256 `3b2ae65dc7404c29ca53cbbb72468726db8173768e081d6f9048749bd19ab2ce`。使用本地 HTTP 服务器、真实 `DeepSeekAdapter`、Harness 应用宿主、原预算插件和 RuntimeStore SQLite；不读取真实密钥，未调用外部模型或 OpenSandbox。

修复前，5 个场景的账本都保留未知用量，但宿主返回 `COMPLETED_PARTIAL`，终态阻止恢复。修复后，HTTP 503、已读增量后断流、缺少 finish、缺少 usage 和请求超时均停在 `PAUSED_ACCOUNTING`。每个场景仅一次 HTTP 请求，账本记录同一预留的 `reserve → dispatch → unknown`；预留保留，实际用量未记账且计量标为不完整。

关闭并重新打开宿主后，原预算域、deadline、回执、预留和模型响应事实保持一致。未补录前恢复被拒绝；用受信合成数据补录 15 token 后只导入一条结算回执，重复补录不再记账，冲突补录被拒绝，恢复命令把同一任务转回 `RUNNING`。探针没有重启模型对话或声称工作流已经继续完成。

验证：`pnpm check` 通过，56 个测试文件、652 项通过、12 项跳过；类型检查、构建、客户端资源及 fixture 校验通过。

## 外部 DeepSeek：认证拒绝与客户端主动中断

命令：`pnpm eval external-transport-faults --out .runtime/external-transport-faults-20261118-n01`。报告 SHA-256：`6de62a582d071216b697150eb7f695789e72b0d92de9a1b072d5d1c9e5bef892`。两次请求均发往 DeepSeek；一次用固定无效凭据，另一次认证请求用 `deepseek-flash`，输出上限 256 token。

- 认证拒绝：收到 HTTP 401，未收到 SSE 或 usage。
- 客户端中断：收到 HTTP 200 和首个文本增量，随后主动 abort，未收到最终 usage。未核对服务端是否继续推理。

每格只有一次请求。应用进入 `PAUSED_ACCOUNTING`，按 `reserve → dispatch → unknown` 保留 2044 预留 token，已结算 0，未知调用 1。重开原账本与 SQLite 核对了同一回执、预算域及 deadline。2044 是本地预留估算；实际用量未知，结算为 0 不代表没有收费。此次只验证了主动认证拒绝和客户端中断，没有制造真实服务端故障，不涉及账单或 OpenSandbox。其余 G1 条件按任务清单复核。

## 流式响应期间用户取消

本机六场景报告位于 `.runtime/transport-faults-b8fdfee5/report.json`，SHA-256 `3b188ad73c77616cbe22db5bf4dea9ba531116814a77ea096127e852be3049b5`。六项全部通过。探针使用本地 HTTP/SSE 服务、实际应用宿主和原预算插件，不调用外部模型或 OpenSandbox。

新增场景在收到第一段文本后通过宿主接口取消。应用进入 `CANCELLED`，未完成的 HTTP 响应关闭，仅产生一次请求，没有创建沙箱。用量未返回，原预留保持未知；宿主重开后取消状态、预算域和回执仍一致。对原预留输入可信的合成迟到用量后，核对到一次结算；重复相同补录不重复记账，冲突补录被拒绝，取消任务无法恢复。

验证使用 `RUNTIME_BUDGET_INTEGRATION=1` 执行 `node scripts/check.mjs`，65 个测试文件、728 项通过，类型检查、构建、客户端资源和固定样例验证均通过。该结果不证明外部供应商是否停止推理或取消后的计费结果。原五场景与新取消场景的完整回归包含在上述报告中。


2026-11-19 收尾重新核对六场景本机报告、两场景外部报告及其 SHA-256，结果与上述记录一致。原预算插件和运行时组合复验结果及 G1 原始条目映射见 [QA-02](QA-02.md)。各探针覆盖范围及未知用量保守处理继续有效。
