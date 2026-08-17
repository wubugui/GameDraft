"""Item definition editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QPushButton, QSpinBox,
    QDoubleSpinBox, QScrollArea, QGroupBox, QLabel, QStyle, QMessageBox,
    QCheckBox,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.list_affordances import wire_list_affordances
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor
from ..shared.item_tags import ITEM_TAGS
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.qt_icon_buttons import outline_row_tool_button, delete_standard_pixmap
from ..shared.form_layout import compact_form
from ..shared.collapsible_section import CollapsibleSection

#: consume 三态下拉的取值顺序（索引即 combo 行号）。
#: ``None`` = 不写 ``consume`` 键，运行时按 type 推定（consumable 扣 / key 不扣）——
#: 与位面编辑器的槽继承同一范式：不显式配置就不写键，别拿默认值把"没配"写成"配了"。
_CONSUME_MODES: tuple[bool | None, ...] = (None, True, False)
_CONSUME_LABELS = ("按类型（默认）", "消耗一个", "不消耗")


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
        # 资源路径一律走图片选择器（禁裸 QLineEdit 手打路径）；工程外的图会自动复制进
        # resources/runtime/images/icons/。留空是合法的——背包格子会退回物品名文字显示。
        self._i_icon = CutsceneImagePathRow(
            self._model, "", external_copy_subdir="icons",
            external_copy_hint="项目外图片会复制到 resources/runtime/images/icons/；"
                               "建议 128 见方以内的透明底 PNG（背包格子 64px）",
        )
        self._i_icon.setToolTip("背包格子图标；留空则该物品在背包里显示名称文字")
        f.addRow("icon", self._i_icon)
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
        # tags 是受控词表的多选，不是自由文本——按选择器铁律不能用裸 QLineEdit；
        # 词表很短，勾选框比弹窗合适。词表外的旧值走 _unknown_tag_boxes 保值展示。
        self._tag_boxes: dict[str, QCheckBox] = {}
        self._unknown_tag_boxes: list[QCheckBox] = []
        self._loaded_tags: list[str] = []
        tags_host = QWidget()
        self._tags_row = QHBoxLayout(tags_host)
        self._tags_row.setContentsMargins(0, 0, 0, 0)
        for tag in ITEM_TAGS:
            cb = QCheckBox(tag)
            self._tag_boxes[tag] = cb
            self._tags_row.addWidget(cb)
        self._tags_row.addStretch(1)
        tags_host.setToolTip(
            "物件的民俗类别，给系统看的分类（不是玩家可见文案）。\n"
            "用途：让「用点」按类别接受物件，不必逐个点名物件 id。\n"
            "要加新类别请改 tools/editor/shared/item_tags.py（校验器读同一份词表）。")
        f.addRow("tags", tags_host)
        dl.addWidget(basic_box)

        # ── 自身用途（ItemDef.use）─────────────────────────────────────────
        # 「对着场景里某个东西用」不在这里，那是检视热区的 itemUses；两者互不覆盖。
        use_section = CollapsibleSection("Use（背包里主动使用）", start_open=False)
        use_section.set_header_tool_tip(
            "玩家在背包里对该物件执行的一次自身行为（吃掉 / 点燃 / 撕开）。\n"
            "不勾「本物件可主动使用」就不写 use 键——该物件在背包里没有使用入口。")
        use_inner = QWidget()
        use_lay = QVBoxLayout(use_inner)
        use_lay.setContentsMargins(0, 0, 0, 0)

        self._u_enabled = QCheckBox("本物件可主动使用")
        self._u_enabled.setToolTip(
            "不勾＝删除 use 键（背包里不画使用键）；勾上才写入下面这些字段。")
        self._u_enabled.toggled.connect(self._sync_use_enabled)
        use_lay.addWidget(self._u_enabled)

        self._u_body = QWidget()
        uf = compact_form(QFormLayout(self._u_body))
        self._u_label = RichTextLineEdit(self._model)
        self._u_label.setMinimumWidth(240)
        self._u_label.setToolTip("按钮文字，如「吃掉」「点燃」「灌一口」；可含 [tag:…]")
        uf.addRow("label", self._u_label)
        self._u_consume = QComboBox(); self._u_consume.addItems(_CONSUME_LABELS)
        self._u_consume.setToolTip(
            "使用后是否扣掉一个。「按类型」＝不写该键：consumable 扣、key 不扣。")
        uf.addRow("consume", self._u_consume)
        self._u_hint = RichTextLineEdit(self._model)
        self._u_hint.setMinimumWidth(240)
        self._u_hint.setToolTip(
            "条件不满足时，按钮置灰旁边显示的理由；留空用 strings.inventory.useDisabled。")
        uf.addRow("disableHint", self._u_hint)
        self._u_result = RichTextTextEdit(self._model)
        self._u_result.setMinimumHeight(56)
        self._u_result.setMaximumHeight(140)
        self._u_result.setPlaceholderText("使用后另起一段展示的叙事（可选）")
        uf.addRow("resultText", self._u_result)
        use_lay.addWidget(self._u_body)

        # 条件决定按钮灰不灰，必须是声明式的：写进 actions 里去判断，
        # 按钮态与置灰理由就再也算不出来了（详见 types.ts 的 ItemUseDef 注释）。
        self._u_conds = ConditionEditor("Conditions")
        self._u_conds.set_flag_pattern_context(self._model, None)
        use_lay.addWidget(self._u_conds)
        # 本编辑器全程只有这一棵 ActionEditor（切物件走 set_data 而不是重建），
        # 不必走 CollapsibleSection 的懒建：控件数不随物件数增长。
        self._u_actions = ActionEditor("Use Actions")
        self._u_actions.set_project_context(self._model, None)
        use_lay.addWidget(self._u_actions)

        use_section.add_body(use_inner)
        dl.addWidget(use_section)
        self._sync_use_enabled(False)

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

    # --- tags / use 的 UI ↔ 数据 互转 ------------------------------------
    # 三处同步契约：这两组字段必须同时出现在 _on_select（读进 UI）、_is_dirty（判脏）、
    # _apply（写回）里。漏掉 _is_dirty 的后果最阴——切换物件时 commit-on-leave 判不脏，
    # 编辑被静默吞掉，而 flush_to_model / confirm_close 全靠它。

    def _sync_use_enabled(self, on: bool) -> None:
        self._u_body.setEnabled(on)
        self._u_conds.setEnabled(on)
        self._u_actions.setEnabled(on)

    def _set_tags(self, tags: list) -> None:
        """按数据回填勾选；词表外的值另造勾选框保值展示，不静默丢弃。"""
        for cb in self._unknown_tag_boxes:
            self._tags_row.removeWidget(cb)
            cb.deleteLater()
        self._unknown_tag_boxes.clear()
        clean = [str(t).strip() for t in (tags or []) if str(t).strip()]
        self._loaded_tags = list(clean)
        known = set(clean)
        for tag, cb in self._tag_boxes.items():
            cb.setChecked(tag in known)
        for tag in clean:
            if tag in self._tag_boxes:
                continue
            cb = QCheckBox(tag)
            cb.setChecked(True)
            cb.setToolTip(f"「{tag}」不在受控词表里（校验器会报 warning）；此处原样保值。")
            self._unknown_tag_boxes.append(cb)
            # 插在 addStretch 之前，否则新框会被挤到伸缩项右边
            self._tags_row.insertWidget(self._tags_row.count() - 1, cb)

    def _tags_to_list(self) -> list[str]:
        """先按载入时的原顺序输出，再追加新勾的——不动的数据往返后逐字节不变
        （勾选框天然按词表顺序输出，直接那么写就是把 ["引火","辟邪"] 悄悄重排）。"""
        checked = {t for t, cb in self._tag_boxes.items() if cb.isChecked()}
        checked |= {cb.text() for cb in self._unknown_tag_boxes if cb.isChecked()}
        out = [t for t in self._loaded_tags if t in checked]
        out += [t for t in ITEM_TAGS if t in checked and t not in out]
        return out

    def _set_use(self, use: dict | None) -> None:
        u = use if isinstance(use, dict) else {}
        self._u_enabled.setChecked(bool(use))
        self._u_label.setText(str(u.get("label", "") or ""))
        raw = u.get("consume")
        mode = raw if isinstance(raw, bool) else None
        self._u_consume.setCurrentIndex(_CONSUME_MODES.index(mode))
        self._u_hint.setText(str(u.get("disableHint", "") or ""))
        self._u_result.setPlainText(str(u.get("resultText", "") or ""))
        self._u_conds.set_data(u.get("conditions") or [])
        self._u_actions.set_data(u.get("actions") or [])
        self._sync_use_enabled(bool(use))

    def _use_to_dict(self) -> dict | None:
        if not self._u_enabled.isChecked():
            return None
        out: dict = {"label": self._u_label.text()}
        conds = self._u_conds.to_list()
        if conds:
            out["conditions"] = conds
        hint = self._u_hint.text().strip()
        if hint:
            out["disableHint"] = hint
        mode = _CONSUME_MODES[self._u_consume.currentIndex()]
        if mode is not None:
            out["consume"] = mode
        acts = self._u_actions.to_list()
        if acts:
            out["actions"] = acts
        result = self._u_result.toPlainText().strip()
        if result:
            out["resultText"] = result
        return out

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
        if self._i_icon.path() != str(it.get("icon", "") or ""):
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
        if self._tags_to_list() != [str(t) for t in (it.get("tags") or [])]:
            return True
        if self._use_to_dict() != (it.get("use") if isinstance(it.get("use"), dict) else None):
            return True
        return False

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用的编辑在保存前提交进模型，否则被静默丢弃。"""
        if self._current_idx >= 0 and self._is_dirty():
            self._apply()
        return True

    def commit_pending_on_leave(self) -> bool:
        """切到别的编辑器页之前提交未应用的编辑（mainwindow-editor-hooks 契约 4）。

        本面板是 staging + 「Apply」模式，而 commit-on-leave 原先只覆盖**面板内部**
        切物件（`_on_select`）；改完不点 Apply 直接切页，模型里根本没有这次编辑——
        该卡把它列为已知坑（"item 编辑器有 Apply 却没钩子"）。主窗不会拿
        `flush_to_model` 兜底（那对图对话/叙事页是灾难），所以必须显式实现。
        """
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
        self._i_icon.set_path(str(it.get("icon", "") or ""))
        self._i_desc.setPlainText(it.get("description", ""))
        self._i_stack.setValue(it.get("maxStack", 1))
        self._i_price.setValue(it.get("buyPrice", 0))
        self._rebuild_dyn(it.get("dynamicDescriptions", []))
        self._set_tags(it.get("tags") or [])
        self._set_use(it.get("use") if isinstance(it.get("use"), dict) else None)
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
        icon = self._i_icon.path()
        if icon:
            it["icon"] = icon
        elif "icon" in it:
            del it["icon"]
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
        tags = self._tags_to_list()
        if tags:
            it["tags"] = tags
        elif "tags" in it:
            del it["tags"]
        use = self._use_to_dict()
        if use is not None:
            it["use"] = use
        elif "use" in it:
            del it["use"]
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
