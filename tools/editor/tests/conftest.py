"""编辑器测试的 Qt 卫生层。

仓库级设施（只读工作区守卫 / QSettings 隔离 / 对话布局侧档重定向）在
``tools/conftest.py``；这里只放**编辑器测试特有**的收尾。

刻意只挂在 ``tools/editor/tests`` 这一层：同样的销毁动作放到 ``tools/conftest.py``
会让 ``tools/dialogue_graph_editor/tests`` 段错误退出（控件被销毁后，队列里指向
其 QGraphicsScene 的事件在下一个测试的 ``processEvents()`` 里投递 → SIGSEGV）。
那是图对话编辑器自己的生命周期残留，得单独修，别顺手把范围放大。

⚠️ 但要清楚这道边界是**什么**边界：fixture 的作用域只决定「哪些测试**触发**销毁」，
``destroy_leftover_qt_widgets()`` 本身是全进程扫 ``app.topLevelWidgets()``。所以把两个
测试目录塞进同一次 pytest 调用（或 ``--dist loadfile`` 把两边的文件派给同一个 worker）时，
图对话的残留照样会被随后某个编辑器测试的收尾收走。实测
``pytest tools/editor/tests tools/dialogue_graph_editor/tests`` 是绿的（898 passed），
但真要是哪天在这种组合下段错误，原因就在这儿——按文档分开跑两条门即可。
"""
from __future__ import annotations

from typing import Iterator

import pytest

from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets


@pytest.fixture(autouse=True)
def _destroy_leftover_qt_widgets() -> Iterator[None]:
    """每个测试收尾真正销毁遗留控件——为什么必须显式收，见 qt_teardown 模块注释。"""
    yield
    destroy_leftover_qt_widgets()
