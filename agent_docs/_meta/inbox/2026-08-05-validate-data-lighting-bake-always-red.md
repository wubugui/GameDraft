---
target: asset-pipeline-norms
date: 2026-08-05
session: 图对话编辑器 GUI 专项审查（跑收尾门时发现 error 通道被噪音占满）
---

# validate-data 的 lighting-bake 门常红（84 error）

- **现象**：`./dev.sh validate-data` 稳定 84 error，全是同一类：
  `[lighting-bake] scenes/<场景>/lighting: atlas_l1.bin 尺寸 53760 != 期望 215040（probe 网格不匹配）`。
  28 个场景 × 3 个文件，期望值恒为实际的 **4 倍**。
- **根因方向**：期望值公式在 `tools/editor/validate.py:107-109`（`pn*4*4*4*2`，注释"列块
  [base+cov|amb|emit|nee]"），blame 是 b978386（2026-07-23）；而烘焙产物（DVC 管、
  2026-07-25 生成）按另一套布局写。校验器口径与实际烘焙差一个列块维度。
- **影响**：error 通道被 84 条噪音占满，新引入的 error 极易被淹没——这道门现在无法区分
  "新数据坏了"和"老噪音"。2026-08-05 那轮验证只能靠逐条确认"lighting 之外的 error 为 0"。
