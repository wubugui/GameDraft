"""全局禁止鼠标滚轮在未展开的下拉框上切换 QComboBox 当前项。

已展开的下拉列表内仍可用滚轮滚动列表（事件目标一般不在 QComboBox 父链上）。"""
from __future__ import annotations

from PySide6.QtCore import QObject, QTimer
from PySide6.QtGui import QWheelEvent
from PySide6.QtWidgets import QApplication, QComboBox, QWidget


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
            w = w.parentWidget()
        return False


def install_global_combo_wheel_block(app: QApplication) -> None:
    """给现有和后续创建的 QComboBox 安装滚轮过滤器；重复调用无效。

    不在 QApplication 上安装全局 event filter：QtWebEngine 会从 Chromium
    线程投递内部 QObject 事件，PySide 在包装这些内部对象时可能 native crash。
    """
    if getattr(app, "_gamedraft_combo_wheel_blocker_installed", False):
        return
    blocker = _ComboWheelBlocker(app)

    installed: set[int] = set()

    def install_on_combo_boxes() -> None:
        for widget in app.allWidgets():
            if not isinstance(widget, QComboBox):
                continue
            key = id(widget)
            if key in installed:
                continue
            widget.installEventFilter(blocker)
            installed.add(key)

    install_on_combo_boxes()
    timer = QTimer(app)
    timer.setInterval(750)
    timer.timeout.connect(install_on_combo_boxes)
    timer.start()

    app._gamedraft_combo_wheel_blocker = blocker  # 防止被 GC
    app._gamedraft_combo_wheel_timer = timer
    app._gamedraft_combo_wheel_blocker_installed = True
