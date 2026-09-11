---
target: live-editor-forensics
date: 2026-09-08
session: 编辑器游戏预览窗黑屏排查
---

现象: 卡里"编辑器的 stderr 里带 `js:` 前缀的就是页面 console"在 PySide6 6.11.2 上**不成立**——Qt 默认的 `javaScriptConsoleMessage` 一个字都不转发(`console.error` 与未捕获异常都没有输出),照着这条去 dev_console 找页面报错只会找到空的,把"内嵌页出错"误判成"页面根本没跑"。
证据: 离屏最小脚本(纯 `QWebEngineView` + `setHtml` 里 `console.log/warn/error` + 未定义函数调用)stderr 全空;`grep -rn "js:" tools/dev_console tools/editor` 全仓没有任何产出 `js:` 的地方。2026-09-08 游戏预览窗黑屏那次,页面里真实存在 `Uncaught SyntaxError`,dev_console 16 条日志里一条线索都没有。
建议: 本轮已在 `tools/editor/web_engine_page.py` 的 `QuietWebEnginePage` 里显式转发 error/warning(前缀 `js:error:` / `js:warn:`,info 不转以免刷屏)——卡里那条应改成"**因为编辑器显式转发**才有 `js:` 行,且只有 error/warning",顺带记下别的 Qt 壳(scene_sweep 自己覆写了、audio_editor 没有)口径不一。
