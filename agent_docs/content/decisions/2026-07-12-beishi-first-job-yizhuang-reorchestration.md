---
id: beishi-first-job-yizhuang-reorchestration
title: 背尸第一单重排(义庄拦活取代工头派活)
domain: content
type: decision
summary: 第一单(路倒)=自由空挡→打哈欠找活→义庄门口被拦接活→自己找尸→背回;工头改为路倒交付后专职派淹尸单;取代旧"工头顺序派两尸"编排
status: active
triggers:
  topics: [背尸, 第一单, 路倒, 义庄, 找活, 零工, 淹尸]
last_governed: 2026-07-13
---

## 背景(一段)

2026-06-22 决策([beishi-mundane-eerie-redesign](2026-06-22-beishi-mundane-eerie-redesign.md))
定下"混子糊口铺垫→阿秀逐拍崩坏"的反差结构,当时第一单实现为零工工头顺序派两具普通尸。
2026-07-12 策划重排第一单开场(会话:背尸第一单重排),强化"日常基线"意图:玩家先有
自由空挡、自己起意找活,而非被动等派活。策划口中"淹尸"实指工头后续派的单,第一单=路倒。

## 决定(一句)

第一单(路倒)编排 = **正常位面自由空挡 → 打哈欠起意找活(信号 beishi_lg_seek → 新
looking 态)→ 义庄门口被老汉拦下接活 → 自己找尸 → 背回**;零工工头改为只在路倒交付后
(delivered 门闸)专职派淹尸单。

落点:narrative_graphs.json beishi_lingong_flow(looking / beishi_lg_seek)、新对话
寻狗_找活 / 寻狗_义庄门口拦活、雾津街头.json(工头门闸改 delivered、T_去义庄 加 looking、
加 hs_找活_起意)、义庄.json(加 npc_义庄门口拦活)、quests.json 描述;已过
validate-data 零 error。已知待办:自由空挡内容(走访见闻/微型任务)待填。

## 被否方案(列表,防翻案)

- 旧编排"先经零工工头顺序背两具普通尸、工头派活"——被本重排取代("混子糊口铺垫
  日常基线"意图保留且强化)。
- 母决策其余内容(反差结构、阿秀段增量崩坏及其被否清单)不受本决策影响,仍以旧卡为准。
