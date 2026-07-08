"""Archive editor: characters, lore, books, documents."""
from __future__ import annotations

import copy

from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QTabWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QSpinBox,
    QScrollArea, QLabel, QGroupBox, QFileDialog, QMessageBox,
    QToolButton, QStyle, QMenu,
)
from PySide6.QtCore import Qt, QObject, QEvent

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.collapsible_section import CollapsibleSection
from ..shared.condition_editor import ConditionEditor
from ..shared.id_ref_selector import IdRefSelector
from ..shared.action_editor import ActionEditor
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit
from ..shared.qt_icon_buttons import outline_row_tool_button, delete_standard_pixmap
from ..shared.project_paths import (
    DIR_KIND_RUNTIME_IMAGES_ILLUSTRATIONS,
)
from ..shared.form_layout import compact_form


def _tool_std_icon_btn(
    parent: QWidget,
    std: QStyle.StandardPixmap,
    tip: str,
    px: int = 26,
    text_fallback: str = "",
) -> QToolButton:
    """工具条式 QToolButton，与遭遇/过场行内按钮视觉一致。"""
    return outline_row_tool_button(
        parent,
        tip,
        theme_names=(),
        std=std,
        fallback_text=text_fallback,
        fixed_width=px,
        fixed_height=px,
    )


def _make_insert_image_btn(
    text_edit: QTextEdit | RichTextTextEdit,
    model: ProjectModel,
) -> QPushButton:
    """Create a button that inserts an ``[img:...]`` marker into *text_edit*.

    迁移后档案插图位于 ``public/resources/runtime/images/...``；这里写入的短路径
    会被 ``RichContent``/``ArchiveManager`` 解析为媒体 URL。
    """

    def _pick() -> None:
        if model.project_path is None:
            return
        paths = model.paths
        start_dir = str(
            paths.default_dir_existing_or_root(DIR_KIND_RUNTIME_IMAGES_ILLUSTRATIONS),
        )
        path, _ = QFileDialog.getOpenFileName(
            text_edit, "Select Image", start_dir,
            "Images (*.png *.jpg *.jpeg *.webp);;All Files (*)",
        )
        if not path:
            return
        try:
            rel = Path(path).resolve().relative_to(paths.runtime_root.resolve()).as_posix()
        except ValueError:
            QMessageBox.warning(
                text_edit, "Insert Image",
                "迁移后插图必须放在 public/resources/runtime/ 下，请把图片放进 runtime 树后再选择。",
            )
            return
        marker = f"[img:{rel}]"
        core = (
            text_edit.core_text_edit()
            if isinstance(text_edit, RichTextTextEdit)
            else text_edit
        )
        cursor = core.textCursor()
        cursor.insertText(marker)
        core.setTextCursor(cursor)

    btn = QPushButton("Insert Image")
    btn.setMaximumWidth(120)
    btn.clicked.connect(_pick)
    return btn


# ---------------------------------------------------------------------------
# List affordances (context menu + Delete key) — UI-only, reuse existing handlers
# ---------------------------------------------------------------------------

class _ListDeleteKeyFilter(QObject):
    """按 Delete 键时调用列表既有的删除处理函数（不引入新删除逻辑）。"""

    def __init__(self, delete_handler, parent: QWidget | None = None):
        super().__init__(parent)
        self._delete_handler = delete_handler

    def eventFilter(self, obj, event):  # noqa: N802 (Qt signature)
        if event.type() == QEvent.Type.KeyPress and event.key() in (
            Qt.Key.Key_Delete,
            Qt.Key.Key_Backspace,
        ):
            self._delete_handler()
            return True
        return super().eventFilter(obj, event)


def _make_list_search_box(list_widget: QListWidget) -> QLineEdit:
    """列表上方的纯视图搜索框：按文本逐项 setHidden，不增删/不重排/不改数据。"""
    box = QLineEdit()
    box.setPlaceholderText("搜索…")
    box.setClearButtonEnabled(True)
    box.setToolTip("按 id/名称过滤下方列表（仅隐藏不匹配项，不改动数据）。")

    def _filter(text: str) -> None:
        q = text.strip().lower()
        for i in range(list_widget.count()):
            it = list_widget.item(i)
            if it is None:
                continue
            it.setHidden(bool(q) and q not in it.text().lower())

    box.textChanged.connect(_filter)
    return box


def _wire_list_affordances(
    list_widget: QListWidget,
    delete_handler,
    *,
    delete_label: str = "删除",
) -> None:
    """给左侧主列表加右键菜单 + Delete 键删除，全部转调既有删除处理函数。"""
    list_widget.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)

    def _ctx_menu(pos) -> None:
        if list_widget.currentRow() < 0:
            return
        menu = QMenu(list_widget)
        menu.addAction(delete_label, delete_handler)
        menu.exec(list_widget.mapToGlobal(pos))

    list_widget.customContextMenuRequested.connect(_ctx_menu)
    flt = _ListDeleteKeyFilter(delete_handler, list_widget)
    list_widget.installEventFilter(flt)
    # keep a reference so the filter isn't garbage-collected
    list_widget._delete_key_filter = flt  # type: ignore[attr-defined]


# lore.json 的 categories 键固定为这 4 类（与 src/data/types.ts 的 LoreEntry.category 联合类型一致）
_LORE_CATEGORY_KEYS = ("legend", "geography", "folklore", "affairs")
_LORE_CATEGORY_DEFAULT_NAMES = {
    "legend": "传说", "geography": "地理", "folklore": "民俗", "affairs": "时事",
}


def _next_unique_id(prefix: str, existing) -> str:
    """生成 ``prefix_N`` 形式、且不与 *existing* 冲突的 id。

    旧实现用 ``f"{prefix}_{len(list)}"``，在“删掉中间一项后再新增”时会重新落到一个
    已存在的编号上（例如 ``[char_0, char_2]`` 再 +1 又得 ``char_2``），运行时 Map
    last-wins 会让一条档案凭空消失。这里从 ``len`` 起步、撞到就自增，保证唯一。
    """
    seen = set(existing)
    i = len(seen)
    while f"{prefix}_{i}" in seen:
        i += 1
    return f"{prefix}_{i}"


# ---------------------------------------------------------------------------
# Helpers for repeatable condition+text groups
# ---------------------------------------------------------------------------

