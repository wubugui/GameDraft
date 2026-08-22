---
target: ui-component-layer
date: 2026-08-22
session: 「游戏界面被识别成手机界面」现场排查 + 判据收窄
---

# 触屏判据只问「能不能摸」，把带触屏的桌面机整套换成手机 UI

- **现象**：桌面机（1536×864、鼠标操作）进游戏后，右下角 8 个木框图标入口条整条消失，
  换成顶部一排纯文字 DOM 按钮 + 左下虚拟摇杆 + 右下 6 键动作网格。玩家读作
  「谁把我的 HUD 改了」，实际没人改过 HUD——是**另一套 UI 顶上来了**。
- **根因**：`useCoarsePointerOrTouchDevice()`（`src/ui/TouchMobileControls.ts`）第二条判据是
  裸的 `'ontouchstart' in window`。Win11 触屏一体机 / 二合一 / 装了驱动的数位板上
  `navigator.maxTouchPoints = 10`，这条恒真，而 `(pointer: coarse)` 是 false（主指针是鼠标）。
  两套入口是**互斥**的：`HUD.buildEntryStrip()` 开头 `if (this.isTouchDevice) return;`，
  一旦判成触屏，桌面条一个钮都不建。触屏布局把 bottom-left / bottom-right 占给了摇杆和动作网格，
  面板入口只能置顶（`touch-mobile-controls.css` 里有注释：躲矮横屏下的 bottom 区域）。
- **影响**：任何带触摸能力的桌面机（包括不少笔记本）默认拿手机 UI，且**全项目零 CSS 媒体查询**，
  这个切换 100% 由那一个函数决定，肉眼从窗口尺寸完全推不出来。

## 2026-08-22 已修

判据改成三段：`(pointer: coarse)` 快车道**原样保留**（真手机 + DevTools 设备模拟都从这走，
零回归——文件里记着上次用 `(hover:none)`+排除 `fine` 收窄，把真手机整块 HUD 干没了）；
第二段要求拿出「是手机」的正面证据（`navigator.userAgentData.mobile` / UA 正则 / **设备 screen** 短边 ≤820）。

踩到的两个坑，留给下一个人：

1. **别用 `innerWidth` 兜底 `screen`**。第一版写了 `screen.width || innerWidth`，
   而内嵌 WebView / 预览面板在启动瞬间 `screen` 报 **0×0** → 退回 1280×720 的窗口尺寸 →
   短边 720 ≤ 820 → 照样判手机。窗口能被随手拖窄，设备不会；`screen` 取不到时宁可判桌面。
2. `HUD.isTouchDevice` 原是构造时冻结的字段，而 `TouchMobileControls.update()` 每帧现算。
   判据来源一变（模拟开关、外接触屏拔插），两边会错位成「两套入口都在 / 都不在」。
   已改成 getter 现算——调用点只有入口条重建与提示条重建，不在逐帧路径上。

现场取证口：`window.__game` 上 `hud.entryLayer.children.length`（桌面 8 / 触屏 0）
配 `#touch-mobile-controls` 的 className（空 = 隐藏，`is-explore` = 触屏 UI 在跑）。
