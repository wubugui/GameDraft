---
target: desktop-window-no-cache
date: 2026-09-27
session: engine2d/RHI 迁移 · Qt 宿主上 WebGPU(wt/qthosts)
---

现象: 卡与各宿主默认"Qt 窗口 = QtWebEngine";但 QtWebEngine 编 Chromium 时写死 use_dawn=false(6.11 与 dev 分支都是),任何开关 / QSG_RHI_BACKEND 都拿不到 WebGPU 适配器,游戏(只有 WebGPU)在里面起不来。
证据: tools/qt_webgpu.py 模块头(dll 里无 Dawn/Tint 字符串、试过的全部开关);Qt 6.11 的 PySide6.QtWebView(WebView2)实测 nvidia/lovelace 适配器、36 场景 scene_sweep 全过。
建议: 卡里补一句"播游戏 / 用引擎 RHI 的页面走 tools/qt_webgpu.WebGpuView(WebView2),缓存口径由它负责:每进程新的用户数据目录 + 禁缓存开关";authority 加 tools/qt_webgpu.py。
