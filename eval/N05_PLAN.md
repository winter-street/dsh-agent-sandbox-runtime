# N05 保留评测集与离线、串行、并行对照计划

`suite-n05-v2.json` 是当前对照集。它沿用 `suite-n05.json` 的三个输入、参考答案和验证标准，并在 `TASK-N05-v2.md` 中明确时段、严重度的值均为整数计数。见 [N05 运行记录](../docs/evidence/N05-evaluation.md)。

## 已完成的离线前置检查

```powershell
& .\node_modules\.bin\tsx.cmd eval/cli.ts verify-fixtures --suite eval/suite-n05-v2.json
& .\node_modules\.bin\tsx.cmd eval/cli.ts plan --suite eval/suite-n05-v2.json --split evaluation --repetitions 1 --out .runtime\eval\n05-plan-prompt.json
```

当前 suite 的独立哈希和提示文件哈希已经固定。参考实现对三个输入分别得到 `e21` 的 8 条统计、`e22` 的 4 条统计、`e23` 的 `MISSING_COLUMN`。这两条命令不调用模型、供应商或沙箱。

## 第一批真实对照

每组运行 3 个任务 × 3 个策略 × 1 次重复，共 9 个槽位。三策略使用同一模型、同一总 token 预算和同一沙箱资源，差异只来自 `hard-only`、`tiered`、`tiered-finalize` 的预算策略。每个条件使用独立输出目录、独立 SQLite、独立预算目录和独立证据目录。

先做无调用检查，确认凭据和固定配置路径存在：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\run-parallel-evaluation.ps1 `
  -Suite eval/suite-n05-v2.json `
  -Split evaluation `
  -Repetitions 1 `
  -MaxRunsPerWorker 5 `
  -ProviderConcurrency 2 `
  -SandboxConcurrency 2 `
  -CheckOnly
```

串行基线使用一个 runner，保存完整运行时间。先在同一 PowerShell 进程临时加载配置和凭据，再运行：

```powershell
. .\scripts\evaluation-env.ps1
Initialize-EvaluationEnvironment -RepoRoot (Get-Location).Path
$serialOut = ".runtime\n05-serial-$(Get-Date -Format yyyyMMdd-HHmmss)"
$serialStart = Get-Date
& .\node_modules\.bin\tsx.cmd eval/cli.ts run `
  --suite eval/suite-n05-v2.json `
  --driver eval/runtime-driver.ts `
  --mode real `
  --split evaluation `
  --repetitions 1 `
  --max-runs 9 `
  --out $serialOut
$serialExit = $LASTEXITCODE
$serialElapsedMs = [int](((Get-Date) - $serialStart).TotalMilliseconds)
[pscustomobject]@{ mode = 'serial'; exitCode = $serialExit; elapsedMs = $serialElapsedMs; output = (Resolve-Path $serialOut).Path } |
  ConvertTo-Json | Set-Content (Join-Path $serialOut 'timing.json')
if ($serialExit -ne 0) { throw "Serial N05 run stopped with exit $serialExit. Preserve $serialOut." }
```

双 worker 对照使用现有分片 runner。`MaxRunsPerWorker 5` 是上界，因此最多派发 10 槽，但 N05 计划只有 9 槽。runner 的分片计划和 merge 会按 suite 计划精确校验，最终必须是 9/9，不能以 10 槽替代覆盖检查。它会为两个 worker 创建独立运行目录，并在合并前检查槽位归属、SQLite 提交结果、suite 指纹、策略配置指纹和完整覆盖：

```powershell
$parallelOut = ".runtime\n05-parallel-$(Get-Date -Format yyyyMMdd-HHmmss)"
$parallelStart = Get-Date
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\run-parallel-evaluation.ps1 `
  -Suite eval/suite-n05-v2.json `
  -OutDir $parallelOut `
  -Split evaluation `
  -Repetitions 1 `
  -MaxRunsPerWorker 5 `
  -ProviderConcurrency 2 `
  -SandboxConcurrency 2
$parallelExit = $LASTEXITCODE
$parallelElapsedMs = [int](((Get-Date) - $parallelStart).TotalMilliseconds)
if ($parallelExit -ne 0) { throw "Parallel N05 run stopped with exit $parallelExit. Preserve $parallelOut and inspect progress.json." }
& .\node_modules\.bin\tsx.cmd eval/cli.ts merge-shards `
  --suite eval/suite-n05-v2.json `
  --root $parallelOut `
  --split evaluation `
  --repetitions 1 `
  --mode real `
  --out "$parallelOut-merged"
[pscustomobject]@{ mode = 'parallel-2-worker'; elapsedMs = $parallelElapsedMs; output = (Resolve-Path "$parallelOut-merged").Path } |
  ConvertTo-Json | Set-Content (Join-Path "$parallelOut-merged" 'timing.json')
```

