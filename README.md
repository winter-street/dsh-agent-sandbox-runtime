# Agent Sandbox Runtime

TypeScript 运行时，连接 DeepSeek Harness 预算插件与 OpenSandbox，管理执行、产物、预算暂停和步骤恢复。原始 G1—G4 已按已记录范围验收，达到原计划首版证据目标。交互、上下文与长任务恢复交付见 [v0.3](docs/releases/v0.3.md) 和 [QA-04](docs/evidence/QA-04.md)，工具与串行编排证据见 [P4-07](docs/evidence/P4-07.md)。

设计：[AGENT_RUNTIME_PLAN.md](AGENT_RUNTIME_PLAN.md)。进度：[AGENT_RUNTIME_TASKS.md](AGENT_RUNTIME_TASKS.md)。

## DSH 插件

本仓库同时是一个可安装的 DSH bundle（`package.json` 的 `dsh.bundle` + `dsh.client`）。`pnpm build` 后通过 Plugins 安装本地目录；Host 半边注册 `runtime_python`、任务作用域 run、会话附件输入、可选 DSH 审批、取消/停止、预算模型策略与“运行管控”Host 路由，Client 半边在 Settings 中提供“运行管控”页。2026-11-20 已在 DSH Desktop `0.2.2-rc.3` 的 `desktop` profile 完成真实 DeepSeek + 真实 OpenSandbox 验收：三份产物提交、独立结构化验收通过、`verify.py` PASS、沙箱删除、账本无未知用量。v0.1 证据见 [插件验收记录](docs/evidence/plugin-host-v1.md)，P6-02 增强（任务作用域/附件/审批/取消/恢复）见 [增强记录](docs/evidence/plugin-host-v2.md)，配置与限制见 [docs/DETAIL.md](docs/DETAIL.md)。

## 开发

当前开发基线 Node 22.22.2、pnpm 11.7.0；运行时使用 Node 内置 SQLite（Node 22 会提示实验性 API）。真实宿主固定为 Cordis 8.0.1、DeepSeek Harness 0.1.0-rc.6；部署版本见 [环境记录](docs/environment.md)。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm fixture:verify
```

普通测试不调用外部模型或真实沙箱；探针位于 `spikes/`，按各自说明显式执行。已通过真实 OpenSandbox 生命周期、RuntimeService 产物提交、独立 worker SIGKILL 后同 attempt 恢复、Harness/原预算插件/沙箱受控组合，以及浏览器 18 项操作验证。受控 provider 返回合成 usage，不能当成外部模型计量证据。

2026-11-19 交付复现开启本地预算集成，`pnpm check` 通过 65 个测试文件、777 项测试，类型检查、构建及固定输入验证通过。统一应用宿主、可信任务验证器和生产 DeepSeek SSE 适配器已接入。[应用说明](docs/application.md)和[本轮验证记录](docs/evidence/2026-11-17-integration.md)列出准确范围与剩余验收。三策略真实校准 15/15 后，正式评测已提交 **180/180 槽，177 完整完成**；全部交付独立重验、407 份产物哈希及原账本核对通过，无未知用量。其中 3 槽部分完成，严格资格 `finalEvaluationEligible=false`。该批次的三次准入拒绝已完成事件与账本核对，因历史请求估算缺失而无法计算误拦截率。后续拒绝会记录决策快照。[真实评测结果及后续计划](docs/evaluation.md)说明准确指标与限制。原始 G1 的后续验收已记录于 [QA-02](docs/evidence/QA-02.md)，其余阶段见任务总表。[真实验证诊断](docs/evidence/2026-11-18-real-validation.md)。

2026-11-19 在同机新源码及依赖目录从固定基线重放预算插件补丁，插件 135 项通过，1 项外部 smoke 跳过。复现源码的一次真实 DeepSeek 与 OpenSandbox 示例完成三份产物交付，独立校验通过。N05 v2 双 worker 重复评测 27/27 槽完整交付，独立核对 63 份产物。固定 9 槽对照中，串行和双 worker 分别耗时 155 秒和 86 秒。[交付与复现](docs/evidence/N06-delivery.md) · [N05 实测](docs/evidence/N05-evaluation.md) · [简历项目经历](docs/resume-evidence.md)。

带来源的实体检索已接入角色上下文。`pnpm eval` 提供固定输入核验、持久化执行和显式结果核对，使用方法见 [评测说明](eval/README.md)。本机 HTTP/SSE 原账本故障验证为 6/6，有界外部认证拒绝及主动断流为 2/2，具体边界见 [N01](docs/evidence/N01-fault-matrix.md)。AgentScope 已完成真实 SDK 契约评估，生产适配按 [决策记录](docs/decisions/agentscope.md) 延后。真实工作流分支组合八项验证通过，覆盖共享预算、独立沙箱、产物合并、父取消和重开复用。[分支证据](docs/evidence/P5-02.md)。

[隔离探针](spikes/sandbox-isolation/README.md)发现并修复了 dns 模式的直接 IP 绕过，当前本地 dns+nft 下 8 项有界网络/权限/挂载/CPU/内存检查通过；完整租户隔离与端口暴露范围仍有限制。固定真实长任务已验证上下文压缩、worker 强杀后的续跑与 SSE 重连。正式任务总表记录已关闭的门槛。[长任务结果](docs/evidence/P3-06.md) · [任务总表](AGENT_RUNTIME_TASKS.md)。

`config/example.json` 是待验证部署的参数示例；镜像 digest、网络策略和服务 endpoint 应在真实部署 profile 中固定。密钥由环境配置，不写入文件、日志或提交。

`.sources/` 是忽略的独立上游工作区，预算插件更改在那里单独维护；`.runtime/` 为运行数据。架构及完成状态以当前证据为准。

真实评测前先运行只读沙箱探针，确认创建、执行、回收链路可用：

```powershell
pnpm eval doctor --driver eval/runtime-driver.ts --mode real
```

探针失败时不会创建评测 slot。评测过程中出现 OpenSandbox/Docker 基础设施故障会记录到每个 run 的 `failure.json`，打开运行时熔断并停止后续批次；请修复服务后再显式重试或核对 pending slot。
