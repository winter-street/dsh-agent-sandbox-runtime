# F01–F07 后续实施与验证

日期：2026-11-18。实现保存在当前工作树，尚未提交。原 180 槽结果、三条部分完成、冻结 suite/TASK.md/参考实现均保留；新实现指纹与历史版本不同。

## F01–F04：失败反馈与显式修复

`tests/support/local-python.ts` 执行真实 Python，仅用于受信测试代码，不是安全沙箱。合成缺列 CSV 上先写出正确错误 JSON，再执行不适用的 `report.md` 断言，确认退出码 1 和 AssertionError；还实际复现错误产物和新输出目录 FileNotFoundError。

工具提供有界独立诊断、失败步骤 ID 及 `AGENT_INPUT_DIR/artifacts/<artifactId>/<path>` 引用。非零执行保留失败，不因产物正确而成功结轮；无效输入按契约只检查错误 JSON，处理完成后正常退出。

模型只能额外提交 `repairOf`，不能提交义务、预算域或权限。宿主绑定验收义务。`RuntimeService.inspectCodeResult` 验证当前 attempt 字节，成功且独立验收通过后，才以原子事务写入 `repair.validated`、逐项 `step.superseded` 和 checkpoint。来源必须是同 run、同义务、明确 SCRIPT_FAILED 的必需 Python 步骤；原状态仍为 FAILED，只移除被明确替代步骤的 required 标志。

测试覆盖未知计量、未结预留、取消/deadline/上下文暂停竞态、未决执行、跨 run/义务、错误修复引用、SQLite 重开及变更 repair 元数据。无显式关联的失败仍阻止完整完成。应用三策略真实 Python 修复 8 项通过，核心 17 项，另有 Harness/schema 专项检查。初始完整检查 633 通过、12 跳过；后续扩展检查以最终输出为准。

## F05：真实校准复验

命令：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-evaluation-smoke.ps1 -Calibration`。

- 新目录：`.runtime/calibration-smoke-20261118-065639-6e8445e2`。
- 5 校准任务 × 3 策略 × 1 次：15/15 完整完成，33 份产物重验通过。
- 原账本 60442 token，未知调用为零；不是货币成本。
- 执行指纹：`611ef277915a73621c6d8d64d1490dad1c7f4380b54ec6af31cece86a5daab62`。
- records SHA-256：`75a96a2d9c95c7445fdd533649a99595ab5976b4e646f86d4dba90d16f978e64`。
- 原始 `smoke-summary.json`，离线 `audit.json`；`pnpm eval audit` 重新读取产物/哈希、输入派生验证器和原账本回执。

这是校准成功路径；未强制真实模型生成断言失败，失败修复由实际 Python 加受控 provider 验证。后续 F07 改变宿主存储位置接口及 driver，此指纹不是最终源码指纹。

## F06：固定预算压力实验

`eval/pressure-plan.json` 事前固定 3000/6000/12000 token、三策略、steady/retry-unsent/unknown-usage，共 27 条件；八段整数求和、可选说明、450 synthetic token/调用、输出预留和顺序固定。运行前复制 plan，报告保存 plan hash 与代码指纹。

`pnpm eval pressure --out <新目录>` 使用真实 Harness hook、原预算插件和 SQLite，provider 为受控实现。逐段独立验算；低预算保持 PAUSED_BUDGET，usage 丢失保留预留、PAUSED_ACCOUNTING 并拒绝下一调用；仅在明确未发送的注入点有限重试。收尾额度来自原总额，可用时生成报告，不足时保留模板。

开发运行 `.runtime/pressure-controlled-v1d` 的 27 条件满足会计不变量；报告保存 plan hash `63d7703c1e7ef8f59cfd13cc9e78163a419eaeaa9198dcb650c192f5528b177b` 和 execution revision `4be18c8751b3dc48f152f0c81824215d9f6619e1d2cccaf23c7b9026b9f2c4b6`；失败开发目录保留。6000 梯度下 tiered 完成，hard-only/tiered-finalize 暂停；12000 三策略稳态完成，tiered-finalize 另结算 450 收尾 token；3000 全部暂停。拒绝记录必需/可选、请求估计、原全局/分类剩余及原因，独立硬边界公式筛出候选误拦截，无拒绝时比率 null。

这是机制实验，不是模型效果或显著性结论。候选筛查不替代真实拒绝人工复核，也不把旧评测三次拒绝说成已复核。持续真实模型/资源压力及新保留任务仍开放。

## F07：双 worker 分片

`eval/sharded.ts`、runner 与 `scripts/run-parallel-evaluation.ps1` 提供同一 Node 进程中的两个异步 worker。各自使用独立 runner/application SQLite、预算日志、证据目录和 run/sandbox。稳定槽位哈希分配，manifest 固定配置/预算/代码身份；存储位置不改变语义配置。协调器排他锁防止同目录第二运行器。

全局 provider/sandbox 上限各为 1 或 2，保守地为整个 run 持有名额直到执行与验证结束；单 run 宿主只启动一个根 Agent。取得名额后才写调用意图。未明调用只核对原 run，普通重启不重发、不重置预算。失败/暂停/未知用量阻止后续派发，另一已在途 run 等待其已发工作结束。

合并读取各 SQLite 已提交记录，与 JSONL 完全核对，再检查分片归属、唯一槽位、run/call 去重、manifest 和精确覆盖；缺失/重复/串分片/未知 intent 均拒绝，不伪造或去重错误。完整覆盖保留实际失败，校准不变为正式 evaluation。

受控验证：6 项 coordinator 测试，另有 actual Harness host + original ledger + SQLite/artifact store 的 15 槽组合测试。后者使用受控 provider/fake sandbox，20 次调用（15 work + 5 finalize）、300 synthetic token、33 份产物重验通过，重开不新增调用；覆盖单/双上限、响应丢失、原身份核对、未知 usage 和错误合并。

真实有界验证：`.runtime/parallel-calibration-20261118-072919-ca180917`，两 worker 各一槽，c02/hard-only 与 c01/hard-only 均 complete，6 份产物重验，原账本 4079/3942 token，未知调用零，`progress.json` 峰值 2。各 worker 保存 `audit.json`。仅覆盖 2/15，不能合并为完整校准，没有加速比结论。

## N02：真实预算账本与沙箱进程恢复

命令：分别使用 `-CrashPoint after-dispatch-intent`、`-CrashPoint after-execute` 和 `-CrashPoint after-publish` 运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-budget-process-recovery-docker.ps1`。

