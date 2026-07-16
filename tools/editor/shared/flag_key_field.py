"""Single-line flag key: read-only display + button opening FlagPickerDialog."""
from __future__ import annotations

from PySide6.QtWidgets import QWidget, QHBoxLayout, QLineEdit, QPushButton, QDialog
from PySide6.QtCore import Signal


class FlagKeyPickField(QWidget):
    valueChanged = Signal()

    def __init__(
        self,
        model,
        scene_id: str | None,
        current: str = "",
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self._edit = QLineEdit(current or "")
        self._edit.setReadOnly(True)
        self._edit.setPlaceholderText("点击「选择…」打开登记表…")
        self._btn = QPushButton("选择…")
        self._btn.clicked.connect(self._pick)
        lay.addWidget(self._edit, stretch=1)
        lay.addWidget(self._btn)

    def set_context(self, model, scene_id: str | None) -> None:
        self._model = model
        self._scene_id = scene_id

    def _pick(self) -> None:
        if self._model is None:
            return
        from .flag_picker_dialog import FlagPickerDialog
        dlg = FlagPickerDialog(self._model, self._scene_id, self._edit.text().strip(), self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._edit.setText(dlg.selected_key())
            self.valueChanged.emit()

    def key(self) -> str:
        return self._edit.text().strip()

    def set_key(self, key: str) -> None:
        s = key or ""
        if self._edit.text() == s:
            return
        self._edit.setText(s)
        self.valueChanged.emit()

    def set_key_silent(self, key: str) -> None:
        """程序性设值，不发 valueChanged（供 set_dict 等载入路径用，避免误标脏）。

        与 IdRefSelector.set_current 语义一致：程序性 set 不外发信号。
        注意：常规 set_key 仍会发信号——condition_editor 的模板套用依赖该副作用置脏，
        不可改动其行为，故新增本静默变体而非改 set_key。
        """
        self._edit.setText(key or "")
