"""Item definition editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QPushButton, QSpinBox,
    QDoubleSpinBox, QScrollArea, QGroupBox, QLabel, QStyle, QMessageBox,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.list_affordances import wire_list_affordances
from ..shared.condition_editor import ConditionEditor
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit
from ..shared.qt_icon_buttons import outline_row_tool_button, delete_standard_pixmap
from ..shared.form_layout import compact_form
from ..shared.collapsible_section import CollapsibleSection


class DynDescWidget(QGroupBox):
    def __init__(self, idx: int, data: dict,
                 model: ProjectModel | None = None, parent: QWidget | None = None):
        super().__init__(f"Dynamic Desc {idx + 1}", parent)
        self._idx = idx
        lay = QVBoxLayout(self)

        head = QHBoxLayout()
        self._btn_up = outline_row_tool_button(
            self, "上移", std=QStyle.StandardPixmap.SP_ArrowUp, fallback_text="上")
        self._btn_down = outline_row_tool_button(
            self, "下移", std=QStyle.StandardPixmap.SP_ArrowDown, fallback_text="下")
        self._btn_del = outline_row_tool_button(
            self, "删除该动态描述", std=delete_standard_pixmap(), fallback_text="删")
        head.addStretch(1)
        head.addWidget(self._btn_up)
        head.addWidget(self._btn_down)
        head.addWidget(self._btn_del)
        lay.addLayout(head)

        self._cond = ConditionEditor("Conditions")
        self._cond.set_flag_pattern_context(model, None)
        self._cond.set_data(data.get("conditions", []))
        lay.addWidget(self._cond)
        pm = model if model is not None else ProjectModel()
        self._text = RichTextTextEdit(pm)
        self._text.setPlainText(data.get("text", ""))
        self._text.setMinimumHeight(72)
        self._text.setMaximumHeight(180)
        lay.addWidget(self._text)

    def set_dyn_index(self, idx: int) -> None:
        self._idx = idx
        self.setTitle(f"Dynamic Desc {idx + 1}")

    def to_dict(self) -> dict:
        return {"conditions": self._cond.to_list(), "text": self._text.toPlainText()}


class ItemEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Item"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索…")
        self._search.setClearButtonEnabled(True)
        self._search.setToolTip("按 id / 名称过滤下方列表（仅隐藏不匹配项，不改动数据）")
        self._search.textChanged.connect(self._filter_list)
        ll.addWidget(self._search)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        wire_list_affordances(self._list, self._delete, delete_label="删除物品")
        ll.addWidget(self._list)
        self._empty_hint = QLabel("暂无物品，点击「+ Item」新增")
        self._empty_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_hint.setWordWrap(True)
        self._empty_hint.setStyleSheet("color: gray; padding: 12px;")
        self._empty_hint.hide()
        ll.addWidget(self._empty_hint)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        basic_box = QGroupBox("基本信息")
        f = compact_form(QFormLayout(basic_box))
        self._i_id = QLineEdit(); f.addRow("id", self._i_id)
        self._i_name = RichTextLineEdit(self._model)
        self._i_name.setMinimumWidth(240)
        f.addRow("name", self._i_name)
        self._i_type = QComboBox(); self._i_type.addItems(["consumable", "key"])
        self._i_type.setToolTip("consumable=可消耗品；key=关键道具（通常不可丢弃/堆叠固定）")
        f.addRow("type", self._i_type)
        self._i_desc = RichTextTextEdit(self._model)
        self._i_desc.setMinimumHeight(72)
        self._i_desc.setMaximumHeight(180)
        self._i_desc.setMinimumWidth(240)
        f.addRow("description", self._i_desc)
        self._i_stack = QSpinBox(); self._i_stack.setRange(1, 999)
        self._i_stack.setToolTip("单格最大堆叠数量")
        f.addRow("maxStack", self._i_stack)
        self._i_price = QSpinBox(); self._i_price.setRange(0, 99999)
        self._i_price.setToolTip("商店买入价；为 0 时不写入该字段（视为非卖品）")
        f.addRow("buyPrice", self._i_price)
        dl.addWidget(basic_box)

        dyn_section = CollapsibleSection("Dynamic Descriptions（条件动态描述）", start_open=False)
        dyn_section.set_header_tool_tip(
            "按条件覆盖物品描述；从上到下取第一条满足条件的 text，顺序影响优先级。")
        dyn_inner = QWidget()
        dyn_inner_lay = QVBoxLayout(dyn_inner)
        dyn_inner_lay.setContentsMargins(0, 0, 0, 0)
        self._dyn_layout = QVBoxLayout()
        dyn_inner_lay.addLayout(self._dyn_layout)
        add_dyn = QPushButton("+ Dynamic Desc"); add_dyn.clicked.connect(self._add_dyn)
        dyn_inner_lay.addWidget(add_dyn)
        dyn_section.add_body(dyn_inner)
        dl.addWidget(dyn_section)

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 600])
        root.addWidget(splitter)
        self._dyn_widgets: list[DynDescWidget] = []
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        for it in self._model.items:
            tag = "[K]" if it.get("type") == "key" else "[C]"
            self._list.addItem(f"{tag} {it.get('id', '?')}  {it.get('name', '')}")
        self._filter_list(self._search.text())
        self._empty_hint.setVisible(self._list.count() == 0)

    def _filter_list(self, text: str) -> None:
        """纯视图过滤：仅 setHidden 隐藏不匹配行，不增删/重排/修改任何数据。"""
        query = (text or "").strip().lower()
        for i in range(self._list.count()):
            item = self._list.item(i)
            item.setHidden(bool(query) and query not in item.text().lower())

    def select_by_id(self, item_id: str, _scene_id: str = "") -> bool:
        """全局搜索/跳转落点：按物品 id 选中（行序与 model.items 一致）。"""
        for i, it in enumerate(self._model.items):
            if it.get("id") == item_id:
                if self._search.text():
                    self._search.clear()  # 目标行可能被过滤隐藏
                self._list.setCurrentRow(i)
                return True
        return False

    def _is_dirty(self) -> bool:
        """当前 UI 是否与模型里的该物品有差异（用于切换/保存/关闭时判断是否需提交）。"""
        if self._current_idx < 0 or self._current_idx >= len(self._model.items):
            return False
        it = self._model.items[self._current_idx]
        if self._i_id.text().strip() != it.get("id", ""):
            return True
        if self._i_name.text() != it.get("name", ""):
            return True
        if self._i_type.currentText() != it.get("type", "consumable"):
            return True
        if self._i_desc.toPlainText() != it.get("description", ""):
            return True
        if self._i_stack.value() != it.get("maxStack", 1):
            return True
        if self._i_price.value() != (it.get("buyPrice", 0) or 0):
            return True
        dyns = [dw.to_dict() for dw in self._dyn_widgets]
        if dyns != (it.get("dynamicDescriptions") or []):
            return True
        return False

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用的编辑在保存前提交进模型，否则被静默丢弃。"""
        if self._current_idx >= 0 and self._is_dirty():
            self._apply()
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        """关闭/切项目门控：有未应用编辑则提示保存/放弃/取消。"""
        if self._current_idx < 0 or not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改",
            "当前物品有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply()
        else:
            # Discard：把表单回滚到模型当前值。否则关闭路径随后的统一 flush 会按
            # UI≠模型判脏，把刚被放弃的编辑重新提交（复核 P1-01）。
            self._on_select(self._current_idx)
        return True

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.items):
            return
        # commit-on-leave：切到别的物品前，把上一项未应用的编辑提交，避免静默丢弃。
        if 0 <= self._current_idx < len(self._model.items) and self._current_idx != row \
                and self._is_dirty():
            self._apply()
        self._current_idx = row
        it = self._model.items[row]
        self._i_id.setText(it.get("id", ""))
        self._i_name.setText(it.get("name", ""))
        self._i_type.setCurrentText(it.get("type", "consumable"))
        self._i_desc.setPlainText(it.get("description", ""))
        self._i_stack.setValue(it.get("maxStack", 1))
        self._i_price.setValue(it.get("buyPrice", 0))
        self._rebuild_dyn(it.get("dynamicDescriptions", []))
        self._i_id.setFocus()

    def _rebuild_dyn(self, dyns: list[dict]) -> None:
        for w in self._dyn_widgets:
            self._dyn_layout.removeWidget(w)
            w.deleteLater()
        self._dyn_widgets.clear()
        for i, d in enumerate(dyns):
            dw = DynDescWidget(i, d, self._model)
            self._connect_dyn(dw)
            self._dyn_widgets.append(dw)
            self._dyn_layout.addWidget(dw)

    def _connect_dyn(self, dw: DynDescWidget) -> None:
        dw._btn_up.clicked.connect(self._move_dyn_up)
        dw._btn_down.clicked.connect(self._move_dyn_down)
        dw._btn_del.clicked.connect(self._remove_dyn_sender)

    def _dyn_widget_from_sender(self) -> DynDescWidget | None:
        w = self.sender()
        while w is not None and not isinstance(w, DynDescWidget):
            w = w.parent()
        return w if isinstance(w, DynDescWidget) else None

    def _move_dyn_up(self) -> None:
        dw = self._dyn_widget_from_sender()
        if dw is None:
            return
        try:
            idx = self._dyn_widgets.index(dw)
        except ValueError:
            return
        if idx <= 0:
            return
        self._swap_dyn(idx, idx - 1)

    def _move_dyn_down(self) -> None:
        dw = self._dyn_widget_from_sender()
        if dw is None:
            return
        try:
            idx = self._dyn_widgets.index(dw)
        except ValueError:
            return
        if idx >= len(self._dyn_widgets) - 1:
            return
        self._swap_dyn(idx, idx + 1)

    def _swap_dyn(self, a: int, b: int) -> None:
        self._dyn_widgets[a], self._dyn_widgets[b] = (
            self._dyn_widgets[b], self._dyn_widgets[a])
        for w in self._dyn_widgets:
            self._dyn_layout.removeWidget(w)
        for i, w in enumerate(self._dyn_widgets):
            w.set_dyn_index(i)
            self._dyn_layout.addWidget(w)

    def _remove_dyn_sender(self) -> None:
        dw = self._dyn_widget_from_sender()
        if dw is None:
            return
        try:
            idx = self._dyn_widgets.index(dw)
        except ValueError:
            return
        self._dyn_layout.removeWidget(dw)
        self._dyn_widgets.pop(idx)
        dw.deleteLater()
        for i, w in enumerate(self._dyn_widgets):
            w.set_dyn_index(i)

    def _add_dyn(self) -> None:
        dw = DynDescWidget(len(self._dyn_widgets), {"conditions": [], "text": ""}, self._model)
        self._connect_dyn(dw)
        self._dyn_widgets.append(dw)
        self._dyn_layout.addWidget(dw)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        it = self._model.items[self._current_idx]
        _prev_iid = str(it.get("id", "")).strip()
        _new_iid = self._i_id.text().strip()
        if not _new_iid:
            _new_iid = _prev_iid  # 空 id 不接受：保留原 id
        elif _new_iid != _prev_iid and any(
            o is not it and str(o.get("id", "")).strip() == _new_iid
            for o in self._model.items
        ):
            QMessageBox.warning(
                self, "物品 id",
                f"id「{_new_iid}」与其它物品重复，已保留原 id「{_prev_iid}」。")
            _new_iid = _prev_iid
        it["id"] = _new_iid
        # 改名级联：商店货架 itemId、遭遇 consumeItems 跟随（审查 P2-24：
        # 旧实现改 id 后引用悬垂，商店购买/消耗静默失效）
        if _prev_iid and _new_iid != _prev_iid:
            for sh in self._model.shops:
                for row_ in (sh.get("items") or []):
                    if isinstance(row_, dict) and str(row_.get("itemId", "")).strip() == _prev_iid:
                        row_["itemId"] = _new_iid
                        self._model.mark_dirty("shop")
            for enc in self._model.encounters:
                for opt in (enc.get("options") or []):
                    for ci in (opt.get("consumeItems") or []) if isinstance(opt, dict) else []:
                        if isinstance(ci, dict) and str(ci.get("id", "")).strip() == _prev_iid:
                            ci["id"] = _new_iid
                            self._model.mark_dirty("encounter")
        it["name"] = self._i_name.text()
        it["type"] = self._i_type.currentText()
        it["description"] = self._i_desc.toPlainText()
        it["maxStack"] = self._i_stack.value()
        bp = self._i_price.value()
        if bp > 0:
            it["buyPrice"] = bp
        elif "buyPrice" in it:
            del it["buyPrice"]
        dyns = [dw.to_dict() for dw in self._dyn_widgets]
        if dyns:
            it["dynamicDescriptions"] = dyns
        elif "dynamicDescriptions" in it:
            del it["dynamicDescriptions"]
        self._model.mark_dirty("item")
        row = self._current_idx
        tag = "[K]" if it.get("type") == "key" else "[C]"
        iw = self._list.item(row)
        if iw is not None:
            iw.setText(f"{tag} {it.get('id', '?')}  {it.get('name', '')}")

    def _add(self) -> None:
        taken = {str(i.get("id", "")) for i in self._model.items}
        n = 0
        while f"item_{n}" in taken:
            n += 1
        self._model.items.append({
            "id": f"item_{n}", "name": "New Item",
            "type": "consumable", "description": "", "maxStack": 1,
        })
        self._model.mark_dirty("item")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            it = self._model.items[self._current_idx]
            if not confirm.confirm_delete(self, f"物品「{it.get('id', '')}」"):
                return
            self._model.items.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("item")
            self._refresh()
