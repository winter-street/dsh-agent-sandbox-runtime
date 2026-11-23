# 固定任务评测

2026-11-18 后续：失败脚本显式修复、15/15 真实校准、双 worker 受控完整覆盖与两槽真实复验已通过，历史 177/180 保留。见 [实施证据](../docs/evidence/2026-11-18-followups.md)。

## 离线复核与受控压力

```powershell
pnpm eval audit --records <records.jsonl> --split calibration --mode real --repetitions 1 --out <新audit.json>
pnpm eval pressure --out .runtime/pressure-new-experiment
```

`audit` 不调用宿主、模型或沙箱，校验原产物哈希、重跑输入派生验证器并核对原 ledger receipts。`pressure` 固定 `eval/pressure-plan.json`，真实 Harness/原预算插件加受控 provider，无外部模型/真实沙箱，合成 usage 只验证机制。

受控 provider / sandbox 故障矩阵：

```powershell
pnpm eval fault-matrix --out .runtime/fault-matrix-controlled-<timestamp>
```

该命令使用真实 `DeepSeekAdapter` 的受控 `fetch` 和 `RuntimeService` 的 `FakeBudget`/`FakeSandbox`，覆盖 HTTP/SSE/usage/超时/取消以及沙箱创建、命令超时、取消未确认和远端未知结果。每个场景保存受限 `failure.json` 与 `evidence.json`。它不调用外部模型或 OpenSandbox，也不能替代真实预算账本进程恢复。

```powershell
pnpm eval transport-faults --out .runtime/transport-faults-new
```

`transport-faults` 需要已构建的原预算插件和一个新输出目录。它使用本机 HTTP/SSE、实际应用宿主和 SQLite，验证用量未知时暂停、重开时保留预留、补录时不会重复结算。该命令不需要真实密钥，不调用外部模型或沙箱。

## QA-02 受控验收证据

QA-02 runner 用真实 `RuntimeStore`、`RuntimeService` 和 `ArtifactStore`，在每个独立场景中使用明确标注的 `FakeBudget`、`FakeSandbox` 和 `FakeClock`。它不会调用 DeepSeek、原预算插件或外部 OpenSandbox，因此结果只能证明本地状态机、产物边界和回收逻辑，不能替代真实 provider/sandbox 全链路验收。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-qa-02-evidence.ps1
# 或指定新输出目录
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-qa-02-evidence.ps1 -Out .runtime\qa-02-<timestamp>
```

也可以直接运行：

```powershell
pnpm eval qa-02 --out .runtime/qa-02-<timestamp>
```

报告写入 `report.json`、`report.md`，每个场景另有脱敏的 `<scenario>/evidence.json`。当前场景包括正常执行、脚本非零退出、命令超时、客户端取消、取消无法确认、文件数限制、总字节限制、产物路径穿越、已发布产物 hash 篡改和原预算 usage 未知时阻止新沙箱执行。退出码为 0 才表示受控场景全部通过；报告中的 `execution=controlled-fake`、`modelCalled=false`、`realProvider=false` 和 `realSandbox=false` 是验收边界，不能被改写成真实调用证明。

真实 OpenSandbox/Harness/预算账本证据仍需分别引用 `docs/evidence/P1-06-harness.md`、`docs/evidence/P1-07.md`、`docs/evidence/P1-08.md` 和 `docs/evidence/N02-budget-process-recovery.md`。历史正式评测即使记录数达到 180/180，也必须以报告中的 `finalEvaluationEligible` 和 `eligibilityBlockers` 为准，不能由 QA-02 受控 runner 改变。

```powershell
pnpm eval external-transport-faults --out .runtime/external-transport-faults-new
```

外部探针向 DeepSeek 发送最多两次请求：一次固定无效凭据、一次从进程环境或 `.env.local` 加载 `DEEPSEEK_API_KEY` 的 `deepseek-flash` 流式调用，输出上限 256 token。客户端收到首个文本增量即主动断开。报告记录响应和账本状态，不记录密钥或响应正文，不核对费用，也不需要 OpenSandbox。

## 两 worker 并行

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-parallel-evaluation.ps1 -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-parallel-evaluation.ps1 -MaxRunsPerWorker 1
```

