# Agent 沙箱运行时插件

把 DeepSeek Harness 会话中的 Python 工具调用放进隔离的 OpenSandbox 容器执行，并把 run、attempt、产物和预算绑定持久化到本地 SQLite。

## 功能

- **`runtime_python` 工具**：模型提交 Python 代码，在 OpenSandbox 中执行；每次调用拥有独立的 `AGENT_INPUT_DIR` 与 `AGENT_OUTPUT_DIR`。
- **任务作用域 run**：一个任务一个 run；上一条交付被独立验收接受后，新的用户消息创建新 run；未完成的续跑消息复用原 run。子会话共享根会话的当前 run。
- **持久与恢复**：SQLite 保存 run/step/attempt、事件和已提交产物；插件重载后先恢复原 attempt/execution，未知状态阻断重复派发。
- **会话附件输入**：当前任务用户消息中的文件/图片进入 `AGENT_INPUT_DIR`；文件名清洗、重名去重，并受 `inputLimits` 的数量/字节上限约束，超限在创建沙箱前失败。
- **产物提交与验收**：只接受通过 manifest 校验的产物；由宿主执行结构化验收，模型文本和退出码不能单独宣告完成。
- **预算绑定**：运行时通过 `agentBudget` 服务读取账本，不在模型调用之外重复预留或结算；未绑定运行时的普通会话不套用运行时模型策略。
- **可选 DSH 审批**：`approval.mode=first-execution` 时，每个 run 的首次沙箱执行前通过 DSH 审批；拒绝/取消/不可用都不创建沙箱，审批不能绕过预算或工具规则。
- **取消与停止**：工具取消会停止远程命令并销毁沙箱；`workspace/session-stop` 取消活动的根会话 run；已验收交付不会被停止取消。
- **配置化**：沙箱镜像、命令超时、TTL、策略阈值、验收文件、受控输入、输入上限与审批模式均由插件配置提供，模型参数无法选择 run、路径或权限。

## 使用

安装后在会话中让模型使用 `runtime_python` 执行代码。插件配置位于 profile 的 `cordis.patch.yml` 行 `agent-sandbox-runtime`；运行数据默认写入 `~/.dsh/agent-sandbox-runtime`。

真实部署需要：

1. 可访问的 OpenSandbox 服务（`sandbox.domain`）。
2. 沙箱 API key：设置 `sandbox.apiKeyEnv` 指向的环境变量，或把 key 写入 `sandbox.apiKeyFile`。
3. 可信的静态输入与验收规则（`inputs`、`validation`），或让用户把文件上传到会话后由 `inputLimits` 约束的附件读取。
4. 如启用审批，profile 必须加载 DSH approval 服务；否则插件会在激活时明确失败。

## 限制

- **输入冻结**：续跑复用原 run 的已存输入；新消息里的新附件不会合并进未完成任务。需要新附件时先完成当前任务再发新请求。
- 独立验收只做结构化检查；统计语义仍需任务专用验证脚本单独核对。
- 审批只覆盖“每个 run 首次沙箱执行”，不覆盖串行三角色工作流的 `PAUSED_APPROVAL`；暂停/恢复 UI 尚未映射。
- 子会话的 `workspace/session-stop` 不取消根 run；其工具取消由工具 signal 处理。
- 运行中取消在派发前发生时，run 保持 RUNNING 且无 attempt；这是刻意避免临时中断误判任务失败。
- 已绑定 run 的会话才套用运行时模型策略；普通会话仅由预算插件计量。
- 任务轮换以“required review 已 SUCCEEDED 或 run 终态”为边界；未完成任务内的新消息视为续跑。
- 客户端“运行管控”页已验证注册与 Host 接口；视觉、主题与禁用清理仍待人工/带认证浏览器确认（见 [视觉记录](evidence/plugin-host-v1/visual.md)）。

## 验证状态

2026-11-20 已在 DSH Desktop `0.2.2-rc.3` 的 `desktop` profile 中完成一次真实验收：DeepSeek 模型通过本插件调用 `runtime_python`，在真实 OpenSandbox 中执行并提交 `statistics.json`、`report.md`、`chart.svg`，宿主独立结构化验收通过，`verify.py` 对统计结果返回 PASS；沙箱已删除，预算账本无未知用量或未结预留。运行 ID、产物哈希与命令见 [插件验收记录](evidence/plugin-host-v1.md)。

2026-11-20 的 P6-02 增强新增任务作用域、附件、审批、取消/停止与恢复测试；完整检查为 **789 passed + 12 skipped = 801**（70 个测试文件，66 通过 + 4 跳过），`pnpm typecheck` 通过。该轮增强的 profile 真实两任务验收与预算补丁重放结果见后续证据记录。