class _CondTextGroup(QGroupBox):
    def __init__(self, title: str, data: dict,
                 model: ProjectModel | None = None, parent: QWidget | None = None):
        super().__init__(title, parent)
        lay = QVBoxLayout(self)
        head = QHBoxLayout()
        head.addStretch(1)
        self._btn_up = _tool_std_icon_btn(
            self, QStyle.StandardPixmap.SP_ArrowUp, "上移", text_fallback="上")
        self._btn_down = _tool_std_icon_btn(
            self, QStyle.StandardPixmap.SP_ArrowDown, "下移", text_fallback="下")
        self._btn_del = _tool_std_icon_btn(
            self, delete_standard_pixmap(), "删除该条", text_fallback="删")
        head.addWidget(self._btn_up)
        head.addWidget(self._btn_down)
        head.addWidget(self._btn_del)
        lay.addLayout(head)
        self._cond = ConditionEditor("conditions")
        self._cond.set_flag_pattern_context(model, None)
        self._cond.set_data(data.get("conditions", []))
        lay.addWidget(self._cond)
        pm = model if model is not None else ProjectModel()
        self._text = RichTextTextEdit(pm)
        self._text.setPlainText(data.get("text", ""))
        self._text.setMaximumHeight(120)
        lay.addWidget(self._text)

    def to_dict(self) -> dict:
        # 键序与磁盘数据一致（text 先于 conditions），保编辑器往返字节不变。
        return {"text": self._text.toPlainText(), "conditions": self._cond.to_list()}


# ---------------------------------------------------------------------------
# ArchiveEditor
# ---------------------------------------------------------------------------

class ArchiveEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        root = QVBoxLayout(self)
        tabs = QTabWidget()
        root.addWidget(tabs)

        tabs.addTab(self._build_characters_tab(), "Characters")
        tabs.addTab(self._build_lore_tab(), "Lore")
        tabs.addTab(self._build_documents_tab(), "Documents")
        tabs.addTab(self._build_books_tab(), "Books")

    @staticmethod
    def _set_list_label(listw, idx: int, text: str) -> None:
        """提交未刷新时,就地更新单行标签,避免整表 clear() 触发选择递归。"""
        it = listw.item(idx)
        if it is not None:
            it.setText(text)

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        """Save All 钩子：提交四个档案区当前选中项的未应用编辑（跨页编辑也一并提交）。

        每个 _apply_* 在对应区无选中（idx<0）时自守空转；无条件提交是安全的——只写入当前
        UI 状态，未编辑的区写回等值数据（语义上无操作），保存后清脏；黄金往返测试保证不损坏。
        这堵住"改了档案没点 Apply 就 Ctrl+S 被静默丢弃"的主要丢失路径。

        ``for_save_all`` 仅为与 main_window 统一调用签名（无需异常兜底重试），逻辑上不区分。
        """
        self._apply_char(refresh=False)
        self._apply_lore(refresh=False)
        self._apply_doc(refresh=False)
        self._apply_book(refresh=False)
        self._apply_lore_categories()
        return True

    # ---- Characters -------------------------------------------------------

    def _build_characters_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Character"); btn_add.clicked.connect(self._add_char)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_char)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._char_list = QListWidget()
        ll.addWidget(_make_list_search_box(self._char_list))
        self._char_list.currentRowChanged.connect(self._on_char_select)
        _wire_list_affordances(self._char_list, self._del_char, delete_label="删除角色档案")
        ll.addWidget(self._char_list)
        self._char_empty_hint = QLabel("暂无角色档案，点击「+ Character」新增")
        self._char_empty_hint.setStyleSheet("color: #888;")
        self._char_empty_hint.setWordWrap(True)
        ll.addWidget(self._char_empty_hint)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = compact_form(QFormLayout())
        self._ch_id = QLineEdit(); f.addRow("id", self._ch_id)
        self._ch_name = RichTextLineEdit(self._model)
        self._ch_name.setMinimumWidth(240)
        f.addRow("name", self._ch_name)
        self._ch_title = RichTextLineEdit(self._model)
        self._ch_title.setMinimumWidth(240)
        f.addRow("title", self._ch_title)
        dl.addLayout(f)
        ch_unlock_hint = QLabel(
            "人物档案的解锁唯一入口是 addArchiveEntry 动作"
            "（在对话图/过场里 addArchiveEntry: bookType=character, entryId=本档案 id）。")
        ch_unlock_hint.setWordWrap(True)
        ch_unlock_hint.setStyleSheet("color:#888; font-size:11px;")
        dl.addWidget(ch_unlock_hint)
        ch_fv_box = QGroupBox("首次阅览动作 firstViewActions")
        ch_fv_box.setToolTip("玩家第一次点开该人物档案时执行一次。")
        ch_fv_lay = QVBoxLayout(ch_fv_box)
        ch_fv_lay.setContentsMargins(6, 2, 6, 6)
        self._ch_first_view = ActionEditor("firstViewActions")
        ch_fv_lay.addWidget(self._ch_first_view)
        dl.addWidget(ch_fv_box)

        imp_body = QWidget()
        imp_body_lay = QVBoxLayout(imp_body)
        imp_body_lay.setContentsMargins(0, 0, 0, 0)
        self._ch_imp_layout = QVBoxLayout()
        imp_body_lay.addLayout(self._ch_imp_layout)
        add_imp = QPushButton("+ Impression"); add_imp.clicked.connect(self._add_impression)
        imp_body_lay.addWidget(add_imp)
        imp_sec = CollapsibleSection("Impressions（条件化印象文本）", start_open=False)
        imp_sec.set_header_tool_tip("满足条件时显示的人物印象段落；可多条，按顺序求值。")
        imp_sec.add_body(imp_body)
        dl.addWidget(imp_sec)

        ki_body = QWidget()
        ki_body_lay = QVBoxLayout(ki_body)
        ki_body_lay.setContentsMargins(0, 0, 0, 0)
        self._ch_ki_layout = QVBoxLayout()
        ki_body_lay.addLayout(self._ch_ki_layout)
        add_ki = QPushButton("+ Known Info"); add_ki.clicked.connect(self._add_known_info)
        ki_body_lay.addWidget(add_ki)
        ki_sec = CollapsibleSection("Known Info（条件化已知信息）", start_open=False)
        ki_sec.set_header_tool_tip("满足条件时解锁的已知信息段落；可多条，按顺序求值。")
        ki_sec.add_body(ki_body)
        dl.addWidget(ki_sec)

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(lambda *_: self._apply_char(refresh=False))
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._char_idx = -1
        self._imp_widgets: list[_CondTextGroup] = []
        self._ki_widgets: list[_CondTextGroup] = []
        self._refresh_chars()
        return w

    def _refresh_chars(self) -> None:
        self._char_list.clear()
        for ch in self._model.archive_characters:
            self._char_list.addItem(f"{ch.get('id', '?')}  [{ch.get('name', '')}]")
        self._char_empty_hint.setVisible(self._char_list.count() == 0)

    def _on_char_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.archive_characters):
            return
        # commit-on-leave：切到别的角色前先提交上一项未应用编辑，避免静默丢弃。
        prev = self._char_idx
        if 0 <= prev < len(self._model.archive_characters) and prev != row:
            self._apply_char(refresh=False)
        self._char_idx = row
        ch = self._model.archive_characters[row]
        self._ch_id.setText(ch.get("id", ""))
        self._ch_name.setText(ch.get("name", ""))
        self._ch_title.setText(ch.get("title", ""))
        self._ch_first_view.set_project_context(self._model, None)
        self._ch_first_view.set_data(ch.get("firstViewActions", []))
        self._rebuild_cond_text_list(self._ch_imp_layout, self._imp_widgets,
                                      ch.get("impressions", []), "Impression")
        self._rebuild_cond_text_list(self._ch_ki_layout, self._ki_widgets,
                                      ch.get("knownInfo", []), "Info")
        self._ch_id.setFocus()

    def _rebuild_cond_text_list(self, layout, widgets, items, prefix):
        for w in widgets:
            layout.removeWidget(w)
            w.deleteLater()
        widgets.clear()
        for i, item in enumerate(items):
            g = _CondTextGroup(f"{prefix} {i + 1}", item, self._model)
            self._wire_cond_text_group(g)
            widgets.append(g)
            layout.addWidget(g)

    def _wire_cond_text_group(self, g: _CondTextGroup) -> None:
        g._btn_up.clicked.connect(self._move_cond_text_up)
        g._btn_down.clicked.connect(self._move_cond_text_down)
        g._btn_del.clicked.connect(self._remove_cond_text_sender)

    def _cond_text_context_from_sender(self):
        """返回 (layout, widgets, prefix) 三元组以定位 sender 所属的列表。"""
        w = self.sender()
        while w is not None and not isinstance(w, _CondTextGroup):
            w = w.parent()
        if not isinstance(w, _CondTextGroup):
            return None
        if w in self._imp_widgets:
            return (w, self._ch_imp_layout, self._imp_widgets, "Impression")
        if w in self._ki_widgets:
            return (w, self._ch_ki_layout, self._ki_widgets, "Info")
        return None

    def _renumber_cond_text(self, layout, widgets, prefix) -> None:
        for w in widgets:
            layout.removeWidget(w)
        for i, w in enumerate(widgets):
            w.setTitle(f"{prefix} {i + 1}")
            layout.addWidget(w)

    def _move_cond_text_up(self) -> None:
        ctx = self._cond_text_context_from_sender()
        if ctx is None:
            return
        g, layout, widgets, prefix = ctx
        idx = widgets.index(g)
        if idx <= 0:
            return
        widgets[idx - 1], widgets[idx] = widgets[idx], widgets[idx - 1]
        self._renumber_cond_text(layout, widgets, prefix)

    def _move_cond_text_down(self) -> None:
        ctx = self._cond_text_context_from_sender()
        if ctx is None:
            return
        g, layout, widgets, prefix = ctx
        idx = widgets.index(g)
        if idx >= len(widgets) - 1:
            return
        widgets[idx + 1], widgets[idx] = widgets[idx], widgets[idx + 1]
        self._renumber_cond_text(layout, widgets, prefix)

    def _remove_cond_text_sender(self) -> None:
        ctx = self._cond_text_context_from_sender()
        if ctx is None:
            return
        g, layout, widgets, prefix = ctx
        idx = widgets.index(g)
        layout.removeWidget(g)
        widgets.pop(idx)
        g.deleteLater()
        self._renumber_cond_text(layout, widgets, prefix)

    def _add_impression(self) -> None:
        g = _CondTextGroup(f"Impression {len(self._imp_widgets) + 1}",
                           {"text": "", "conditions": []}, self._model)
        self._wire_cond_text_group(g)
        self._imp_widgets.append(g)
        self._ch_imp_layout.addWidget(g)

    def _add_known_info(self) -> None:
        g = _CondTextGroup(f"Info {len(self._ki_widgets) + 1}",
                           {"text": "", "conditions": []}, self._model)
        self._wire_cond_text_group(g)
        self._ki_widgets.append(g)
        self._ch_ki_layout.addWidget(g)

    def _apply_char(self, refresh: bool = True) -> None:
        if self._char_idx < 0:
            return
        ch = self._model.archive_characters[self._char_idx]
        _before = copy.deepcopy(ch)
        ch["id"] = self._ch_id.text().strip()
        ch["name"] = self._ch_name.text()
        ch["title"] = self._ch_title.text()
        # 人物解锁只走 addArchiveEntry 动作；清掉历史遗留的死字段 unlockConditions。
        ch.pop("unlockConditions", None)
        ch_fv = self._ch_first_view.to_list()
        if ch_fv:
            ch["firstViewActions"] = ch_fv
        elif "firstViewActions" in ch:
            del ch["firstViewActions"]
        ch["impressions"] = [w.to_dict() for w in self._imp_widgets]
        ch["knownInfo"] = [w.to_dict() for w in self._ki_widgets]
        if ch == _before:
            return  # 无实质变化：不标脏、不重建列表（保留选中）
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_chars()
        else:
            self._set_list_label(
                self._char_list, self._char_idx,
                f"{ch.get('id', '?')}  [{ch.get('name', '')}]")

    def _add_char(self) -> None:
        new_id = _next_unique_id(
            "char", (c.get("id", "") for c in self._model.archive_characters))
        self._model.archive_characters.append({
            "id": new_id, "name": "New",
            "title": "", "impressions": [], "knownInfo": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_chars()
        self._char_list.setCurrentRow(len(self._model.archive_characters) - 1)

    def _del_char(self) -> None:
        if self._char_idx >= 0:
            ch = self._model.archive_characters[self._char_idx]
            if not confirm.confirm_delete(self, f"角色档案「{ch.get('id', '')}」"):
                return
            self._model.archive_characters.pop(self._char_idx)
            self._char_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_chars()

    # ---- Lore -------------------------------------------------------------

    def _build_lore_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Lore"); btn_add.clicked.connect(self._add_lore)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_lore)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._lore_list = QListWidget()
        ll.addWidget(_make_list_search_box(self._lore_list))
        self._lore_list.currentRowChanged.connect(self._on_lore_select)
        _wire_list_affordances(self._lore_list, self._del_lore, delete_label="删除传说条目")
        ll.addWidget(self._lore_list)
        self._lore_empty_hint = QLabel("暂无传说条目，点击「+ Lore」新增")
        self._lore_empty_hint.setStyleSheet("color: #888;")
        self._lore_empty_hint.setWordWrap(True)
        ll.addWidget(self._lore_empty_hint)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = compact_form(QFormLayout(detail))
        self._lo_id = QLineEdit(); f.addRow("id", self._lo_id)
        self._lo_title = RichTextLineEdit(self._model)
        self._lo_title.setMinimumWidth(240)
        f.addRow("title", self._lo_title)
        self._lo_content = RichTextTextEdit(self._model)
        self._lo_content.setMinimumWidth(240)
        self._lo_content.setMinimumHeight(80)
        self._lo_content.setMaximumHeight(220)
        lo_content_row = QHBoxLayout()
        lo_content_row.addWidget(self._lo_content)
        lo_content_row.addWidget(_make_insert_image_btn(self._lo_content, self._model))
        f.addRow("content", lo_content_row)
        self._lo_source = RichTextLineEdit(self._model)
        self._lo_source.setMinimumWidth(240)
        f.addRow("source", self._lo_source)
        self._lo_cat = QComboBox()
        self._lo_cat.addItems(["legend", "geography", "folklore", "affairs"])
        self._lo_cat.setMaximumWidth(160)
        self._lo_cat.setToolTip(
            "传说分类键：legend / geography / folklore / affairs（中文显示名见下方"
            "「分类名称 categories」可编辑）。")
        f.addRow("category", self._lo_cat)
        self._lo_cond = ConditionEditor("unlockConditions")
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(lambda *_: self._apply_lore(refresh=False))

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(scroll)
        scroll.setWidget(detail)
        rl.addWidget(self._lo_cond)
        rl.addWidget(QLabel("<b>首次阅览动作 firstViewActions</b>"))
        self._lo_first_view = ActionEditor("firstViewActions")
        rl.addWidget(self._lo_first_view)
        rl.addWidget(apply_btn)
        rl.addWidget(self._build_lore_categories_section())

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._lore_idx = -1
        self._refresh_lore()
        return w

    def _lore_categories_map(self):
        """lore 的 categories 映射（dict）——仅当 archive_lore 是 dict 且确含该键时返回；否则 None。"""
        d = self._model.archive_lore
        if isinstance(d, dict) and isinstance(d.get("categories"), dict):
            return d["categories"]
        return None

    def _build_lore_categories_section(self) -> QWidget:
        """分类显示名编辑（全局，非按条目）。仅当工程 lore 已使用 categories 映射时可写，
        绝不向缺此键的工程注入字段——保护"数据格式不变"。"""
        cats = self._lore_categories_map()
        self._lore_categories_editable = cats is not None
        self._lore_cat_name_edits: dict[str, QLineEdit] = {}
        body = QWidget()
        form = compact_form(QFormLayout(body))
        for key in _LORE_CATEGORY_KEYS:
            le = QLineEdit()
            le.setMaximumWidth(160)
            le.setText((cats or {}).get(key, _LORE_CATEGORY_DEFAULT_NAMES[key]))
            if not self._lore_categories_editable or key not in (cats or {}):
                le.setReadOnly(True)
            self._lore_cat_name_edits[key] = le
            form.addRow(key, le)
        if self._lore_categories_editable:
            btn = QPushButton("应用分类名")
            btn.setMaximumWidth(120)
            btn.clicked.connect(self._apply_lore_categories)
            form.addRow("", btn)
        sec = CollapsibleSection("分类名称 categories（全局）", start_open=False)
        if self._lore_categories_editable:
            sec.set_header_tool_tip(
                "编辑各分类的中文显示名（运行时档案界面用）。键固定为 4 类、不可增删；"
                "仅工程 lore 已含 categories 时可改，灰色行表示该键不在映射中。")
        else:
            sec.set_header_tool_tip("当前工程 lore 未使用 categories 映射，此处为只读默认值。")
        sec.add_body(body)
        return sec

    def _apply_lore_categories(self) -> None:
        """把分类显示名就地写回已存在的键，不注入新键、不删除、不重排（保 JSON 字节级往返）。"""
        if not getattr(self, "_lore_categories_editable", False):
            return
        cats = self._lore_categories_map()
        if cats is None:
            return
        changed = False
        for key in _LORE_CATEGORY_KEYS:
            le = self._lore_cat_name_edits.get(key)
            if le is not None and key in cats:
                if cats[key] != le.text():
                    cats[key] = le.text()
                    changed = True
        if changed:
            self._model.mark_dirty("archive")

    def _lore_entries(self) -> list[dict]:
        d = self._model.archive_lore
        if isinstance(d, dict):
            return d.setdefault("entries", [])
        return d if isinstance(d, list) else []

    def _refresh_lore(self) -> None:
        self._lore_list.clear()
        for e in self._lore_entries():
            self._lore_list.addItem(f"{e.get('id', '?')}  [{e.get('title', '')}]")
        self._lore_empty_hint.setVisible(self._lore_list.count() == 0)

    def _on_lore_select(self, row: int) -> None:
        entries = self._lore_entries()
        if row < 0 or row >= len(entries):
            return
        prev = self._lore_idx
        if 0 <= prev < len(entries) and prev != row:
            self._apply_lore(refresh=False)
        self._lore_idx = row
        e = entries[row]
        self._lo_id.setText(e.get("id", ""))
        self._lo_title.setText(e.get("title", ""))
        self._lo_content.setPlainText(e.get("content", ""))
        self._lo_source.setText(e.get("source", ""))
        self._lo_cat.setCurrentText(e.get("category", "legend"))
        self._lo_cond.set_flag_pattern_context(self._model, None)
        self._lo_cond.set_data(e.get("unlockConditions", []))
        self._lo_first_view.set_project_context(self._model, None)
        self._lo_first_view.set_data(e.get("firstViewActions", []))
        self._lo_id.setFocus()

    def _apply_lore(self, refresh: bool = True) -> None:
        entries = self._lore_entries()
        if self._lore_idx < 0 or self._lore_idx >= len(entries):
            return
        e = entries[self._lore_idx]
        _before = copy.deepcopy(e)
        e["id"] = self._lo_id.text().strip()
        e["title"] = self._lo_title.text()
        e["content"] = self._lo_content.toPlainText()
        e["source"] = self._lo_source.text()
        e["category"] = self._lo_cat.currentText()
        e["unlockConditions"] = self._lo_cond.to_list()
        lo_fv = self._lo_first_view.to_list()
        if lo_fv:
            e["firstViewActions"] = lo_fv
        elif "firstViewActions" in e:
            del e["firstViewActions"]
        if e == _before:
            return  # 无实质变化：不标脏、不重建列表（保留选中）
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_lore()
        else:
            self._set_list_label(
                self._lore_list, self._lore_idx,
                f"{e.get('id', '?')}  [{e.get('title', '')}]")

    def _add_lore(self) -> None:
        entries = self._lore_entries()
        new_id = _next_unique_id("lore", (e.get("id", "") for e in entries))
        entries.append({
            "id": new_id, "title": "", "content": "",
            "source": "", "category": "legend", "unlockConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_lore()
        self._lore_list.setCurrentRow(len(entries) - 1)

    def _del_lore(self) -> None:
        entries = self._lore_entries()
        if 0 <= self._lore_idx < len(entries):
            if not confirm.confirm_delete(self, f"传说条目「{entries[self._lore_idx].get('id', '')}」"):
                return
            entries.pop(self._lore_idx)
            self._lore_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_lore()

    # ---- Documents --------------------------------------------------------

    def _build_documents_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Document"); btn_add.clicked.connect(self._add_doc)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_doc)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._doc_list = QListWidget()
        ll.addWidget(_make_list_search_box(self._doc_list))
        self._doc_list.currentRowChanged.connect(self._on_doc_select)
        _wire_list_affordances(self._doc_list, self._del_doc, delete_label="删除文档档案")
        ll.addWidget(self._doc_list)
        self._doc_empty_hint = QLabel("暂无文档档案，点击「+ Document」新增")
        self._doc_empty_hint.setStyleSheet("color: #888;")
        self._doc_empty_hint.setWordWrap(True)
        ll.addWidget(self._doc_empty_hint)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = compact_form(QFormLayout())
        self._doc_id = QLineEdit(); f.addRow("id", self._doc_id)
        self._doc_name = RichTextLineEdit(self._model)
        self._doc_name.setMinimumWidth(240)
        f.addRow("name", self._doc_name)
        self._doc_content = RichTextTextEdit(self._model)
        self._doc_content.setMinimumWidth(240)
        self._doc_content.setMaximumHeight(120)
        doc_content_row = QHBoxLayout()
        doc_content_row.addWidget(self._doc_content)
        doc_content_row.addWidget(_make_insert_image_btn(self._doc_content, self._model))
        f.addRow("content", doc_content_row)
        self._doc_annot = RichTextTextEdit(self._model)
        self._doc_annot.setMinimumWidth(240)
        self._doc_annot.setMaximumHeight(100)
        f.addRow("annotation", self._doc_annot)
        dl.addLayout(f)
        self._doc_cond = ConditionEditor("discoverConditions")
        dl.addWidget(self._doc_cond)
        dl.addWidget(QLabel("<b>首次阅览动作 firstViewActions</b>"))
        self._doc_first_view = ActionEditor("firstViewActions")
        dl.addWidget(self._doc_first_view)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(lambda *_: self._apply_doc(refresh=False))
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._doc_idx = -1
        self._refresh_docs()
        return w

    def _refresh_docs(self) -> None:
        self._doc_list.clear()
        for d in self._model.archive_documents:
            self._doc_list.addItem(f"{d.get('id', '?')}  [{d.get('name', '')}]")
        self._doc_empty_hint.setVisible(self._doc_list.count() == 0)

    def _on_doc_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.archive_documents):
            return
        prev = self._doc_idx
        if 0 <= prev < len(self._model.archive_documents) and prev != row:
            self._apply_doc(refresh=False)
        self._doc_idx = row
        d = self._model.archive_documents[row]
        self._doc_id.setText(d.get("id", ""))
        self._doc_name.setText(d.get("name", ""))
        self._doc_content.setPlainText(d.get("content", ""))
        self._doc_annot.setPlainText(d.get("annotation", ""))
        self._doc_cond.set_flag_pattern_context(self._model, None)
        self._doc_cond.set_data(d.get("discoverConditions", []))
        self._doc_first_view.set_project_context(self._model, None)
        self._doc_first_view.set_data(d.get("firstViewActions", []))
        self._doc_id.setFocus()

    def _apply_doc(self, refresh: bool = True) -> None:
        if self._doc_idx < 0:
            return
        d = self._model.archive_documents[self._doc_idx]
        _before = copy.deepcopy(d)
        d["id"] = self._doc_id.text().strip()
        d["name"] = self._doc_name.text()
        d["content"] = self._doc_content.toPlainText()
        annot = self._doc_annot.toPlainText()
        if annot:
            d["annotation"] = annot
        elif "annotation" in d:
            del d["annotation"]
        d["discoverConditions"] = self._doc_cond.to_list()
        doc_fv = self._doc_first_view.to_list()
        if doc_fv:
            d["firstViewActions"] = doc_fv
        elif "firstViewActions" in d:
            del d["firstViewActions"]
        if d == _before:
            return  # 无实质变化：不标脏、不重建列表（保留选中）
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_docs()
        else:
            self._set_list_label(
                self._doc_list, self._doc_idx,
                f"{d.get('id', '?')}  [{d.get('name', '')}]")

    def _add_doc(self) -> None:
        new_id = _next_unique_id(
            "doc", (d.get("id", "") for d in self._model.archive_documents))
        self._model.archive_documents.append({
            "id": new_id, "name": "",
            "content": "", "discoverConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_docs()
        self._doc_list.setCurrentRow(len(self._model.archive_documents) - 1)

    def _del_doc(self) -> None:
        if self._doc_idx >= 0:
            dc = self._model.archive_documents[self._doc_idx]
            if not confirm.confirm_delete(self, f"文档档案「{dc.get('id', '')}」"):
                return
            self._model.archive_documents.pop(self._doc_idx)
            self._doc_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_docs()

    # ---- Books ------------------------------------------------------------

    def _build_books_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Book"); btn_add.clicked.connect(self._add_book)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_book)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._book_list = QListWidget()
        ll.addWidget(_make_list_search_box(self._book_list))
        self._book_list.currentRowChanged.connect(self._on_book_select)
        _wire_list_affordances(self._book_list, self._del_book, delete_label="删除书籍")
        ll.addWidget(self._book_list)
        self._book_empty_hint = QLabel("暂无书籍，点击「+ Book」新增")
        self._book_empty_hint.setStyleSheet("color: #888;")
        self._book_empty_hint.setWordWrap(True)
        ll.addWidget(self._book_empty_hint)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = compact_form(QFormLayout())
        self._bk_id = QLineEdit(); f.addRow("id", self._bk_id)
        self._bk_title = RichTextLineEdit(self._model)
        self._bk_title.setMinimumWidth(240)
        f.addRow("title", self._bk_title)
        self._bk_pages_spin = QSpinBox(); self._bk_pages_spin.setRange(0, 99)
        self._bk_pages_spin.setMaximumWidth(90)
        self._bk_pages_spin.setReadOnly(True)
        self._bk_pages_spin.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        self._bk_pages_spin.setToolTip(
            "书籍总页数：只读，自动同步为下方 Pages 的实际数量（避免手填与真实页数漂移）。")
        f.addRow("totalPages", self._bk_pages_spin)
        dl.addLayout(f)
        dl.addWidget(QLabel("<b>Pages</b>"))
        self._page_list = QListWidget()
        self._page_list.currentRowChanged.connect(self._on_page_select)
        dl.addWidget(self._page_list)
        page_btns = QHBoxLayout()
        add_pg = QPushButton("+ Page"); add_pg.clicked.connect(self._add_page)
        del_pg = QPushButton("删除页"); del_pg.clicked.connect(self._del_page)
        up_pg = QPushButton("↑"); up_pg.setToolTip("上移当前页")
        up_pg.clicked.connect(self._move_page_up)
        down_pg = QPushButton("↓"); down_pg.setToolTip("下移当前页")
        down_pg.clicked.connect(self._move_page_down)
        page_btns.addWidget(add_pg)
        page_btns.addWidget(del_pg)
        page_btns.addWidget(up_pg)
        page_btns.addWidget(down_pg)
        dl.addLayout(page_btns)

        pf = compact_form(QFormLayout())
        self._pg_title = RichTextLineEdit(self._model)
        self._pg_title.setMinimumWidth(240)
        pf.addRow("title", self._pg_title)
        self._pg_content = RichTextTextEdit(self._model)
        self._pg_content.setMinimumWidth(240)
        self._pg_content.setMinimumHeight(80)
        self._pg_content.setMaximumHeight(220)
        pg_content_row = QHBoxLayout()
        pg_content_row.addWidget(self._pg_content)
        pg_content_row.addWidget(_make_insert_image_btn(self._pg_content, self._model))
        pf.addRow("content", pg_content_row)
        self._pg_illust = IdRefSelector(allow_empty=True, editable=True)
        self._pg_illust.setMinimumWidth(180)
        self._pg_illust.setToolTip("本页插图资源 id（可留空）；从已登记的插图资源中选择。")
        pf.addRow("illustration", self._pg_illust)
        dl.addLayout(pf)
        self._pg_cond = ConditionEditor("unlockConditions")
        dl.addWidget(self._pg_cond)
        dl.addWidget(QLabel("<b>首次阅览动作（本页）firstViewActions</b>"))
        self._pg_first_view = ActionEditor("page firstViewActions")
        dl.addWidget(self._pg_first_view)

        dl.addWidget(QLabel("<b>Page entries（书籍子条目）</b>"))
        self._entry_list = QListWidget()
        self._entry_list.currentRowChanged.connect(self._on_entry_select)
        dl.addWidget(self._entry_list)
        ent_btn_row = QHBoxLayout()
        btn_add_ent = QPushButton("+ Entry")
        btn_add_ent.clicked.connect(self._add_page_entry)
        btn_del_ent = QPushButton("Delete Entry")
        btn_del_ent.clicked.connect(self._del_page_entry)
        btn_up_ent = QPushButton("↑")
        btn_up_ent.setToolTip("上移当前子条目")
        btn_up_ent.clicked.connect(self._move_entry_up)
        btn_down_ent = QPushButton("↓")
        btn_down_ent.setToolTip("下移当前子条目")
        btn_down_ent.clicked.connect(self._move_entry_down)
        ent_btn_row.addWidget(btn_add_ent)
        ent_btn_row.addWidget(btn_del_ent)
        ent_btn_row.addWidget(btn_up_ent)
        ent_btn_row.addWidget(btn_down_ent)
        dl.addLayout(ent_btn_row)
        ef = compact_form(QFormLayout())
        self._en_id = QLineEdit()
        ef.addRow("entry id", self._en_id)
        self._en_title = RichTextLineEdit(self._model)
        self._en_title.setMinimumWidth(240)
        ef.addRow("title", self._en_title)
        self._en_content = RichTextTextEdit(self._model)
        self._en_content.setMinimumWidth(240)
        self._en_content.setMaximumHeight(120)
        en_content_row = QHBoxLayout()
        en_content_row.addWidget(self._en_content)
        en_content_row.addWidget(_make_insert_image_btn(self._en_content, self._model))
        ef.addRow("content", en_content_row)
        self._en_annotation = RichTextTextEdit(self._model)
        self._en_annotation.setMinimumWidth(240)
        self._en_annotation.setMaximumHeight(100)
        self._en_annotation.setPlaceholderText("按语…")
        self._en_annotation.setToolTip(
            "按语；可点内置「引用」按钮插入 [tag:string:类:key]、[tag:flag:键]、[tag:item:道具id]",
        )
        ef.addRow("annotation", self._en_annotation)
        self._en_illust = IdRefSelector(allow_empty=True, editable=True)
        self._en_illust.setMinimumWidth(180)
        self._en_illust.setToolTip("本子条目插图资源 id（可留空）；从已登记的插图资源中选择。")
        ef.addRow("illustration", self._en_illust)
        dl.addLayout(ef)
        self._en_disc = ConditionEditor("discoverConditions")
        dl.addWidget(self._en_disc)
        dl.addWidget(QLabel("<b>首次阅览动作（子条目）firstViewActions</b>"))
        self._en_first_view = ActionEditor("entry firstViewActions")
        dl.addWidget(self._en_first_view)

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(lambda *_: self._apply_book(refresh=False))
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._book_idx = -1
        self._page_idx = -1
        self._entry_idx = -1
        self._refresh_books()
        return w

    def _refresh_books(self) -> None:
        self._book_list.clear()
        for b in self._model.archive_books:
            self._book_list.addItem(f"{b.get('id', '?')}  [{b.get('title', '')}]")
        self._book_empty_hint.setVisible(self._book_list.count() == 0)

    def _on_book_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.archive_books):
            return
        # commit-on-leave：切到别的书前提交上一本书（含其当前页/条目）的未应用编辑。
        prev = self._book_idx
        if 0 <= prev < len(self._model.archive_books) and prev != row:
            self._apply_book(refresh=False)
        self._book_idx = row
        b = self._model.archive_books[row]
        self._bk_id.setText(b.get("id", ""))
        self._bk_title.setText(b.get("title", ""))
        self._bk_pages_spin.setValue(len(b.get("pages", []) or []))
        self._page_list.clear()
        for pg in b.get("pages", []):
            self._page_list.addItem(f"Page {pg.get('pageNum', '?')}: {pg.get('title', '')}")
        self._entry_list.clear()
        self._page_idx = -1
        self._entry_idx = -1
        self._clear_entry_form()
        self._pg_first_view.set_project_context(self._model, None)
        self._pg_first_view.set_data([])
        self._bk_id.setFocus()

    def _on_page_select(self, row: int) -> None:
        if self._book_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if row < 0 or row >= len(pages):
            return
        # commit-on-leave：切到别的页前提交上一页（含其当前条目）的未应用编辑。
        prev = self._page_idx
        if 0 <= prev < len(pages) and prev != row:
            self._apply_book(refresh=False)
        self._page_idx = row
        pg = pages[row]
        self._pg_title.setText(pg.get("title", ""))
        self._pg_content.setPlainText(pg.get("content", ""))
        ill_choices = self._model.illustration_asset_choices()
        cur_ill = pg.get("illustration", "") or ""
        if cur_ill and all(x[0] != cur_ill for x in ill_choices):
            ill_choices = [(cur_ill, cur_ill)] + ill_choices
        self._pg_illust.set_items(ill_choices)
        self._pg_illust.set_current(cur_ill)
        self._pg_cond.set_flag_pattern_context(self._model, None)
        self._pg_cond.set_data(pg.get("unlockConditions", []))
        self._pg_first_view.set_project_context(self._model, None)
        self._pg_first_view.set_data(pg.get("firstViewActions", []))
        self._refresh_entry_list()
        self._entry_idx = -1
        self._clear_entry_form()

    def _refresh_entry_list(self) -> None:
        self._entry_list.clear()
        if self._book_idx < 0 or self._page_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if self._page_idx >= len(pages):
            return
        pg = pages[self._page_idx]
        for i, ent in enumerate(pg.get("entries") or []):
            eid = ent.get("id", "?") if isinstance(ent, dict) else "?"
            self._entry_list.addItem(f"{i + 1}. {eid}")

    def _clear_entry_form(self) -> None:
        self._en_id.clear()
        self._en_title.clear()
        self._en_content.clear()
        self._en_annotation.clear()
        ill_choices = self._model.illustration_asset_choices()
        self._en_illust.set_items(ill_choices)
        self._en_illust.set_current("")
        self._en_disc.set_flag_pattern_context(self._model, None)
        self._en_disc.set_data([])
        self._en_first_view.set_project_context(self._model, None)
        self._en_first_view.set_data([])

    def _on_entry_select(self, row: int) -> None:
        if self._book_idx < 0 or self._page_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if self._page_idx >= len(pages):
            return
        entries = pages[self._page_idx].get("entries") or []
        if row < 0 or row >= len(entries):
            self._entry_idx = -1
            self._clear_entry_form()
            return
        # commit-on-leave：切到别的条目前提交上一条目的未应用编辑。
        prev = self._entry_idx
        if 0 <= prev < len(entries) and prev != row:
            self._apply_book(refresh=False)
        self._entry_idx = row
        ent = entries[row]
        if not isinstance(ent, dict):
            self._clear_entry_form()
            return
        self._en_id.setText(str(ent.get("id", "")))
        self._en_title.setText(str(ent.get("title", "")))
        self._en_content.setPlainText(str(ent.get("content", "")))
        self._en_annotation.setPlainText(str(ent.get("annotation", "")))
        ill_choices = self._model.illustration_asset_choices()
        cur_ill = ent.get("illustration", "") or ""
        if cur_ill and all(x[0] != cur_ill for x in ill_choices):
            ill_choices = [(cur_ill, cur_ill)] + ill_choices
        self._en_illust.set_items(ill_choices)
        self._en_illust.set_current(cur_ill)
        self._en_disc.set_flag_pattern_context(self._model, None)
        self._en_disc.set_data(ent.get("discoverConditions", []))
        self._en_first_view.set_project_context(self._model, None)
        self._en_first_view.set_data(ent.get("firstViewActions", []))

    def _all_book_entry_ids(self):
        """所有书全部页内子条目 id 的集合（条目 id 须跨书全局唯一，validator 强制）。"""
        ids = set()
        for bk in self._model.archive_books:
            if not isinstance(bk, dict):
                continue
            for pg in bk.get("pages") or []:
                if not isinstance(pg, dict):
                    continue
                for ent in pg.get("entries") or []:
                    if isinstance(ent, dict) and ent.get("id"):
                        ids.add(ent["id"])
        return ids

    def _add_page_entry(self) -> None:
        if self._book_idx < 0 or self._page_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].setdefault("pages", [])
        pg = pages[self._page_idx]
        ents = pg.setdefault("entries", [])
        ents.append({
            "id": _next_unique_id("book_entry", self._all_book_entry_ids()),
            "title": "",
            "content": "",
        })
        self._model.mark_dirty("archive")
        self._refresh_entry_list()
        self._entry_list.setCurrentRow(len(ents) - 1)

    def _del_page_entry(self) -> None:
        if self._book_idx < 0 or self._page_idx < 0 or self._entry_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if self._page_idx >= len(pages):
            return
        pg = pages[self._page_idx]
        ents = pg.get("entries")
        if not isinstance(ents, list) or self._entry_idx >= len(ents):
            return
        if not confirm.confirm_delete(self, f"书页条目「{ents[self._entry_idx].get('id', '')}」"):
            return
        ents.pop(self._entry_idx)
        if not ents:
            pg.pop("entries", None)
        self._entry_idx = -1
        self._model.mark_dirty("archive")
        self._refresh_entry_list()
        self._clear_entry_form()

    def _page_entries(self) -> list | None:
        if self._book_idx < 0 or self._page_idx < 0:
            return None
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if self._page_idx >= len(pages):
            return None
        ents = pages[self._page_idx].get("entries")
        return ents if isinstance(ents, list) else None

    def _move_entry_up(self) -> None:
        ents = self._page_entries()
        if ents is None or self._entry_idx <= 0 or self._entry_idx >= len(ents):
            return
        # 提交当前条目未应用编辑后再交换，避免随后重建列表时丢失。
        self._apply_book(refresh=False)
        i = self._entry_idx
        ents[i - 1], ents[i] = ents[i], ents[i - 1]
        self._entry_idx = -1
        self._model.mark_dirty("archive")
        self._refresh_entry_list()
        self._entry_list.setCurrentRow(i - 1)

    def _move_entry_down(self) -> None:
        ents = self._page_entries()
        if ents is None or self._entry_idx < 0 or self._entry_idx >= len(ents) - 1:
            return
        # 提交当前条目未应用编辑后再交换，避免随后重建列表时丢失。
        self._apply_book(refresh=False)
        i = self._entry_idx
        ents[i + 1], ents[i] = ents[i], ents[i + 1]
        self._entry_idx = -1
        self._model.mark_dirty("archive")
        self._refresh_entry_list()
        self._entry_list.setCurrentRow(i + 1)

    def _add_page(self) -> None:
        if self._book_idx < 0:
            return
        # 先提交当前页/条目未应用编辑：下面 _on_book_select(同一本书) 不会触发
        # commit-on-leave（prev==row），会直接用数据重置表单，丢掉手头的改动。
        self._apply_book(refresh=False)
        pages = self._model.archive_books[self._book_idx].setdefault("pages", [])
        pages.append({"pageNum": len(pages) + 1, "content": "", "unlockConditions": []})
        self._on_book_select(self._book_idx)
        self._page_list.setCurrentRow(len(pages) - 1)

    def _renumber_pages(self, pages: list[dict]) -> None:
        """重排后让每页 pageNum 等于其顺序号（1 起），与列表位置一致。"""
        for i, pg in enumerate(pages):
            if isinstance(pg, dict):
                pg["pageNum"] = i + 1

    def _del_page(self) -> None:
        if self._book_idx < 0 or self._page_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if self._page_idx >= len(pages):
            return
        nent = len(pages[self._page_idx].get("entries", []) or [])
        if not confirm.confirm_delete(
            self, f"第 {self._page_idx + 1} 页",
            f"含 {nent} 个条目。" if nent else "",
        ):
            return
        # 提交书级（id/title）等未应用编辑，再删除当前页——否则 _on_book_select 重置会丢掉它们。
        self._apply_book(refresh=False)
        pages.pop(self._page_idx)
        self._renumber_pages(pages)
        self._page_idx = -1
        self._model.mark_dirty("archive")
        self._on_book_select(self._book_idx)

    def _move_page_up(self) -> None:
        if self._book_idx < 0 or self._page_idx <= 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if self._page_idx >= len(pages):
            return
        # 提交当前页/条目编辑后再交换：随后 _on_book_select 会用数据重建表单。
        self._apply_book(refresh=False)
        i = self._page_idx
        pages[i - 1], pages[i] = pages[i], pages[i - 1]
        self._renumber_pages(pages)
        self._page_idx = -1
        self._model.mark_dirty("archive")
        self._on_book_select(self._book_idx)
        self._page_list.setCurrentRow(i - 1)

    def _move_page_down(self) -> None:
        if self._book_idx < 0 or self._page_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if self._page_idx >= len(pages) - 1:
            return
        # 提交当前页/条目编辑后再交换：随后 _on_book_select 会用数据重建表单。
        self._apply_book(refresh=False)
        i = self._page_idx
        pages[i + 1], pages[i] = pages[i], pages[i + 1]
        self._renumber_pages(pages)
        self._page_idx = -1
        self._model.mark_dirty("archive")
        self._on_book_select(self._book_idx)
        self._page_list.setCurrentRow(i + 1)

    def _apply_book(self, refresh: bool = True) -> None:
        if self._book_idx < 0:
            return
        b = self._model.archive_books[self._book_idx]
        _before = copy.deepcopy(b)
        b["id"] = self._bk_id.text().strip()
        b["title"] = self._bk_title.text()
        # totalPages 派生自实际页数，杜绝手填漂移（运行时本就只认 pages，此字段仅展示）。
        b["totalPages"] = len(b.get("pages", []) or [])
        if self._page_idx >= 0:
            pages = b.get("pages", [])
            if self._page_idx < len(pages):
                pg = pages[self._page_idx]
                pg["title"] = self._pg_title.text() or None
                if pg["title"] is None:
                    pg.pop("title", None)
                pg["content"] = self._pg_content.toPlainText()
                ill = self._pg_illust.current_id().strip()
                if ill:
                    pg["illustration"] = ill
                elif "illustration" in pg:
                    del pg["illustration"]
                pg["unlockConditions"] = self._pg_cond.to_list()
                pg_fv = self._pg_first_view.to_list()
                if pg_fv:
                    pg["firstViewActions"] = pg_fv
                elif "firstViewActions" in pg:
                    del pg["firstViewActions"]
                if self._entry_idx >= 0:
                    ents = pg.setdefault("entries", [])
                    if self._entry_idx < len(ents):
                        ent = ents[self._entry_idx]
                        if not isinstance(ent, dict):
                            ent = {}
                            ents[self._entry_idx] = ent
                        ent["id"] = self._en_id.text().strip()
                        ent["title"] = self._en_title.text().strip()
                        ent["content"] = self._en_content.toPlainText()
                        ann = self._en_annotation.toPlainText().strip()
                        if ann:
                            ent["annotation"] = ann
                        else:
                            ent.pop("annotation", None)
                        ill = self._en_illust.current_id().strip()
                        if ill:
                            ent["illustration"] = ill
                        elif "illustration" in ent:
                            del ent["illustration"]
                        disc = self._en_disc.to_list()
                        if disc:
                            ent["discoverConditions"] = disc
                        elif "discoverConditions" in ent:
                            del ent["discoverConditions"]
                        en_fv = self._en_first_view.to_list()
                        if en_fv:
                            ent["firstViewActions"] = en_fv
                        elif "firstViewActions" in ent:
                            del ent["firstViewActions"]
        if b == _before:
            return  # 无实质变化：不标脏、不重建列表（保留选中）
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_books()
        else:
            self._set_list_label(
                self._book_list, self._book_idx,
                f"{b.get('id', '?')}  [{b.get('title', '')}]")

    def _add_book(self) -> None:
        new_id = _next_unique_id(
            "book", (b.get("id", "") for b in self._model.archive_books))
        self._model.archive_books.append({
            "id": new_id, "title": "",
            "totalPages": 0, "pages": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_books()
        self._book_list.setCurrentRow(len(self._model.archive_books) - 1)

    def _del_book(self) -> None:
        if self._book_idx >= 0:
            bk = self._model.archive_books[self._book_idx]
            npages = len(bk.get("pages", []) or [])
            if not confirm.confirm_delete(
                self, f"书籍「{bk.get('id', '')}」", f"含 {npages} 页及其全部条目。",
            ):
                return
            self._model.archive_books.pop(self._book_idx)
            self._book_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_books()
