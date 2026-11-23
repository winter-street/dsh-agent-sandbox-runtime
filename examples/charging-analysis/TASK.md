# 校园设备告警分析：冻结任务

所有 CSV 为手工合成数据，无真实用户记录。Agent 只获得输入 CSV 和本任务，不获得 expected.json 或 reference.py。

请校验输入，输出 `statistics.json`，给出设备告警总数排名和四个 6 小时时段的分布图，并在 `report.md` 中解释数据口径、主要结论及限制。正常数据产物至少包含统计 JSON、可查看的图表和 Markdown 报告。

必需口径：

- 时间全部转换为 UTC+08:00，再按 00–05、06–11、12–17、18–23 分段；无时区时间戳拒绝处理。
- 排名按告警总数降序，同分按 device_id 升序。
- 误报率为 rejected / (confirmed + rejected)，保留 6 位小数；pending 不进入分母，分母为 0 时输出 null 并解释。
- review_state 缺失按 pending，severity 缺失按 unknown；缺少必需列、非法时间戳、重复 alert_id 或未知枚举返回明确错误，不生成伪分析。
- 空数据允许统计为零和误报率 null，报告说明无数据，不虚构趋势。
- JSON 字段与 expected.json 中的结构一致（任务调度时由 schema 提供字段，不提供答案）；数字结论应能对应 CSV 和 JSON。

结果 JSON 包含 total_alerts、confirmed、rejected、pending、false_positive_rate、devices（device_id/total/confirmed）、time_bands（上述四个时段）、severity（high/medium/low/unknown）。不要读取参考答案或验证器内部数据。
