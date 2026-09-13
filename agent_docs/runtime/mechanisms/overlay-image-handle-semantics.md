---
id: overlay-image-handle-semantics
title: 叠图动作 id=句柄、image 才是图引用
domain: runtime
type: mechanism
summary: show/blend/hideOverlayImage 的 id 是图层实例句柄;引用 overlay_images.json 的是 image/fromImage/toImage;校验别搞反。文档揭示 2026-09-12 已与这套解耦,不再有句柄
status: active
authority:
  - src/core/ActionRegistry.ts
  - src/systems/DocumentRevealManager.ts
  - src/core/Game.ts#resolveOverlayImageIdToPath
triggers:
  paths: ["public/assets/data/overlay_images.json", "src/systems/DocumentRevealManager.ts"]
  topics: [叠图, overlay, showOverlayImage, blendOverlayImage, 文档揭示, revealDocument, hideDocument]
last_governed: 2026-09-12
---

## 是什么(一句话)

叠图动作参数的两种身份:`id` = **图层实例句柄**(供后续 hide 寻址,可任意命名,与
`overlay_images.json` 无关);真正引用注册表短 id 的是 `image`(show)/ `fromImage`+`toImage`(blend)。

## 权威源(读代码从哪进)

`ActionRegistry.ts` 的 show/blend/hideOverlayImage 注册处;短 id → 路径的解析在
`Game.resolveOverlayImageIdToPath`(以 `/` 开头当完整路径)。

## 硬契约(违反即 bug)

- 校验叠图引用存在性只校 `image` / `fromImage` / `toImage`,**不校 `id`**
  ——运行时校验与编辑器校验历史上都把这点搞反过(2026-06 已修),改校验时别复发。
- **文档揭示不在这套里(2026-09-12 制作人定调解耦)**:它自己一张登记表
  (`CutsceneRenderer.documentLayers`,键是 **documentId**),由 `revealDocument` / `hideDocument`
  按 documentId 收发。`DocumentRevealDef.overlayId` 已**降级为运行时忽略的兼容字段**
  (老数据保留、编辑器不再给入口),别再把它当句柄读。两张表**永不互访**:
  `hideOverlayImage` 收不到文档揭示,反之亦然。
- 踩过的两脚(都不报错、只是画面不对):① 编辑器下拉把「文档揭示 X」这个**展示串**当取值
  存进了 JSON 的 `hideOverlayImage.id`,运行时找不到图层,收不掉;② 让作者去填句柄这件事
  本身就是把内部寻址抬成作者面——句柄与"哪份文书"零关系,写错无人拦。

## 怎么验证

写一条 show→hide 同句柄链真跑;给 `image` 填不存在的短 id 应被 `validate-data` 咬住,
给 `id` 填任意名不应报错。文档揭示那条另测:`revealDocument` → `hideDocument` → 再
`revealDocument`,第三步必须**直接出清晰图**(三态见
[document-reveal-three-states](document-reveal-three-states.md));
同时用一条同名 `hideOverlayImage` 打过去,必须**收不掉**文档揭示那层。
