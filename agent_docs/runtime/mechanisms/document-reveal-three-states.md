---
id: document-reveal-three-states
title: 文档揭示是「一个入口三态」,且自己一张显示层
domain: runtime
type: mechanism
summary: revealDocument 三态(条件不满足出模糊图/未揭示播动画/已揭示瞬时出清晰图)+force 只跳条件;显示层键是 documentId、与叠图句柄两张表永不互访;收图走 hideDocument
status: active
authority:
  - src/systems/DocumentRevealManager.ts#checkAndReveal
  - src/rendering/CutsceneRenderer.ts#documentLayers
  - src/core/ActionRegistry.ts
triggers:
  paths: ["src/systems/DocumentRevealManager.ts", "public/assets/data/document_reveals.json"]
  topics: [文档揭示, 告示, revealDocument, hideDocument, 揭示动画, force]
  tasks: [改文档揭示, 加揭示条目, 让揭示的图消失]
verified_by:
  - src/systems/DocumentRevealManager.test.ts
  - tools/editor/tests/test_document_reveal_actions.py
last_governed: 2026-09-12
---

## 是什么(一句话)

一份文书两张图(揭示前/揭示后)。作者只发 `revealDocument`,**该显示哪张由管理器判**;
`hideDocument` 收图。作者从不接触任何"图层句柄"。

## 三态(2026-09-12 制作人定调)

| 状态 | 行为 |
|---|---|
| `revealCondition` 不满足 | 显示 `blurredImagePath`。不记档、不写 flag、不响音效、不发 `document:revealed` |
| 满足且未揭示 | 播叠化动画;完成后 `revealed.add` + 写 `revealedFlag` + 响揭示音效 + 发事件 |
| 已揭示 | 瞬时显示 `clearImagePath`。**不重播、不响音效、不发事件** |

- `force: true` **只跳过条件判定**:未揭示的照样播动画(照样记档/写 flag/响音效),已揭示的照样瞬时出清晰图。
- 同态重复触发幂等(重贴同一张,不重叠化)。`revealing` 在途时后到的请求直接忽略。
- 「已揭示」是**存档级**状态(`serialize(): { revealed: [...] }`),重进游戏保持清晰。

## 显示层与叠图解耦

- `CutsceneRenderer` 有**两张**登记表:`images`(叠图动作的作者句柄)与 `documentLayers`
  (键 **documentId**)。两者永不互访——`hideOverlayImage` 收不到文档揭示,反之亦然。
- 二者共用 `opEpoch` 与 `cleanup()`:换场景 / 过场中断 / 读档时 **两张表都要清**
  (`cleanup` 里逐键 `hideDocumentLayer`,漏掉就是上一场的告示挂在覆盖层上)。
- `DocumentRevealDef.overlayId` 自此**运行时忽略**(兼容字段,老数据保留、编辑器不给入口)。

## 已知坑(都不报错,只是画面不对)

- **三态曾只实现中间一态**:另两态直接 `return`。于是"条件没到"与"已揭示后收过图"
  在画面上都是一片空白;作者第一次揭示完把图收掉,这条揭示就**永久再也显示不出来**
  (2026-09-12 真机踩到,`revealDocument` 第二次触发什么都不显示)。
- `getDisplayImage` / `getDocumentPhase` 长期**零消费者**——"已揭示就该显示清晰图"这半边
  从来没接上过,唯一把图放上屏的是那一次性叠化(叠完保留目标图,原设计指望它一直留着)。
  改这块前先确认这两个 API 有没有真被用上,别照着"看起来有设计"去推断。
- 曾让作者手填句柄收图(`hideOverlayImage` + `overlayId`):句柄与"哪份文书"零关系,
  编辑器下拉还一度把展示串当取值存进 JSON,运行时找不到图层、收不掉、**无人报错**。

## 怎么验证

`revealDocument` → `hideDocument` → 再 `revealDocument`,第三步必须直接出清晰图;
条件不满足时必须出模糊图(不是空白);用同名 `hideOverlayImage` 必须收不掉这层。
