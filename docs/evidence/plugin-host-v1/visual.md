# 客户端面板注册与视觉验收（P6-02-08）

日期：2026-11-20。范围：`agent-sandbox-runtime` 的 Client 半边（`src/client/dsh-panel.js`）与 `settings.section` 的“运行管控”页。

## 已实际确认

1. **构建产物存在**：`pnpm build` 由 `scripts/copy-client.mjs` 将 `src/client/` 复制到 `dist/client/`；`dist/client/dsh-panel.js` 为 5,718 字节（2026-11-20 03:25:14）。
2. **语法检查**：`node --check src/client/dsh-panel.js` 退出 0。
3. **manifest 接线**：`package.json` 的 `exports["./client"] = "./dist/client/dsh-panel.js"`，`dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-slots"] }`。
4. **活页面注册**：Client Inspect `Slots.listSubTree("settings.section")` 返回的 occupants 包含：

   | id | order | active |
   | --- | ---: | --- |
   | `agent-budget-settings` | 60 | true |
   | `agent-sandbox-runtime-governance` | 61 | true |

   说明“运行管控”页已在当前 GUI 页面注册，budget 页也在同一分组。
5. **Host 数据接口**：`GET http://127.0.0.1:51182/agent-sandbox-runtime/api/runs`（带 `x-agent-sandbox-runtime-request: 1`）返回 `{ ok: true, runs: [...] }`，包含本 run 且 `governed: false`。

## 未执行（需已认证浏览器或人工确认）

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 打开 Settings → 运行管控 | 未执行 | 需要已登录的 GUI 页面；当前会话无浏览器控制 |
| 标题/提示/run 列表显示 | 未执行 | 同上 |
| 切换“开启/解除管控”并观察剩余时间 | 未执行 | 会改动运行治理状态，未在验收中执行 |
| 浅色/深色主题 | 未执行 | 无浏览器截图 |
| 窄宽/滚动布局 | 未执行 | 无浏览器截图 |
| 禁用 bundle 后 section 消失、重新启用恢复 | 未执行 | 会改动 profile 状态，留待人工/后续 |
| 控制台无 `slot entry crashed` | 未执行 | 无浏览器控制台访问 |

**结论**：注册与数据接口已验证；视觉与交互未验证，不能据此声称 UI 通过。请用户在 GUI 中按上表确认，或提供已认证的浏览器控制后再补截图。
