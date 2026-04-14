"""全局禁止鼠标滚轮在未展开的下拉框上切换 QComboBox 当前项。

已展开的下拉列表内仍可用滚轮滚动列表（事件目标一般不在 QComboBox 父链上）。"""
from __future__ import annotations

from PySide6.QtCore import QObject
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
    """在 QApplication 上安装事件过滤器；重复调用无效。"""
    if getattr(app, "_gamedraft_combo_wheel_blocker_installed", False):
        return
    blocker = _ComboWheelBlocker(app)
    app.installEventFilter(blocker)
    app._gamedraft_combo_wheel_blocker = blocker  # 防止被 GC
    app._gamedraft_combo_wheel_blocker_installed = True
