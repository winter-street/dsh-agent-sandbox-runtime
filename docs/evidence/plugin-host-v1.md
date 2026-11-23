# P6-01 · Desktop profile 插件化与真实端到端验收

更新：2026-11-20。本记录只描述本轮实际执行并观察到的结果；未执行的浏览器视觉检查、语义任务一致性等限制在末尾列出。

## 1. 环境

| 项 | 值 |
| --- | --- |
| DSH Desktop | `0.2.2-rc.3`，Cordis `4.1.0` |
| 运行时 | Electron `44.7.0` / Node `24.21.0`（`ELECTRON_RUN_AS_NODE=1` 实测） |
| profile | `desktop`（Web GUI，本机 loopback） |
| OpenSandbox | 本机 `http://127.0.0.1:8090`，Docker 容器 `opensandbox-server` |
| 沙箱镜像 | `python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535` |
| 插件运行数据 | `~/.dsh/agent-sandbox-runtime`；预算账本 `~/.dsh/agent-budget` |

## 2. 迁移基线

- 依赖从 DSH `0.1.0-rc.6` / Cordis `4.0.1` 升级到 `0.2.2-rc.3` / `4.1.0`；新增 `dsh-session-projection`、`dsh-tool-executor-native` 与 `@deepseek-ai/schemastery@3.19.0`。
- 组合根顺序改为 `tools → tool-executor-native → sessionProjection → agents → jsonl → agent-loop`；`JsonlPersistence` 改为命名插件导入。
- `CallId → ToolCallId`；工具结果改为 `role: 'tool'` 消息；system prompt 改由消息前置承载；`purpose` 按 0.2.2 的 `LlmRequestPurposeMap` 扩展。
- `pnpm typecheck` 退出 0；`pnpm test` 为 **765 passed + 12 skipped = 777**（61 个测试文件通过、4 个跳过）。

## 3. Bundle 安装与激活

两个本地目录 bundle 已通过 Plugin Manager 安装进 `desktop` profile：

| Bundle | 版本 | 入口 | 结果 |
| --- | --- | --- | --- |
| `dsh-plugin-agent-budget` | `0.4.0` | `link:D:/1GISwork/11-OPENSANDBOX+runtime/.sources/budget` | `application: applied` |
| `agent-sandbox-runtime` | `0.4.0-dev.0` | `link:D:/1GISwork/11-OPENSANDBOX+runtime` | `application: applied` |

运行时行的 patch id 为 `agent-sandbox-runtime`；预算行为 `agent-budget`（`maxTokens: 50000`、`reservationMode: true`、`pressurePrompt: false`）。运行时插件注册 `runtime_python` 工具，并通过 `agentBudget` 注入等待预算插件激活。

客户端半边：`src/client/dsh-panel.js` 经 `scripts/copy-client.mjs` 复制到 `dist/client/dsh-panel.js`，`package.json` 的 `dsh.client` 声明 `platform: web`、`inject: ["@deepseek-ai/dsh-client-ui-slots"]`，`exports["./client"]` 指向该文件；面板注册 `settings.section` 的“运行管控”页，调用 `/agent-sandbox-runtime/api/runs` 与 `/governance`。

活页面注册已通过 Client Inspect 确认：`Slots.listSubTree('settings.section')` 的 occupants 包含 `agent-sandbox-runtime-governance`（order 61，`active: true`）和 `agent-budget-settings`（order 60，`active: true`）；`node --check src/client/dsh-panel.js` 通过。Host 路由 `GET http://127.0.0.1:51182/agent-sandbox-runtime/api/runs`（带 `x-agent-sandbox-runtime-request: 1`）返回 `{ ok: true, runs: [...] }`，包含本 run 与 `governed: false`。未做截图或明暗主题视觉检查。


## 4. 真实执行

本会话通过已安装的运行时插件调用 `runtime_python`，真实使用 DeepSeek（`deepseek-official` / `deepseek-flash`）与真实 OpenSandbox：

| 项 | 值 |
| --- | --- |
| Session | `session-aa5f692f-a35f-414f-ba47-413703a56b66` |
| Run | `run-c6e0ffdaaf4db74ee49c1afcb130e092` |
| Attempt | `9de0917e-04c5-48a0-bdcb-0ec4f8ca6d7b` |
| 状态 | `RUNNING`（未管控会话，交付后保持可继续） |
| 执行 | `exitCode: 0`；`validation: passed`；`problems: []` |
| 步骤 | `accept-af59a998a71dc46289f5eb35a6b73a4a`（review，SUCCEEDED）、`tool-f526210a...`（python，SUCCEEDED） |
| 事件 | `sandbox.attached → sandbox.cleanup_required → sandbox.cleanup_confirmed`、`validation.completed`、`delivery.manifest`、`delivery.accepted` |

已提交产物（从 `ArtifactStore` 取回并独立核对 SHA-256）：

| 路径 | 字节 | SHA-256 |
| --- | ---: | --- |
| `statistics.json` | 611 | `7a770f883044c17df3909f9769ef9fab20e464d989fa99b6729e0535adc348fb` |
| `report.md` | 503 | `a44b58d2f2acb448237e6d5a02f8d4a881c2bd2eef179b6b1afdb478dc498112` |
| `chart.svg` | 1146 | `0c680101093a0e8ccd0ab1bec5b8d26a51312ad47459eaff7dbb38c69db05c37` |

产物副本位于 [files](plugin-host-v1/files)。`statistics.json` 与冻结答案独立比对：

```text
python examples/charging-analysis/verify.py --fixture normal.csv --result <statistics.json>
PASS candidate statistics
```

沙箱清理：数据库中该 run 的 `sandboxes.active=0`；`docker ps` 只显示 `opensandbox-server`，没有残留执行容器。

## 5. 预算账本

本会话 scope 的账本统计（`~/.dsh/agent-budget/ledger.jsonl`）：

- `reserve` 94、`dispatch` 94、`settle` 94；未结预留 0；`unknown` 0。
- 已结算用量：input 954,829；output 67,674；cacheRead 39,777,536；cacheWrite 0。
- 会话期间操作者曾把该 scope 的限额从 50,000 调整到 10,000,000，随后调整到 `Number.MAX_SAFE_INTEGER`；调整记录仍在账本中。本轮不把该调整当成预算策略效果。

## 6. 限制

- 该 run 的 `task` 取自本会话首条用户消息（“先了解一下项目”），实际交付的是 `examples/charging-analysis/normal.csv` 的统计产物。本轮证明的是“真实模型 → 宿主插件 → OpenSandbox → 产物提交 → 独立验收”链路，不是任务语义与用户请求一致性的验收。
- 客户端面板只做了构建、manifest、活 slot 注册与 Host API 的 GET 验证；未做浏览器截图、明暗主题对比或卸载残留检查。面板的“运行管控”默认不阻断对话。
- 会话期间因代码重建发生 `codeHash` 变化，旧 run 已按显式迁移要求清理；本记录只覆盖清理后的新 run。
- 未覆盖并发会话、子 Agent 共享 run、崩溃恢复与审批映射；这些仍按原任务表现有待验收项处理。

## 7. 复现命令

```powershell
pnpm typecheck
pnpm test
pnpm build
# 安装（本机 profile）
# 通过 DSH GUI 的 Plugins 页面或 plugin_manager 安装两个本地目录
# 会话中调用 runtime_python 后核对：
python examples/charging-analysis/verify.py --fixture normal.csv --result docs/evidence/plugin-host-v1/files/statistics.json
```

运行时数据库与账本为本地运行数据，不随仓库提交；产物副本和本记录提交。
