---
id: ui-component-layer
title: UI 组件层(窗体/按钮/滚动区)
domain: runtime
type: mechanism
summary: 面板不再各自手搭遮罩·标题栏·滚动·按钮,统一走 src/ui/components;重绘用 attach 不用 open、量高前必须摘 mask、行内点击必须消费
status: active
authority:
  - src/ui/components/UIWindow.ts#UIWindow
  - src/ui/components/UIButton.ts
  - src/ui/components/UIScrollView.ts
  - src/ui/components/UIDecor.ts
  - src/ui/uiPointerCoords.ts#markPointerConsumed
triggers:
  paths: ["src/ui/components/*.ts", "src/ui/*UI.ts", "src/ui/uiPointerCoords.ts"]
  topics: [UI 组件, UIWindow, UIScrollView, UIButton, 面板重绘, 滚动, 命中]
last_governed: 2026-08-05
---

## 是什么(一句话)

运行时面板的公共件层:窗体(遮罩+底框+标题栏+✕+开关动效)、三级按钮、滚动区、装饰件;
[ui-panel-skin](ui-panel-skin.md) 的 `PanelSkin` 降为**这一层的底层依赖**,面板不再直接调它画底边。

## 权威源(读代码从哪进)

`src/ui/components/` 五个件;命中消费在 `uiPointerCoords.ts`;
已迁移的面板(四本册子 / 暂停菜单 / 商店 / 用规矩)是抄写样板。

## 硬契约(违反即 bug)

- **窗体内容重绘走 `attach()`,不走 `open()`**:忘了挂载面板直接从画面消失;
  走 `open()` 则每点一行都重放一遍开场动效。
- **`UIScrollView.refresh()` 量高前必须先摘 mask**:`getLocalBounds` 会与 target 自身的
  mask 求交,量出来的高恒被夹到视口高 → `maxScroll` 恒为 0,滚轮 / 滚动条 / 方向键**全废**。
- **所有行内 `pointerdown` 必须 `markPointerConsumed(e.nativeEvent)`**,否则点击穿透到
  下层(打字机被瞬间跳满之类)。
- **容器当按钮必须自带 `hitArea`**(见 [pixi-v8-traps](pixi-v8-traps.md));
  底部那排关闭提示都是这个形状。
- **`[img:…]` 富文本走的是只读缓存**:不在预载清单里的图恒走占位分支。缺图要现装 +
  回调让调用方整段重排,重排要带"面板已关 / 已翻页"的守卫。
- **「返回主菜单」= 整页重启到标题态**,URL 带一次性引导参数;标题分支**不装载世界**
  (只 `setState` 的老写法会让场景/玩家/HUD 全活着,子面板遮罩底下透出游戏画面)。
  该分支必须判在 dev 分支**之前**,否则 `mode=dev` 抢走。
- 标题界面**不属于**面板皮肤那一套,版式是制作人拍板项,见
  [2026-07-05-ui-panel-skin-direction](../decisions/2026-07-05-ui-panel-skin-direction.md);
  其底图是**带透视的氛围立绘**、构图正中偏上刻意留空给菜单——换图要保住这条,
  且它与「可行走场景背景」的 45° 无透视等距规格无关,别混用。

## 已知坑

- **面板内部键位不得与 `registerPanel` 的快捷键表重名**:控制器先拿到键,面板自己的
  window 监听收不到——**纯静默**,没有报错也没有日志,那个键就是不工作
  (实测:日志面板拿 `Tab` 切过滤档,而 `Tab` 是任务面板的注册键;同一处理器对方向键正常)。
  "面板开着时那个键反正没用"是错觉。**切页签/切档一律走焦点导航**(分组 + 组内优先),
  别绑键。
- 只构造视口附近条目时 `getLocalBounds()` 只量得到已构造的那几条,滚动条比例会失真——
  这类面板要显式喂总高。
- 标题菜单的「无框」皮必须判在「选中」之前,否则选中先被铺上琥珀色块,无框白设计(已踩过)。
- 居中排版里的选中记号要按**文字实际宽度**画;挂在行盒左沿的竖条会飘在离文字上百像素的半空。

## 怎么验证

`npx tsc --noEmit` + 取景台全分辨率截图(见 [ui-panel-skin](ui-panel-skin.md) 验证节);
出口类交互必须**真点一次**,肉眼看不出"点不中"和"点了没反应"的区别。