默认校准集、一次重复、每 worker 最多一槽，共最多两槽。自动加载 `.env.local`；两个异步 worker 同属一个 Node 进程，分别持有 runner/application/budget/evidence 目录。全局 provider/sandbox 上限为 2，可用 `-ProviderConcurrency 1 -SandboxConcurrency 1` 收紧，续跑必须使用原参数。

继续同一实验时传原 `-OutDir`，已提交槽跳过且预算不清零。`-MaxRunsPerWorker 15` 可完成剩余校准；正式评估须显式 `-Split evaluation -Repetitions 3`，规模仍受每 worker 上限约束。未知调用/暂停停止后续派发，pending 时用相同目录和参数加 `-Reconcile` 只核对原 run，不新增槽位。不能删除未知记录来重新获得额度。

精确覆盖完成后合并：

```powershell
pnpm eval merge-shards --root <原并行目录> --split calibration --repetitions 1 --mode real --out <新合并目录>
```

合并对照每个 worker SQLite 与 JSONL，检查归属、唯一性、manifest 和完整覆盖，不自动去重/补齐。失败不重标成功，校准不作为正式效果结论。

当前任务集为 **frozen-for-final-evaluation**，包含 5 个校准输入与 20 个评估输入。已有真实运行的诊断记录，但最终效果评测尚未通过；不能仅凭槽位数量宣称成功。

仓库提供三套无密钥配置模板：`config/eval-hard.json`、`config/eval-tiered.json` 和 `config/eval-finalize.json`。它们固定同一模型、沙箱和总预算，只分别选择 observe hard-only、enforce tiered、enforce tiered-finalize。运行真实评测前必须在当前进程设置 `DEEPSEEK_API_KEY`、`OPEN_SANDBOX_API_KEY`，并确认本地 OpenSandbox 服务可用；缺凭证时 driver 会在写入调度意图前失败。

## 自动加载配置的单槽诊断（Windows）

项目根目录的 `.env.local` 填写两个密钥后，在项目目录执行下面一条命令即可，不必逐次设置三个 `ASR_EVAL_CONFIG_*` 变量：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-evaluation-smoke.ps1
```

脚本与批量入口共用 `scripts/evaluation-env.ps1`，只在子进程中加载密钥及三套配置的绝对路径，不输出密钥。每次创建独立的 `.runtime/evaluation-smoke-日期时间-随机后缀` 目录，固定 `--max-runs 1`，只执行第一个评估槽位（e01 / hard-only），不会启动 180 槽批量运行。结束时显示 `Passed`、任务状态、统计/报告/图表验收和问题列表，以及 `ModelResponses` 中的结束原因、请求输出上限、文本/思考字符数和工具调用数。已识别的本地模型准入拒绝单独列入 `ModelAdmissionRejections`，不会作为无 usage 的空响应列入前者；任务或产物验收未通过时返回非零退出码。已有目录会被拒绝，保留原证据。

三套评测配置统一显式使用 `model.thinking: disabled` 和 `model.maxOutputTokens: 8192`，总预算仍为 50000。输出被截断会记录 `finishReason: max-tokens`，不把它误判成正常回答结束；该修改改变实验配置指纹，需使用新诊断目录，旧记录仍保留原始含义。

仅检查配置路径、密钥是否存在及任务哈希，可加 `-CheckOnly`；此模式不调用模型或沙箱，也不创建评测输出目录：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-evaluation-smoke.ps1 -CheckOnly
```

直接执行 `pnpm eval run` 或 `pnpm eval doctor` 不会读取 `.env.local`，仍需在同一个终端设置所需环境变量。单槽诊断的 `recorded=1/60`、`finalEvaluationEligible=false` 是覆盖不足的预期结果，具体任务是否通过以最后的 `Passed` 和独立产物验收为准。

