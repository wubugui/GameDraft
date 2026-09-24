---
id: desktop-window-no-cache
title: 桌面窗口一律禁缓存(Qt WebEngine 壳 / 游戏预览 Chromium / 发行版 WebView2)
domain: meta
type: mechanism
summary: 制作人 2026-09-08 定死——借 web 技术做的游戏不是网页,任何桌面窗口不留任何缓存(HTTP / V8 code / GPU shader / Qt pipeline);Qt 壳只走一个口径入口,Chromium 开关必须在 WebEngine 初始化前设,清缓存是异步的、边清边载会吊死
status: active
authority:
  - tools/webengine_cache_policy.py#disable_all_caches
  - tools/webengine_cache_policy.py#apply_no_cache
  - tools/dev/game_preview.py
  - src-tauri/src/web_root.rs#ok_response
triggers:
  paths: ["tools/webengine_cache_policy.py", "tools/desktop_shell.py", "tools/editor/__main__.py", "tools/editor/editors/game_browser.py", "tools/audio_editor/**", "tools/*_workbench/app.py", "tools/build/scene_sweep.py", "tools/dev/game_preview.py", "src-tauri/src/web_root.rs"]
  topics: [缓存, cache, QWebEngineProfile, DiskHttpCache, setCachePath, no-store, WebView2, 黑屏, 桌面壳]
  tasks: [新开桌面窗口, 新写 Qt 网页壳, 改工作台桌面壳, 改发行版协议头, 查预览窗黑屏, 想加缓存提速]
verified_by:
  - tools/editor/tests/test_webengine_no_cache_policy.py
  - tools/editor/editors/tests/test_game_boot_watchdog.py
last_governed: 2026-09-23
---

## 是什么(一句话)

本仓所有"用网页技术画的桌面窗口"——主编辑器内嵌页、各 PySide 工具/工作台壳、开发用游戏预览的专用
Chromium、发行版 Tauri/WebView2——**一律不留任何缓存**。这是制作人 2026-09-08 定死的规矩,不是优化选项:
内容要么在本机 localhost、要么就在 exe 旁边,缓存买不到任何东西,却能制造一整类"缓存烂了 → 一屏黑、
毫无线索"的故障(当天编辑器游戏预览因烂掉的磁盘缓存把坏字节当响应体喂回,模块 SyntaxError,
`main.ts` 一行没跑,整整查了一天)。**"为了性能加个缓存"这个权衡他已经拒绝过**,别再提。

## 权威源(读代码从哪进)

- Qt 壳的唯一口径:`tools/webengine_cache_policy.py`(头注释即用法)。
- 开发用游戏预览(专用 Chromium 实例)的开关:`tools/dev/game_preview.py`。
- 发行版那扇窗:`src-tauri/src/web_root.rs` 的自定义协议响应头(附 Rust 单测)。
- 门:`tools/editor/tests/test_webengine_no_cache_policy.py`。

## 硬契约(违反即 bug)

1. **新开任何桌面窗口先接统一口径,别再自己发明一份**。Qt 壳两件缺一不可:进程最开始调
   `disable_all_caches()`;每个 profile(含共享默认 profile)走 `apply_no_cache*`。
2. **Chromium 开关只在 WebEngine 初始化时读一次**:`disable_all_caches()` 必须在任何 `QApplication` /
   WebEngine 初始化**之前**;晚了**不报错、也不生效**。它是**并进**已有开关而非覆盖——各壳自带的
   GPU/自动播放开关不能被吃掉,改它时保住这条。
3. **`setCachePath("")` 不能省,`DiskHttpCache` 与 `setCachePath(<路径>)` 一律禁止**:`NoCache` 只挡 HTTP 缓存,
   具名 profile 的标准目录里照样落 code cache / GPUCache。
4. **发行版协议只许发 `Cache-Control: no-store`**。`immutable`/长 `max-age` 等于允许 WebView2 长期喂旧字节,
   而"换图不换文件名"恰是发行包 `game/` 目录的设计卖点。
5. **要落盘的是存档**,那条走 dev server 的文件后端,与浏览器缓存无关——别拿"持久化"当理由给壳接缓存。

## 已知坑

- **清缓存是异步的**:`clearHttpCache()` 在飞时发起重载,这次加载会被永久吊死(`loadStarted` 后
  `loadFinished` 再不来)。必须等 `clearHttpCacheCompleted` 再重载(游戏预览首屏看门狗的兜底即此时序)。
- **"外部浏览器打开正常"会把人往反方向带**:浏览器有它自己那份缓存,与壳内那份毫无关系。
- **门只扫"自己造 profile 的壳"有没有引用统一口径**,查不到调用时机(契约 2)与只用默认 profile 的壳——
  新壳这两处靠自己对。
- 历史上各壳各写各的(有的三层俱全、有的只关 HTTP、有的开着磁盘缓存、发行版发一年期 immutable),
  这就是没有单一口径时的自然走向;任何"这个壳特殊一点"的写法都先回来对这张卡。

## 怎么验证

```bash
sh scripts/py.sh -m pytest tools/editor/tests/test_webengine_no_cache_policy.py -q -p no:cacheprovider
cd src-tauri && cargo test 游戏内容一律不进缓存
```

实测判据:新口径下壳的 AppLocalData 连缓存目录都不再创建。黑屏取证与"哪一种黑"的判读见
[live-editor-forensics](../../editor-tools/recipes/live-editor-forensics.md)。
