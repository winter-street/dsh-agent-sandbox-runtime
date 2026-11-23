# AgentScope 适配决策（P5-05）

**完成评估、能力未交付；本阶段延后生产适配。** 已实测固定版本 AgentScope 的真实 SDK 契约，未实现 AgentScope → RuntimeService 的执行/计量链路，不能在简历写“已接入 AgentScope”。这不是语言或技术不可兼容的判断；经跨进程桥接可以适配，但当前 TS Harness 已承担编排，尚无必须增加第二套 Agent 循环的固定任务收益。

## 核对版本

官方 [agentscope-ai/agentscope](https://github.com/agentscope-ai/agentscope)，PyPI `agentscope==2.0.12`，固定 tag `v2.0.12` / commit `28ab5ef6b1d8969c6ed8a3975c2063478a5c4986`。运行证据位于 `spikes/agentscope-contract/`。只按 2.x 实际接口评估，未使用旧版 ReActAgent 教程冒充当前接口。

## 接口、可复用点与归属

| 关注点 | 官方实际接口及实测 | 对当前项目的影响 |
| --- | --- | --- |
| 消息 | `Msg` / `UserMsg`，Pydantic JSON roundtrip；`ToolCallBlock.input` 是 JSON 字符串 | 可转换，但运行 ID、scope 与调用身份必须由可信 host 注入，不能从模型字符串接受 |
| 工具 | `FunctionTool` / `Toolkit.get_tool_schemas` / `Toolkit.call_tool` 实际执行 2+3=5 | 可桥接到当前工具注册表；当前 spike 只调用纯函数，未接沙箱，未验完整 Agent permission 路径 |
| 会话 | `AgentState(session_id, context, reply_context, permission_context, …)` roundtrip 后可供新 `Agent` 继续 reply | Python state 不自动具备当前 SQLite checkpoint、attempt、远端 sandbox 恢复语义；恢复协调权仍归 RuntimeService |
| 拦截 | `MiddlewareBase.on_model_call` 调用真实 `ChatModelBase` | 本次实测 1 次 middleware 包含 2 次 `_call_api`，不能默认按 middleware 计费 |
| 用量 | `ChatUsage.input_tokens` 包含 cache；OpenAI parser 实测 input=100/cache=40/output=20 | 转当前互斥桶必须得到 input=60/cacheRead=40/output=20；直接相加会得到错误的 160 |
| 缺失/取消 | response usage=None 时 `ModelCallEndEvent` 实测输出 0；取消返回 interrupted 且 usage=None | 事件 0 不能作为真实零消费回执；预算保留 unknown，等待可核实回执 |

固定 commit 的来源：

- [Agent 与模型中间件调用](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/agent/_agent.py#L3393)
- [消息 Usage / Msg](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/message/_base.py)
- [Toolkit 调用](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/tool/_toolkit.py#L225)
- [AgentState](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/state/_state.py#L207)
- [模型重试及取消](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/model/_base.py#L234)
- [ChatUsage 口径](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/model/_model_usage.py)
- [OpenAI completion parser](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/model/_openai_chat/_model.py#L514)
- [应用存储会话接口（只读源码，未运行 backend）](https://github.com/agentscope-ai/agentscope/blob/28ab5ef6b1d8969c6ed8a3975c2063478a5c4986/src/agentscope/app/storage/_base.py)

## 若以后接入，先满足这些条件

1. 先确定现有 Harness 做不到或明显不适合的一个固定任务；预算账本仍只有原 TS budget owner，Python 不另做结算。
2. 每次真实 provider attempt 走可信 RPC 的 prepare/reserve/call/settle；冻结完整请求、映射 session/scope/call ID，并验证回执身份与幂等。默认关闭 AgentScope model、Agent 和底层 provider SDK 的重复重试/fallback；若开启，逐次 attempt 受预算控制。
3. 针对实际 provider 验证 cache/input/output 的互斥转换和缺失用量；不能以聚合 Msg usage 或全零 ModelCallEndEvent 冒充账本回执。
4. 工具执行仍经 RuntimeService/OpenSandbox，Python 只携带可信调度凭据；schema repair 不能替代 host 的严格 schema、权限与资源限制。
5. 明确跨进程暂停、取消、断线及恢复协议；以持久化 checkpoint、reservation/attempt 与 sandbox 身份共同验收，而非仅 JSON roundtrip。
6. 用真实模型与真实沙箱固定任务演示执行、计量、取消恢复后，才标记“已适配”；该后续能力尚未交付。
