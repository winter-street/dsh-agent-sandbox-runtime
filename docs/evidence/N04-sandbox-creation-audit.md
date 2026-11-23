# N04 沙箱创建历史审计

2026-11-19。旧版本可能将创建请求已发送但响应未知的情况记为 `FAILED / SANDBOX_CREATE_FAILED`，随后重试；无 sandboxId 不等于远端没有创建资源。现版本只允许适配器显式证明请求未发送时重试，但相同错误码的历史记录没有可靠的持久化未发送证明，因此统一作为待调查项，可能包含误报。

使用只读 SQLite 连接检查单个数据库：

```powershell
node .\scripts\audit-sandbox-creation.mjs <runtime.sqlite 的完整路径>
```

结果列出创建失败、创建结果未知以及创建阶段中断的 attempt、任务状态、已知的本地沙箱记录和代码指纹；不会查询远端、删除资源、变更任务状态或解除阻断。SQLite 可能需要访问数据库旁的 WAL/共享内存文件；应保留这些文件，检查失败不能当作没有风险。只检查指定数据库，不代表已经检查全部历史数据库。输出中的资源 ID 可能属于敏感运行信息，应谨慎分享。

对 `.runtime/n04-real-serial-20261119-010143-6c1998a0/application/database/runtime.sqlite` 检查到两个终态任务的旧创建失败 attempt，与先前记录的两个真实残留相符；先前已按 runId 和标签精确清理并对两个已知 ID 查询得到 404。此查询结果只说明这两个已知资源在查询时不存在，不证明该 run 或其他 run 不会出现晚到创建，也不能推断所有历史数据库安全。

恢复、继续和新执行会检查当前代码及配置身份和 checkpoint；终态任务的恢复直接返回，身份检查不审计既有终态资源，也无法约束仍在运行的旧进程或人工迁移。资源发现与解除阻断必须先确定所属关系、旧请求不再可能创建或具备可靠的服务端终止证据，且确认相关资源状态；目前没有实现此自动流程。单次清理或单次空列表不足以解除未知创建状态。

审计回归覆盖旧创建失败、未知创建、中断创建、终态任务、缺失身份、损坏/孤立记录和缺失数据库；审计失败应调查而非忽略。审计不证明任意外部副作用或远端资源完整性。

## 本地数据库盘点

2026-11-19 对工作区 `.runtime` 下当时发现的 145 个名为 `runtime.sqlite` 的文件逐个运行上述本地审计，均可读取，6 个数据库存在待调查项：

| 数据库位置 | attempt 数 | 本库内 run 数 |
| --- | ---: | ---: |
| `evaluation/hard/database/runtime.sqlite` | 674 | 63 |
| `evaluation/tiered/database/runtime.sqlite` | 622 | 60 |
| `evaluation/tiered-finalize/database/runtime.sqlite` | 607 | 60 |
| `clean-reproduction-20261118-073654-beee6075/config/.runtime/application/database/runtime.sqlite` | 3 | 3 |
| `clean-reproduction-20261118-073831-b2385e46/config/.runtime/application/database/runtime.sqlite` | 3 | 3 |
| `n04-real-serial-20261119-010143-6c1998a0/application/database/runtime.sqlite` | 2 | 1 |

上表路径均相对 `.runtime`。两份 clean-reproduction 数据库中三条 attempt ID 相同，是重复记录，不能当成六个独立事件。三份评测数据库共 1903 条待调查 attempt；其原因目前只有旧错误码，没有可持久核验的未发送证明。高数量可能包含同一任务的多次 attempt，不等于远端残留数量，也不能推断每次请求都已发送。上述盘点不包含其他命名的数据库、工作区之外的副本或以后新增的数据库；未对每一项逐条追查，更未证明远端清理完成。

对三份旧评测库的这些 attempt 进一步只读聚合，全部 1903 条均未保存 `failure` 细节。按包含这些 attempt 的 run 检索 `sandbox.attached` 事件：hard 组的 63 个 run 中有 3 个曾记录关联，tiered 与 tiered-finalize 各 60 个 run 均未记录关联。关联事件并不能证明与某条失败 attempt 是同一个创建请求；没有关联事件也不能证明服务端没有创建。以 UTC 计，三组失败 attempt 的开始时间跨度分别为 2026-11-16 22:02:36 至 2026-11-17 13:15:46、2026-11-17 13:15:56 至 13:37:39、2026-11-17 13:37:40 至 14:00:22。既有基础设施诊断记录了 Windows 端口配置问题，但不能仅凭时间或统一错误码将每条旧记录归因于该问题。

同日只读执行 `docker ps -a` 时，本机仅显示 OpenSandbox 服务容器。此结果仅覆盖当时所连接的 Docker 守护进程及容器，不能证明所有历史服务端或其他主机均无残留，也不提供请求已终止或不会晚到的证明。未执行批量删除或解除任何阻断。

## 工作区内其他数据库

2026-11-19 在工作区使用 `rg --files --hidden --no-ignore` 查找 `.sqlite`、`.sqlite3`、`.db`、`.db3` 文件，排除 `node_modules` 与 `.git`，发现 146 个 `runtime.sqlite` 和 15 个 `execution.sqlite`。除上述 `.runtime` 中的 145 份外，`config/.runtime/application/database/runtime.sqlite` 也包含 3 条旧创建失败 attempt；其 attempt ID 与两份 clean-reproduction 副本的三条完全相同，不是额外的三个独立事件。15 个 `execution.sqlite` 经只读检查均只有 `metadata`、`slots` 表，不能用运行时 attempt 审计器审计；这只说明其当前表结构，不证明评测未涉及其他数据库。

本次搜索按扩展名筛选，未检查无扩展名或其他扩展名的 SQLite 文件、被排除目录、工作区外副本及以后新增文件。三份相同 attempt 的数据库可能有不同的后续状态，去重只针对上述 ID，不能代替逐库保留与审计。

资源发现及阻断解除的候选设计和验收条件见 [创建结果未知的恢复设计](N04-sandbox-creation-recovery-design.md)。
