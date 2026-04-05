"""Quest editor with list, detail panel, and flow graph."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsTextItem,
    QGraphicsLineItem, QScrollArea,
)
from PySide6.QtGui import QPen, QBrush, QColor, QFont, QPainter
from PySide6.QtCore import Qt, Signal

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor
from ..shared.id_ref_selector import IdRefSelector


class QuestEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # left: list + flow
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Quest"); btn_add.clicked.connect(self._add_quest)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_quest)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        # flow graph
        self._flow_scene = QGraphicsScene()
        self._flow_view = QGraphicsView(self._flow_scene)
        self._flow_view.setRenderHint(QPainter.RenderHint.Antialiasing)
        self._flow_view.setMaximumHeight(200)
        ll.addWidget(QLabel("Quest Chain"))
        ll.addWidget(self._flow_view)

        # right: detail
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        detail = QWidget()
        form = QVBoxLayout(detail)
        f = QFormLayout()
        self._q_id = QLineEdit(); f.addRow("id", self._q_id)
        self._q_type = QComboBox(); self._q_type.addItems(["main", "side"])
        f.addRow("type", self._q_type)
        self._q_side_type = QComboBox()
        self._q_side_type.addItems(["", "errand", "inquiry", "investigation", "commission"])
        f.addRow("sideType", self._q_side_type)
        self._q_title = QLineEdit(); f.addRow("title", self._q_title)
        self._q_desc = QTextEdit(); self._q_desc.setMaximumHeight(80)
        f.addRow("description", self._q_desc)
        self._q_next = IdRefSelector(allow_empty=True)
        f.addRow("nextQuestId", self._q_next)
        form.addLayout(f)
        self._q_pre = ConditionEditor("Preconditions"); form.addWidget(self._q_pre)
        self._q_comp = ConditionEditor("Completion Conditions"); form.addWidget(self._q_comp)
        self._q_rewards = ActionEditor("Rewards"); form.addWidget(self._q_rewards)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        form.addWidget(apply_btn)
        form.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([350, 600])
        root.addWidget(splitter)
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        for i, q in enumerate(self._model.quests):
            tag = "[M]" if q.get("type") == "main" else "[S]"
            self._list.addItem(f"{tag} {q.get('id', '?')}  {q.get('title', '')}")
        self._q_next.set_items(self._model.all_quest_ids())
        self._rebuild_flow()

    def _rebuild_flow(self) -> None:
        self._flow_scene.clear()
        nodes: dict[str, tuple[float, float]] = {}
        x = 0
        for q in self._model.quests:
            nodes[q["id"]] = (x, 20 if q.get("type") == "main" else 60)
            x += 140
        for qid, (px, py) in nodes.items():
            el = self._flow_scene.addEllipse(px, py, 100, 30,
                                              QPen(QColor(200, 200, 255)),
                                              QBrush(QColor(60, 80, 140)))
            txt = self._flow_scene.addText(qid, QFont("Consolas", 7))
            txt.setDefaultTextColor(Qt.GlobalColor.white)
            txt.setPos(px + 5, py + 5)
        for q in self._model.quests:
            nxt = q.get("nextQuestId")
            if nxt and nxt in nodes:
                sx, sy = nodes[q["id"]]
                ex, ey = nodes[nxt]
                self._flow_scene.addLine(sx + 100, sy + 15, ex, ey + 15,
                                          QPen(QColor(180, 180, 255), 2))

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.quests):
            return
        self._current_idx = row
        q = self._model.quests[row]
        self._q_id.setText(q.get("id", ""))
        self._q_type.setCurrentText(q.get("type", "main"))
        self._q_side_type.setCurrentText(q.get("sideType", ""))
        self._q_title.setText(q.get("title", ""))
        self._q_desc.setPlainText(q.get("description", ""))
        self._q_next.set_current(q.get("nextQuestId", ""))
        flags = self._model.registry_flag_choices(None)
        self._q_pre.set_flag_pattern_context(self._model, None)
        self._q_comp.set_flag_pattern_context(self._model, None)
        self._q_pre.set_flags(flags)
        self._q_comp.set_flags(flags)
        self._q_pre.set_data(q.get("preconditions", []))
        self._q_comp.set_data(q.get("completionConditions", []))
        self._q_rewards.set_flag_completions(flags)
        self._q_rewards.set_data(q.get("rewards", []))

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        q = self._model.quests[self._current_idx]
        q["id"] = self._q_id.text().strip()
        q["type"] = self._q_type.currentText()
        st = self._q_side_type.currentText()
        if st:
            q["sideType"] = st
        elif "sideType" in q:
            del q["sideType"]
        q["title"] = self._q_title.text()
        q["description"] = self._q_desc.toPlainText()
        nxt = self._q_next.current_id()
        if nxt:
            q["nextQuestId"] = nxt
        elif "nextQuestId" in q:
            del q["nextQuestId"]
        q["preconditions"] = self._q_pre.to_list()
        q["completionConditions"] = self._q_comp.to_list()
        q["rewards"] = self._q_rewards.to_list()
        self._model.mark_dirty("quest")
        self._refresh()

    def _add_quest(self) -> None:
        self._model.quests.append({
            "id": f"quest_{len(self._model.quests)}",
            "type": "main", "title": "New Quest", "description": "",
            "preconditions": [], "completionConditions": [], "rewards": [],
        })
        self._model.mark_dirty("quest")
        self._refresh()

    def _del_quest(self) -> None:
        if self._current_idx >= 0:
            self._model.quests.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("quest")
            self._refresh()
