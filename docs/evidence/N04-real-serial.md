# N04 真实串行组合验收

日期：2026-11-19。入口：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-n04-real-serial.ps1`（运行前可加 `-CheckOnly`）。每次使用独立证据目录；真实模型调用最多三角色和一次可选收尾，总预算 30000 tokens。实际使用 DeepSeek `deepseek-flash` 和 OpenSandbox，固定 CSV 输入由独立验证器核对。

## 运行记录

- `.runtime/n04-real-serial-20261119-003554-657c89ad`：Planner 返回非 JSON 且以 DSML 标记开头，严格解析阻断；用量 745 tokens，无未知或剩余预留，未创建沙箱。原因未证实；随后为无工具角色请求增加 JSON 对象响应格式，仍保留严格校验。
- `.runtime/n04-real-serial-20261119-004306-1a964df2`：Planner、Executor 与只读 MCP 完成，正常重开后审批已接受，但异步调度前等待返回暂停；验收失败并取消，用量 3432 tokens。验收等待已处理该竞态。
- `.runtime/n04-real-serial-20261119-004503-5960585c`：任务成功，独立产物验证通过，用量 7121 tokens；验收在清理完成前读取到活跃沙箱而失败。事后只读核对 SQLite 的 active 为 0，认证远端 GET 返回 404；原报告保留失败。宿主活跃状态已纳入执行控制器的收尾期，并增加延迟销毁回归。
- `.runtime/n04-real-serial-20261119-005050-a9689b71`：验收通过，状态 SUCCEEDED，用量 6802 tokens（work 6698、finalize 104），四次调用各有一组 reserve、dispatch、settle，预留及未知调用均为 0。独立校验两份 HTTP 下载的内容、哈希及长度；本地沙箱已释放且认证远端 GET 为 404。耗时约 15.8 秒，仅代表本次运行。

通过的运行覆盖真实 Planner、Executor、Reviewer 和可选收尾的共享账本；固定只读 MCP 预取；等待审批时正常关闭并重开宿主；一次认证批准和一次沙箱 Python 执行；重复批准幂等、冲突决定拒绝。重开发生于同一 Node 进程的正常关闭，不是强杀。无真实远端故障注入、供应商账单核对或单 Agent 对照；单个固定样例不能证明质量、稳定性或性能收益。

## 状态查询断连与创建结果未知

- `.runtime/n04-real-serial-20261119-010143-6c1998a0`：创建请求响应超时后旧逻辑重试，远端实际创建两个沙箱，暴露资源泄漏风险。两者按项目标签和唯一 runId 定位后逐一清理，认证查询均为 404；保留 `orphan-cleanup.json`。现仅对适配器明确证明请求未发送的错误允许重试；创建结果未知时持久化 `UNKNOWN/SANDBOX_CREATE_UNKNOWN` 并阻断自动重试、取消确认、恢复和部分交付。
- `.runtime/n04-real-serial-20261119-011012-43693143`：状态查询断连后确实进入 `RECOVERY_REQUIRED`，验收脚本误将未知执行导致的 `host.active` 当作本地控制器仍在运行，等待至截止时间后断言失败；未完成恢复验证。清理后的认证远端查询为 404。脚本现单独等待本地控制器退出。
- `.runtime/n04-real-serial-20261119-011935-8dcce3cf`：通过。一次测试专用连接断开使真实 SDK 状态查询返回未知；核对后沿用同一 attempt 和 execution，未重新派发。审批消费一次，账本在核对前后不变；最终四次模型调用分别结算，使用 7327 tokens、预留及未知调用均为 0。两份 HTTP 下载通过独立语义和哈希验证，远端沙箱认证查询为 404。耗时约 16.8 秒，仅为单次观察。

注入的是测试端状态查询断连，不是 OpenSandbox 自然故障。创建结果未知后的自动资源发现、确认远端不会晚到创建后的解除阻断仍未实现；外部手动清理也不会自动解除未知 attempt。历史 `SANDBOX_CREATE_FAILED` 记录的安全性及代码身份兼容仍需复核。G4 仍需真实重试开销、前置任务复核和单 Agent 对照。

此前 `node scripts/check.mjs`：708 项通过、12 项默认跳过，类型检查、构建及固定样例验证通过；另设 `RUNTIME_BUDGET_INTEGRATION=1` 运行相关 6 个测试文件，33 项全部通过，包含上述 12 项。

创建结果未知保护及等待条件修复后重新运行 `node scripts/check.mjs`：712 项通过、12 项默认跳过，类型检查、构建、客户端资产及固定样例验证通过。跳过项不计为通过。
