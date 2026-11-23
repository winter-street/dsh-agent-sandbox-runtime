# AgentScope 2.0.12 contract spike

状态：**完成评估、能力未交付**。这里执行真实 AgentScope SDK，但模型结果和计量都是明确的固定测试数据；不调用外部模型，不接入 RuntimeService，不证明真实计费或沙箱安全。

- 官方仓库：https://github.com/agentscope-ai/agentscope
- 版本：`agentscope==2.0.12`，tag `v2.0.12`。
- 源码 commit：`28ab5ef6b1d8969c6ed8a3975c2063478a5c4986`。
- 实测环境：Windows、Python 3.13.7。`requirements.lock` 记录本次完整依赖版本；其他平台需独立验证。

在项目根目录执行（首次安装需要网络，探针执行禁止 socket 连接）：

```powershell
pwsh -File spikes/agentscope-contract/run.ps1 -Bootstrap
pwsh -File spikes/agentscope-contract/run.ps1
```

需要 Python >=3.11 与 uv。依赖只装入忽略的 `.sources/agentscope-contract-venv`，不改主项目依赖。探针成功后覆盖此目录下 `result.json`，断言失败则非零退出。`probe.py` 没有加载环境密钥；OpenAI parser 使用显式无效的 fixture 字符串，未请求 API。

覆盖：真实消息与状态序列化、纯加法工具 schema/执行、恢复状态继续一轮 reply、实际中间件与 SDK 内部重试的层级差异、缺失 usage 的事件表现、取消后的未知 usage、固定版本 OpenAI parser 的 cache 口径。parser 为私有方法，仅用于固定版本审查，不作为稳定生产接口。

未覆盖：真实 provider、持久化服务 backend、崩溃重启、RuntimeService/预算 ledger 桥接、SSE、Docker/OpenSandbox。`Toolkit.call_tool` 的直接调用只验证工具契约，不代表 Agent 权限确认流程验收。

决策与证据见 `docs/decisions/agentscope.md`、`docs/evidence/P5-05.md`。
