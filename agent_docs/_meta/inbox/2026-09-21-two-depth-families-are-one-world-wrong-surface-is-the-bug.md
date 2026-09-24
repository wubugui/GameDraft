---
target: coordinate-spaces
date: 2026-09-21
session: 法宝「窥夜」窗户世界 · 实体着色排障
---

现象: 库里（与我自己在 `windowWorld/windowWorldCone.ts` 里抄的）把 `depth_map` 与 `ground_d` 当成两个「同量纲只靠烘焙保证」的深度族，暗示两者给出的世界位置可能整体不一致。实测不是这样：雾津街头同一批脚点，两者解出来的 M-world **X 完全相同（差 0）**，Y/Z 在未被遮挡处相差 ≤9 wu（场景横跨 ~1800 wu，<1%）。真正的坑是**问错了面**——`depth_map` 答的是"这个像素上画的那个东西有多远"，站在屋檐 / 灯笼 / 招牌像素底下的实体会被判到屋檐上：13 人的送葬队伍里 3 人的深度落在遮挡物上（Y 偏 +55 / +138 / +179 wu），其中 2 人因此被楔形判到界外、整只不显示，零报错。
证据: 真跑游戏（`?mode=dev`，雾津街头/午，窗看夜），逐只对比 `uvToWorldWu(depth_map)` 与 `chestQAt(x,y,0)→qToWorldWu(ground_d)`；10/13 两者一致到 <1%，3/13 落在遮挡物上。修法：背景逐像素继续读 `depth_map`（对的），实体与楔形顶点改读行走面。
建议: `coordinate-spaces.md` 那段「两个深度族」的措辞值得补一句判据——**按"要问哪张面"选，不是按"哪个族安全"选**：要"这个屏幕位置上画的东西"用 `depth_map`，要"这个屏幕位置的地"用 `ground_d`。另附一条相邻的静默陷阱：`CharacterLightingSystem.applyLights` 在 `shadowBasis` 未注入时**不报错**，把灯存进 `pendingLights` 后按"没有灯"喂进去，等 `setShadowBasis` 重放；主场景的重放由 `rebuildEntityShadows` 触发，不建投影阴影的第二实例（窗户世界）那次重放永远不来，于是角色只剩 probe 底光——日志只有一行"暂缓"，画面只是"暗了三成"。
