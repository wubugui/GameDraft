---
target: vfx-system
date: 2026-09-15
session: 01a0a095-e1c4-71c2-a2fb-fa8cb8acb295
---
现象: 粒子由 simulation 显式选择出生/输入/求解/补回；薄片可接收空气速度及标签加速度，参数块存在不等于启用，工作台保存增加了同份数据的外部基线冲突检查。
证据: src/systems/vfx/vfxProgram.ts、vfxFields.ts、vfxMotionSource.ts、vfxLifecycle.ts；tools/vfx_workbench；artifact/particle-system-20260915/REVIEW.md 及逐帧、真实场景、保存测试。
建议: vfx-system / vfx-workbench 机制卡补充新契约、旧资产无写盘兼容、真实物理 wu 到 M-world 的度量边界和保存冲突语义。
