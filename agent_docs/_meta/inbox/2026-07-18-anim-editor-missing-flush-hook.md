---
target: mainwindow-editor-hooks
date: 2026-07-18
session: refSpeed 保存排查
---

现象: 卡里警告的「缺钩子静默漏网」实锤发生——AnimEditor 自建成起就没有 flush_to_model，Save All 一直静默跳过动画面板（改帧率/refSpeed 只标脏零 diff），用户以为保存成功；今日已补 flush_to_model + pop_flush_error（复用 _save_current_bundle 非交互核心）。
证据: tools/editor/editors/anim_editor.py（_save_current_bundle/flush_to_model）；用户现场：动画浏览改 refSpeed → Save All → git 零 diff。
建议: 值得配一条机械护栏——枚举全部注册编辑器，凡有本地脏态（_dirty/has_unsaved_changes）者必须可 grep 到 flush_to_model，缺失即 fail（钉死清单式 parity）。
