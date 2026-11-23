# N06 · 可复现交付与简历证据

2026-11-19。本轮完成了同机独立复现、阶段证据复核和简历材料整理。阶段门槛按原设计与任务表逐项验收。下表列出每项能力的实测范围和仍需验证的条件。[设计门槛](../../AGENT_RUNTIME_PLAN.md#81-阶段门槛和演示版本) · [任务总表](../../AGENT_RUNTIME_TASKS.md) · [简历材料](../resume-evidence.md)

## 启动与取证

| 要展示的能力 | 入口 | 查看结果 |
| --- | --- | --- |
| 从本机缓存重建源码和依赖 | [独立复现脚本](../../scripts/verify-clean-reproduction.ps1)，操作见 [演示说明](../demo.md#干净源目录复现) | `reproduction.json`、`source-manifest.json`、插件与运行时检查日志 |
| 真模型生成可下载产物 | [演示脚本](../../scripts/run-demo.ps1)，配置见 [运行环境](../environment.md) | `demo.json`、`trace.json`、`ledger.json` 和 `delivery/` 中的统计、报告与图表 |
| 强杀后的恢复与保守核对 | [三窗口恢复脚本](../../scripts/run-budget-process-recovery-docker.ps1)，参数见 [N02 记录](N02-budget-process-recovery.md#验证命令) | 原预算域、原 deadline、远端执行 ID、attempt 数与迟到用量回执 |
| 长任务、重连与三角色审批 | [长任务脚本](../../scripts/run-n03-long-task.ps1) · [串行验收脚本](../../scripts/run-n04-real-serial.ps1) | 检查点、SSE 游标、审批消费记录和下载产物 |
| 比较预算策略和执行吞吐 | [N05 运行计划](../../eval/N05_PLAN.md) | 每槽独立验证、两个分片的 SQLite 提交记录、合并审计和分组指标 |

## 同机独立复现

在同一 Windows 主机的新目录复制公开项目文件，从本地 Git 对象检出预算插件基线并重放补丁，再用两个锁文件从本机 pnpm store 安装依赖。复现脚本清除继承的两个服务凭据并启用 `RUNTIME_BUDGET_INTEGRATION=1`。预算插件 **135 项通过、1 项外部 smoke 跳过**。运行时 **65 个测试文件、728 项全部通过**，类型、构建、客户端资产、固定输入及 N05 v2 输入指纹验证通过。本轮复现调用外部模型和沙箱的次数均为 0。[完整日志](../../.runtime/clean-reproduction-n06-20261119-034221-a59f0d8f-check.log)

前三次尝试依次暴露了交付补丁漏带 `withCallIdentity`、低层服务构造器缺少必需接口以及并发回归不符合预算插件的 lint 规则。补丁已同步可信调用身份与关联测试，并补齐构造器类型契约。最终从固定基线重放的补丁通过检查。失败目录保留在本机 `.runtime/`。

| 版本材料 | 值 |
| --- | --- |
| 项目 Git 基线 | `dff1a01a3b20eb46af2f00d0d78e6e1e1a9e2eb2` |
| 预算插件 Git 基线 | `28c77462aa20ceb27acc0cec99db0dea11087dbc` |
| 预算补丁 SHA-256 | `8bccf89238e49438a37e251d215f278d7d115ce064077984f414618e9306001c` |
| 运行时锁文件 SHA-256 | `7743292edfe7dd16c8a9ce81899c75095b8d6fa55c8318178d9bb11ca982c719` |
| 预算插件锁文件 SHA-256 | `1f1b30e4154a8505426a0a3008779fd71d33025d517d761ddea183e4f1024f18` |
| 源目录清单 SHA-256 | `6e84f1f3d261c2b72c3ff45bc55697ea35051cc0406ece1b43f2a18782138154` |
| 独立核验的源文件 | 373 个，逐一核对 SHA-256 |

快照记录运行时工作树的内容，Git 基线是项目历史中的设计与任务基线。快照涵盖本交付记录编写前的源码、配置、补丁、锁文件与文档。当时 373 个文件均与工作树一致。此后的交付文档以当前工作树为准。复现范围是同一主机的新源目录和依赖目录，新机器部署仍需单独验证。[复现结果](../../.runtime/clean-reproduction-n06-20261119-034221-a59f0d8f/reproduction.json) · [文件清单](../../.runtime/clean-reproduction-n06-20261119-034221-a59f0d8f/source-manifest.json)

### 2026-11-19 20:39 的更新复现

在本机新目录再次运行独立复现脚本，结果 `Passed=true`。脚本从本机 Git 对象重放预算补丁，使用锁文件和本机 pnpm store 安装依赖，启用原预算集成并完成插件与运行时检查及 N05 v2 输入指纹验证。本次没有调用外部模型或沙箱。复现结果与清单分别保存在 [reproduction.json](../../.runtime/clean-reproduction-20261119-203930-9fb174d5/reproduction.json) 和 [source-manifest.json](../../.runtime/clean-reproduction-20261119-203930-9fb174d5/source-manifest.json)。

核对时清单中的 393 个源文件 SHA-256 均与工作树一致，清单本身 SHA-256 为 `ea23d5dfa8fe8753e6511ebf36d39a9f3a9ebdbc6f66d24da3abf6a33117839d`。此记录在核对后更新，因此属于快照之后的文档变化。复现仍依赖同一台机器的工具、本地 Git 对象和依赖缓存，新机器部署尚未验证。

### 2026-11-19 21:23 的交付复现

准入审计字段补齐后，从新源码与依赖目录重新复现。公开源文件 393 个，其中 `src/`、`config/`、`tests/`、`eval/`、`scripts/` 和 `integrations/` 下 207 个文件的哈希与当前实现一致。清单只收录 `.env.example`。预算插件 135 项通过，1 项外部 smoke 跳过。运行时 65 个文件、777 项测试通过，类型、构建、客户端资产和固定输入检查通过。本次复现的服务调用为零。真实 DeepSeek 与真实 OpenSandbox 示例来自 20:39 的复现源码，详见 [P5-07](P5-07.md)。[交付复现结果](../../.runtime/clean-reproduction-delivery-20261119-212327/reproduction.json) · [检查日志](../../.runtime/clean-reproduction-delivery-20261119-212327.log)

## G1–G5 证据复核

2026-11-19 更新。G1—G4 已按原始要求及所列证据范围验收。固定单 Agent 对照、真实工作流分支与候选模型实测已补齐，Python 统一 registry 生产接入后的真实串行任务已通过。

| 阶段 | 原始交付与证据 | 当前状态及范围 |
| --- | --- | --- |
| G1 可执行 | 原 Harness/预算、真实模型和 OpenSandbox 交付统计/报告/图表，实际取消、deadline 和回收验证。[QA-02](QA-02.md) · [v0.1](../releases/v0.1.md) | 已验收。部署隔离按本机实际网络/权限/资源探针描述。 |
| G2 预算与恢复 | 原子预留、去重、未知用量、三个 worker 强杀窗口、软策略与收尾。[QA-03](QA-03.md) · [v0.2](../releases/v0.2.md) | 已验收。未知计量保留核对状态，可信调额恢复的扩展分支已有原预算组合回归。 |
| G3 上下文与交互 | 真实长任务、两次摘要、SSE 重连、浏览器控制与 trace 关联。[QA-04](QA-04.md) · [v0.3](../releases/v0.3.md) | 已验收。摘要人工核对覆盖两份，tokenizer 校准属于后续增强。 |
| G4 工具与编排 | 真实 MCP、一次性审批、有限重试和三角色。固定单 Agent 对照两边均成功，分别为 13.702 秒/2057 tokens 和 15.454 秒/6797 tokens。[P4-07](P4-07.md) · [对照](N04-comparison.md) | 已验收。Python 与 MCP 通过统一 Tool Registry，修改后一次真实串行运行通过；固定对照发生在该修改之前。 |
| G5 完整演示 | 真实分支八项、资源压力 14/14、实体来源验证、模型白名单与真实路由、AgentScope 契约决策、同机独立复现及完整评测。[分支](P5-02.md) · [资源](P5-04.md) · [模型](P5-06.md) · [QA-05](QA-05.md) | P5-01—P5-07 已验收。G5 剩余 QA-05 的正式批次误拦截率。模型路由为可选功能，主应用仍显式选择配置中的模型。AgentScope 生产适配暂缓。 |

历史正式评测的三条部分完成触发严格资格的 `RUN_NOT_ACCEPTED`，保留 180/180 已记录和 `finalEvaluationEligible=false`。N05 v2 独立保留集双 worker 重复运行 27/27，独立核对 63 份产物。九槽对照中，单 runner 与双 worker 分别耗时 155.021 秒与 86.247 秒，吞吐比为 1.80×。历史三个拒绝事件与账本均已核对，由于缺少被拒请求的估算及决策快照，可独立分类数为 0/3。N05 无拒绝样本。[历史报告](../evaluation.md) · [保留集报告](N05-evaluation.md)

新的分支探针发现并修复了 71 字符子 runId 超过远端 63 字符标签上限的问题，完整本地身份继续用于存储和执行目录。五个探针沙箱均确认删除。模型路由首次 JSON 调用缺失 usage 的失败仍保留未知计量记录。上表保留此前 373 文件的历史快照，新一轮 393 文件复现见上方记录。
