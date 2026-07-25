---
target: editor-change-verification-gate
date: 2026-07-25
session: 编辑器 pytest 全套 823s → 40s
---

现象: 编辑器全套 pytest 跑 823 秒里有 713 秒（86.6%）耗在 5 个测试上，根因不是测试重而是 **`deleteLater()` 在测试里销毁不掉任何控件**（loopLevel 0 下 `processEvents()` 不投递 `DeferredDelete`）——控件从头堆到尾（会话末存活 QWidget 数万、RSS 2.2GB），而这 5 个测试是全套唯一调 `theme.apply_application_theme()` 的，其 `app.setStyleSheet()` 是全应用重刷，成本正比于存活控件数 → 纯 O(N²)（同一次调用在第 30 位测试要 4s，在第 779 位要 226s）。真正销毁控件后又炸出第二个隐藏 bug 家族：**35 处 2 参 `QTimer.singleShot`** 排的定时器没有 receiver，宿主销毁后照样触发，且 PySide 会把 RuntimeError 沿最近的 Python-override 边界外抛、**炸在毫不相干的下一段操作里**（换工程/重建页面栈/关窗后随手一点，真实编辑器也踩得到）。
证据: `tools/editor/tests/qt_teardown.py`（显式 `sendPostedEvents(None, DeferredDelete)`）+ `tools/editor/tests/conftest.py`；35 处 singleShot 补 context 对象，护栏 `tools/editor/tests/test_single_shot_context_parity.py`；实测 823s/3 failed → 40s/823 passed（`-n auto --dist loadfile`，根 `pytest.ini` 新建）。**未修的已知残留**：同一个销毁 fixture 挂到 `tools/conftest.py` 会让 `tools/dialogue_graph_editor/tests` **SIGSEGV**（`test_open_clean_and_save_fidelity.py::_pump` 的 `processEvents()` 把队列里指向已销毁 QGraphicsScene 的事件投出去），所以 fixture 刻意只挂 `tools/editor/tests` 一层。
建议: ①`editor-tools-norms` 加一条不变量「`QTimer.singleShot` 必须带 context 对象」（已有护栏可 grep）；②图对话编辑器的 QGraphicsScene 生命周期残留另开一条修，修完把销毁 fixture 上提到 `tools/conftest.py`，全 tools 测试都拿到同一层卫生；③`python -m unittest` 的跑法要从库里清干净——它完全不加载 conftest，等于绕过仓库写保护 / QSettings 隔离 / 对话布局重定向 / 控件销毁收尾（本轮已改两处，别再写回去）。
