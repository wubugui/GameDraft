"""Animation config editor with sprite preview."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QSpinBox, QPushButton, QLabel,
    QTableWidget, QTableWidgetItem, QHeaderView, QScrollArea,
)
from PySide6.QtGui import QPixmap
from PySide6.QtCore import Qt

from ..project_model import ProjectModel


class AnimEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_key: str | None = None

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        self._list = QListWidget()
        self._list.currentTextChanged.connect(self._on_select)
        ll.addWidget(self._list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = QFormLayout()
        self._a_sheet = QLineEdit(); f.addRow("spritesheet", self._a_sheet)
        self._a_cols = QSpinBox(); self._a_cols.setRange(1, 99); f.addRow("cols", self._a_cols)
        self._a_rows = QSpinBox(); self._a_rows.setRange(1, 99); f.addRow("rows", self._a_rows)
        self._a_ww = QSpinBox(); self._a_ww.setRange(1, 9999); f.addRow("worldWidth", self._a_ww)
        self._a_wh = QSpinBox(); self._a_wh.setRange(1, 9999); f.addRow("worldHeight", self._a_wh)
        dl.addLayout(f)

        dl.addWidget(QLabel("<b>States</b>"))
        self._state_table = QTableWidget(0, 4)
        self._state_table.setHorizontalHeaderLabels(["name", "frames", "frameRate", "loop"])
        self._state_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        dl.addWidget(self._state_table)
        state_btns = QHBoxLayout()
        add_st = QPushButton("+ State"); add_st.clicked.connect(self._add_state)
        state_btns.addWidget(add_st)
        dl.addLayout(state_btns)

        self._preview = QLabel()
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        dl.addWidget(self._preview)

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([200, 600])
        root.addWidget(splitter)
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        for k in self._model.animations:
            self._list.addItem(k)

    def _on_select(self, key: str) -> None:
        if not key or key not in self._model.animations:
            return
        self._current_key = key
        a = self._model.animations[key]
        self._a_sheet.setText(a.get("spritesheet", ""))
        self._a_cols.setValue(a.get("cols", 1))
        self._a_rows.setValue(a.get("rows", 1))
        self._a_ww.setValue(a.get("worldWidth", 100))
        self._a_wh.setValue(a.get("worldHeight", 100))

        states = a.get("states", {})
        self._state_table.setRowCount(len(states))
        for i, (sname, sdef) in enumerate(states.items()):
            self._state_table.setItem(i, 0, QTableWidgetItem(sname))
            self._state_table.setItem(i, 1, QTableWidgetItem(str(sdef.get("frames", []))))
            self._state_table.setItem(i, 2, QTableWidgetItem(str(sdef.get("frameRate", 8))))
            self._state_table.setItem(i, 3, QTableWidgetItem(str(sdef.get("loop", True))))

        sheet_path = a.get("spritesheet", "")
        if sheet_path and self._model.project_path:
            full = self._model.project_path / "public" / sheet_path.lstrip("/")
            if full.exists():
                pm = QPixmap(str(full))
                self._preview.setPixmap(pm.scaled(300, 200, Qt.AspectRatioMode.KeepAspectRatio))

    def _add_state(self) -> None:
        r = self._state_table.rowCount()
        self._state_table.insertRow(r)
        self._state_table.setItem(r, 0, QTableWidgetItem("new_state"))
        self._state_table.setItem(r, 1, QTableWidgetItem("[0]"))
        self._state_table.setItem(r, 2, QTableWidgetItem("8"))
        self._state_table.setItem(r, 3, QTableWidgetItem("True"))

    def _apply(self) -> None:
        if self._current_key is None:
            return
        a = self._model.animations[self._current_key]
        a["spritesheet"] = self._a_sheet.text()
        a["cols"] = self._a_cols.value()
        a["rows"] = self._a_rows.value()
        a["worldWidth"] = self._a_ww.value()
        a["worldHeight"] = self._a_wh.value()
        states: dict = {}
        for i in range(self._state_table.rowCount()):
            name_item = self._state_table.item(i, 0)
            frames_item = self._state_table.item(i, 1)
            rate_item = self._state_table.item(i, 2)
            loop_item = self._state_table.item(i, 3)
            if name_item and name_item.text():
                import json
                try:
                    frames = json.loads(frames_item.text()) if frames_item else [0]
                except Exception:
                    frames = [0]
                states[name_item.text()] = {
                    "frames": frames,
                    "frameRate": int(rate_item.text()) if rate_item else 8,
                    "loop": loop_item.text().lower() in ("true", "1", "yes") if loop_item else True,
                }
        a["states"] = states
        self._model.mark_dirty("animation")
