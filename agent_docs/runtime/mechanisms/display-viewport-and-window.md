---
id: display-viewport-and-window
title: 显示链:逻辑视口 · 等比信箱 · 宿主窗口(4:3 标准)
domain: runtime
type: mechanism
summary: 标准视口 1024×768(4:3)定义在 game_config.viewport;app.screen 恒为它,显示只许等比缩放(Renderer.layoutMount 在 #game-stage 里放最大同比例盒);windowSize 只是宿主窗口期望尺寸,编辑器 F5 与 exe(main.rs 启动时读同一份 JSON)按它开窗;三个布局元素的尺寸规则只住在 index.html
status: active
authority:
  - public/assets/data/game_config.json
  - src/rendering/Renderer.ts#layoutMount
  - src/rendering/viewportFit.ts
  - index.html
  - src-tauri/src/main.rs#preferred_window_size
  - tools/editor/main_window.py#_get_game_window_size
triggers:
  paths: ["src/rendering/Renderer.ts", "src/rendering/viewportFit.ts", "index.html", "src/ui/debug-panel-dock.css", "src-tauri/src/main.rs", "src/ui/TouchMobileControls.ts"]
  tasks: [改分辨率, 改窗口尺寸, 改布局 CSS, 排查画面拉伸, 排查黑边, 排查触屏 HUD 误出]
  topics: [分辨率, 视口, viewport, windowSize, 宽高比, 信箱, letterbox, 拉伸, 窗口尺寸, DPI, 触屏 HUD]
last_governed: 2026-09-06
---

## 是什么(一句话)

游戏在**固定的逻辑分辨率**下渲染(`game_config.viewport`,1024×768,4:3),显示时**只许等比缩放**;
宿主窗口多大、什么形状,画面都在里面放一个最大的同比例盒,余下黑边。

## 权威源(读代码从哪进)

- 标准的定义:`public/assets/data/game_config.json` 的 `viewport`(逻辑分辨率)与 `windowSize`
  (宿主窗口期望尺寸,通常相等)。编辑器「工程与全局 → Config → Display」页可改。
- 等比信箱:`src/rendering/Renderer.ts` 的 `layoutMount`(纯算法在 `viewportFit.ts` 的 `containBox`,有测试)。
- 布局链:`index.html` —— `#app-shell`(横向 flex:舞台 + F2 调试坞)→ `#game-stage`(宿主给游戏的
  可用区域,把画面盒居中)→ `#game-mount`(画面盒;canvas 与全部 DOM 覆盖层都挂在它上面)。
- 宿主窗口:exe 在 `src-tauri/src/main.rs` 的 `preferred_window_size` 启动时读同一份 JSON 开窗;
  编辑器 F5 在 `tools/editor/main_window.py` 的 `_get_game_window_size` 读同一字段。

## 硬契约

- **`app.screen` 恒为 viewport**:相机视野、UI 布局/分档常量(`HUD` 的 `META_BASE_H=768` 等)、
  指针映射(`uiPointerCoords.clientToCanvas` 按 canvas 实际矩形分轴换算)全按它算。
  显示层只改 CSS 尺寸,**永远不动逻辑分辨率**。
- **三个布局元素的尺寸规则只住在 index.html**。任何别的 CSS(尤其随 UI 组件打包进发行包的那些)
  不许再给 `#app-shell` / `#game-stage` / `#game-mount` 写 flex/width/height——2026-09-06 的事故
  正是 `debug-panel-dock.css` 给 `#game-mount` 写了 `flex:1 1 auto`,把画面盒横向撑满窗口。
- **`Renderer` 盯的是舞台不是画面盒**:画面盒尺寸是按舞台算出来的,盯它自己会自激。
- **`windowSize` 不参与前端布局**。`Renderer.setWindowSize` 只记录;它是给宿主(编辑器/exe)开窗用的。
  窗口被拖大/最大化后画面按视口比例等比放大——不是固定 1024×768 的小盒。
- **exe 窗口尺寸不写死**:`main.rs` 读 exe 旁 `game/assets/data/game_config.json`,读不到回落 1024×768
  并 `eprintln!`;`min_inner_size` 取一半同比例;`prevent_overflow()` 让 150% 缩放的 1080p 屏
  (逻辑高 720)也放得进去。`inner_size` 是逻辑像素,比例结论与 DPI 无关。
- **QtWebEngine 里一律桌面 HUD**(`TouchMobileControls.decideTouchUi` 第 0 条):它只承载编辑器预览与
  打包验收扫描,而 Qt 6.11 在带触摸数字化仪的 PC 上把主指针报成 coarse、`any-pointer:fine` 报 false,
  原有硬否决够不着,预览窗任何尺寸都出触屏方向键、与 exe 不一致。

### WebView2 启动参数（Windows，`main.rs` `WEBVIEW2_ARGS`）

桌面客户端不许有浏览器那套「没点过页面不出声、窗口没焦点 / 被盖住就把页面降成后台」（制作人 2026-09-08）：
`additional_browser_args` 带 `--autoplay-policy=no-user-gesture-required` + `--disable-background-timer-throttling
--disable-renderer-backgrounding --disable-backgrounding-occluded-windows`，并**自己带上** wry 的缺省项
`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`（一自定义就不再自动加）。开发期预览窗同一套开关在
`tools/dev/game_preview.py`。`cargo check` 过；未在真机装包验过（改的是启动参数，不是行为代码）。

## 已知坑

- **2026-09-06「打包出来比例不对」**:exe 写死 1280×720(16:9)+ 画面盒被 flex 撑满 + canvas 纯 CSS
  100%×100% 拉伸 ⇒ 4:3 的画横向拉宽 25%、竖向压 6%;最大化到 1080p 时横向 ×1.87 + 底部 312px 黑带。
  编辑器预览窗恰好是 `windowSize` 的 1024×768,所以开发期永远看不见;指针分轴换算让点击照样命中,
  ResizeObserver 在固定视口时直接 return,没有任何断言暴露"显示矩形比例 ≠ 逻辑比例"。
  修法即上面的硬契约(等比信箱 + 壳读 game_config + CSS 规则收口)。
- **游戏没有全屏切换**(无 F11/`requestFullscreen`/`set_fullscreen`);玩家只能拖大/最大化,表现按等比信箱。
- 编辑器 Config 页两组 spinbox 的**未勾选缺省**曾是 1280×720——一勾就把标准换成 16:9;现与标准一致。

## 怎么验证

`npx vitest run src/rendering/viewportFit.test.ts src/ui/TouchMobileControls.test.ts`;
`cargo test --manifest-path src-tauri/Cargo.toml`(含"仓库里的 game_config 是 4:3"这条);
真机:把 exe 窗口拖成任意形状,画面始终 4:3、黑边在两侧或上下,不拉伸;
无头取证用 QtWebEngine 读 `#game-mount` 的 `getBoundingClientRect()`——宽高比 ≈ 4/3 才对。
