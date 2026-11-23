# 开发基线

记录日期：2026-11-16（Asia/Shanghai）。项目基线 commit：`dff1a01`。

| 组件 | 已核对版本 / 位置 |
| --- | --- |
| 运行时 | 本仓库，Node 22.22.2、pnpm 11.7.0、TypeScript 5.9.3、Vitest 4.0.18 |
| SQLite | Node 内置 node:sqlite，3.51.2；Node 22 API 有 experimental 提示 |
| Python | 系统 Python 3.13.7，仅用于参考计算和源代码验证，未作为宿主代码执行回退 |
| 预算插件 | `.sources/budget`，独立 Git checkout，原基线 `28c77462aa20ceb27acc0cec99db0dea11087dbc`、0.4.0 |
| Harness 执行基线 | 精确发布包 0.1.0-rc.6、Cordis 4.0.1；不使用浮动 latest |
| Harness 参考源码 | `.sources/harness`，`39163dd30f703a79079e2d2446545cff3c453738`；API 已漂移，未用于默认运行 |
| OpenSandbox | SDK 1.2.1；参考源码 `.sources/opensandbox`，`4ae99691ff0a62594614df90a86ecbee07add966` |

原预算插件 clone 时 main 干净。初始类型检查/构建通过；Windows autocrlf 造成 migration .mjs shebang 错误，规范 LF 后基线 104 passed / 1 skipped。该失败和修复均保存在 `docs/evidence/logs/budget-baseline-*`，并由预算分支补 `.gitattributes`。

没有检测到本进程的 DeepSeek/OpenAI/DSH 凭据变量名；未输出凭据值。真实外部 provider 使用情况不由本地确定性 adapter 测试证明。

沙箱环境：用户之后配置了 Docker Desktop；OpenSandbox 1.2.1 的 SDK 与项目适配器 lifecycle smoke 均已通过，详细部署与限制见 `environment.md`。真实隔离和 RuntimeService/ArtifactStore 恢复集成仍待验收；接口测试不计作真实容器通过。

根目录 Git 原先不存在，创建时只有计划文档及 tmp；已建立独立可回溯仓库。上游 checkout 保持独立，预算修改需用 `integrations/budget/` 的补丁/版本记录复现。密钥、运行数据和依赖目录均忽略。
