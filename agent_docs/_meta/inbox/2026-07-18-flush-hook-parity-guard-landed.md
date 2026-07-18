---
target: mainwindow-editor-hooks
date: 2026-07-18
session: flush 钩子 parity 护栏落地
---

现象: 卡里「钩子缺失静默跳过、无机械护栏」的表述已与现实不符——同日建议的机械护栏已落地：钉死 main_window rows 注册清单，凡持本地脏态标记（_dirty 属性 / has_unsaved_changes / has_pending_changes）的编辑器类必须实现 flush_to_model，缺失即 fail 并列出面板名；TimelineEditor 走显式豁免（pending 协议特判）并用锚点正则钉死其替代通路。
证据: tools/editor/tests/test_flush_hook_parity.py（3 条：主断言 + AnimEditor 防空转锚 + 豁免保鲜）；负向验证过删掉 AnimEditor.flush_to_model 会红灯。
建议: 治理时把机制卡「怎么验证」节补上该护栏入口，并弱化「无机械护栏」措辞（缺钩子仍是静默跳过，但现在会被测试拦）。
