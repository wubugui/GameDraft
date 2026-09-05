---
id: live-editor-forensics
title: 对活着的编辑器进程取证
domain: editor-tools
type: recipe
summary: 编辑器"某页白/卡/打不开"而离屏复现全绿时,故障只存在于那个跑了几小时的进程里——去问它,别再复现
status: active
authority:
  - tools/editor/__main__.py
  - tools/dev_console/app.py
triggers:
  paths: ["tools/editor/**", "tools/dev_console/**"]
  topics: [编辑器卡死, 一片白, 崩溃, py-spy, 取证, QtWebEngine]
  tasks: [查编辑器卡顿, 查页面打不开, 查内存涨, 查崩溃]
last_governed: 2026-09-03
---

## 实测环境与日期

Windows / 项目 venv,2026-08-26 实测有效(`py-spy` 已在 `.tools/venv`)。

## 什么时候用

用户报"编辑器某页打不开 / 一片白 / 卡",而你**离屏复现是全绿的**(页面、打包产物、数据都健康)。
这不是"复现不出来",是**故障只存在于那个已经跑了几小时的进程里**——继续复现是白费。

## 三条取证路

- **要活栈**:`.tools/venv/Scripts/py-spy.exe dump --pid <编辑器 pid>`,采几次看落点分布。
  这是唯一能直接指认"哪个定时器在烧 GUI 线程"的手段。
  注意 `faulthandler` 那份崩溃日志(`tools/editor/__main__.py` 装的)**只在原生崩溃时才有内容**,
  卡死/白页时它是空的——空日志不等于没事。
- **要页面报错**:编辑器的 stderr 被开发者控制台收着,`curl http://127.0.0.1:8765/api/state?since=0`,
  回包的日志数组里带 `js:` 前缀的就是页面 console。⚠ 它只留最近若干条,**被刷屏的页面顶掉后
  就查不到真错误了**——先看有没有在刷屏,再看内容。
- **数渲染子进程**:编辑器里每个内嵌网页各占一个 `QtWebEngineProcess --type=renderer`。
  **少一个 = 那个页的渲染进程死了 = 那一页一片白**,与页面代码无关。
  正常个数按当前有几个内嵌页算,别记死数字。

## 判读

"某页白"最常见的真因不在那一页:**别处有个高频定时器没有可见性门**,切走后照跑,
把主进程钉在满 CPU / 高内存,把渲染子进程挤死(2026-08-26 实测就是这个形状)。
所以拿到活栈先看**落点在哪个页**,通常不是出问题的那一页。

## 相关

停不干净的后台 Python 进程见
[project-interpreter-entrypoint](../../meta/mechanisms/project-interpreter-entrypoint.md);
测试进程挂死是另一回事,走
[editor-change-verification-gate](editor-change-verification-gate.md) 的挂死分流。