单槽通过后，用下面一条命令运行 **5 个校准任务 × 3 种策略 × 1 次，共 15 槽**，覆盖正常、空表、缺失值、缺列和无效时间输入：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-evaluation-smoke.ps1 -Calibration
```

该模式自动加载配置和密钥，创建全新的 `.runtime/calibration-smoke-日期时间-随机后缀` 目录。执行后显示逐槽结果，并写入含全部产物验收和响应诊断的 `smoke-summary.json`；核对任务、策略、重复次数和 15 槽覆盖，任一任务未通过时退出码为 1。异常输入按任务契约核验 `statistics.json` 错误对象，不强求三份正常分析产物。沙箱基础设施失败会停止批次并保留退出码，不自动重试或核对。加 `-CheckOnly` 可先离线检查。校准结果用于排查集成问题，不计入最终评估集。

```powershell
pnpm eval verify-fixtures
pnpm eval plan --split calibration --repetitions 3 --out .runtime/eval/calibration-plan.json
pnpm eval plan --split evaluation --repetitions 3 --out .runtime/eval/evaluation-plan.json
```

真实校准从单槽位开始，确认产物、账本和 usage 后再扩大范围：

```powershell
$env:ASR_EVAL_CONFIG_HARD_ONLY = (Resolve-Path config/eval-hard.json)
$env:ASR_EVAL_CONFIG_TIERED = (Resolve-Path config/eval-tiered.json)
$env:ASR_EVAL_CONFIG_FINALIZE = (Resolve-Path config/eval-finalize.json)
pnpm eval run --driver eval/runtime-driver.ts --mode real --split calibration --repetitions 1 --max-runs 1 --out .runtime/evaluation-calibration
```

如果进程在 provider 或沙箱调用后退出，先使用同一目录和同一配置执行 `pnpm eval reconcile ...`；不要删除 pending slot 或改用新 `runId` 掩盖未知 usage。校准结果经独立复核并冻结任务集后，才允许运行 evaluation split。

三个策略为 `hard-only`、`tiered`、`tiered-finalize`。3 次重复分别产生 45 个校准槽位、180 个评估槽位；生成计划不会调用模型或沙箱。先完成校准与答案复核，再固定配置及评估集；校准记录不能计入最终评估。

## 执行与核对

`runner.ts` 提供顺序执行器，仓库已交付 `eval/runtime-driver.ts` 作为默认可信宿主 driver。它会在写入调度意图前预检 DeepSeek/OpenSandbox 凭据和配置，并把真实运行产生的 trace、原预算账本、产物和独立验证结果落盘；当前仍需完成并通过最终效果评测。

driver 模块应默认导出 `EvaluationDriver`：

- `manifest` 固定 provider/model/runtime 版本、真实或模拟模式、各策略配置哈希和预算上限。
- `execute(request, signal)` 通过已配置宿主执行任务。请求仅包含任务提示、当前输入、槽位身份，不包含参考答案。模型与代码仍受现有运行时和原预算插件管理。
- `validate(request, execution)` 由可信宿主读取已提交产物、原预算账本和验收证据，返回 `RunResult`。模型自报正确、脚本退出码或一个文件路径字符串都不能替代验证。
- 可选的 `reconcile(request, signal)` **只能查询原 run 的执行/计量结果**，不能发送模型请求或重试工具。核对后仍经 `validate`。

```powershell
pnpm eval run --driver <可信宿主driver.ts> --mode real --split calibration --repetitions 3 --max-runs 1 --out .runtime/eval/calibration
pnpm eval reconcile --driver <同一个driver.ts> --mode real --split calibration --repetitions 3 --max-runs 1 --out .runtime/eval/calibration
pnpm eval report --mode real --split calibration --repetitions 3 --records .runtime/eval/calibration/records.jsonl --out .runtime/eval/calibration-report
```

`--max-runs` 默认 1，限制本次执行或核对的槽位数，不是每槽位的模型调用数。槽位内部的调用次数、预算和期限由可信 driver/原预算插件负责。宿主 driver 是本机可信代码，与应用共享文件权限；仅省略参考答案字段不构成宿主进程的文件隔离。

执行器在 SQLite 原子提交槽位意图后才调用 driver，结果验证后单独提交。重开数据库会跳过已提交槽位；意图存在但没有结果时，普通 `run` 整体停止。显式 `reconcile` 只查询既有槽位，保持原 runId，且不会开始新任务。缺少核对能力或核对失败时保留待核对状态，不能删除数据库或改 runId 来掩盖未知消费。

同目录仅允许一个活跃 runner；进程已退出时可重新接管 owner，但不会释放未知槽位。任务集、输入、提示和参考实现的哈希在调用及验证边界重新核对。目录绑定整个计划、driver manifest 和每项策略配置；修改实验须使用另一个目录。

`execution.sqlite` 是执行记录来源，`records.jsonl` 从已提交结果导出，导出失败可在下次启动重建。runner 的 SQLite 不保存另一份预算余额，消耗仍从原预算账本取证。

## 报告口径

报告拒绝混合真实/模拟数据、跨校准/评估记录、重复槽位、跨 run 重用 model call、冲突用量、provider/model/runtime 变化及同策略预算/配置变化。未知 usage、未检查产物、缺失耗时和未执行任务不填零；辅助摘要、复核、重试、收尾调用全部纳入 token。`knownOverage` 是所有已记录 run 的已确定超额下界，有未知的额外用量时也不抹去已知超额；`overageKnownRuns` 单独表示账目完整的 run 数，不是该下界的分母。

`evaluationDataComplete` 表示 evaluation split、真实模式、冻结任务集、全部计划记录、完整用量/耗时及已知统计和必需检查结果；已知失败与未检查的 null 分开。`acceptance` 单独报告通过与未通过数量。历史 `finalEvaluationEligible` 更严格，另要求每条记录完整成功且所有必需检查通过；180/180 中存在部分完成时仍为 false，不能据此把整批当成未运行完。`eligibilityBlockers` 和 `unacceptedRuns` 列出具体原因和 runId。失败样本保留在完成率与消耗分母中，不为使门槛变 true 自动重跑。当前 schema 中 evidence 是引用，数据完整字段不会凭字符串证明真实模型调用；仍须独立核对原账本和产物文件。校准、模拟和未冻结任务集不能满足最终评测数据条件。

## 冻结后的批量真实评测

任务集冻结且 15 槽校准通过后，使用新目录启动正式评测。以下批次现已完成 180/180 槽，177 完整完成、3 部分完成，结果与后续任务见 [真实评测结果](../docs/evaluation.md)。以下保留该批次原启动命令，复核结果无需重新执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-final-evaluation.ps1 `
  -OutDir .runtime\evaluation-final-20261118-validated `
  -ReportDir .runtime\evaluation-final-20261118-validated-report
```

