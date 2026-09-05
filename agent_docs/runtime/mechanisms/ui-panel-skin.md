---
id: ui-panel-skin
title: UI 面板皮肤单一入口
domain: runtime
type: mechanism
summary: 面板底/边只经 PanelSkin 的 createPanel(有木框)或 drawPanelBase(只有底+细边);拿木框皮肤调 drawPanelBase 会静默丢框;「暗角」实为一层均匀黑纱,暗底配色是连着它一起量的
status: active
authority:
  - src/ui/PanelSkin.ts#createPanel
  - src/ui/PanelSkin.ts#drawPanelBase
  - src/ui/UITextures.ts
  - src/ui/UITheme.ts
  - src/ui/components/UIDecor.ts
triggers:
  paths: ["src/ui/PanelSkin.ts", "src/ui/UITheme.ts", "src/ui/UITextures.ts", "src/ui/UIIcons.ts", "src/ui/components/*.ts", "src/ui/*UI.ts"]
  topics: [面板皮肤, UI 观感, PanelSkin, 木框, 纸纹, 取景台]
last_governed: 2026-09-03
---

## 是什么(一句话)

运行时全部 Pixi 面板的**底色 + 边框 + 装饰件**收敛到 `PanelSkin` 与 `components/UIDecor`
(历史上 21 处复制同一段 roundRect+fill+stroke,已全部塌掉);
面板结构件(窗体/按钮/滚动)在它之上,见 [ui-component-layer](ui-component-layer.md)。

## 权威源(读代码从哪进)

`PanelSkin.ts` 的两个入口 + `SKINS` 注册表;设计令牌(颜色/alpha/字族/间距/字号/动效/z 序)
全在 `UITheme.ts`;贴图预载在 `UITextures.ts`,装饰件在 `components/UIDecor.ts`。

## 硬契约(违反即 bug)

- 两个入口二选一,不许再手画底+边:**面板级(要木框)走 `createPanel`**;
  **行 / 格 / 进度槽 / 需要原地 `clear()` 重画的 Graphics 走 `drawPanelBase`**。
  ⚠ 拿带 `wood` 的皮肤去调 `drawPanelBase`,**木框会静默消失**(木框是 Sprite,
  塞不进 Graphics)——这套里最容易踩的一脚。
- 皮肤只管「底 + 框 + 内金线 + 暗角」;hover 高亮 / 遮罩 / 进度条 / 滑块不属于它,
  别往里塞(各有 `UIDecor` 里的件)。
- ⚠ **「暗角」在面板尺寸下不出渐变,它等效于一层均匀黑纱**(2026-08-17 在真跑的游戏里
  逐点采样实测:中心与四角同值)。这不是个待修的 bug,是**必须知道的既成事实**:
  **暗底面板的底色是连着这层黑纱一起量定的**——真去把它修成渐变,全站暗面板会一起变亮,
  等于重调一遍配色。所以要么当它是"整体压暗系数"来用(纸页两档就是这么处理的:
  压暗系数归零、把目标色直接烘进底色),要么把修渐变**当成一次配色改动立项**,别顺手改。
  凡是"配色里写的值与游戏里看到的对不上"的问题,先怀疑这一层。
- **贴图未加载必须降级**:取贴图在预载完成前和 jsdom 测试里返回 null,
  底退回纯色+细线、木框返回 null。任何调用方不许因为素材没到就抛错。
- 贴图预载排在**任何面板首次构建之前**(图标可以晚到一帧,只是这一帧没图标)。
- 颜色只取 `UITheme.colors.*`,字号只用七档,间距只用六档;**行距用 `lineHeight`,
  禁用 `leading`**(见 [pixi-v8-traps](pixi-v8-traps.md))。
- systems / rendering / core 层**不许 import ui**(架构铁律一)。切场进度条配色因此是
  由组装层注入的,不是直接 import 主题。
- **换木框贴图必须同步导出边条宽度常量**(`UITextures.ts` 的 `FRAME_BORDER_PX`),
  否则九宫格切边错位。
  ⚠ **木框/纸纹的再生成入口(出图提示词 + 后处理脚本)已失传**:它当初放在 `tmp/` 下,
  那个目录早已清掉。要重出这批底图得先重建一套生成材料;
  代码注释里指向 `tmp/` 的那条路**不要照着找**。新素材的复现材料一律别再放 `tmp/`。
- 美学方向见 [2026-07-05-ui-panel-skin-direction](../decisions/2026-07-05-ui-panel-skin-direction.md)
  (**2026-08-03 已换向为「做旧木框 + 纸纹 + 金细线」,原「纯程序化零素材」条款作废**)。

## 怎么验证

`npx tsc --noEmit`;观感必须出**全分辨率**对照图——800x450 的浏览器截图看不见木纹 / 金线 / 字距。
DEV 取景台在 `src/dev/uiShotHarness.ts`:`__uiReady()` 等到可拍(**茶馆有 onEnter 开场演出,
不能当取景场景**)→ `__uiPose(名)` 摆姿势 → `__uiShot(名)` 抓帧 POST 给收图服务
(`tmp/ui_shots/shot_server.py`,**不起服务时抓帧静默失败**)。它自带隐藏页 rAF 补泵,见
[headless-visual-verification](../recipes/headless-visual-verification.md)。
