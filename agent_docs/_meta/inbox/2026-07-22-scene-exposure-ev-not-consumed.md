---
target: scene-radiance-restoration-pipeline
date: 2026-07-22
session: 角色着色与阴影系统通读
---

现象: 决策要求 sceneExposureEV 乘入线性基础辐射，但当前 character_lighting_lab 的 ev 只进入参数/界面与 manifest，stage_hdr 未读取 P['ev']，调节「场景EV」不会改变烘焙辐射。
证据: tools/character_lighting_lab/pipeline.py:321-363；仓库 rg "\\['ev'\\]" 在计算路径无命中，viewer/index.html 仍宣称该参数影响辐射度绝对水平。
建议: 治理时将其列为实现缺口；修复应在 base/emit 分账前统一应用 2^EV，并增加不同 EV 导出数值变化的回归检查。
