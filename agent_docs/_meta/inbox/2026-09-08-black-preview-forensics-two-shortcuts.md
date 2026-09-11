---
target: live-editor-forensics
date: 2026-09-08
session: 编辑器游戏预览窗黑屏排查
---

现象: 卡里三条取证路都指向"进程/栈/日志",这次全部无效——py-spy 显示主线程正常在 `app.exec()`、渲染子进程一个不少、dev_console 里零条页面报错,而窗口就是纯黑;真正把案子破了的是卡里没有的两条:(1) **数渲染子进程的 CPU 增量**:五分钟纹丝不动地停在 1.39s = 页面根本没跑起来(没有 rAF),这与"死循环卡死"(CPU 打满)是相反的指纹;(2) **取那一屏的像素**:最小化的窗口 `ShowWindow(SW_RESTORE)` + `Graphics.CopyFromScreen` 就能拍到,`RGB(17,17,17)` 一眼判死是 index.html 的 `#111` 而非开始门的 `#0b0d10`,于是"卡在 main.ts 之前"当场成立——肉眼看两种黑分不出来。
证据: 本次会话:`Get-Process 31684` 两次采样 CPU 均为 1.390625s;`scratchpad/shotwin.ps1` 拍的 `gamewin.png` 全屏采样四点均 `R17 G17 B17`;离屏复现(新 profile)则一路全绿,正是卡里说的"复现是白费"的那种。
建议: 把这两条补进卡的"三条取证路"(变四/五条),并写清判读口径:**黑屏先分清是哪一种黑**(宿主 `#111` / 开始门 `#0b0d10` / 游戏画面),再决定往哪查;CPU 增量为 0 与 CPU 打满指向完全相反的两类根因。本次真因(WebEngine 磁盘缓存烂掉 → 模块 SyntaxError → main.ts 没跑)已固化在 `tools/editor/editors/game_browser.py` 的 `_GameBootWatchdog` 里,库里目前没有对应的卡。
