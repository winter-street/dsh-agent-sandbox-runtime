# N04 单 Agent 与串行三角色真实对照

2026-11-19 在 Windows、Node.js v22.22.2、pnpm 11.7.0、Docker Engine 29.9.3 和 OpenSandbox SDK 1.2.1 上完成。原 P4-07 要求的固定任务对照已产生一组真实结果。

## 输入与运行方式

固定输入复用 `spikes/n04/task.ts` 的六行 CSV，SHA-256 为 `f021c1f80e3a2bba820b9cbdb9a25a2f833bf57b2ea97476d3152e19613d808f`。任务要求按设备汇总，按 count 降序、设备标识升序排列，交付 `ranking.json` 和 `report.md`。两个模式收到同一任务文本和输入，任务文本已经包含 MCP 返回的排序规则。

单 Agent 使用生产应用的根 Agent 工具循环。串行模式启用现有 Planner → Executor → Reviewer、只读 MCP stdio 预取、局部工具限制、一次 HTTP 审批和已有有限重试配置。运行器自动批准本次固定任务，审批记录消费一次。两边均通过实际 Harness、原预算插件和 RuntimeService 调用真实 OpenSandbox。

请求模型配置为 `deepseek-flash`，thinking 为 disabled，单次输出上限为 4096 tokens。每个模式总预算为 30000 tokens，其中收尾预留 2000 tokens。每个模式最多六次模型调用、运行等待上限 420000 ms，单次模型请求超时 90000 ms，沙箱命令超时 15000 ms。串行模式修复轮数配置为零，本次每边只执行一个沙箱 attempt。

运行器通过现有 provider 参数显式提供生产 `DeepSeekAdapter`，以配置已有调用次数和请求超时限制。因此原始记录中的 `host.mode.injectedProvider=true`。该适配器使用真实 DeepSeek API SSE 和供应商 usage，原预算插件自动结算。沙箱由应用创建，`injectedSandbox=false`。本结果的入口是这份有界集成运行器。

两次运行均在 submit 前开始计时，到应用执行控制器空闲时停止，包含任务执行期间的正常清理。应用初始化、HTTP 产物下载及随后独立查询远端清理状态的时间排除在计时外。

## 实测结果

| 模式 | 独立校验 | 耗时 | 模型调用 | 原账本总 tokens | work / finalize tokens | 未知调用 / 剩余预留 |
|---|---|---|---|---|---|---|
| 单 Agent | 通过，SUCCEEDED | 13.702 秒 | 2 | 2057 | 1968 / 89 | 0 / 0 |
| 串行三角色 | 通过，SUCCEEDED | 15.454 秒 | 4 | 6797 | 6711 / 86 | 0 / 0 |

本次串行模式多用 1.752 秒、4740 tokens 和两次模型调用。两个模式交付内容均通过独立输入推导的验证器，产物字节也一致。这个固定简单任务中，观察到三角色流程增加调用和开销，质量校验结果均为通过。

| 原账本归一化 usage | 单 Agent | 串行三角色 |
|---|---|---|
| 普通输入 tokens | 453 | 3908 |
| 缓存读取 tokens | 640 | 1408 |
| 缓存写入 tokens | 0 | 0 |
| 输出 tokens | 964 | 1481 |

每个 reservation 都有且仅有一组 reserve → dispatch → settle，用量按互斥归一化字段求和后分别为 2057 和 6797。根预算域和原 deadline 从提交到结束保持一致，三角色派发指向同一根预算域。MCP 事件记录一次成功的 `mcp.lookup_rule`，三个角色调用均为 done，审批消费事件为一次。

两边 HTTP 下载分别核对长度与 SHA-256，再执行独立验证。`ranking.json` 均为 293 bytes，SHA-256 为 `ac9447f85712be1ec109ef83c73a65bdb45f6e4fa05e087456e9541183726b16`。`report.md` 均为 65 bytes，SHA-256 为 `0d158bb4734bb820a79f754136f3f0130f016215d4bb850409a80f6838823582`。

独立期望值为六行、总 count 14，排序为 alpha 5、beta 5、delta 2、gamma 2。两份独立验证报告的问题列表均为空。应用存储中活跃沙箱已释放，认证远端查询分别对两个已知 sandbox ID 返回 404。

## 证据与复现

真实证据目录为 `.runtime/n04-comparison-20261119-194448-287ec5e8`。根目录的 `manifest.json` 保存输入、模型配置、界限和计时口径，`comparison.json` 保存汇总。每个模式分别保留 `application.json`、`runtime.json`、`evidence.json`、`independent-validation.json`、`result.json`、原 SQLite 和预算目录，以及 HTTP 下载的两份产物。

汇总报告 SHA-256 为 `283682c12533198db2c8174de4ab6779167f0ea17d5afd1521dfafe41c0ef918`。单 Agent 原证据 SHA-256 为 `628ae7350c51fd142bc77c2dff120e8bdf4a759f64e4b1c1e8fb5fd516ccdafa`，串行原证据为 `cd4164478191b3f81ad0a26179734d89cbd67d74f40d8a0ea8115a47ea070b11`。

两次记录的运行时代码身份一致，codeHash 为 `f570ec48db694ff425a441fcb331407d2e8efd648b5c2100840dce5fc4d18b08`，configHash 为 `762fc2ac54600e2c06cf92800e81ee6b9a78db75b73d675c955821c3b4625687`。应用模式差异另保存在各自的 `application.json`。

在项目根目录配置已有 `.env.local` 后执行下列命令。环境加载复用 `scripts/evaluation-env.ps1`，报告保存变量名称和配置路径。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-n04-comparison.ps1 -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-n04-comparison.ps1
```

首次预检因本机既有 `opensandbox-server` 容器已停止而连接失败。启动原容器后预检通过，随后这一组真实实验两边均成功。运行器使用新的证据目录，失败时保存失败快照并尝试有界清理，已有目录会被拒绝。

相关验证命令为 `pnpm exec vitest run tests/app/n04-task.test.ts tests/app/n04-wait-approved.test.ts`，两文件八项通过。对照运行器及其传递依赖的严格 TypeScript 检查通过。此次全仓 `pnpm typecheck` 遇到另一路正在修改的 `spikes/workflow-branches/real-smoke.ts` 三项类型错误，位于该次检查的 281、288、289 行。该次全仓命令退出码为 2。

## 结果适用范围

每个模式各运行一次，顺序固定为先单 Agent、后三角色。供应商缓存读取分别为 640 和 1408 tokens，顺序、缓存和网络会影响结果。对照涵盖生产模式的工作流、上下文组装、MCP 及审批差异，单次样本只支持上述观察。

token 使用量来自供应商 usage 和原预算账本，货币价格、折扣与账单核对留待单独处理。此次输入规模较小，可靠性与成功率的总体收益需要更多任务和重复样本支持。P4-07 的固定任务对照证据已补齐，G4 仍由原有前置任务与阶段评审决定。此前正常重开及一次状态查询断连的真实证据继续引用 [N04 真实串行验收](N04-real-serial.md)。
