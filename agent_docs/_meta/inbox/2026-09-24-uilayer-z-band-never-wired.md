---
target: ui-component-layer
date: 2026-09-24
session: 任务引导浮标画在暂停菜单存档页/设置页上
---

现象: UITheme.z 早就写着 panel:10 > overlay:5，但全仓零个面板用 z.panel（UIWindow/暂停页/书架全在 0 带），于是浮标 z=5 恒压所有面板；另 09-19 把 GuidanceLayerUI.update 收进 !worldPaused 闸，面板/说明卡/死亡时它冻在上一帧 visible=true。卡上没有任何 uiLayer 层序的说法。
证据: 新表 src/rendering/uiLayerOrder.ts（worldMarker5 < panel10 < curtain20 < toast50 …，住渲染层因 SceneManager 遮幕也要用）；src/ui/uiLayerOrder.test.ts；UIWindow/MenuUI/BookshelfUI 根设 z.panel，SceneManager 切场遮幕+持久黑幕设 curtain（读档时菜单读完才关，遮幕必须盖住面板）。
建议: ui-component-layer 硬契约补一条「面板根一律 z.panel；新 uiLayer 子节点先查 uiLayerOrder 选带，0 带内部靠插入序别发 z」；「每帧可见性状态不许挂在世界暂停闸后面」可入 runtime 已知坑。
