---
target: scene-onenter-reveal-timing
date: 2026-07-16
session: 开场NPC刷屏修复
---

现象: 卡里 seam 写"初始进场/dev/reload 不传 onReveal(本就无遮罩)"，但玩家进场恰恰因**无遮罩**在可见画布上看着背景/NPC 逐个刷出来（尤其首启贴图未命中缓存），茶馆开场即此症。
证据: 修前 loadScene START teahouse onReveal=false → 4 个 NPC 边可见边 instantiate；已加 `SceneManager.loadInitialScene`（遮罩 alpha=1 起手 + onReveal=fadeIn(400)），Game.ts 首场景改走它，实测揭幕即完整、无刷屏（src/systems/SceneManager.ts、src/core/Game.ts）。
建议: 卡里把"初始进场无遮罩"更正为"初始进场也要遮罩装载后揭幕，只是无前场景可淡出、instant 置黑起手"；dev/reload 仍可无遮罩（要即时）。
