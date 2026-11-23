# 校园设备告警分析

只使用本次附带的 `input.csv`。首先校验数据，再输出 `statistics.json`、一个可以查看的时段分布图，以及 `report.md`。不读取参考答案、验证脚本或其他任务输入。

统计规则：

- 时间必须有时区；转换为 UTC+08:00，再分为 `00-05`、`06-11`、`12-17`、`18-23` 四段。
- 每个设备按告警总量降序排列，同量时按 device_id 升序。
- 误报率为 `rejected / (confirmed + rejected)`，保留六位小数；pending 不计入分母，分母为零则输出 null。
- review_state 空值当作 pending，severity 空值当作 unknown。必需列为 alert_id、device_id、occurred_at、severity、review_state。
- 缺列返回 `{"error":"MISSING_COLUMN"}`；无效或无时区时间返回 `{"error":"INVALID_TIMESTAMP"}`；空 alert_id/device_id 或重复 alert_id 返回 `{"error":"INVALID_ID"}`；未知枚举返回 `{"error":"INVALID_ENUM"}`。错误输入只需输出上述 JSON，不生成伪分析。
- 有效空数据也输出零统计与 null 误报率，并说明没有数据。

正常 JSON 的字段为 total_alerts、confirmed、rejected、pending、false_positive_rate、devices（数组元素包括 device_id/total/confirmed）、time_bands（上述四段）、severity（high/medium/low/unknown）。每个键均需出现，数据类型与含义一致。

报告应说明口径、对应统计的数字结论与限制；图表应对应四段统计。不得以脚本退出码代替正确性验收，也不得虚构不存在的趋势。
