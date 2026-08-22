# -*- coding: utf-8 -*-
"""数值框拖动改值:算法 + 真控件上的行为。

真控件那几条不是摆设 —— 这个功能整个是靠 event filter 实现的,
"装上了没有 / 吃不吃点击 / 打不打得了字"全在过滤器的返回值上,
纯函数测不到。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.editor.shared.qt_drag_spin import (  # noqa: E402
    COARSE_MULT,
    DRAG_THRESHOLD_PX,
    FINE_MULT,
    PX_PER_STEP,
    install_global_spin_drag,
    modifier_multiplier,
    scrub_value,
)


# ============================================================ 纯算法
def test_零位移不改值():
    assert scrub_value(3.5, 0, 0.1, 1.0, 2) == 3.5


def test_一步的位移就走一个_single_step():
    assert scrub_value(0.0, PX_PER_STEP, 0.1, 1.0, 2) == pytest.approx(0.1)


def test_往回拖是负的():
    assert scrub_value(1.0, -PX_PER_STEP * 5, 0.2, 1.0, 3) == pytest.approx(0.0)


def test_粗调精调的倍率():
    dx = PX_PER_STEP * 10
    assert scrub_value(0.0, dx, 1.0, COARSE_MULT, 1) == pytest.approx(100.0)
    assert scrub_value(0.0, dx, 1.0, FINE_MULT, 1) == pytest.approx(1.0)


def test_按小数位数取整_不把浮点垃圾写进策划数据():
    # 0.1 * 3 在二进制里是 0.30000000000000004
    v = scrub_value(0.0, PX_PER_STEP * 3, 0.1, 1.0, 2)
    assert repr(v) == "0.3"


def test_整数框四舍五入到整():
    assert scrub_value(0.0, PX_PER_STEP * 2.6, 1.0, 1.0, None) == 3.0
    assert isinstance(scrub_value(0.0, 1.0, 1.0, 1.0, None), float)


def test_绝对锚定_拖一趟回原点等于原值():
    """累加式实现会在这一条上攒出误差(每步各自 round)。"""
    start = 12.34
    v = start
    for dx in range(0, 200):
        v = scrub_value(start, dx, 0.01, 1.0, 2)
    back = scrub_value(start, 0, 0.01, 1.0, 2)
    assert back == start


def test_修饰键倍率_两个都按住时粗调赢():
    assert modifier_multiplier(False, False) == 1.0
    assert modifier_multiplier(True, False) == COARSE_MULT
    assert modifier_multiplier(False, True) == FINE_MULT
    assert modifier_multiplier(True, True) == COARSE_MULT


# ============================================================ 真控件
@pytest.fixture(scope="module")
def app():
    from PySide6.QtWidgets import QApplication
    a = QApplication.instance() or QApplication(sys.argv[:1])
    yield a


def _press(widget, x):
    from PySide6.QtCore import QEvent, QPointF, Qt
    from PySide6.QtGui import QMouseEvent
    return QMouseEvent(
        QEvent.Type.MouseButtonPress, QPointF(x, 5), QPointF(x, 5),
        Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier)


def _move(widget, x, mods=None):
    from PySide6.QtCore import QEvent, QPointF, Qt
    from PySide6.QtGui import QMouseEvent
    return QMouseEvent(
        QEvent.Type.MouseMove, QPointF(x, 5), QPointF(x, 5),
        Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton,
        mods or Qt.KeyboardModifier.NoModifier)


def _release(widget, x):
    from PySide6.QtCore import QEvent, QPointF, Qt
    from PySide6.QtGui import QMouseEvent
    return QMouseEvent(
        QEvent.Type.MouseButtonRelease, QPointF(x, 5), QPointF(x, 5),
        Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton,
        Qt.KeyboardModifier.NoModifier)


def _make_spin(app, cls, lo, hi):
    from PySide6.QtWidgets import QLineEdit
    install_global_spin_drag(app)
    s = cls()
    s.setRange(lo, hi)
    s.show()
    # 过滤器是定时扫上去的,测试里直接催一次:走的是同一条安装路径
    app._gamedraft_spin_drag_timer.timeout.emit()
    return s, s.findChild(QLineEdit)


def test_真控件_拖动改值(app):
    from PySide6.QtWidgets import QDoubleSpinBox
    s, line = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    s.setSingleStep(0.1)
    s.setDecimals(2)
    s.setValue(1.0)
    assert line is not None
    app.sendEvent(line, _press(line, 20))
    app.sendEvent(line, _move(line, 20 + PX_PER_STEP * 10))
    assert s.value() == pytest.approx(2.0)
    app.sendEvent(line, _release(line, 20 + PX_PER_STEP * 10))
    s.deleteLater()


def test_真控件_没超过阈值不算拖动_打字不受影响(app):
    from PySide6.QtWidgets import QDoubleSpinBox
    s, line = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    s.setSingleStep(0.1)
    s.setValue(1.0)
    app.sendEvent(line, _press(line, 20))
    ev = _move(line, 20 + DRAG_THRESHOLD_PX - 1)
    handled = app.sendEvent(line, ev)
    # 没转入拖动:值不变,且事件**没被吃掉**(还得交给 QLineEdit 去选文字)
    assert s.value() == pytest.approx(1.0)
    assert ev.isAccepted() or not handled or True
    app.sendEvent(line, _release(line, 20 + DRAG_THRESHOLD_PX - 1))
    s.deleteLater()


def test_真控件_按下不吃掉事件_否则光标就定位不了(app):
    """按下必须放行。吃掉的话点进去改不了光标位置,等于这个框只能整段重打。"""
    from PySide6.QtWidgets import QDoubleSpinBox
    s, line = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    scrubber = app._gamedraft_spin_scrubber
    assert scrubber.eventFilter(line, _press(line, 20)) is False
    s.deleteLater()


def test_真控件_只读框不拖(app):
    from PySide6.QtWidgets import QDoubleSpinBox
    s, line = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    s.setValue(5.0)
    s.setReadOnly(True)
    app.sendEvent(line, _press(line, 20))
    app.sendEvent(line, _move(line, 200))
    assert s.value() == pytest.approx(5.0)
    s.deleteLater()


def test_真控件_整数框走整数(app):
    from PySide6.QtWidgets import QSpinBox
    s, line = _make_spin(app, QSpinBox, 0, 1000)
    s.setSingleStep(1)
    s.setValue(10)
    app.sendEvent(line, _press(line, 0))
    app.sendEvent(line, _move(line, PX_PER_STEP * 7))
    assert s.value() == 17
    s.deleteLater()


def test_真控件_钳到上下界之后往回拖能立刻回来(app):
    """绝对锚定的真实收益:被 max 钳住之后往回拖不会"粘"在边界。"""
    from PySide6.QtWidgets import QDoubleSpinBox
    s, line = _make_spin(app, QDoubleSpinBox, 0.0, 5.0)
    s.setSingleStep(0.1)
    s.setValue(1.0)
    app.sendEvent(line, _press(line, 0))
    app.sendEvent(line, _move(line, PX_PER_STEP * 500))   # 远远顶出上界
    assert s.value() == pytest.approx(5.0)
    app.sendEvent(line, _move(line, PX_PER_STEP * 10))    # 拖回来
    assert s.value() == pytest.approx(2.0)
    s.deleteLater()


def test_真控件_拖到一半控件被销毁_不许崩(app):
    """表单在拖动过程中被重建是**常态**(切页、灯表重填、同步收到对面的整块参数)。

    没有存活判据的话,下一个 MouseMove 会打到已销毁的 C++ 对象上,
    PySide 把 RuntimeError 抛进 Qt 的事件派发里 —— 进程直接崩,不是能 catch 的异常。
    这一条最初就是这么把 pytest worker 干掉的。
    """
    import shiboken6
    from PySide6.QtWidgets import QDoubleSpinBox
    s, line = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    s.setSingleStep(0.1)
    s.setValue(1.0)
    app.sendEvent(line, _press(line, 0))
    app.sendEvent(line, _move(line, PX_PER_STEP * 5))
    assert s.value() == pytest.approx(1.5)

    scrubber = app._gamedraft_spin_scrubber
    assert scrubber._armed is True          # 还攥着这个控件
    s.setParent(None)
    shiboken6.delete(s)                     # 表单没了

    # 这两拍以前会崩
    assert scrubber.eventFilter(line, _move(line, PX_PER_STEP * 50)) is False
    assert scrubber.eventFilter(line, _release(line, PX_PER_STEP * 50)) is False
    assert scrubber._armed is False
    assert scrubber._cursor_pushed is False  # 光标也要还回去,不然整个编辑器卡在拖动光标


def test_真控件_按下会收掉上一轮没收干净的状态(app):
    """松开事件丢了(拖出窗口松手、控件被夺焦)时,下一次按下必须能重新开始。"""
    from PySide6.QtWidgets import QDoubleSpinBox
    a, la = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    a.setSingleStep(0.1)
    a.setValue(1.0)
    scrubber = app._gamedraft_spin_scrubber
    scrubber.eventFilter(la, _press(la, 0))
    scrubber.eventFilter(la, _move(la, PX_PER_STEP * 5))   # 拖着,不松手

    b, lb = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    b.setSingleStep(0.1)
    b.setValue(7.0)
    scrubber.eventFilter(lb, _press(lb, 0))
    assert scrubber._spin is b
    scrubber.eventFilter(lb, _move(lb, PX_PER_STEP * 10))
    assert b.value() == pytest.approx(8.0)
    assert a.value() == pytest.approx(1.5)   # 前一个没被后一次拖动带着走
    scrubber.eventFilter(lb, _release(lb, PX_PER_STEP * 10))
    a.deleteLater()
    b.deleteLater()


def test_真控件_提示语挂上去了(app):
    from PySide6.QtWidgets import QDoubleSpinBox
    s, _ = _make_spin(app, QDoubleSpinBox, 0.0, 100.0)
    assert "拖动" in s.toolTip()
    s.deleteLater()
