"""火势比较值：自填数值，或读取当前挂件的护火教学安全线。"""
from copy import deepcopy
from math import isfinite

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QWidget, QHBoxLayout, QComboBox, QDoubleSpinBox


class VitalityThresholdField(QWidget):
    valueChanged = Signal(object)

    def __init__(self, parent=None):
        super().__init__(parent)
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        self.source = QComboBox(self)
        self.source.addItem("指定数值", "number")
        self.source.addItem("预设安全线", "guardSafety")
        self.source.setMaximumWidth(160)
        self.setMaximumWidth(270)
        self.number = QDoubleSpinBox(self)
        self.number.setRange(0, 1)
        self.number.setDecimals(3)
        self.number.setSingleStep(0.05)
        self.number.setMaximumWidth(96)
        row.addWidget(self.source)
        row.addWidget(self.number)
        self.setToolTip("预设安全线读取当前手持挂件的「玩家操作 → 护火教学安全线」。\n未配置安全线时条件不成立，教学动作报错；不会偷偷使用固定值。")
        self.source.currentIndexChanged.connect(self._changed)
        self.number.valueChanged.connect(self._changed)
        self.setValue(0.5)

    def _snapshot(self):
        return self.source.currentData(), self.number.value()

    def _changed(self, *_args):
        self.number.setVisible(self.source.currentData() == "number")
        self.valueChanged.emit(self.value())

    def setValue(self, value):
        self.source.blockSignals(True)
        self.number.blockSignals(True)
        try:
            while self.source.count() > 2:
                self.source.removeItem(2)
            if value == "guardSafety":
                self.source.setCurrentIndex(1)
            elif isinstance(value, (int, float)) and not isinstance(value, bool) and isfinite(value):
                self.source.setCurrentIndex(0)
                self.number.setValue(value)
            else:
                self.source.addItem(f"（数据）{value!r}", "raw")
                self.source.setCurrentIndex(2)
            self._raw = deepcopy(value)
            self._seed = self._snapshot()
            self.number.setVisible(self.source.currentData() == "number")
        finally:
            self.source.blockSignals(False)
            self.number.blockSignals(False)
        self.valueChanged.emit(value)

    def value(self):
        if self._snapshot() == self._seed or self.source.currentData() == "raw":
            return deepcopy(self._raw)
        return "guardSafety" if self.source.currentData() == "guardSafety" else self.number.value()
