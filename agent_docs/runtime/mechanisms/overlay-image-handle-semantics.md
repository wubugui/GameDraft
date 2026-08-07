---
id: overlay-image-handle-semantics
title: 叠图动作 id=句柄、image 才是图引用
domain: runtime
type: mechanism
summary: show/blend/hideOverlayImage 的 id 是图层实例句柄;引用 overlay_images.json 的是 image/fromImage/toImage;校验别搞反
status: active
authority:
  - src/core/ActionRegistry.ts
  - src/systems/DocumentRevealManager.ts
  - src/core/Game.ts#resolveOverlayImageIdToPath
triggers:
  paths: ["public/assets/data/overlay_images.json", "src/systems/DocumentRevealManager.ts"]
  topics: [叠图, overlay, showOverlayImage, blendOverlayImage]
last_governed: 2026-08-05
---

## 是什么(一句话)

叠图动作参数的两种身份:`id` = **图层实例句柄**(供后续 hide 寻址,可任意命名,与
`overlay_images.json` 无关);真正引用注册表短 id 的是 `image`(show)/ `fromImage`+`toImage`(blend)。

## 权威源(读代码从哪进)

`ActionRegistry.ts` 的 show/blend/hideOverlayImage 注册处;短 id → 路径的解析在
`Game.resolveOverlayImageIdToPath`(以 `/` 开头当完整路径);`DocumentRevealManager.ts`
里的 `overlayId` 同为**图层句柄**,不是图引用。

## 硬契约(违反即 bug)

- 校验叠图引用存在性只校 `image` / `fromImage` / `toImage`,**不校 `id`**
  ——运行时校验与编辑器校验历史上都把这点搞反过(2026-06 已修),改校验时别复发。

## 怎么验证

写一条 show→hide 同句柄链真跑;给 `image` 填不存在的短 id 应被 `validate-data` 咬住,
给 `id` 填任意名不应报错。