若第一次运行停止且留下 pending intent，使用 `-Reconcile` 和相同的 suite、输出目录、重复次数与并发参数核对原 runId。全部槽位已提交时可直接合并。

## 槽位通过标准

每个槽位必须同时满足以下条件，才计入该策略的完整通过数。

- `outcome=complete`，`failureKind` 为空。
- `calls` 的 usage 全部已知，原预算账本没有未知调用或未结 reservation。
- `e21` 和 `e22` 的统计、报告和图表验证通过。
- `e23` 的统计结果是固定的 `MISSING_COLUMN`，不生成伪造分析产物。
- `records.jsonl`、worker SQLite 和 evidence 文件的 runId、task、variant、repetition、suite/config 指纹一致。
- 并行合并必须达到精确的 9/9 覆盖。任何失败、未知 usage、基础设施停止或待核对槽位都保留在原目录，不自动重发。

N05 suite 仍是 `frozenForFinalEvaluation=false`，所以报告中的 `finalEvaluationEligible=false` 是预期结果。N05 关注的是三策略的完成率、正确性、token、耗时、拒绝和人工复核，而不是历史正式评测门槛。

## 扩大批次

3 次重复已完成 27/27，分片、计时及产物审核见 [重复实验](../docs/evidence/N05-evaluation.md#v2-双-worker-重复实验)。

只有第一批 9/9 槽位通过，且没有未知 usage、未结 reservation、sandbox 未确认状态或配置指纹漂移，才扩大到 3 次重复，共 27 个槽位：

```powershell
$repeatOut = ".runtime\n05-v2-parallel-r3-$(Get-Date -Format yyyyMMdd-HHmmss)-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\run-parallel-evaluation.ps1 `
  -Suite eval/suite-n05-v2.json `
  -OutDir $repeatOut `
  -Split evaluation `
  -Repetitions 3 `
  -MaxRunsPerWorker 14 `
  -ProviderConcurrency 2 `
  -SandboxConcurrency 2
& .\node_modules\.bin\tsx.cmd eval/cli.ts merge-shards `
  --suite eval/suite-n05-v2.json `
  --root $repeatOut `
  --split evaluation `
  --repetitions 3 `
  --mode real `
  --out "$repeatOut-merged"
```

真实批次在同一机器上比较，固定模型、预算配置、任务集和重复次数，记录不同并发条件下的端到端墙钟时间及 provider 调用次数。测量的是评测 worker 的吞吐。

## 受控软限制和资源压力

预算机制对照仍使用固定的受控计划，不调用模型或真实沙箱：

```powershell
& .\node_modules\.bin\tsx.cmd eval/cli.ts pressure `
  --plan eval/pressure-plan.json `
  --out .runtime\pressure-n05-$(Get-Date -Format yyyyMMdd-HHmmss)
```

该计划固定 3 个预算梯度、3 种策略、3 种场景，共 27 个条件，覆盖稳定执行、未发送重试和 usage 未知。它只证明预留、结算、软限制拒绝、滞回和恢复的机制行为。真实 CPU、内存、日志压力由独立 OpenSandbox 探针覆盖。14 项实测检查、恢复边界和报告见 [N05 资源结果](../docs/evidence/N05-evaluation.md#真实-cpu内存与日志压力)。

## 结果记录规则

每次实验在新目录开始，记录 `plan.json`、`progress.json`、`records.jsonl`、`report.json`、`report.md`、worker SQLite、budget receipts 和 evidence 文件。实验中途失败时保留目录并先核对 pending intent、原预算账本和远端 execution，再决定是否执行 reconcile。不得删除失败样本、修改 suite 哈希、改写 usage 或把 token 数直接换算成货币节省。
