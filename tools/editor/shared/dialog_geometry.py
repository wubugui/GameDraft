"""弹窗几何记忆：让弹窗可缩放并跨会话记忆大小/位置（小屏友好）。

与主窗口 (`main_window.py`) 同一套 QSettings 范式，抽出复用。仅影响窗口几何，
不触碰任何数据/逻辑/序列化。用法：

    from ..shared.dialog_geometry import remember_dialog_geometry
    remember_dialog_geometry(self, "flag_picker")   # 构造末尾、resize() 之后调用

`remember_*` 会在调用时用已保存几何覆盖默认尺寸，并挂到 QDialog.finished
信号上，于每次关闭时回存——无需各弹窗自己改 closeEvent。
"""
from __future__ import annotations

from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QDialog, QWidget

_ORG = "GameDraft"
_APP = "Editor"


def restore_dialog_geometry(dlg: QWidget, key: str) -> None:
    geo = QSettings(_ORG, _APP).value(f"dialogGeometry/{key}")
    if geo is not None:
        try:
            dlg.restoreGeometry(geo)
        except Exception:
            pass


def save_dialog_geometry(dlg: QWidget, key: str) -> None:
    try:
        QSettings(_ORG, _APP).setValue(f"dialogGeometry/{key}", dlg.saveGeometry())
    except Exception:
        pass


def remember_dialog_geometry(dlg: QWidget, key: str) -> None:
    """恢复已保存几何，并在弹窗关闭时自动回存（QDialog）。"""
    restore_dialog_geometry(dlg, key)
    if isinstance(dlg, QDialog):
        dlg.finished.connect(lambda _r, _d=dlg, _k=key: save_dialog_geometry(_d, _k))
