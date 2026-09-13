# -*- coding: utf-8 -*-
"""控件丢弃出口：不许再把可见控件摘成「野顶层窗口」。

2026-09-12 现场事故：场景属性面板每重载一次，屏幕正中就弹出一个标题为
「GameDraft Editor」的小窗（414×68，条件树的「Flag 条件」叶子行），一闪即逝、
任务栏里一个个摞着。根因是对**当前可见**的子控件直接 ``setParent(None)``：
Qt 只置 ``WA_WState_Hidden``、不置 ``WA_WState_ExplicitShowHide``，于是事件循环回来时
（``deleteLater`` 还没落地）把这个孤儿当成「该显示的顶层窗口」显示出来。

判据用属性而不是"看得见没有"：**弹出来那一下是平台相关的**（Windows QPA 上复现，
离屏平台不复现），只有 ``WA_WState_ExplicitShowHide`` 这个状态位是跨平台确定的，
它就是「Qt 还会不会把它显示出来」的开关。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.editor.shared.widget_discard import (  # noqa: E402
    detach_widget,
    discard_layout_widgets,
    discard_widget,
)

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture
def app():
    from PySide6.QtWidgets import QApplication
    a = QApplication.instance() or QApplication(sys.argv[:1])
    yield a


def _explicit_hidden(w) -> bool:
    from PySide6.QtCore import Qt
    return w.testAttribute(Qt.WidgetAttribute.WA_WState_ExplicitShowHide)


def _visible_host_with_child(app):
    from PySide6.QtWidgets import QVBoxLayout, QWidget
    host = QWidget()
    lay = QVBoxLayout(host)
    child = QWidget(host)
    lay.addWidget(child)
    host.resize(200, 120)
    host.show()
    app.processEvents()
    assert child.isVisible()
    return host, lay, child


def test_丢弃可见控件_摘成孤儿之前必须先隐藏(app):
    host, lay, child = _visible_host_with_child(app)
    lay.removeWidget(child)
    discard_widget(child)
    assert child.parent() is None
    assert child.isHidden()
    # 这一条才是护栏：没有它，Qt 会在 deleteLater 落地前把孤儿显示成顶层窗口
    assert _explicit_hidden(child), "孤儿没被显式隐藏 —— 它会作为顶层窗口弹出来"
    host.deleteLater()


def test_清空布局_每个控件都按丢弃处理(app):
    from PySide6.QtWidgets import QVBoxLayout, QWidget
    host = QWidget()
    lay = QVBoxLayout(host)
    kids = []
    for _ in range(3):
        k = QWidget(host)
        lay.addWidget(k)
        kids.append(k)
    host.resize(200, 200)
    host.show()
    app.processEvents()

    discard_layout_widgets(lay)
    assert lay.count() == 0
    for k in kids:
        assert k.parent() is None
        assert _explicit_hidden(k)
    host.deleteLater()


def test_嵌套子布局也一并清掉(app):
    from PySide6.QtWidgets import QHBoxLayout, QVBoxLayout, QWidget
    host = QWidget()
    lay = QVBoxLayout(host)
    sub = QHBoxLayout()
    deep = QWidget(host)
    sub.addWidget(deep)
    lay.addLayout(sub)
    host.show()
    app.processEvents()

    discard_layout_widgets(lay)
    assert lay.count() == 0
    assert deep.parent() is None
    assert _explicit_hidden(deep)
    host.deleteLater()


def test_摘出来准备重新安家的控件_不许被显式隐藏(app):
    """``detach_widget`` 的语义与丢弃相反：接着要加回布局，显式隐藏过就再也不显示了。"""
    host, lay, child = _visible_host_with_child(app)
    lay.removeWidget(child)
    detach_widget(child)
    assert child.parent() is None
    assert not _explicit_hidden(child)
    lay.addWidget(child)          # 立刻重新安家 —— 这是该函数的契约
    app.processEvents()
    assert child.parent() is host
    assert child.isVisible()
    host.deleteLater()


def test_条件树换类型_旧条件体不会变成会弹出来的孤儿(app):
    """回归本体：走真实载入路径（set_dict → _rebuild_body → _clear_body）。"""
    from PySide6.QtWidgets import QVBoxLayout, QWidget

    from tools.editor.shared.condition_expr_tree import ConditionExprNodeEditor

    host = QWidget()
    lay = QVBoxLayout(host)
    node = ConditionExprNodeEditor(0, lambda: None, host)
    lay.addWidget(node)
    host.resize(420, 200)
    host.show()
    app.processEvents()

    node.set_dict({"flag": "淹尸_烤过火", "op": "==", "value": True})
    app.processEvents()
    body = node._flag_wrap
    assert body is not None and body.isVisible()

    node.set_dict({"all": []})     # 换类型 = 旧条件体被丢弃
    app.processEvents()
    assert body.parent() is None
    assert _explicit_hidden(body), (
        "条件体被摘成孤儿却没显式隐藏 —— Windows 上它会作为「GameDraft Editor」小窗弹出来"
    )
    host.deleteLater()


# ============================================================ 护栏：出口唯一
_ALLOWED = {
    "tools/editor/shared/widget_discard.py",   # 出口自己
}


def _iter_python_sources():
    for path in sorted(REPO.glob("tools/**/*.py")):
        rel = path.relative_to(REPO).as_posix()
        if rel in _ALLOWED or "/tests/" in rel or rel.endswith("/conftest.py"):
            continue
        yield rel, path


def test_生产代码不许裸调_setParent_None():
    """裸 ``setParent(None)`` 一律走 widget_discard 的两个出口。

    这道门是本次事故的真正修法：坏写法在 12 个文件里重复了 30 多处，
    "改对这一处"挡不住下一次照抄。注释里提到不算（只看 AST 里真实的调用）。
    """
    offenders: list[str] = []
    for rel, path in _iter_python_sources():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:      # 语法错误由别的门管，这里不连坐
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not isinstance(func, ast.Attribute) or func.attr != "setParent":
                continue
            if len(node.args) != 1:
                continue
            arg = node.args[0]
            if isinstance(arg, ast.Constant) and arg.value is None:
                offenders.append(f"{rel}:{node.lineno}")
    assert not offenders, (
        "这些地方在裸调 setParent(None)，可见控件会变成弹出来的野顶层窗口；"
        "销毁用 discard_widget()/discard_layout_widgets()，"
        "要重新安家用 detach_widget()：\n  " + "\n  ".join(offenders)
    )
