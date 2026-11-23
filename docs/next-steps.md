# 当前后续任务清单

更新：2026-11-20。本清单按证据区分已完成与剩余验收。原任务依赖及阶段定义见 [任务总表](../AGENT_RUNTIME_TASKS.md) 与 [设计文档](../AGENT_RUNTIME_PLAN.md)。

## 已完成的基线

- 历史正式评测记录 180/180 槽，177 完整完成、3 部分完成，finalEvaluationEligible=false。原始失败与指标继续保留。
- F01—F04 的诊断、产物引用与显式修复已实现，修复后的真实校准 15/15 通过。F06 覆盖 27 条受控预算压力条件。
- 原始 G1 已逐项验收。一次真实演示完成三份可取回交付，本轮重新核对大小与哈希。原预算插件专项 63 项及运行时组合 49 项通过，零跳过。见 [QA-02](evidence/QA-02.md) 和 [v0.1](releases/v0.1.md)。
- 原预算插件和真实 OpenSandbox 的三个 worker 强杀窗口已有报告。N03 已有真实长任务、上下文压缩、SSE 重连、浏览器取件、worker 强杀恢复及用户控制的固定场景证据。
- SSE 已实现字节窗口、背压、游标重放和多类事件字段投影。串行 Harness 回归已串联原预算回执、步骤、attempt、execution 与产物。最新完整本地检查为 61 个测试文件、757 项通过，4 文件和 12 项跳过。详见 [P3-02](evidence/P3-02.md)。
- N05 有界资源探针 14/14 通过。固定九槽批次双 worker 实测吞吐为 1.80×，三次重复的 27 槽均通过，未知用量为零。指标适用范围见 [N05](evidence/N05-evaluation.md)。
- 同机独立源目录及依赖目录复现、源码快照、架构图、演示步骤和简历证据材料已经整理。该次复现复用了本机工具和缓存，见 [N06](evidence/N06-delivery.md)。

## P6 · 插件封装与 desktop profile 验收（进行中）

- [x] 迁移到 DSH `0.2.2-rc.3` / Cordis `4.1.0`；`pnpm typecheck` 通过，完整测试为 70 个文件、789 项通过、12 项跳过（共 801）。
- [x] 运行时与 patched 预算插件作为本地 bundle 安装进 `desktop` profile；`runtime_python` 真实执行并提交三份产物，`verify.py` PASS，沙箱删除，账本无未知用量或未结预留。见 [插件验收记录](evidence/plugin-host-v1.md)。
- [x] 任务作用域 run 绑定：交付验收后新消息创建新 run，未完成续跑复用；legacy 绑定与同消息重试已覆盖。
- [x] 会话附件输入：文件/图片进入 `AGENT_INPUT_DIR`，文件名清洗、去重与数量/字节上限在沙箱前检查。
- [x] 可选 DSH 审批：`first-execution` 每 run 一次；拒绝/取消/不可用不创建沙箱，审批不绕过预算与工具规则。
- [x] 取消与停止：执行中 signal 取消销毁沙箱；`workspace/session-stop` 取消活动根 run；已验收交付保留。
- [x] 恢复与并发：插件重开复用原 attempt/execution；同 run 并发调用在沙箱前拒绝；双会话 run/沙箱隔离。
- [x] 客户端“运行管控”设置页与 Host 治理路由已接入，Client Inspect 确认 `settings.section` 中 `agent-sandbox-runtime-governance` 活跃注册；视觉检查见 [视觉记录](evidence/plugin-host-v1/visual.md)。
- [x] 预算插件测试迁移、`check` 与累计补丁重放：补丁 SHA-256 `1f5699…7b60a`，干净重放 exit 0，主仓库 802/802。
- [ ] 浏览器视觉与交互验证（设置页、明暗主题、卸载残留）。
- [ ] 增强后 desktop profile 两任务真实验收（第二个人类消息触发新 run）与临时收敛。

## N01 · 统一故障矩阵与 G1 验收（已完成）

