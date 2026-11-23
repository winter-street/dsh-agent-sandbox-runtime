# 校园设备告警分析（N05 保留集）

只使用本次附带的 `input.csv`。首先校验数据，再输出 `statistics.json`、一个可以查看的时段分布图，以及 `report.md`。不读取参考答案、验证脚本或其他任务输入。

统计规则：

- 时间必须有时区；转换为 UTC+08:00，再分为 `00-05`、`06-11`、`12-17`、`18-23` 四段。
- 每个设备按告警总量降序排列，同量时按 device_id 升序。
- 误报率为 `rejected / (confirmed + rejected)`，保留六位小数；pending 不计入分母，分母为零则输出 null。
- review_state 空值当作 pending，severity 空值当作 unknown。必需列为 alert_id、device_id、occurred_at、severity、review_state。
- 缺列返回 `{"error":"MISSING_COLUMN"}`；无效或无时区时间返回 `{"error":"INVALID_TIMESTAMP"}`；空 alert_id/device_id 或重复 alert_id 返回 `{"error":"INVALID_ID"}`；未知枚举返回 `{"error":"INVALID_ENUM"}`。错误输入只需输出上述 JSON，不生成伪分析。
- 有效空数据也输出零统计与 null 误报率，并说明没有数据。

正常输入的 `statistics.json` 顶层只包含以下八个字段：

- `total_alerts`、`confirmed`、`rejected`、`pending` 均为非负整数。
- `false_positive_rate` 为 JSON 数字或 `null`。
- `devices` 是数组。每个元素恰好包含字符串 `device_id`、整数 `total` 和整数 `confirmed`。
- `time_bands` 是对象，恰好包含 `00-05`、`06-11`、`12-17`、`18-23` 四个键。每个值直接写该时段的告警总数（整数）。
- `severity` 是对象，恰好包含 `high`、`medium`、`low`、`unknown` 四个键。每个值直接写该严重度的告警总数（整数）。

`time_bands` 和 `severity` 的每个值都是整数，零计数也要保留相应的键。编写 `report.md` 时，`devices`、`time_bands`、`severity` 三行直接序列化 `statistics.json` 对应字段的值。绘制图表时使用 `time_bands` 的四个整数值。

报告应说明口径、对应统计的数字结论与限制；图表应对应四段统计。不得以脚本退出码代替正确性验收，也不得虚构不存在的趋势。

这是 N05 的保留对照输入集。沿用上述数据口径，记录执行条件、预算和耗时，保留失败或未知结果供后续复核。
