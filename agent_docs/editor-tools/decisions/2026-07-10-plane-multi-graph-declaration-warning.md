---
id: plane-multi-graph-declaration-warning
title: 位面被多图点名的校验口径
domain: editor-tools
type: decision
summary: 同一位面被多张叙事图点名完全合法不报;仅多图点名不同位面才 warning;勿回退成"全局唯一"error
status: active
triggers:
  topics: [位面校验, 多图点名, validate-data]
last_governed: 2026-07-11
---

## 背景(一段)

叙事模板的核心用例是"每单任务一张图、共用同一 archetype 位面"——多张图点名同一位面是设计常态,运行时按最后进入状态派生、无歧义。此前位面迭代曾把"位面被多于一张图声明"升成 error 且不按位面分组,直接判死模板用例;2026-07-10 制作人拍板纠正(落在 `tools/editor/validator.py` `_validate_planes` 的 plane_declaring_graphs 分组逻辑)。

## 决定(一句)

同一位面被多张图点名 = 完全合法、不报;只有多张图点名了**不同**位面才 warning(后进者胜兜底,提醒确认互斥)。

## 被否方案(列表,防翻案)

- "位面声明全局唯一"error(不分组、多于一图即错)——判死模板共用 archetype 位面的核心用例,已明确否决,勿再回退。
