# QA-05 — 宿主运行评测驱动与独立产物验证

状态：宿主与评测框架实现完成，受控检查通过；真实 DeepSeek + 三策略外部评测尚未执行。以下测试不构成真实任务效果、节省 token 或完成率的证据。候选题集没有冻结。

## 已实现

- `eval/runtime-driver.ts` 提供 `EvaluationDriver` 默认导出，CLI 默认仅为 `real`。导入不启动应用或发起请求；首次访问 manifest 时检查三份配置、凭证变量和原预算插件构建产物。缺配置/凭证直接失败，runner 尚未提交调度意图。
- 真实路径调用应用宿主 `startApplication`，经实际 Harness / 原预算 ledger / OpenSandbox adapter。禁止将注入 provider、注入 sandbox、注入 host factory 或手填 execution 身份标记为 real。
- 三种策略必须有实际不同配置：hard-only 使用 observe 且无 finalize reserve；tiered 使用 enforce 且无 finalize reserve；tiered-finalize 使用 enforce 且有对应比例 reserve。总预算、模型配置、沙箱资源和其余策略阈值保持一致。配置、验证器、格式契约和代码进入指纹。每策略独立持久目录。
- driver 从原 `eventsAfter(0)` 枚举作用域内所有 reservation 调用及 legacy sample；settle 的四个互斥 usage bucket 原样入报告；UNKNOWN 和未结算调用保留 null，仅明确 release-unsent 排除。枚举的已知消耗与原 snapshot.usedTokens 再次核对。没有模型调用也不能证明零 token，report 层会标记未知。
- 各次 run 的 intent 先持久化，绑定完整请求/输入/套件/manifest；重复 execute 拒绝。reconcile 需要已有 intent 和已有 run，仅调用宿主 get/reconcile，不调用 submit、continue 或 wait，更不重发模型/代码执行。
- 不信任模型 reviewer、路径字符串、退出码或 SVG 自报 metadata。独立 TypeScript CSV 读取器从原输入重新计算统计；与 Python 参考派生的 25 个候选 fixture 逐一核对。UTF-8 BOM、带逗号/换行/转义引号 CSV 和日期无时区/非法日期都有检查。
- 有限产物契约会附加到模型请求，只有格式规范，没有参考答案。`report.md` 的八组实际指标用 JSON 解析后比较，方法、局限与结论行逐项检查；`chart.svg` 的四组可见标签与柱高/y 坐标逐字规范核对，拒绝隐藏覆盖层、样式、脚本、任意 PNG 等无法由此验证器证明的内容。这是对指定输出格式的验证，不宣称支持任意报告或图片的语义判断。
- 修复后的输出只取 trusted trace 中最后一个已提交 `tool.finished` attempt，核对其 run/attempt 状态，再读该 attempt 的产物；不会从旧 attempt 挑选正确文件拼装结果。全部历史产物仍保存供审计。
- 所有产物经 `ArtifactStore.read` 的 manifest/大小/哈希校验后重新读取，再把实际 trace、原 receipt、validation 与产物 bytes 写入证据目录；evidence 路径不能替代内容检查。

## 当前验证

```text
pnpm exec vitest run tests/eval/artifact-validation.test.ts tests/eval/runtime-driver.test.ts
50/50 PASS（36 个独立产物测试 + 13 个原receipt/配置预检测试 + 1 个真实core/store/ArtifactStore与假budget/sandbox的driver生命周期测试）

pnpm typecheck
PASS
```

这些评测专项的 reader 和 receipt fixture 明确为 controlled，没有外部模型调用；生命周期测试真实落盘 RuntimeStore/ArtifactStore、经 RuntimeService 提交产物，预算与沙箱为明确的 test fake。另有 `tests/app/host.test.ts` 验证统一宿主的受控 provider + fake sandbox 组合，且本地 Docker `opensandbox-server` 的真实 OpenSandbox host smoke 已通过。上述结果不等于真实 DeepSeek 效果、计量或最终评测。

## 真实调用方式

应用宿主配置及环境准备完成后设置三个配置路径，不要把密钥写进配置或报告：

```powershell
$env:ASR_EVAL_CONFIG_HARD_ONLY = '绝对路径/hard-only.application.json'
$env:ASR_EVAL_CONFIG_TIERED = '绝对路径/tiered.application.json'
$env:ASR_EVAL_CONFIG_FINALIZE = '绝对路径/tiered-finalize.application.json'
$env:ASR_EVAL_EVIDENCE_DIR = '绝对路径/evaluation-evidence'
pnpm eval run --driver eval/runtime-driver.ts --mode real --split calibration --repetitions 1 --max-runs 1 --out .runtime/evaluation-calibration
```

配置的 `runtimeConfigPath`、`dataDir` 按配置文件目录解析；凭证由配置中的 `model.apiKeyEnv`、`sandbox.apiKeyEnv` 指定。默认驱动不接受注入 factory。模型版本只标明供应商提供的模型 alias，DeepSeek 服务端 revision 未暴露；OpenSandbox 记录 SDK 版本，不伪称已获取 server/image digest。

某 slot 已调度但未提交结果时，仅使用查询恢复：

```powershell
pnpm eval reconcile --driver eval/runtime-driver.ts --mode real --split calibration --repetitions 1 --max-runs 1 --out .runtime/evaluation-calibration
```

## 尚待验收/限制

- 应用宿主真实接线、实际 host + controlled provider + fake sandbox 的集成验收已通过；其中新增了无 finalize reserve 时仍提交独立验收并 `SUCCEEDED` 的测试。本地 Docker `opensandbox-server` 上的真实 OpenSandbox host smoke 也已通过（唯一 run、一次 attempt、一个 `result.json`、SUCCEEDED）。tiered-finalize 实际调用 `FinalizationCoordinator` 的完整矩阵仍待验收。
- 真实凭证、DeepSeek provider、OpenSandbox 服务环境的可用性和真实三策略 calibration；当前未联网试跑，未生成真实指标。
- 人工复核拒绝事件尚未提供，`reviewedDenials`/`falseDenials` 为 0（代表没有复核，不代表误拦截率为零；聚合分母为 0 则显示未知）。
- 分类 hints 来自 trusted workflow role completion 与 context coverage；无法归类的调用计入 work，总用量不会遗漏，但辅助调用分类不能视为完整测量。
- 输入时间戳目前验证器支持规范 ISO 日期时间（显式 Z 或 ±HH:MM）。候选 fixture 均覆盖此契约；不宣称兼容 Python `fromisoformat` 的全部扩展写法。
- 真实服务端模型 revision、OpenSandbox server版本和运行镜像 digest 仍需环境侧补充记录，当前不得宣称模型版本完全可复现。
- 校准通过、候选题集人工复核并冻结以后才可以执行最终 evaluation。禁止由受控测试或 simulation 推导简历性能百分比。