- [x] 建立受控统一 runner 和汇总报告，复用真实 `DeepSeekAdapter`、`RuntimeService`、SQLite 及现有状态规则；受控预算/沙箱替身明确标记。
- [x] 覆盖 provider HTTP 错误、SSE 中断、缺少 finish、缺少 usage、请求超时和客户端取消。
- [x] 覆盖沙箱创建失败、命令超时、取消无法确认、远端结果未知后的核对。
- [x] 每格保存脱敏失败证据、错误类别、重试依据、暂停/未知状态、预算处置和人工核对要求。
- [x] 报告区分受控适配器、真实 HTTP/SSE 传输和真实外部服务观察；不能把本地故障响应说成 DeepSeek 实际返回的故障。
- [x] 本机 HTTP/SSE 故障探针已接入原预算插件：6/6 通过，覆盖回执、预留、未知状态、重开及补录，新增流式响应中宿主取消。修复了用量未知时宿主误进部分交付终态的问题。
- [x] 有界外部 DeepSeek 探针 2/2 通过：一次认证拒绝，一次收到增量后主动断开。两次均保留未知用量，无重发。
- [x] 修复派发或状态查询耗时跨过命令超时后错误接收结果的问题。本地回归覆盖两个边界，真实沙箱受控延迟派发验证通过；按本地观察时间判定可能将延迟返回的已完成结果判为超时。详见 P1-07。
- [x] 真实 OpenSandbox 命令超时与脱离进程组的子孙清理探针连续两次通过，任务 deadline 未到期时 run 继续运行并可在新沙箱执行后续步骤。首次探针失败原因未知，已补充失败诊断并保留报告；见 P1-07。
- [x] 真实 OpenSandbox deadline 已分别通过推进测试时钟及实际等待约 30 秒的 wall-clock 探针。新 SDK 连接确认命令停止和沙箱删除，使用 FakeBudget，详见 P1-07。
- [x] 真实 Harness 插件卸载探针：工具调用经过原预算插件接入的 RuntimeService 与 OpenSandbox；卸载后独立确认命令停止及沙箱删除，不含模型调用。详见 P1-07；其他卸载和崩溃窗口仍需验收。
- [x] 真实同进程组父、子、孙取消探针：取消前后在沙箱内独立核对 PID 与启动时间，本次取消后三个原进程均消失，随后确认沙箱删除；无模型调用。详见 P1-07；其他进程树和崩溃路径仍待验收。
- [x] 修复步骤间脱离进程组的后台进程清理缺口：正常退出后先持久化清理意图并提交结果，确认销毁后才允许后续执行。真实 RuntimeService 探针确认受控子孙进程随沙箱销毁消失，下一沙箱可读取产物。本地故障注入覆盖清理失败及恢复。
- [x] 真实 OpenSandbox 配合独立 worker 的 SIGKILL 探针覆盖产物发布后与沙箱销毁后的两个窗口。重开 SQLite 后复用原 attempt 和 execution，保留产物与 deadline，远端沙箱查询返回 404。两次使用 FakeBudget，详见 P1-07。
- [x] 使用真实 OpenSandbox 及受控 HTTP 代理验证销毁请求被拒绝、服务已删除但响应丢失两种通信故障；保留待清理状态并在 SQLite 重开后完成核对，未重复执行。故障由客户端代理注入，详见 P1-07。
- [x] 按原始 P0-02、P1-06、P1-07、P1-08 和 QA-02 核对预算、工具权限、真实交付、远端停止和清理。G1 逐项验收见 [QA-02](evidence/QA-02.md)。

证据见 [N01 故障矩阵](evidence/N01-fault-matrix.md)。本机及有界外部观察确认未收到 usage 时保留预留，回执在重开后仍可追查。各探针覆盖范围继续按其报告说明。

## N02 · 真实预算账本与沙箱进程恢复（已完成）

