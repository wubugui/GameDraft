"""Flag condition / setFlag value: bool, float, or string (matches FlagStore)."""
from __future__ import annotations

from PySide6.QtWidgets import QWidget, QHBoxLayout, QComboBox, QDoubleSpinBox, QLineEdit
from PySide6.QtCore import Signal


def _to_bool(v: object) -> bool:
    if v is True or v is False:
        return bool(v)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, str):
        s = v.strip().lower()
        if s == "false" or s == "0":
            return False
        if s == "true":
            return True
        try:
            return float(s) != 0
        except ValueError:
            return True
    return True


def _to_str(v: object) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    return "" if v is None else str(v)


def _to_float(v: object) -> float:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s.lower() == "true":
            return 1.0
        if s.lower() == "false":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return 0.0
    return 0.0


class FlagValueEdit(QWidget):
    valueChanged = Signal()

    def __init__(self, parent: QWidget | None = None, registry: dict | None = None):
        super().__init__(parent)
        self._registry: dict = dict(registry) if registry else {}
        self._flag_key: str = ""
        self._mode: str = "bool"

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self._bool_combo = QComboBox()
        self._bool_combo.addItem("false", False)
        self._bool_combo.addItem("true", True)
        self._bool_combo.setMaximumWidth(72)
        self._bool_combo.currentIndexChanged.connect(lambda *_: self.valueChanged.emit())

        self._spin = QDoubleSpinBox()
        self._spin.setRange(-1e9, 1e9)
        self._spin.setDecimals(4)
        self._spin.setMaximumWidth(110)
        self._spin.valueChanged.connect(lambda *_: self.valueChanged.emit())

        self._line = QLineEdit()
        self._line.setPlaceholderText("字符串")
        self._line.setMinimumWidth(120)
        self._line.textChanged.connect(lambda *_: self.valueChanged.emit())

        lay.addWidget(self._bool_combo)
        lay.addWidget(self._spin)
        lay.addWidget(self._line)
        self._apply_mode_visibility()

    def set_registry(self, registry: dict | None) -> None:
        self._registry = dict(registry) if registry else {}
        self._update_mode_from_registry()

    def set_flag_key(self, key: str) -> None:
        nk = (key or "").strip()
        if nk == self._flag_key:
            return
        self._flag_key = nk
        self._update_mode_from_registry()

    def _update_mode_from_registry(self) -> None:
        from ..flag_registry import flag_value_type_for_key

        want = flag_value_type_for_key(self._flag_key, self._registry)
        if want == self._mode:
            self._apply_mode_visibility()
            return
        cur = self.get_value()
        self._mode = want
        self._apply_mode_visibility()
        self.set_value(cur)

    def _apply_mode_visibility(self) -> None:
        self._bool_combo.setVisible(self._mode == "bool")
        self._spin.setVisible(self._mode == "float")
        self._line.setVisible(self._mode == "string")

    def set_value(self, v: object) -> None:
        self._bool_combo.blockSignals(True)
        self._spin.blockSignals(True)
        self._line.blockSignals(True)
        try:
            if self._mode == "bool":
                self._bool_combo.setCurrentIndex(1 if _to_bool(v) else 0)
            elif self._mode == "string":
                self._line.setText(_to_str(v))
            else:
                try:
                    self._spin.setValue(_to_float(v))
                except (ValueError, OverflowError):
                    self._spin.setValue(0.0)
        finally:
            self._bool_combo.blockSignals(False)
            self._spin.blockSignals(False)
            self._line.blockSignals(False)

    def get_value(self) -> object:
        if self._mode == "bool":
            d = self._bool_combo.currentData()
            if d is None:
                return self._bool_combo.currentText().lower() == "true"
            return bool(d)
        if self._mode == "string":
            return self._line.text()
        return float(self._spin.value())
