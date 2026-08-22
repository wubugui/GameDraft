---
target: coordinate-spaces
date: 2026-08-21
session: 运行时编辑模式 v1（在真实画面里摆灯）
---

# 「灯的作者面」不是场景坐标那一行 —— 原点在画面中心、Y 朝上

- **现象**：卡里的总表把「灯的作者面」列在 **场景坐标(世界空间)** 那一行，
  而那一行写着"原点 = 画布左上"。照这行去把 `light.pos` 当 NPC 坐标用，摆出来的灯
  会整体偏掉半张图，而且不报任何错。
- **实情**：`packLights`（`src/rendering/lighting/lightPacking.ts`）对 `pos` **只乘
  `quPerWu`，不挪原点、不翻 Y**。也就是说灯的 frame = 伪世界 q 转个朝向（R）再换把尺，
  **原点在画面中心、Y 朝上、Z 是纵深**。与 NPC/热区/spawn 只共用 wu 这把尺（角色高 150 wu），
  不共用原点与朝向。实测雾津街头：`scene_x = 2000 + pos[0]`（世界宽 4000 ⇒ 原点在正中）。
- **建议改法**：总表里给灯单开一行（或在那一行注明"只共用单位，不共用原点/朝向"），
  并把换算写清楚：`场景 wu →(work px, meta.cal)→ q →(×R×wuPerQUnit)→ 灯世界`。
  两个方向的现成实现在 `src/authoring/lightSpace.ts`（含单测），运行时既有的同一条链
  在 `Game.getPlayerLightWorld` + `CharacterLightingSystem.chestQAt`——本次实测两者逐位相等。

## 顺带两条同域的实测（都不报错，只是效果不对）

- **「深度恒定的一片」不是世界里的水平地面**。45° 视角下它是斜面。所以"把灯投影到屏幕、
  在落点采一下地面"算出来的离地高度是错的：抬高 300 wu，估出来的地面跟着爬 150 wu，
  高度读数只剩一半且越拖越飘。正解是解 `world(q).x/z == 灯的 x/z` 且 `q.z == ground(q.xy)`，
  **迭代必须带阻尼**（真·水平地面上 `∂d/∂qy` 恰好是 1，裸迭代在两个值之间来回跳，
  偶数次迭代正好跳回出发点）。
- **两套像素栅格在这条链上的分工**：运行时侧（`chestQAt` / `driveFilter` / 地面场）全在
  **work + `meta.cal`**；桌面编辑器 `tools/editor/editors/scene_lights.py` 用的是
  **native + `depthConfig.M`**。各自自洽，抄错一边只是位置差一截。
