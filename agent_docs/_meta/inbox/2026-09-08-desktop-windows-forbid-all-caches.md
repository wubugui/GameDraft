---
target: missing
date: 2026-09-08
session: 编辑器游戏预览窗黑屏排查 → 全仓禁缓存收口
---

现象: 库里没有"桌面窗口禁缓存"这条卡,于是每个 Qt 壳各写各的(desktop_shell 三层俱全、audio_editor 只关 HTTP、编辑器游戏预览干脆开了 `DiskHttpCache`、发行版 Tauri 反而发 `max-age=31536000, immutable`),2026-09-08 编辑器预览窗因此被烂掉的磁盘缓存整整坑掉一天(坏条目 revalidate 时被当响应体喂回 → 模块 SyntaxError → `main.ts` 没跑 → 纯黑无线索)。制作人当场定死:**这是借 web 技术做的游戏不是网页,任何 desktop 窗口一律禁用所有缓存**(HTTP / V8 code cache / GPU shader cache / Qt pipeline cache 全关)。
证据: 本轮改动 `tools/webengine_cache_policy.py`(统一口径)+ 五个壳接入 + `src-tauri/src/web_root.rs` 改发 `no-store`;门 `tools/editor/tests/test_webengine_no_cache_policy.py`(4 条)与 `src-tauri` 的 `游戏内容一律不进缓存` 均绿;实测同一份被污染 profile 复现黑屏、清掉即恢复,新口径下 AppLocalData 连目录都不再创建。
建议: 收成一张 editor-tools(或 runtime)机制卡:规矩 + 唯一口径入口 + 两条时序陷阱(① Chromium 开关必须在 WebEngine 初始化前设,晚了不报错也不生效;② `clearHttpCache()` 是异步的,清理在飞时发起重载会把这次加载永久吊死,必须等 `clearHttpCacheCompleted`)+ 判读捷径(纯黑先分清 `#111` 宿主壳 / `#0b0d10` 开始门 / 游戏画面)。同时把 desktop_shell 文档里"零浏览器缓存"那三条升格成全仓规矩的引用,别再各写各的。
