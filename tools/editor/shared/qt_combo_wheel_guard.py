"""全局禁止鼠标滚轮误改未聚焦的取值控件。

- QComboBox：未展开下拉时滚轮一律拦截（已展开的下拉列表内仍可滚动）。
- QAbstractSpinBox（QSpinBox/QDoubleSpinBox）：未持有键盘焦点时拦截滚轮——
  点进去（聚焦）后仍可用滚轮微调，扫过时不会误改数值。
"""
from __future__ import annotations

from PySide6.QtCore import QObject, QTimer
from PySide6.QtGui import QWheelEvent
from PySide6.QtWidgets import QApplication, QAbstractSpinBox, QComboBox, QWidget

_GUARD_PROP = "_gamedraft_wheel_guarded"


class _ComboWheelBlocker(QObject):
    def eventFilter(self, obj: QObject, event: object) -> bool:  # noqa: N802
        # 使用 isinstance 避免 event.type() 与 QEvent.Type 比较时触发 Shiboken SystemError（含 Ctrl+C 收尾阶段）
        if not isinstance(event, QWheelEvent):
            return False
        w = obj if isinstance(obj, QWidget) else None
        while w is not None:
            if isinstance(w, QComboBox):
                view = w.view()
                if view is not None and view.isVisible():
                    return False
                return True
            if isinstance(w, QAbstractSpinBox):
                return not w.hasFocus()
            w = w.parentWidget()
        return False


def install_global_combo_wheel_block(app: QApplication) -> None:
    """给现有和后续创建的取值控件安装滚轮过滤器；重复调用无效。

    不在 QApplication 上安装全局 event filter：QtWebEngine 会从 Chromium
    线程投递内部 QObject 事件，PySide 在包装这些内部对象时可能 native crash。

    去重用 widget 自身的动态属性（随控件销毁消失）——不能用 id(widget) 集合：
    CPython 会复用被销毁控件的内存地址，会让新控件被误判"已装"而漏防护。
    """
    if getattr(app, "_gamedraft_combo_wheel_blocker_installed", False):
        return
    blocker = _ComboWheelBlocker(app)

    def install_on_widgets() -> None:
        for widget in app.allWidgets():
            if not isinstance(widget, (QComboBox, QAbstractSpinBox)):
                continue
            if widget.property(_GUARD_PROP):
                continue
            widget.installEventFilter(blocker)
            widget.setProperty(_GUARD_PROP, True)

    install_on_widgets()
    timer = QTimer(app)
    timer.setInterval(750)
    timer.timeout.connect(install_on_widgets)
    timer.start()

    app._gamedraft_combo_wheel_blocker = blocker  # 防止被 GC
    app._gamedraft_combo_wheel_timer = timer
    app._gamedraft_combo_wheel_blocker_installed = True
