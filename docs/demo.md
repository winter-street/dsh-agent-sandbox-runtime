# 一次真实任务演示

在仓库根目录安装锁定依赖、构建预算插件并填写 `.env.local`。确认 OpenSandbox 服务监听 `127.0.0.1:8090`。演示默认使用 `config/eval-finalize.json`。详见 [依赖和预算插件](../integrations/budget/README.md) 与 [沙箱环境](environment.md)。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-demo.ps1
```

入口读取仓库合成 `normal.csv`，使用真实 DeepSeek Harness、原预算插件和 OpenSandbox，独立校验统计、报告和 SVG，生成新的 `.runtime/demo-日期时间-随机后缀/`。不会获得 expected.json 或参考实现，也不计入正式评测覆盖。

打开该目录中的 `delivery/report.md`、`delivery/chart.svg` 和 `delivery/statistics.json` 即可查看或复制交付。`demo.json` 保存状态、独立验证、预算快照和产物哈希；`trace.json` 与 `ledger.json` 保存过程和逐调用回执。原始运行数据保存在 application 子目录。目录已存在则拒绝覆盖；失败保留证据，不自动重试。

`-CheckOnly` 检查两个服务密钥变量、三个固定评测配置路径、fixture 和输出目录可用性。它不会验证密钥有效性或请求服务。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-demo.ps1 -CheckOnly
```

单次成功演示不能代替真实中断恢复、provider 断流矩阵、长任务或完整 G1/G5 验收。浏览器 API 的交互验收单独记录，演示入口交付的是可直接打开的本地文件。

## 干净源目录复现

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-clean-reproduction.ps1
```

默认将公开源码复制到全新忽略目录，以本地 Git 对象检出预算插件固定基线并重放补丁；不复制 `.env.local`、历史运行数据、现成 node_modules 或预算插件工作树。依赖从本机 pnpm store 锁定安装，然后执行插件和运行时完整检查。缺缓存时加 `-Online`。没有删除/覆盖已有目录或调用真实模型/沙箱。

结果写入复现目录 `reproduction.json`，`source-manifest.json` 记录快照中每个文件的 SHA-256。复现会临时移除继承的服务密钥，并启用本地预算集成测试。范围是同一 Windows 主机上的独立源目录和依赖目录，复用 Node/Python、本地预算 Git 对象和 pnpm 缓存。沙箱部署见 [沙箱环境](environment.md)。
