# 2026-11-17 整合验证记录

实现为当前工作树，尚未创建实现提交。整体计划正式验收仍为 13/51；以下组合验证不能替代各阶段的外部模型和完整任务门槛。

## 已验证的整合

- 真实 Cordis/AgentLoop、原预算插件、角色上下文和 SerialWorkflow：摘要、Planner、Executor 完成后重建 Harness 并重开 SQLite，只继续 Reviewer；四次模型调用均有独立结算，累计 120 synthetic tokens，三角色共享根预算，远端执行接口调用一次。这里 provider/sandbox 是受控适配器，不是外部推理或真实沙箱证据，详见 P4-05。
- DurableRetryExecutor 可注入 Harness composition 和 SerialWorkflow。只有明确未发送代码的沙箱创建失败自动重试；产生新 service attempt；未知结果必须先核对。工作流还能注入 FinalizationCoordinator，收尾因未知用量降为部分交付时，工作流也记录 partial。
- RuntimeService 收尾在异步产物、预算和验证读取后核对原 run revision/status；验证等待期间取消或上下文暂停不会被晚到结果覆盖。终态和 checkpoint 同事务提交。执行并发 guard 仍以 service 实例为界。
- 上下文阻断持久化，普通 resume 不能清除；可信宿主重新核验后才允许继续。可信 adapter 明确报告主角色尚未发送时，可在显式修复/继续后重新请求；不确定调用不能自动重发。
- 带来源实体检索接入真实 Harness 角色请求，验证输入/事件/已提交产物的归属、版本、哈希和定位；数据库重开后仍可检索。原预算插件受控联调为 6 次调用/180 synthetic tokens；固定样例证明目标证据可被保留，不证明真实准确率或节约成本，详见 P5-03。
- 评测框架补充 SQLite 执行意图、排他 runner、已提交跳过和显式核对；未决调用不会自动重发。统一应用宿主已接入实际 Harness、原预算插件、RuntimeService、OpenSandbox 和生产 DeepSeek SSE adapter；受控宿主生命周期、仅查询式 reconcile 与 provider 断流/缺失 usage 测试通过。真实评测 driver 和校准/冻结/效果对照未交付，详见 QA-05。构建与 check 现在复制客户端静态资源到 dist/client，构建后的三个页面资源均已实际返回 200。
- AgentScope 2.0.12 真实 SDK 契约探针通过，发现内部重试层级和缺失/缓存 usage 口径需要独立适配；决策为完成评估、延后生产适配，不能宣称已经接入，详见 P5-05。

## 检查命令

| 验证 | 结果 |
| --- | --- |
| 早期整合检查（历史记录） | 退出码 0；47 个测试文件、562 项测试通过、0 跳过；类型检查、构建、客户端静态资源复制及 fixture 验证通过 |
| 本轮新增资源调度桥接、可信任务验证器后执行 `pnpm check` | 退出码 0；48 个测试文件、559 项通过、12 项跳过（总计 571 项）；类型检查、构建、客户端静态资源复制及 fixture 验证通过；仍不包含 live provider 评测 |
| `pnpm eval verify-fixtures` | 退出码 0；25 个候选输入一致；suite 仍为 candidate-awaiting-calibration，未冻结为最终评测集 |
| 上述 check 内固定输入验证 | 五类 fixture 通过；错误分母被拒绝 |
| `pnpm exec tsc --noEmit -p spikes/sandbox-smoke/tsconfig.json` | 退出码 0 |
| 配置本地 API key 后执行 `spikes/sandbox-smoke/run-runtime-service-docker.ps1 -Scenario process-recovery` | 退出码 0；真实 SIGKILL、同 attempt 远端恢复及原 deadline 保留通过 |
| `git diff --check` | 退出码 0；检查 Git 已跟踪文件，存在 CRLF 转 LF 提示；新实现文件当前仍未跟踪 |

真实进程报告时间为 `2026-11-16T17:24:58.926Z`（Asia/Shanghai 2026-11-17），同 attempt `2ffbcefd-d278-49f7-a23f-54474985748c`，执行 `8788cc1cbf9a4965a2c6b25b130202ab`，最终 SUCCEEDED、attemptCount=1。报告位于忽略的 `.runtime/sandbox-smoke/process-recovery-smoke.json`，具体结果和限制见 P2-06。检查后 Docker 只剩 `opensandbox-server`。本轮受控宿主测试另验证了 SQLite/ArtifactStore/原预算 ledger 的统一启动与关闭路径，但没有把 fake provider/sandbox 结果写成真实联调证据。

## 仍未验收

外部 provider 正常/错误/断流用量口径；真实预算账本与沙箱的进程中断组合；完整 charging-analysis 和长任务恢复；完整 MCP/审批/重试工作流；并行跨进程恢复复核与真实 Docker 并行验收、持续资源压力到软调度；真实模型切换对照；固定任务真实评测、干净环境复现；最终简历逐条证据映射。统一宿主单任务在本地 Docker 的受控 provider + 真实 OpenSandbox smoke 已通过；真实 adapter 单次资源采样已记录于 P5-04，但不等于压力验收。测试数量不是任务成功率、隔离强度或成本收益指标。

原预算插件代码来自忽略的独立 `.sources/budget` 工作区。没有将第二份预算账本写进运行时 checkpoint，没有进行外部付费推理，没有修改简历 PDF。
