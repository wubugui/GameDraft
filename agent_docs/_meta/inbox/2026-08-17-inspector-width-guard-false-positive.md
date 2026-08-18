---
target: dialogue-graph-editor
date: 2026-08-17
session: 台词配音通道(voice/autoAdvance)
---

现象：`test_inspector_panel_width::test_every_node_type_fits_the_default_panel_width` 在**未改任何代码**时也红（choice_with_prompt 316px > 280px）——超宽来自检查器顶部那条「节点 id：<b>probe_choice_with_prompt</b>」标签，是**测试自己造的长 id**，不是表单控件。
证据：把 node id 从 `probe_choice_with_prompt` 换成 `n` 即降到 268px；`git stash` 掉本次 node_inspector 改动后仍是 316px（两次实测同值）。该 QLabel 是富文本、`wordWrap=True` 也不折行。
建议：护栏要么用短 id 量、要么让顶部 id 标签用 `_ElidingLabel`（长 node id 在真实数据里同样会顶宽，那才是真问题）；现状是"红着但指错人"，下一个改检查器的人会以为是自己弄坏的。

已修（2026-08-17，同日）：按后一条办——`node_inspector._type_label` 改成 `_ElidingLabel`（整行含类型名一起省略，因为未知类型走 `其它({node_type})` 同样无上限），完整内容进 tooltip；代价是 `<b>` 加粗没了。新增护栏 `test_inspector_panel_width::test_long_node_id_does_not_push_the_panel_wide`（拿真实数据长度的 id 逐主题量 + 断言 tooltip 有全名），并把"顶宽的不一定是表单"写进该文件的成因自检单。三主题全绿，`pytest tools/dialogue_graph_editor/tests` 157 passed。
可蒸馏去向：`editor-tools/mechanisms/dialogue-graph-editor.md` 的「已知坑」——**数据来的文本（node id / 未知类型名）进面板一律 `_ElidingLabel`，富文本 QLabel 的 minimumSizeHint = 整行宽且 wordWrap 不生效**；同时值得记一条元教训：宽度护栏的报错文案按**节点类型**归因，而真凶可能在表单之外，护栏指错人比不报还费人。
