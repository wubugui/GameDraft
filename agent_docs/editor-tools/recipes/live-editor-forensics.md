---
id: live-editor-forensics
title: 对活着的编辑器进程取证
domain: editor-tools
type: recipe
summary: 编辑器"某页白/黑/卡/打不开"而离屏复现全绿时,故障只存在于那个跑了几小时的进程里——去问它(活栈/页面报错/渲染子进程/CPU 增量/窗口像素),别再复现;数据整块消失先查旧代码孤儿进程
status: active
authority:
  - tools/editor/__main__.py
  - tools/dev_console/app.py
  - tools/editor/web_engine_page.py
  - tools/editor/editors/game_browser.py#_GameBootWatchdog
triggers:
  paths: ["tools/editor/**", "tools/dev_console/**", "tools/audio_editor/**", "tools/desktop_shell.py"]
  topics: [编辑器卡死, 一片白, 黑屏, 崩溃, py-spy, 取证, QtWebEngine, 孤儿进程, 数据被抹]
  tasks: [查编辑器卡顿, 查页面打不开, 查预览窗黑屏, 查内存涨, 查崩溃, 查数据文件被谁写坏]
verified_by:
  - tools/editor/editors/tests/test_game_boot_watchdog.py
  - tools/dev_console/tests/test_tool_lifecycle.py
last_governed: 2026-09-23
---

## 实测环境与日期

Windows / 项目 venv(`py-spy` 在 `.tools/venv`);2026-08-26 与 2026-09-08(PySide6 6.11)两次实测。

## 什么时候用

用户报"编辑器某页打不开 / 一片白 / 纯黑 / 卡",而你**离屏复现是全绿的**(新 profile、打包产物、
数据都健康)。这不是"复现不出来",是**故障只存在于那个已经跑了几小时的进程里**——继续复现是白费。

## 取证路(按便宜程度)

- **要活栈**:`.tools/venv/Scripts/py-spy.exe dump --pid <编辑器 pid>`,采几次看落点分布。
  唯一能直接指认"哪个定时器在烧 GUI 线程"的手段。`faulthandler` 崩溃日志(`tools/editor/__main__.py` 装的)
  **只在原生崩溃时才有内容**,卡死/白页时是空的——空日志不等于没事。
- **要页面报错**:编辑器 stderr 被开发者控制台收着,`curl http://127.0.0.1:8765/api/state?since=0`。
  **PySide6 默认一个字都不转发页面 console**(`console.error`、未捕获异常都没有);日志里的
  `js:error:` / `js:warn:` 行**只因为编辑器的共享页 `QuietWebEnginePage` 显式转发才有**,且只转
  error/warning。没挂这个页的 Qt 壳(各工作台、`tools/audio_editor` 等各写各的或干脆没有)上
  "日志里没有 js 报错"**什么都证明不了**。控制台只留最近若干条,被刷屏顶掉就查不到了。
- **数渲染子进程**:每个内嵌网页各占一个 `QtWebEngineProcess --type=renderer`。**少一个 = 那一页的
  渲染进程死了 = 那一页一片白**,与页面代码无关。个数按当前有几个内嵌页算,别记死数字。
- **数渲染子进程的 CPU 增量**:隔几分钟采两次 `Get-Process <pid>` 的 CPU 秒。**纹丝不动 = 页面根本
  没跑起来(没有 rAF)**;打满 = 死循环/烧帧。两者指向相反的根因,别都叫"卡死"。
- **拍那一屏的像素**:最小化的窗口先 `ShowWindow(SW_RESTORE)` 再 `Graphics.CopyFromScreen` 采几个点。
  用来分清**是哪一种黑**(见判读)——肉眼分不出来。
- **要页面内状态**:起壳时带 `QTWEBENGINE_REMOTE_DEBUGGING=<端口>`,用 CDP 读 `location.href` /
  DOM 规模,"没加载"与"加载了没画"一问便知。

## 判读

- **"某页白"最常见的真因不在那一页**:别处有个高频定时器没有可见性门,切走后照跑,把主进程钉在
  满 CPU / 高内存,把渲染子进程挤死(2026-08-26 实测)。拿到活栈先看**落点在哪个页**。
- **内嵌页白/黑有两种互不相干的根因**,先分清再动手:
  - **首屏被掐**:`loadStarted` 后再无信号,`loadFinished` 根本不发 → 白屏。重发一次就好,
    所以内嵌网页的工具首屏要带**超时看门狗重发**(监听 `loadFinished(False)` 救不了)。
  - **模块图断了**:`loadFinished` 照样 `True`,渲染进程 CPU 归零,窗口停在宿主 `index.html`
    的底色上(不是游戏 `main.ts` 画出来的开始门/错误屏底色——两者当前色值见各自源码)。
    成因可以是烂缓存喂回坏字节(2026-09-08,见 [desktop-window-no-cache](../../meta/mechanisms/desktop-window-no-cache.md))、
    改坏的 import、dev server 半路挂掉。编辑器游戏预览的首屏看门狗按"页面自证 `main.ts` 跑过"判活。
- **数据文件"整块字段消失、别的字段完好、键序变成代码里的 EMPTY 常量"= 陈旧或半加载进程的
  全量写回**,不是哪个会话手滑。先 `Get-CimInstance Win32_Process` 比编辑器进程的 CreationDate
  与相关代码 mtime(孤儿进程拿启动那一刻的旧代码写现网数据),再翻会话记录;半加载那一半见
  [narrative-state-editor](../mechanisms/narrative-state-editor.md) 硬契约 12。

## 进程归属与关闭

开发者控制台登记自己拉起的工具、退出时回收,**不是它拉起的同名工具实例报为孤儿**并拒绝再开第二份
(两份编辑器交替写同一批文件必丢数据)。要礼貌关掉一个编辑器(走它自己的未保存确认):给它进程树的
可见顶层窗口 `PostMessage(WM_CLOSE)`;**`taskkill /T` 不带 `/F` 会直接拒绝**——QtWebEngine 子进程
永远在,它连 WM_CLOSE 都不发。

## 相关

停不干净的后台 Python 进程见
[project-interpreter-entrypoint](../../meta/mechanisms/project-interpreter-entrypoint.md);
测试进程挂死是另一回事,走
[editor-change-verification-gate](editor-change-verification-gate.md) 的挂死分流。
