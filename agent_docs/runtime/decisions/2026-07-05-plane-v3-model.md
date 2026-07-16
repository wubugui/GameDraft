---
id: plane-v3-model
title: 位面基建 v3 模型拍板
domain: runtime
type: decision
summary: 位面=全局一等资产+实体归属+叙事只点名+对账器重派生;v1(绑任务图)/v2(实体变体表)/接管式小游戏均被否
status: active
triggers:
  topics: [位面, plane, v3]
last_governed: 2026-07-11
---

## 背景(一段)

制作人要借背尸玩法造"位面"基建:同场景、玩法规则全变、可配置、精确恢复。2026-07-05 制作人拍板 v3,2026-07-07 实装过全部门禁与真机五断言。工业参照:v3≈UE5 Data Layers+Lyra Experience 合体,恢复用重派生(比两家都稳)。

## 决定(一句)

位面是全局注册的一等资产(archetype 级,normal 也是位面),实体带归属标,位面自身携带全部系统性调整,叙事图只在状态上点名激活位面,`PlaneReconciler` 从叙事状态派生一切并在每个边界重派生、零自持久化(机制细节见 [plane-system](../mechanisms/plane-system.md))。

## 被否方案(防翻案)

- **v1 绑定挂任务图里**:实体配置散进 N 张任务图+叙事层带行为——制作人明确否。
- **v2 实体带位面覆盖/变体表**:要合并语义、偏重——被 v3"存在即配置"(同位置两个实例各归各位面)取代。
- **接管式小游戏(仿 waterMinigame)承载背尸**:背尸是任务态不是小游戏,玩家继续在世界里活动——被否。
- **命令式 activatePlane/deactivatePlane 当主路径**:治"老滚 stage 脚本漏切坏档"病,动作只当逃生舱,主路径=叙事点名。
