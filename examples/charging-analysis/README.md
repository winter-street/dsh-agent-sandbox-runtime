# 评测者说明

Agent 仅获得 TASK.md 和所选 CSV；expected.json、reference.py、verify.py、本说明都不进入模型上下文或沙箱输入。

冻结答案人工枚举：normal 有 10 条，D01/D02/D03/D04 分别为 4/3/2/1 条；审核为 5 confirmed、2 rejected、3 pending；时段为 3/2/2/3。reference.py 使用标准库独立复核。

运行 `python verify.py --self-test` 验证参考实现及错误拒绝；`python verify.py --fixture normal.csv --result <候选JSON>` 核对候选统计。图表可读性和报告证据属于集成验收，不能仅凭 JSON 正确宣布整个任务通过。