脚本默认读取项目根目录的 `.env.local`；可先复制 `.env.example`，只填写 `DEEPSEEK_API_KEY` 和 `OPEN_SANDBOX_API_KEY`。该文件被 `.gitignore` 忽略，脚本只把值放入当前进程环境，不打印或写入评测证据。`.env.local` 是明文文件，适合个人开发机；共享电脑、云同步目录或不确定文件权限时，应改用 PowerShell 进程环境变量，并在评测后删除本地文件。

脚本历史默认目录 `.runtime/evaluation-final-20261117` 保留旧失败证据，因此本次显式指定新的 `OutDir` 和 `ReportDir`。每轮最多执行 45 个槽位，20 个 evaluation 任务 × 三策略 × 三次重复，共 180 槽。脚本自动加载 `.env.local` 和三个配置路径。全部槽位提交后，报告写入指定 `ReportDir` 下的 `report.json` 和 `report.md`；数据完整性看 `evaluationDataComplete`，任务成功看 `acceptance`，严格门槛问题看 `eligibilityBlockers`，并独立核对证据。

当前已有 `.runtime/evaluation-final-20261118-audited-report`，原报告和记录均保留。需要用扩充字段重新生成离线报告时，为 `--out` 选择一个尚不存在的报告目录；该命令不调用模型或沙箱，也不需要 API 密钥：

```powershell
pnpm eval report --mode real --split evaluation --repetitions 3 `
  --records .runtime/evaluation-final-20261118-validated/records.jsonl `
  --out .runtime/evaluation-final-20261118-offline-report
```

恢复同一正式运行时重复同一命令，保持目录、代码与配置一致。普通 `run` 跳过已提交槽位；遇到未决意图时，脚本在同一目录执行只读执行结果核对，保留原 runId。沙箱基础设施熔断退出码 2 会直接停止，不自动核对或重试。没有进展或配置/任务集不一致也会停止并保留证据。
