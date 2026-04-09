from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QFormLayout, QLineEdit, QLabel,
    QTableWidget, QTableWidgetItem, QHeaderView, QPushButton, QHBoxLayout,
)
from PySide6.QtCore import Signal, Qt

from ..model.node_types import NodeData
from .condition_editor import ConditionEditor
from .action_editor import ActionEditor


def _polygon_from_legacy_rect(d: dict) -> list[dict[str, float]]:
    x = float(d.get("x", 0))
    y = float(d.get("y", 0))
    w = float(d.get("width", 100))
    h = float(d.get("height", 100))
    if w <= 0 or h <= 0:
        return [
            {"x": round(x, 1), "y": round(y, 1)},
            {"x": round(x + 100, 1), "y": round(y, 1)},
            {"x": round(x + 50, 1), "y": round(y + 60, 1)},
        ]
    return [
        {"x": round(x, 1), "y": round(y, 1)},
        {"x": round(x + w, 1), "y": round(y, 1)},
        {"x": round(x + w, 1), "y": round(y + h, 1)},
        {"x": round(x, 1), "y": round(y + h, 1)},
    ]


class ZonePanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        self._poly_updating = False
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        form.addRow("ID:", self.id_edit)
        layout.addLayout(form)

        hint = QLabel(
            "polygon：闭合边界顶点顺序（首尾不重复）；与场景编辑器顶点表结构一致。")
        hint.setWordWrap(True)
        layout.addWidget(hint)

        self._poly_table = QTableWidget(0, 3)
        self._poly_table.setHorizontalHeaderLabels(["#", "x", "y"])
        self._poly_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._poly_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._poly_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self._poly_table.setMinimumHeight(200)
        self._poly_table.itemChanged.connect(self._on_poly_cell_changed)
        layout.addWidget(self._poly_table)

        btn_row = QHBoxLayout()
        self._btn_add = QPushButton("添加顶点")
        self._btn_add.clicked.connect(self._on_add_vertex)
        self._btn_del = QPushButton("删除选中顶点")
        self._btn_del.clicked.connect(self._on_remove_vertex)
        self._btn_quad = QPushButton("生成轴对齐四边形")
        self._btn_quad.setToolTip("按当前顶点包围盒生成轴对齐矩形四点")
        self._btn_quad.clicked.connect(self._on_axis_quad)
        btn_row.addWidget(self._btn_add)
        btn_row.addWidget(self._btn_del)
        btn_row.addWidget(self._btn_quad)
        layout.addLayout(btn_row)

        self.cond_editor = ConditionEditor("Conditions")
        layout.addWidget(self.cond_editor)

        self.enter_editor = ActionEditor("onEnter Actions")
        layout.addWidget(self.enter_editor)

        self.stay_editor = ActionEditor("onStay Actions")
        layout.addWidget(self.stay_editor)

        self.exit_editor = ActionEditor("onExit Actions")
        layout.addWidget(self.exit_editor)

        layout.addStretch()

        self.cond_editor.changed.connect(self._mark_dirty)
        self.enter_editor.changed.connect(self._mark_dirty)
        self.stay_editor.changed.connect(self._mark_dirty)
        self.exit_editor.changed.connect(self._mark_dirty)

    def _parse_cell_float(self, it: QTableWidgetItem | None, default: float = 0.0) -> float:
        if it is None:
            return default
        try:
            return float(it.text().strip())
        except ValueError:
            return default

    def _polygon_from_table(self) -> list[dict[str, float]]:
        t = self._poly_table
        out: list[dict[str, float]] = []
        for r in range(t.rowCount()):
            x = round(self._parse_cell_float(t.item(r, 1)), 1)
            y = round(self._parse_cell_float(t.item(r, 2)), 1)
            out.append({"x": x, "y": y})
        return out

    def _set_poly_table(self, polygon: list) -> None:
        self._poly_updating = True
        try:
            t = self._poly_table
            t.blockSignals(True)
            t.setRowCount(0)
            if not isinstance(polygon, list):
                polygon = []
            for p in polygon:
                if not isinstance(p, dict):
                    continue
                r = t.rowCount()
                t.insertRow(r)
                ix = QTableWidgetItem(str(r + 1))
                ix.setFlags(ix.flags() & ~Qt.ItemFlag.ItemIsEditable)
                t.setItem(r, 0, ix)
                t.setItem(r, 1, QTableWidgetItem(str(round(float(p.get("x", 0)), 1))))
                t.setItem(r, 2, QTableWidgetItem(str(round(float(p.get("y", 0)), 1))))
            t.blockSignals(False)
            for r in range(t.rowCount()):
                it0 = t.item(r, 0)
                if it0:
                    it0.setText(str(r + 1))
        finally:
            self._poly_updating = False

    def _emit_if_valid_polygon(self) -> None:
        if self._poly_updating or not self._nd:
            return
        poly = self._polygon_from_table()
        if len(poly) < 3:
            return
        d = self._nd.data
        d["polygon"] = poly
        for k in ("x", "y", "width", "height"):
            d.pop(k, None)
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)

    def _on_poly_cell_changed(self, item: QTableWidgetItem) -> None:
        if self._poly_updating or item.column() == 0:
            return
        self._emit_if_valid_polygon()

    def _on_add_vertex(self) -> None:
        if not self._nd:
            return
        t = self._poly_table
        poly = self._polygon_from_table()
        row = t.currentRow()
        if row < 0 and t.rowCount() > 0:
            row = t.rowCount() - 1
        if len(poly) == 0:
            nx, ny, ins_at = 0.0, 0.0, 0
        elif len(poly) < 2:
            nx = poly[0]["x"] + 10.0
            ny = poly[0]["y"]
            ins_at = 1
        else:
            i = max(0, min(row, len(poly) - 1))
            j = (i + 1) % len(poly)
            nx = (poly[i]["x"] + poly[j]["x"]) * 0.5
            ny = (poly[i]["y"] + poly[j]["y"]) * 0.5
            ins_at = i + 1
        poly.insert(ins_at, {"x": round(nx, 1), "y": round(ny, 1)})
        self._set_poly_table(poly)
        self._emit_if_valid_polygon()

    def _on_remove_vertex(self) -> None:
        if not self._nd:
            return
        t = self._poly_table
        row = t.currentRow()
        if row < 0 or t.rowCount() <= 3:
            return
        poly = self._polygon_from_table()
        if row < len(poly):
            del poly[row]
        self._set_poly_table(poly)
        self._emit_if_valid_polygon()

    def _on_axis_quad(self) -> None:
        if not self._nd:
            return
        poly = self._polygon_from_table()
        if len(poly) < 1:
            poly = [
                {"x": 0, "y": 0}, {"x": 100, "y": 0},
                {"x": 100, "y": 80}, {"x": 0, "y": 80},
            ]
            self._set_poly_table(poly)
            self._emit_if_valid_polygon()
            return
        xs = [p["x"] for p in poly]
        ys = [p["y"] for p in poly]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        if x1 - x0 < 1:
            x1 = x0 + 100
        if y1 - y0 < 1:
            y1 = y0 + 80
        quad = [
            {"x": round(x0, 1), "y": round(y0, 1)},
            {"x": round(x1, 1), "y": round(y0, 1)},
            {"x": round(x1, 1), "y": round(y1, 1)},
            {"x": round(x0, 1), "y": round(y1, 1)},
        ]
        self._set_poly_table(quad)
        self._emit_if_valid_polygon()

    def _write_editors_to_dict(self, d: dict) -> None:
        conds = self.cond_editor.to_list()
        if conds:
            d["conditions"] = conds
        elif "conditions" in d:
            del d["conditions"]
        enter = self.enter_editor.to_list()
        if enter:
            d["onEnter"] = enter
        elif "onEnter" in d:
            del d["onEnter"]
        stay = self.stay_editor.to_list()
        if stay:
            d["onStay"] = stay
        elif "onStay" in d:
            del d["onStay"]
        exit_acts = self.exit_editor.to_list()
        if exit_acts:
            d["onExit"] = exit_acts
        elif "onExit" in d:
            del d["onExit"]
        if "ruleSlots" in d:
            del d["ruleSlots"]

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        poly = d.get("polygon")
        if isinstance(poly, list) and len(poly) >= 3:
            self._set_poly_table(poly)
        else:
            fixed = _polygon_from_legacy_rect(d)
            self._set_poly_table(fixed)
            d["polygon"] = fixed
            for k in ("x", "y", "width", "height"):
                d.pop(k, None)
            nd.dirty = True
            self.data_changed.emit(nd.id)
        self.cond_editor.set_data(d.get("conditions", []))
        self.enter_editor.set_data(d.get("onEnter", []))
        self.stay_editor.set_data(d.get("onStay", []))
        self.exit_editor.set_data(d.get("onExit", []))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        poly = self._polygon_from_table()
        if len(poly) >= 3:
            d["polygon"] = poly
        for k in ("x", "y", "width", "height"):
            d.pop(k, None)
        self._write_editors_to_dict(d)
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
