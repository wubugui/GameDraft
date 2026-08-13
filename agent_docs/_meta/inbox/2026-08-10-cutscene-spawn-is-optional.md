---
target: cutscene-step-semantics
date: 2026-08-10
session: 过场出生点应该可选
---

现象: 过场的 targetScene/targetSpawnPoint 本来就都可选（不跨场景且没写 spawn/targetX,Y 时
玩家与镜头一动不动＝就地开演，27 段里 18 段就这么用），但编辑器把空值显示成
「默认 (spawnPoint)」、清空又只能靠打开弹窗选第一行 → 策划读成必填，来问"能不能不指定"。
证据: src/systems/CutsceneManager.ts saveAndTransitionReturningCrossScene（跨场景才落人，
同场景仅在写了 targetSpawnPoint 时才搬玩家）；修后表单标「（可选）」+「清除」按钮 +
空值显示「不指定：就地开演」，弹窗空行文案由调用方给（switchScene 仍是「默认（spawnPoint）」，
两者语义本就不同）；护栏 tools/editor/tests/test_cutscene_spawn_optional.py。
建议: 卡里补一句「过场入场三态：不写=就地开演 / 写 spawn=搬人搬镜头 / 跨场景必落人（空则目标场景默认出生点），
targetX,Y 覆盖 spawn」——这是策划最常误解的一处。
