"""Flag condition / setFlag value: bool, float, string, or raw (matches FlagStore).

数据安全契约：
- 未登记 flag 不得假设 bool——进 raw 模式按 JSON 字面量编辑（true / 3 / "文本"），
  杜绝「数值条件被静默 bool 化 / op== 丢 value 键」的语义翻转。
- 所有模式做原值保留：控件当前状态与最近一次 set_value 的原值等价时，
  get_value() 原样返回原对象（int 不漂成 float、字符串 "true" 不变 bool）。
"""
from __future__ import annotations

import json

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


def _render_raw(v: object) -> str:
    try:
        return json.dumps(v, ensure_ascii=False)
    except (TypeError, ValueError):
        return _to_str(v)


class FlagValueEdit(QWidget):
    valueChanged = Signal()

    _NO_ORIG = object()

    def __init__(self, parent: QWidget | None = None, registry: dict | None = None):
        super().__init__(parent)
        self._registry: dict = dict(registry) if registry else {}
        self._flag_key: str = ""
        self._mode: str = "bool"
        self._orig_value: object = self._NO_ORIG

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self._bool_combo = QComboBox()
        self._bool_combo.addItem("false", False)
        self._bool_combo.addItem("true", True)
        self._bool_combo.setMaximumWidth(72)
        self._bool_combo.currentIndexChanged.connect(lambda *_: self.valueChanged.emit())

        self._spin = QDoubleSpinBox()
        self._spin.setRange(-1e12, 1e12)
        self._spin.setDecimals(4)
        self._spin.setMaximumWidth(110)
        self._spin.valueChanged.connect(lambda *_: self.valueChanged.emit())

        self._line = QLineEdit()
        self._line.setPlaceholderText("字符串")
        self._line.setMinimumWidth(80)
        self._line.textChanged.connect(lambda *_: self.valueChanged.emit())

        self._raw_line = QLineEdit()
        self._raw_line.setPlaceholderText('true / 3 / "文本"')
        self._raw_line.setToolTip(
            "该 flag 未在登记表登记，按 JSON 字面量编辑：true、false、数字、\"字符串\"。\n"
            "未改动时按原始类型原样保存。"
        )
        self._raw_line.setMinimumWidth(90)
        self._raw_line.textChanged.connect(lambda *_: self.valueChanged.emit())

        lay.addWidget(self._bool_combo)
        lay.addWidget(self._spin)
        lay.addWidget(self._line)
        lay.addWidget(self._raw_line)
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
        from ..flag_registry import registry_value_type_for_key

        want = registry_value_type_for_key(self._flag_key, self._registry) or "raw"
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
        self._raw_line.setVisible(self._mode == "raw")

    def set_value(self, v: object) -> None:
        self._orig_value = v
        self._bool_combo.blockSignals(True)
        self._spin.blockSignals(True)
        self._line.blockSignals(True)
        self._raw_line.blockSignals(True)
        try:
            if self._mode == "bool":
                self._bool_combo.setCurrentIndex(1 if _to_bool(v) else 0)
            elif self._mode == "string":
                self._line.setText(_to_str(v))
            elif self._mode == "raw":
                self._raw_line.setText(_render_raw(v))
            else:
                try:
                    self._spin.setValue(_to_float(v))
                except (ValueError, OverflowError):
                    self._spin.setValue(0.0)
        finally:
            self._bool_combo.blockSignals(False)
            self._spin.blockSignals(False)
            self._line.blockSignals(False)
            self._raw_line.blockSignals(False)

    def _widget_matches_orig(self) -> bool:
        """控件当前状态是否仍等价于最近一次 set_value 的原值（未被用户改动）。"""
        if self._orig_value is self._NO_ORIG:
            return False
        o = self._orig_value
        if self._mode == "bool":
            return self._bool_combo.currentIndex() == (1 if _to_bool(o) else 0)
        if self._mode == "string":
            return self._line.text() == _to_str(o)
        if self._mode == "raw":
            return self._raw_line.text() == _render_raw(o)
        try:
            return float(self._spin.value()) == _to_float(o)
        except (ValueError, OverflowError):
            return False

    def get_value(self) -> object:
        if self._widget_matches_orig():
            return self._orig_value
        if self._mode == "bool":
            d = self._bool_combo.currentData()
            if d is None:
                return self._bool_combo.currentText().lower() == "true"
            return bool(d)
        if self._mode == "string":
            return self._line.text()
        if self._mode == "raw":
            text = self._raw_line.text().strip()
            if not text:
                return ""
            try:
                return json.loads(text)
            except ValueError:
                return text
        return float(self._spin.value())
