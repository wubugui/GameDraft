---
target: ui-component-layer, ui-panel-skin, dialogue-portrait-composition
date: 2026-08-17
session: UI 深审修复 marathon(批0~批5 全量落地)
---

# UI 深审修复后的四条文档漂移/遗留(一次记账)

- **组件层扩员,机制卡未收**:src/ui/components 新增 UIConfirmDialog(全站确认框)、
  UIToast(toast 唯一视觉件)、UIListRow(可交互行原语:tap 激活+拖滚让路+消费标记内建);
  UIScrollView 加内容区拖滚+惯性+detachInput;UIWindow 加 fadeOutAndDestroy(关场淡出);
  PanelSkin 加 paper/paperPage 亮底纸页皮 + skin.vignette;UITheme 加 topLanes(顶中四车道表)、
  paperInk(纸面墨字色板)、z.banner。RichContent 重写为 run 级版式引擎(块+行内,可点 span)。
  [clue:] 线索层见 K7。ui-component-layer / ui-panel-skin 两卡下次治理 run 应收编。
- **立绘尺寸注释自相矛盾**:DialogueUI 实现是 360px 立绘,而文件内另一处注释与
  2026-07-07 定稿卡写 240px。未擅改运行时(现状 360 可能是后来口头拍板),请制作人对账:
  以哪个为准,卡与注释同步。
- **tmp/ui_assets_2026-08-03 已不存在**:UITextures.ts 注释与 ui-panel-skin 卡都指它是
  木框/纸纹再生成入口,本机 tmp 已清,入口失传。新图标批产的复现材料在
  tmp/ui_assets_2026-08-17_icons/(含 process_icon.py 提白管线与 LibTV 画布指引)。
- **systems 层 6 处 import ui 未搬**:三个小游戏场景 + ObjectExamineScene + WaterPullPanel
  是"UI 形代码放错层",硬改注入会给三个小游戏引入回归风险,本轮未动。
  建议单独立项:整体搬 ui 层或抽共享 uiKit 层,配 headless 小游戏回归验证。
