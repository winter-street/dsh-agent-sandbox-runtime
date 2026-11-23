# N04 创建结果未知的恢复设计

2026-11-19。本文记录本地未发送证明与重试阻断已实现的部分，以及创建结果未知恢复仍需的设计和验收条件。它不表示已经实现自动发现、清理或解除阻断。

## 现状及边界

`OpenSandboxAdapter.create` 当前发送的 metadata 是 `project=agent-runtime` 和 `runId`。本地安装的 OpenSandbox SDK 的 `SandboxManager.listSandboxInfos` 提供 metadata 过滤和页码分页，`getSandboxInfo` 可按 ID 查询；这些接口的存在不证明服务端支持幂等创建、稳定分页、强一致列表或取消正在处理的创建请求。SDK 的删除请求接受成功也不等于底层清理已经完成。部署版本、租户范围、服务端实现和一致性须分别验证。

一个 run 可能有多次创建请求，当前 runId 标签不能把某个资源可靠地绑定到某一次 attempt。旧记录没有已发送请求的唯一身份、服务端终止回执或可靠的未发送证明。单次空列表、查询 404、TTL 到期、本地进程退出以及单次人工删除均不足以证明不会出现晚到资源。仅对已验证归属的特定 ID 调查或清理，不执行全项目批量删除。

## 本机服务端源码观察

2026-11-19 只读检查运行中的 `opensandbox-server` 容器，镜像为 `opensandbox/server@sha256:07f9b39adb8cadf68357dd1b86367068210e960fc4cb50e11b75176387557ea7`。容器内 `/app/opensandbox_server/api/lifecycle.py` 的创建接口将 `X-Request-ID` 描述为追踪标识，并将请求交给服务；Docker 后端 `/app/opensandbox_server/services/docker/docker_service.py` 的 `_prepare_creation_context` 每次调用 `generate_sandbox_id()`，`create_sandbox` 在独立线程中执行实际创建并等待结果。现有源码观察未发现客户端提供的创建幂等标识或可以证明创建已终止的操作回执；这不是对其他后端或未来版本的判断。独立线程意味着客户端断开不能作为线程停止的证据。

Docker 后端列表先获取容器摘要再分别 inspect，期间被删除的容器会被跳过，结果再按创建时间排序和分页。不同页请求之间可发生变化，不能将一次多页列表当作具备快照一致性的完成证明。此项为源码分析，尚未做并发一致性或终止契约的真实协议验证；租户隔离与服务端可能存在的其他控制机制仍需调查。

2026-11-19 本地安全机制已补充持久化未发送证明。`AttemptRecord.sandboxCreateEvidence` 可保存版本化标记 `adapter-confirmed-unsent-v1`，只有适配器明确抛出 `SandboxCreateUnsentError` 时 RuntimeService 才会写入。重试执行器只在标记存在且远端标识均为空时允许创建重试；旧 attempt 缺少标记时保持 `UNKNOWN / RECOVERY_REQUIRED`，不会根据状态码和空 ID 推断请求未发送。创建审计脚本也会区分有证明、历史无证明和字段矛盾的记录。OpenSandbox SDK 创建调用目前没有提供可证明请求尚未发出的阶段回执，因此不能从普通网络错误、超时或 HTTP 异常生成该证明。

新增受控回归 `tests/workflow/retry-executor.test.ts`：模拟创建响应超时但远端工作继续，先观察无资源、关闭并重开 SQLite，再让资源出现；核对恢复、重试、取消及人工清理后原 attempt 仍为 `UNKNOWN / SANDBOX_CREATE_UNKNOWN`，run 保持 `RECOVERY_REQUIRED`，没有再次创建或执行代码。另覆盖删除历史记录上的未发送标记后重开数据库不会再次创建沙箱，以及有明确未发送证明的创建失败仍可按策略重试。测试使用真实 RuntimeService 和 SQLite、受控沙箱与预算替身；不验证实际远端列表、服务端取消或任何自动发现能力。历史 `node scripts/check.mjs` 记录为 715 项测试通过、12 项跳过；后续当前工作树完整本地检查为 728 项通过，仍不代表真实服务验收。

## 尚未具备的恢复契约

1. 对未来支持未知结果恢复的适配器，本地需在发送之前原子持久化独立的 `creationId`、runId、attemptId、服务端/租户身份、创建配置指纹及状态，并将 `creationId` 随请求写入服务端 metadata。当前的 `adapter-confirmed-unsent-v1` 仅证明特定创建尝试没有发送，不能标识或恢复已发送请求。身份不能只存在于进程内；历史 attempt 不得补造这个身份。
2. 提供服务端保证的请求幂等及终止协议：相同 `creationId` 至多关联一个创建操作，查询可区分处理中、已完成和明确终止；明确终止必须保证以后不会再创建。若服务端不能保证，维持 `UNKNOWN`，不能通过轮询次数或等待时间自动推断终止。客户端超时或取消不是服务端终止证明。
3. 发现时严格校验服务端/租户、项目、runId、creationId 和预期配置身份；完整处理分页、权限及查询错误。冲突、多匹配、缺失标签、服务端重建或一致性未知都进入人工调查，不能自动接管或删除。metadata 不是认证信息，存在伪造或修改可能，不能单独作为授权依据。
4. 只有确认请求已稳定终止、资源归属及最终状态可证明，且预算、deadline、checkpoint 和其他未决执行均满足现有约束，才能通过带版本检查的事务记录核对证据并解除对应阻断。核对期间有并发写入或版本变化时必须重新检查。明确的服务端未创建证明与已创建资源的终止证明是不同证据。
5. 历史记录按旧身份和证据单独调查：即使查询到候选资源，也不能把它自动归到某个旧 attempt；没有足够证据时保留未解决状态和调查记录。终态任务的历史资源审计是独立操作，不等同于恢复任务。

