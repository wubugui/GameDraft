"""Map node editor with draggable canvas."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QPushButton, QDoubleSpinBox, QScrollArea,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsTextItem,
)
from PySide6.QtGui import QPen, QBrush, QColor, QFont, QPainter, QWheelEvent
from PySide6.QtCore import Qt, Signal

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.id_ref_selector import IdRefSelector


class MapEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Node"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        center = QWidget()
        cl = QVBoxLayout(center)
        self._map_scene = QGraphicsScene()
        self._map_view = QGraphicsView(self._map_scene)
        self._map_view.setRenderHint(QPainter.RenderHint.Antialiasing)
        self._map_view.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        cl.addWidget(self._map_view)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = QFormLayout(detail)
        self._m_scene = IdRefSelector(allow_empty=False)
        f.addRow("sceneId", self._m_scene)
        self._m_name = QLineEdit(); f.addRow("name", self._m_name)
        self._m_x = QDoubleSpinBox(); self._m_x.setRange(-9999, 9999)
        f.addRow("x", self._m_x)
        self._m_y = QDoubleSpinBox(); self._m_y.setRange(-9999, 9999)
        f.addRow("y", self._m_y)
        self._m_cond = ConditionEditor("unlockConditions")
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(scroll)
        scroll.setWidget(detail)
        rl.addWidget(self._m_cond)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(center)
        splitter.addWidget(right)
        splitter.setSizes([180, 400, 300])
        root.addWidget(splitter)
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        self._map_scene.clear()
        for i, n in enumerate(self._model.map_nodes):
            self._list.addItem(f"{n.get('sceneId', '?')}  [{n.get('name', '')}]")
            x, y = n.get("x", 0), n.get("y", 0)
            el = self._map_scene.addEllipse(x - 12, y - 12, 24, 24,
                                             QPen(QColor(100, 200, 255)),
                                             QBrush(QColor(40, 80, 140)))
            txt = self._map_scene.addText(n.get("name", "?"), QFont("Consolas", 7))
            txt.setDefaultTextColor(Qt.GlobalColor.white)
            txt.setPos(x + 14, y - 8)
        self._m_scene.set_items([(s, s) for s in self._model.all_scene_ids()])

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.map_nodes):
            return
        self._current_idx = row
        n = self._model.map_nodes[row]
        self._m_scene.set_current(n.get("sceneId", ""))
        self._m_name.setText(n.get("name", ""))
        self._m_x.setValue(n.get("x", 0))
        self._m_y.setValue(n.get("y", 0))
        mf = self._model.registry_flag_choices(None)
        self._m_cond.set_flag_pattern_context(self._model, None)
        self._m_cond.set_flags(mf)
        self._m_cond.set_data(n.get("unlockConditions", []))

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        n = self._model.map_nodes[self._current_idx]
        n["sceneId"] = self._m_scene.current_id()
        n["name"] = self._m_name.text()
        n["x"] = self._m_x.value()
        n["y"] = self._m_y.value()
        n["unlockConditions"] = self._m_cond.to_list()
        self._model.mark_dirty("map")
        self._refresh()

    def _add(self) -> None:
        self._model.map_nodes.append({
            "sceneId": "", "name": "New", "x": 100, "y": 100, "unlockConditions": [],
        })
        self._model.mark_dirty("map")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.map_nodes.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("map")
            self._refresh()