- [x] 新增原预算插件 + 真实 OpenSandbox 的有界 process-recovery 探针；受控 provider 不调用模型。
- [x] 扩展现有 process-recovery 探针，将 FakeBudget 换为原预算插件，持久化原 scope、call receipt 与运行时游标；真实 Docker 报告已通过。
- [x] 分别在模型 dispatch intent 后、沙箱已派发后、远端完成但本地尚未提交时强制终止独立 worker；三个真实 Docker 窗口均通过。
- [x] 重启后重开 SQLite 与原账本，核对原调用回执、execution、attempt 和产物；已确认的远端完成沿用原 execution/attempt 补交且未重复 dispatch。
- [x] 已覆盖未知 usage 保留预留、迟到 usage 一次结算及冲突重复结算拒绝；无法关联远端 execution 时保留 `UNKNOWN + RECOVERY_REQUIRED`，并清理残留沙箱。
- [x] 已对比崩溃前后调用次数、attempt/execution、reservation/settlement、总用量、产物哈希和残留沙箱；早期窗口不重发，`after-publish` 复用原 execution。
- [x] 补齐可信管理调额后显式恢复的 finalize 解锁，原账本、本地管理 HTTP、Harness 和 SQLite 组合回归通过。P2-01—P2-12、QA-03 已验收，交付 [v0.2](releases/v0.2.md)。

