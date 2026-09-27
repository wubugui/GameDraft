---
target: engine2d
date: 2026-09-28
session: wt/wbkit 工作台 Qt 宿主切 WebView2 / 燃烧自检在 dpr 1.24 下红
---

现象: 按屏幕位置取东西的滤镜(燃烧材质、DepthOcclusionFilter、EntityLightingFilter、CharacterShadingFilter)都拿 `aPosition*uOutputFrame.zw + uOutputFrame.xy` 当屏幕坐标,照 Pixi 这式子只在链的最后一道成立、中间几道 xy = 0;热点挂着燃烧时链是 [密度, 材质, 深度/受光, 自发光],材质与深度/受光都在中间——焦黑/烧没随相机走位或整块没了、遮挡与受光取错位置。master(Pixi WebGL)同样如此。
证据: 页内调试滤镜实测中间一道 vScreenPos = 屏幕坐标 − bounds 左上;燃烧工作台自检 S7 三条在 WebView2(dpr 1.24)里「只挂材质那一道」就对、链中间就错,记 KNOWN(`tools/burn_workbench/tests/test_selftest.py` 的 `_KNOWN_S7`);修复 + 回归在本地分支 `wt/burnfix`(引擎钩子 `filterPassOrigin` 已在主分支)。
建议: 本分支须与 master 一致,不改;报制作人定是否两边一起修。修的话燃烧材质照 wt/burnfix,深度遮挡 / 受光滤镜挂着燃烧时同一个钩子补;修完删掉 `_KNOWN_S7`。
