观察：私有信号批量盖章的交付测试在 Windows 实现机声称全绿，macOS offscreen 一跑：不打桩 QMessageBox.warning 必挂死（离屏模态 exec 永不返回，冻 15 分钟伪装成"变慢"）、打桩后必被 H6 哨兵拦而断言失败——该用例与自己的修法互相矛盾，从未在交付版代码上真跑绿过（终审复审 G-1）。
影响面：editor-change-verification-gate 已有「新加确认弹窗=可能挂死既有测试」段，但缺"跨机绿灯声称必须在验收机重放"这一条；给弹窗类流程写用例时，宿主/主窗缺省形状（找不到主窗走哨兵）是必测分支。
线索：tools/editor/tests/test_narrative_template_batch.py::test_entry_stages_one_graph_per_selected_entity 的 G-1 注释；artifact/Reviews/私有信号-终审复审判决与修复-2026-08-09.md §二。