真实报告：`.runtime/sandbox-smoke/budget-process-recovery-after-dispatch-intent.json`、`.runtime/sandbox-smoke/budget-process-recovery-after-execute.json` 和 `.runtime/sandbox-smoke/budget-process-recovery-smoke.json`；三个命令均退出码 0，早期窗口各 3/3、`after-publish` 窗口 6/6 检查通过。独立 Node worker 使用原预算插件和真实 OpenSandbox，分别在 dispatch intent、沙箱已派发但 execution 尚未落盘、远端产物发布后被 `SIGKILL`。前两类重开后保留同一 attempt，进入 `UNKNOWN + RECOVERY_REQUIRED`，不自动重发并清理无法关联 execution 的沙箱；后一类重开后保留 dispatched reservation 并标为 unknown，沿用原 execution/attempt 补交，未重复 dispatch；迟到 usage 结算一次，冲突重复 usage 被拒绝；同一 attempt 重放并最终化成功，原 deadline 保留。

探针没有调用外部模型，迟到 usage 是受控核对输入。它不覆盖 provider invoice 或任意外部副作用 exactly-once；N02 多窗口已完成，但 P2-12 组合演示和 G2 仍开放。详细证据见 [N02 进程恢复](N02-budget-process-recovery.md)。

## 真实演示与独立源目录复现

`scripts/run-demo.ps1` 的真实演示记录位于 `.runtime/demo-20261118-073931-1d08cb7b`：状态 SUCCEEDED，原账本 3974 token，未知调用与预留均为零，统计、报告和 SVG 独立验证通过。三份文件已导出到该目录的 `delivery/`，`demo.json`、`trace.json`、`ledger.json` 保留验证、过程及预算回执。操作见 [演示说明](../demo.md)。

`scripts/verify-clean-reproduction.ps1` 的记录位于 `.runtime/clean-reproduction-20261118-073831-b2385e46/reproduction.json`：固定预算基线检出、补丁重放、锁定依赖安装和两仓库检查通过。预算插件 134 项通过、1 项跳过；运行时 54 个测试文件、650 项通过、12 项跳过，类型检查、构建、客户端资源和 fixture 验证通过。预算补丁 SHA-256 为 `d1a9f96281ce9442aa3e9aa3d9491b434f7c94baa58b5e8253835f56b0e95905`。

复现使用同一 Windows 主机上的独立源码和依赖目录，仍复用 Node/Python、Git 对象及 pnpm 缓存；不包含真实服务调用，不代表新机器或空缓存部署验收。

## 仍开放

受控故障矩阵 10/10、本机 HTTP/SSE 与原预算账本 5/5 通过，证据见 [N01 故障矩阵](N01-fault-matrix.md)。宿主现会在用量未知时暂停核对，避免提前进入不可恢复的部分交付终态。最新 `pnpm check` 为 56 个测试文件、652 项通过、12 项跳过。

N02 的原预算插件与真实 OpenSandbox 三个崩溃窗口已通过，证据见 [N02 进程恢复](N02-budget-process-recovery.md)。仍开放外部 provider 失败与断流观察、P2-12 组合演示、真实长任务和界面整体恢复、工具审批与多角色完整联调、持续压力与新保留任务实验。G1—G5 按原任务依赖逐项关闭。具体顺序和完成条件见 [当前后续任务清单](../next-steps.md)。
