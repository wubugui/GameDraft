"""编辑 public/assets/data/paper_craft：扎纸部件装配小游戏。"""
from __future__ import annotations

from PySide6.QtCore import Signal, Qt
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel, QPushButton,
    QComboBox, QLineEdit, QTextEdit, QSpinBox, QCheckBox, QListWidget,
    QListWidgetItem, QGroupBox,
)


class PaperCraftEditor(QWidget):
    preview_requested = Signal(str)

    def __init__(self, model, parent=None):
        super().__init__(parent)
        self._model = model
        self._doc: dict | None = None
        self._order: dict | None = None
        self._part: dict | None = None
        self._slot: dict | None = None
        self._paper: dict | None = None
        self._finish: dict | None = None
        self._syncing = False

        root = QVBoxLayout(self)
        top = QHBoxLayout()
        root.addLayout(top)

        self.instance_combo = QComboBox()
        self.instance_combo.setMinimumWidth(260)
        self.instance_combo.currentIndexChanged.connect(self._select_instance)
        top.addWidget(QLabel("实例"))
        top.addWidget(self.instance_combo, 1)
        self.preview_btn = QPushButton("预览")
        self.preview_btn.clicked.connect(self._preview)
        top.addWidget(self.preview_btn)

        body = QHBoxLayout()
        root.addLayout(body, 1)

        left = QVBoxLayout()
        body.addLayout(left, 1)
        right = QVBoxLayout()
        body.addLayout(right, 1)

        order_box = QGroupBox("订单")
        order_form = QFormLayout(order_box)
        self.order_combo = QComboBox()
        self.order_combo.currentIndexChanged.connect(self._select_order)
        self.order_title = QLineEdit()
        self.order_title.editingFinished.connect(self._write_order)
        self.order_desc = QTextEdit()
        self.order_desc.setFixedHeight(82)
        self.order_desc.textChanged.connect(self._write_order)
        self.correct_paper_combo = QComboBox()
        self.correct_paper_combo.currentTextChanged.connect(self._write_order)
        self.success_score = QSpinBox()
        self.success_score.setRange(-999, 999)
        self.success_score.valueChanged.connect(self._write_order)
        self.warn_score = QSpinBox()
        self.warn_score.setRange(-999, 999)
        self.warn_score.valueChanged.connect(self._write_order)
        order_form.addRow("订单", self.order_combo)
        order_form.addRow("标题", self.order_title)
        order_form.addRow("描述", self.order_desc)
        order_form.addRow("正确纸色", self.correct_paper_combo)
        order_form.addRow("合格分", self.success_score)
        order_form.addRow("警告分", self.warn_score)
        left.addWidget(order_box)

        part_box = QGroupBox("部件")
        part_form = QFormLayout(part_box)
        self.part_combo = QComboBox()
        self.part_combo.currentIndexChanged.connect(self._select_part)
        self.part_label = QLineEdit()
        self.part_label.editingFinished.connect(self._write_part)
        self.part_score = QSpinBox()
        self.part_score.setRange(-999, 999)
        self.part_score.valueChanged.connect(self._write_part)
        self.part_tags = QLineEdit()
        self.part_tags.setPlaceholderText("逗号分隔，如：点眼犯忌, 红白相冲")
        self.part_tags.editingFinished.connect(self._write_part)
        part_form.addRow("部件", self.part_combo)
        part_form.addRow("显示名", self.part_label)
        part_form.addRow("分数", self.part_score)
        part_form.addRow("结果标签", self.part_tags)
        left.addWidget(part_box)

        slot_box = QGroupBox("槽位")
        slot_form = QFormLayout(slot_box)
        self.slot_combo = QComboBox()
        self.slot_combo.currentIndexChanged.connect(self._select_slot)
        self.slot_label = QLineEdit()
        self.slot_label.editingFinished.connect(self._write_slot)
        self.slot_optional = QCheckBox("可不放")
        self.slot_optional.stateChanged.connect(self._write_slot)
        self.slot_x = self._spin()
        self.slot_y = self._spin()
        self.slot_w = self._spin()
        self.slot_h = self._spin()
        for sp in (self.slot_x, self.slot_y, self.slot_w, self.slot_h):
            sp.valueChanged.connect(self._write_slot)
        self.accepts_list = QListWidget()
        self.accepts_list.setMinimumHeight(170)
        self.accepts_list.itemChanged.connect(self._write_slot_accepts)
        slot_form.addRow("槽位", self.slot_combo)
        slot_form.addRow("显示名", self.slot_label)
        slot_form.addRow("可选", self.slot_optional)
        slot_form.addRow("x", self.slot_x)
        slot_form.addRow("y", self.slot_y)
        slot_form.addRow("宽", self.slot_w)
        slot_form.addRow("高", self.slot_h)
        slot_form.addRow("可接部件", self.accepts_list)
        right.addWidget(slot_box, 1)

        paper_box = QGroupBox("纸色")
        paper_form = QFormLayout(paper_box)
        self.paper_combo = QComboBox()
        self.paper_combo.currentIndexChanged.connect(self._select_paper)
        self.paper_label = QLineEdit()
        self.paper_label.editingFinished.connect(self._write_paper)
        self.paper_score = QSpinBox()
        self.paper_score.setRange(-999, 999)
        self.paper_score.valueChanged.connect(self._write_paper)
        paper_form.addRow("纸色", self.paper_combo)
        paper_form.addRow("显示名", self.paper_label)
        paper_form.addRow("分数", self.paper_score)
        right.addWidget(paper_box)

        finish_box = QGroupBox("收尾")
        finish_form = QFormLayout(finish_box)
        self.finish_combo = QComboBox()
        self.finish_combo.currentIndexChanged.connect(self._select_finish)
        self.finish_label = QLineEdit()
        self.finish_label.editingFinished.connect(self._write_finish)
        self.finish_score = QSpinBox()
        self.finish_score.setRange(-999, 999)
        self.finish_score.valueChanged.connect(self._write_finish)
        self.finish_tags = QLineEdit()
        self.finish_tags.editingFinished.connect(self._write_finish)
        finish_form.addRow("方式", self.finish_combo)
        finish_form.addRow("显示名", self.finish_label)
        finish_form.addRow("分数", self.finish_score)
        finish_form.addRow("结果标签", self.finish_tags)
        right.addWidget(finish_box)

        self.reload()

    def reload(self) -> None:
        self._syncing = True
        self.instance_combo.clear()
        for iid, label in self._model.all_paper_craft_minigame_ids():
            self.instance_combo.addItem(f"{label}  ({iid})", iid)
        self._syncing = False
        self._select_instance()

    def _spin(self) -> QSpinBox:
        sp = QSpinBox()
        sp.setRange(-9999, 9999)
        return sp

    def _mark_dirty(self) -> None:
        self._model.mark_dirty("paper_craft")

    def _preview(self) -> None:
        iid = self.instance_combo.currentData()
        if iid:
            self.preview_requested.emit(str(iid))

    def _select_instance(self) -> None:
        if self._syncing:
            return
        iid = self.instance_combo.currentData()
        self._doc = self._model.paper_craft_instances.get(str(iid)) if iid else None
        self._syncing = True
        self.order_combo.clear()
        for order in (self._doc or {}).get("orders", []):
            if isinstance(order, dict):
                self.order_combo.addItem(str(order.get("title") or order.get("id") or ""), order.get("id"))
        self._syncing = False
        self._select_order()

    def _select_order(self) -> None:
        if self._syncing:
            return
        orders = (self._doc or {}).get("orders", [])
        idx = self.order_combo.currentIndex()
        self._order = orders[idx] if 0 <= idx < len(orders) and isinstance(orders[idx], dict) else None
        self._refresh_order_fields()

    def _refresh_order_fields(self) -> None:
        self._syncing = True
        o = self._order or {}
        self.order_title.setText(str(o.get("title") or ""))
        self.order_desc.setPlainText(str(o.get("description") or ""))
        self.success_score.setValue(int(o.get("successScore") or 76))
        self.warn_score.setValue(int(o.get("warnScore") or 50))

        self.correct_paper_combo.clear()
        for p in o.get("paperOptions", []):
            if isinstance(p, dict):
                self.correct_paper_combo.addItem(str(p.get("label") or p.get("id") or ""), str(p.get("id") or ""))
        cp = str(o.get("correctPaper") or "")
        i = self.correct_paper_combo.findData(cp)
        self.correct_paper_combo.setCurrentIndex(i if i >= 0 else 0)

        self._fill_combo(self.part_combo, o.get("parts", []))
        self._fill_combo(self.slot_combo, o.get("slots", []))
        self._fill_combo(self.paper_combo, o.get("paperOptions", []))
        self._fill_combo(self.finish_combo, o.get("finishOptions", []))
        self._syncing = False
        self._select_part()
        self._select_slot()
        self._select_paper()
        self._select_finish()

    def _fill_combo(self, combo: QComboBox, rows: list) -> None:
        combo.clear()
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict):
                combo.addItem(str(row.get("label") or row.get("id") or ""), row.get("id"))

    def _write_order(self) -> None:
        if self._syncing or not self._order:
            return
        self._order["title"] = self.order_title.text()
        self._order["description"] = self.order_desc.toPlainText()
        self._order["successScore"] = self.success_score.value()
        self._order["warnScore"] = self.warn_score.value()
        self._order["correctPaper"] = str(self.correct_paper_combo.currentData() or "")
        self._mark_dirty()

    def _select_part(self) -> None:
        self._part = self._pick_from("parts", self.part_combo.currentIndex())
        self._syncing = True
        p = self._part or {}
        self.part_label.setText(str(p.get("label") or ""))
        self.part_score.setValue(int(p.get("score") or 0))
        self.part_tags.setText(", ".join(str(x) for x in p.get("tags", []) if x))
        self._syncing = False

    def _write_part(self) -> None:
        if self._syncing or not self._part:
            return
        self._part["label"] = self.part_label.text()
        self._part["score"] = self.part_score.value()
        self._part["tags"] = self._split_tags(self.part_tags.text())
        self._mark_dirty()

    def _select_slot(self) -> None:
        self._slot = self._pick_from("slots", self.slot_combo.currentIndex())
        self._syncing = True
        s = self._slot or {}
        self.slot_label.setText(str(s.get("label") or ""))
        self.slot_optional.setChecked(bool(s.get("optional")))
        self.slot_x.setValue(int(s.get("x") or 0))
        self.slot_y.setValue(int(s.get("y") or 0))
        self.slot_w.setValue(int(s.get("width") or 0))
        self.slot_h.setValue(int(s.get("height") or 0))
        self._refresh_accepts_list()
        self._syncing = False

    def _refresh_accepts_list(self) -> None:
        self.accepts_list.clear()
        accepts = set(str(x) for x in (self._slot or {}).get("accepts", []))
        for p in (self._order or {}).get("parts", []):
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or "")
            item = QListWidgetItem(str(p.get("label") or pid))
            item.setData(Qt.ItemDataRole.UserRole, pid)
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            item.setCheckState(Qt.CheckState.Checked if pid in accepts else Qt.CheckState.Unchecked)
            self.accepts_list.addItem(item)

    def _write_slot(self) -> None:
        if self._syncing or not self._slot:
            return
        self._slot["label"] = self.slot_label.text()
        self._slot["optional"] = self.slot_optional.isChecked()
        self._slot["x"] = self.slot_x.value()
        self._slot["y"] = self.slot_y.value()
        self._slot["width"] = self.slot_w.value()
        self._slot["height"] = self.slot_h.value()
        self._mark_dirty()

    def _write_slot_accepts(self) -> None:
        if self._syncing or not self._slot:
            return
        ids: list[str] = []
        for i in range(self.accepts_list.count()):
            item = self.accepts_list.item(i)
            if item.checkState() == Qt.CheckState.Checked:
                ids.append(str(item.data(Qt.ItemDataRole.UserRole)))
        self._slot["accepts"] = ids
        self._mark_dirty()

    def _select_paper(self) -> None:
        self._paper = self._pick_from("paperOptions", self.paper_combo.currentIndex())
        self._syncing = True
        p = self._paper or {}
        self.paper_label.setText(str(p.get("label") or ""))
        self.paper_score.setValue(int(p.get("score") or 0))
        self._syncing = False

    def _write_paper(self) -> None:
        if self._syncing or not self._paper:
            return
        self._paper["label"] = self.paper_label.text()
        self._paper["score"] = self.paper_score.value()
        self._mark_dirty()

    def _select_finish(self) -> None:
        self._finish = self._pick_from("finishOptions", self.finish_combo.currentIndex())
        self._syncing = True
        f = self._finish or {}
        self.finish_label.setText(str(f.get("label") or ""))
        self.finish_score.setValue(int(f.get("score") or 0))
        self.finish_tags.setText(", ".join(str(x) for x in f.get("tags", []) if x))
        self._syncing = False

    def _write_finish(self) -> None:
        if self._syncing or not self._finish:
            return
        self._finish["label"] = self.finish_label.text()
        self._finish["score"] = self.finish_score.value()
        self._finish["tags"] = self._split_tags(self.finish_tags.text())
        self._mark_dirty()

    def _pick_from(self, key: str, idx: int) -> dict | None:
        rows = (self._order or {}).get(key, [])
        if not isinstance(rows, list) or not (0 <= idx < len(rows)):
            return None
        row = rows[idx]
        return row if isinstance(row, dict) else None

    def _split_tags(self, text: str) -> list[str]:
        return [x.strip() for x in text.replace("，", ",").split(",") if x.strip()]
