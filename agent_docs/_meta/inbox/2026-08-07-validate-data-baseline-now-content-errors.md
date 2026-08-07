---
target: asset-pipeline-norms
date: 2026-08-07
session: signal-xref editor commit verification
---

现象: `./dev.sh validate-data` 当前稳定报告 85 error、309 warning，且没有任何 `[lighting-bake]` 条目；原记录「84 条 lighting-bake 噪音」已与实际不符。
证据: 校验输出的 error 全为 dialogueGraph 内容引用/空参数问题，首条为 `后巷_棺材铺交互` 的 contextState graphId 不允许读取。
建议: 治理 run 更新 validate-data 基线及分流策略；在此之前提交技术工具改动时，不能把这 85 条误归因为 lighting-bake。
