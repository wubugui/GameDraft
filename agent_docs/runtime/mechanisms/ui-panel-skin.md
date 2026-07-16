---
id: ui-panel-skin
title: UI 面板皮肤单一入口
domain: runtime
type: mechanism
summary: 全部面板底/边走 PanelSkin.drawPanelBase + SKINS;改观感只动 PanelSkin.ts 一处,禁止在面板里复制 fill+stroke
status: active
authority:
  - src/ui/PanelSkin.ts#drawPanelBase
  - src/ui/UITheme.ts
triggers:
  paths: ["src/ui/PanelSkin.ts", "src/ui/UITheme.ts", "src/ui/*UI.ts"]
  topics: [面板皮肤, UI 观感, PanelSkin]
last_governed: 2026-07-11
---

## 是什么(一句话)

运行时 20+ 个 Pixi 面板的底色+边框统一收敛到 `drawPanelBase(g,x,y,w,h,SKINS.<name>,overrides?)`;历史上 21 处复制同一段 roundRect+fill+stroke,已全部塌掉。

## 权威源(读代码从哪进)

`src/ui/PanelSkin.ts`(drawPanelBase + SKINS:dialogue/panel/menu/book/chip/toast 等);颜色常量在 `UITheme.ts`。

## 硬契约(违反即 bug)

- 新面板/新皮肤变体一律走 drawPanelBase 加 SKINS 条目,不许再手画底+边——铺满与调色解耦是这套的全部价值。
- 皮肤只管「底+边」;hover 高亮/遮罩 overlay/进度条/滑块不属于它,别往里塞。
- 纯程序化零素材(无图片九宫格、无打包字体);美学方向已拍板为民俗草根·极简,见 [2026-07-05-ui-panel-skin-direction](../decisions/2026-07-05-ui-panel-skin-direction.md)。

## 怎么验证

`npx tsc --noEmit`;命令通道 `debugInteractNpc` 拉起对话框截图对观感。