## 验证任务

- [ ] 检查实际部署的服务端版本与 API/实现，确认是否支持创建幂等、可查询的创建请求身份、终止证明、列表一致性与租户隔离；记录源码位置或实际协议证据。若缺失，明确外部依赖，保持现有阻断。
- [ ] 用受控服务构造响应丢失后晚到创建、重复响应、跨页变化、多匹配、标签被修改、权限错误、进程重启及并发核对，验证不得提前解除阻断或误删资源。
- [ ] 若服务端具备所需保证，先实现持久 creationId 和只读发现，再实现证据校验与事务状态变更；测试同一 ID 重放、跨 run/租户拒绝、崩溃窗口和旧数据库兼容。
- [ ] 在隔离环境验证真实服务端保证及清理语义；记录部署配置、操作 ID、结果和限制。测试端注入只能证明该场景的处理，不能推断自然故障频率。

## 2026-11-19 真实创建契约探针

新增入口 `spikes/sandbox-smoke/run-creation-contract-docker.ps1`，报告 `.runtime/sandbox-smoke/creation-contract-smoke.json`。本次针对唯一 `contractRun` metadata 在真实 Docker OpenSandbox 1.2.1 服务上执行两次创建、分页发现、重复删除和一次客户端取消创建。

- 相同 metadata 产生两个不同 sandbox ID，说明 metadata 只是发现标签，当前部署没有观察到按 metadata 去重。
- 两个 sandbox 均可通过 metadata 过滤发现，逐个删除后新 SDK 查询均为 404，重复删除返回 404。这里验证了本次 ID 的删除后观察，不代表 API 文档保证删除请求本身幂等。
- `Sandbox.create` 的 `AbortSignal` 在客户端取消创建，随后有界 metadata 查询未发现匹配资源。报告仍将 `serverTerminationConfirmed=false`，因为 SDK 和当前服务没有提供创建线程的终止回执，也不能由一次空列表证明以后不会晚到创建。

因此本次探针关闭“当前 deployment 可按唯一 metadata 发现并按 ID 清理”的观察项，保留创建幂等和创建终止契约阻断。不能把两次重复创建的不同 ID 写成服务端幂等结论。


## 2026-11-19 真实创建响应丢失探针

新增 `spikes/sandbox-smoke/create-response-loss-smoke.ts`，通过 `run-runtime-service-docker.ps1 -Scenario create-response-loss` 运行。真实 OpenSandbox 创建请求返回 HTTP 202 后，由本地代理读取本次响应的 sandbox ID 并断开客户端连接。独立 SDK 查询该 ID，核对 `project` 和唯一 `runId`，确认本次创建成功。

RuntimeService 将唯一 attempt 持久化为 `UNKNOWN / SANDBOX_CREATE_UNKNOWN`，run 为 `RECOVERY_REQUIRED`，未记录 sandboxId 或 executionId。调用恢复、继续、结束、重复执行和取消后仍保持阻断，代理只观察到一次创建请求。关闭并重开 SQLite 后再次通过上述检查。按捕获的唯一 ID 删除资源并由独立 SDK 查询到 404 后，原 attempt 仍保持未知，重复执行仍被阻断。清理只针对本次从成功响应捕获的 ID。

报告为 `.runtime/sandbox-smoke/create-response-loss-d3f9ff53f3484d24a8e5d69fc5f531b3.json`，SHA-256 为 `488154012b8764beef1cb55dfd78dd8128c4733e178995e34ae9f4a2c1663280`。独立严格 TypeScript 检查通过，`tests/workflow/retry-executor.test.ts` 的 34 项通过。使用 FakeBudget，无模型调用。响应丢失由本地代理受控注入，SQLite 重开发生在同一进程，不能作为宿主崩溃、真实预算账本恢复、服务端幂等或创建终止回执的证据。单次删除和 404 仍不足以解除未知创建阻断。

## 2026-11-19 创建响应窗口的进程终止探针准备

新增 `spikes/sandbox-smoke/create-process-crash-smoke.ts`，通过 `run-runtime-service-docker.ps1 -Scenario create-process-crash` 运行。独立 worker 发起真实创建请求，父进程代理在接收成功响应后暂存响应并核对 sandbox 的 project/runId，再对 worker 发送 SIGKILL。父进程重开 SQLite，检查原 CREATED attempt 恢复为 `UNKNOWN / SANDBOX_CREATE_UNKNOWN`，run 进入 `RECOVERY_REQUIRED`，重复执行、继续和结束被阻断，取消仍保持恢复状态，且只观察到一次创建请求和零个 execution ID。清理仅针对本次响应捕获且核对 metadata 的 ID，并检查删除后的 404 与恢复阻断。

该探针已通过独立严格 TypeScript 检查，创建重试相关的 34 项本地回归通过。当前执行环境没有 `OPEN_SANDBOX_API_KEY`，尚未运行真实服务验收，不能将预期行为作为结果。若创建超时且未捕获响应 ID，报告保留 runId 用于调查可能仍在服务端进行的创建。探针使用 FakeBudget 和客户端受控响应窗口，worker 进程强杀不代表物理宿主崩溃，也无法证明服务端创建幂等或终止契约。