入口：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-budget-process-recovery-docker.ps1`。真实执行后将报告写入 `.runtime/sandbox-smoke/budget-process-recovery-smoke.json`；该命令不调用 DeepSeek，只使用受控迟到 usage 做账本核对。

验收：预算域和原 deadline 不变；无重复预留或结算；未知状态不自动清零；可恢复窗口不重复执行已确认的远端命令。不能据此宣称任意外部副作用 exactly-once。G2 原始条目已逐项映射并验收，命令、报告指纹及新增续跑分支的受控范围见 [QA-03](evidence/QA-03.md)。

## N03 · 真实长任务、界面与上下文恢复（依赖 N02）

- [x] 固定一个必须跨多轮、触发上下文压缩的任务与独立成功标准，接入现有 API、SSE、界面和上下文组件；真实 DeepSeek/OpenSandbox 任务及独立产物验证通过。
- [x] 运行中刷新页面、断开并重连 SSE、使用旧游标恢复，核对快照、事件顺序和产物可取回性；真实 worker SIGKILL 后从同 run、同 attempt 恢复。
- [x] 验证摘要及辅助调用纳入原账本；压缩后用户任务输入、必需边界、摘要来源和产物引用可追溯，账本无未知用量或未结预留。
- [x] 从浏览器暂停正在执行的任务、重开宿主后恢复，再取消第二次执行；核对 SQLite、账本和下载哈希，确认两个 OpenSandbox 实例已删除。参见 [P3-06](evidence/P3-06.md#user-control-acceptance)。

验收：断线不丢任务；事件不串 run；压缩不丢必需约束；恢复不重置预算。P3-01—P3-06 与 QA-04 已按原始要求验收，G3 已关闭，交付 [v0.3](releases/v0.3.md)。

## N04 · MCP、审批与三角色工作流（依赖 N03）

- [x] 本地组合回归已接入真实 Harness、原预算插件、真实 MCP stdio 子进程、持久化 Tool Registry/局部限制和三角色流程；provider/沙箱仍为受控替身。
- [x] 新增自动执行审批闸门，绑定代码、输入、原预算/deadline、运行时与重试配置；批准后再次进入工作流时自动消费，拒绝不重复询问，额度/无进展限制不可被审批覆盖。
- [x] 验证 HTTP 决定、SQLite 重开、执行提交后中断与 Reviewer 续跑，以及未知派发阻断；相关 127 项回归、类型检查和构建通过。
- [x] 接入生产应用的持久化串行模式、审批后自动调度及启动恢复；27 项应用集成测试覆盖 HTTP 决定、重启、角色暂停恢复、取消和故障路径。该阶段历史完整检查为 712/712，截至 G1 复核的完整检查为 757 项通过、12 项跳过。
- [x] 完成受控 provider/沙箱下的七项生产浏览器检查：批准、拒绝、取消、重复/冲突决定、后端强杀重启续跑、移动端与认证；下载字节和原账本调用数吻合。重启前显式核对并恢复已死亡进程的 writer lock，不宣称无人值守锁恢复。
- [x] 通过生产宿主故障回归核对有限重试成功/耗尽、三个角色 schema 拒绝、工具额度及无进展停止、MCP 超时/真实 stdio 断连；重开不重发。修复 MCP 未知结果被错误收尾为部分完成的问题。
- [x] 将现有只读 MCP、Tool Registry、局部工具限制与 Planner → Executor → Reviewer 接入同一固定真实任务；MCP 为只读预取。
- [x] 三角色共享原根预算，真实串行报告记录角色模型调用、工具、Reviewer 和收尾。有限重试的次数、退避和重开行为由受控组合验证。
- [x] 受控应用及浏览器验证一次性批准、拒绝、重启后继续和重复命令；审批不能绕过预算、工具额度和无进展边界。
- [x] 真实模型/OpenSandbox 组合已通过批准、产物和清理验收。测试端注入一次真实 SDK 状态查询断连后，恢复沿用原 attempt/execution。样本范围为一次有界注入。
- [x] 沙箱创建响应未知时已阻止盲目重试并保留人工核对状态；创建适配器明确确认请求未发送时会持久化版本化 `adapter-confirmed-unsent-v1` 证明，重试执行器只接受这份证明，旧记录缺少证明时保持 `EXECUTION_UNKNOWN / RECOVERY_REQUIRED`。只读历史记录审计、代码身份保护边界复核、工作区数据库盘点及受控回归已完成。见 [历史创建记录审计](evidence/N04-sandbox-creation-audit.md) 和 [恢复设计](evidence/N04-sandbox-creation-recovery-design.md)。
- [x] 真实 OpenSandbox 创建响应丢失探针通过：成功响应由本地代理丢弃，独立查询确认资源，SQLite 重开及按 ID 清理后仍保留未知状态并阻断重试。使用 FakeBudget，同进程重开；详见 [恢复设计与探针](evidence/N04-sandbox-creation-recovery-design.md)。
- [x] 完成原 P4-07 的固定单 Agent 对照。单 Agent 13.702 秒、2057 tokens，三角色 15.454 秒、6797 tokens，两边独立验收通过且产物字节一致。每模式一次，见 [固定对照](evidence/N04-comparison.md)。
- [x] 补齐 P4-01 原要求中的 Python 统一 Tool Registry 生产入口及回归，真实串行任务通过。见 [P4-01](evidence/P4-01.md)。

- [x] 用真实 OpenSandbox 验证按 metadata 分页发现及按 ID 清理。两次相同 metadata 创建得到两个 ID，两者清理后查询均返回 404。客户端取消创建后未观察到匹配资源，目前缺少服务端终止回执。详见 [创建探针](evidence/N04-sandbox-creation-audit.md)。

验收：必需 Reviewer/工具验证未通过不能成功；角色和 MCP 不能提升权限或重置预算；审批只能消费一次。P4-01—P4-07 已按现有证据验收，G4 已关闭。

证据见 [N04 组合记录](evidence/N04-local-composition.md)、[浏览器/故障验收](evidence/N04-browser-and-failures.md) 和 [真实串行验收](evidence/N04-real-serial.md)。生产宿主通过可选 `workflow.mode=serial` 接入角色、上下文、只读 MCP、审批和有限重试；示例见 `config/app.serial.example.json` 和 [应用说明](application.md#serial-application-mode)。固定真实任务与一次测试端断连恢复已通过，本地未发送证明与创建结果未知阻断已实现。固定单 Agent 对照已完成，Python 统一 Tool Registry 接入后真实串行任务已通过。创建结果未知时持续保守阻断，提升自动发现与回收能力的契约验证列入后续可靠性增强。G4 已按 P4-07 中列出的证据和范围验收。

## N05 · 真实压力与并行对照（依赖 N02；整体工作流结论另依赖 N04）

- [x] 建立独立 N05 保留任务集 `eval/suite-n05.json`，包含 e21-e23 新输入，完成 fixture 哈希校验和 9 槽离线计划；旧 evaluation 保留为历史结果。真实运行前仍需固定预算梯度、成功标准、重复次数、执行顺序和调用上限。
- [x] 从小批量真实模型开始比较三策略，同时报告完成率、token、耗时、拒绝及人工复核结果；token 不换算成未核对的货币节省。
- [x] 有界真实 CPU、内存和日志压力探针通过 14/14，涵盖降档、缺失遥测时维持降档、恢复、在途命令完成和沙箱删除。真实探针验证后续派发上限，调度器应用该上限由独立回归覆盖。
- [x] 使用已有双 worker 分片，固定全局并发上限，保留独立数据库、预算域和产物目录；真实样本合并覆盖 9/9，未知用量为零。失联分片及重启核对通过受控回归。
- [x] 对 N05 v2 分别实测单 runner 与双 worker。两组均 9/9，分别为 155.021 秒与 86.247 秒，观察到本批次吞吐为 1.80×。
- [x] 双 worker 重复 3 次，27/27 槽通过并独立核对 63 份产物，耗时 206.148 秒。三策略各 9/9，36 次模型调用，已知用量 114,389 tokens，无未知用量或未结预留。

这几批真实评测均未触发策略拒绝。见 [N05 评测记录](evidence/N05-evaluation.md) 和 [运行计划](../eval/N05_PLAN.md)。

验收：不能只以 token 降低判定策略更好；未复核拒绝不报告误拦截率为零；未知槽位不自动重发；失败样本全部保留。真实模型调用有界，先给出实验规模与预算，再决定是否扩展。

## N06 · 交付与简历证据（依赖所声明能力对应的前项）

- [x] 汇总启动、演示、故障和恢复操作。交付复现从固定基线重放预算补丁，插件 135 项通过，1 项外部 smoke 跳过，运行时 777 项通过。
- [x] 汇总 G1–G5 的实现入口、实测证据和待验条件。各阶段整体验收仍按原任务表推进。
- [x] 保存同机源码快照和关键指纹。交付快照包含 393 个文件，预算补丁、两份锁文件和快照清单均留有 SHA-256。
- [x] 整理架构图、演示步骤、面试问答与可复制的简历项目经历，逐项链接现有证据。见 [简历及演示材料](resume-evidence.md)。

本轮交付核对见 [N06 交付记录](evidence/N06-delivery.md)。简历材料仅采用固定场景已验证的能力和指标。

申请 AI Agent 应用开发岗位时，可以先使用已有的真实演示和简历材料。2026-11-19 在同机新源码目录中完成一轮真实模型和沙箱演示，17.342 秒交付统计 JSON、Markdown 报告和 SVG 图表，三份产物均通过独立验证，本次记录 4065 tokens。演示运行范围及证据见 [P5-07](evidence/P5-07.md)。

## 后续可靠性增强

全新主机部署适用于需要交给他人从头安装的场景。持续调度压力和更多真实故障适用于扩大负载或恢复能力的承诺。正式评测的三次准入拒绝已核对，但因历史估算缺失无法独立分类。需要正式误拦截数据时，可在独立、有界的新实验里获取可复核的样本。验收与交付状态见 [任务总表](../AGENT_RUNTIME_TASKS.md)。

- [ ] 运行创建响应窗口独立 worker SIGKILL 探针。代码和严格类型检查已完成，真实服务执行待完成。当前保留 UNKNOWN / RECOVERY_REQUIRED，阻止自动重发。见 [N04 创建恢复设计](evidence/N04-sandbox-creation-recovery-design.md)。
- [ ] 在需要提升自动恢复能力时，验证服务内部销毁故障、物理宿主崩溃和未知创建的自动发现与回收。
- [ ] 扩展 SSE 未投影及未知事件、快照字段审计，以及其他入口和真实 provider 的 modelCall → step → attempt → execution 关联。现有字段投影、认证快照和关联 ID 各自的限制保留在 P3-02。
- [ ] 按实际部署需要补充完整 Loader/profile 配置重载、供应商账单核销和更广的摘要语义质量验证。

G1—G4 与 P5-01—P5-07 的验收已记录，G5 尚有 QA-05 的误拦截率缺口。当前演示和投递材料可按其证据范围使用。
