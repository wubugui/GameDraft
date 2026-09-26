---
target: background-sway
date: 2026-09-26
session: 场景前景图层基建(跑马梁歪脖子树)
---

现象: 卡与 backgroundSway.ts 头注释说"每株的位移压在补带的 80% 以内(软封顶)",但软封顶约束的是转角 × 株长(theta ≤ cap/reach),投到画面上经直立面雅可比会放大:跑马梁那棵树增益 1、阵风 ×4 时网格顶点最大位移 43.8 wu,封顶 38.4(1.14 倍,仍在补带 48 以内)。
证据: 页内逐帧读 SwayBackground.instanceDisplacement(1) 与 displacementCap(2026-09-26 跑马梁夜);前景层因此改按顶点真实位移铺网格(见 scene-foreground-layers)。
建议: 卡里"位移软封顶"那条注明它不是画面位移的严格上界;若要"露出的只可能是补过的带"成立,补带宽要按真实位移留余量,或把封顶改成按画面位移算。
