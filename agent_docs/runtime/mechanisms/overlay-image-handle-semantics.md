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
last_governed: 2026-07-11
---

## 是什么(一句话)

叠图动作参数的两种身份:`id` = 图层实例句柄(供后续 hide/寻址,可任意命名,与 overlay_images.json 无关);真正引用 overlay_images.json 短 id 的是 `image`(show)/ `fromImage`+`toImage`(blend)。

## 权威源(读代码从哪进)

- `ActionRegistry.ts` 的 showOverlayImage/blendOverlayImage 注册处
- 解析:`Game.resolveOverlayImageIdToPath`(以 `/` 开头当完整路径,否则查 overlay_images.json)
- `DocumentRevealManager.ts` 的 overlayIdFor:`DocumentRevealDef.overlayId` 同为 blend 图层句柄(缺省 `docReveal_<id>`),**不是**图引用;模糊/清晰图走 blurredImagePath/clearImagePath 全路径

## 硬契约(违反即 bug)

- 校验 overlay_images 引用存在性要校 image/fromImage/toImage,**不校 id**(validator.py 与 narrativeGraphValidation.ts 历史上都把这点搞反过,2026-06 已修——改校验时别复发)。

## 怎么验证

写一条 show→hide 同句柄链真跑;给 image 填不存在的短 id 应被 validate-data 咬住,给 id 填任意名不应报错。
