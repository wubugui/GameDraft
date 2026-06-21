"""Archive editor: characters, lore, books, documents."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QTabWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QSpinBox,
    QScrollArea, QLabel, QGroupBox, QFileDialog, QDialog, QMessageBox,
    QToolButton, QStyle, QMenu,
)
from PySide6.QtCore import Qt, QObject, QEvent

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.collapsible_section import CollapsibleSection
from ..shared.condition_editor import ConditionEditor
from ..shared.id_ref_selector import IdRefSelector
from ..shared.action_editor import ActionEditor
from ..shared.rich_text_field import InsertRefDialog, RichTextLineEdit, RichTextTextEdit
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


def _open_game_tag_insert_dialog(
    parent: QWidget,
    model: ProjectModel,
    text_edit: QTextEdit | RichTextTextEdit,
) -> None:
    """统一插入对话框（8 种 tag，与运行时 resolveText 一致）。"""
    core = (
        text_edit.core_text_edit()
        if isinstance(text_edit, RichTextTextEdit)
        else text_edit
    )
    dlg = InsertRefDialog(model, parent)
    if dlg.exec() != QDialog.DialogCode.Accepted:
        return
    marker = dlg.marker()
    if not marker:
        return
    cur = core.textCursor()
    cur.insertText(marker)
    core.setTextCursor(cur)


def _make_insert_game_tag_btn(
    text_edit: QTextEdit | RichTextTextEdit,
    model: ProjectModel,
    parent: QWidget,
) -> QPushButton:
    btn = QPushButton("插入 tag")

    def _go() -> None:
        _open_game_tag_insert_dialog(parent, model, text_edit)

    btn.setMaximumWidth(100)
    btn.clicked.connect(_go)
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
        return {"conditions": self._cond.to_list(), "text": self._text.toPlainText()}


class _ListDetailTab(QWidget):
    """Generic list+detail for a flat list of dicts."""

    def __init__(self, model: ProjectModel, items_ref: list[dict],
                 data_type: str, build_detail, save_detail,
                 make_new, display_fn, parent=None):
        super().__init__(parent)
        self._model = model
        self._items = items_ref
        self._data_type = data_type
        self._build_detail = build_detail
        self._save_detail = save_detail
        self._make_new = make_new
        self._display_fn = display_fn
        self._current_idx = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Add"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        self._detail = QWidget()
        self._detail_layout = QVBoxLayout(self._detail)
        self._build_detail(self._detail_layout)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        self._detail_layout.addWidget(apply_btn)
        self._detail_layout.addStretch()
        scroll.setWidget(self._detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        root.addWidget(splitter)
        self.refresh()

    def refresh(self) -> None:
        self._list.clear()
        for it in self._items:
            self._list.addItem(self._display_fn(it))

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._items):
            return
        self._current_idx = row

    def _apply(self) -> None:
        if self._current_idx >= 0:
            self._save_detail(self._current_idx)
            self._model.mark_dirty(self._data_type)
            self.refresh()

    def _add(self) -> None:
        self._items.append(self._make_new())
        self._model.mark_dirty(self._data_type)
        self.refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._items.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty(self._data_type)
            self.refresh()


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

    def flush_to_model(self) -> bool:
        """Save All 钩子：提交四个档案区当前选中项的未应用编辑（跨页编辑也一并提交）。

        每个 _apply_* 在对应区无选中（idx<0）时自守空转；无条件提交是安全的——只写入当前
        UI 状态，未编辑的区写回等值数据（语义上无操作），保存后清脏；黄金往返测试保证不损坏。
        这堵住"改了档案没点 Apply 就 Ctrl+S 被静默丢弃"的主要丢失路径。
        """
        self._apply_char()
        self._apply_lore()
        self._apply_doc()
        self._apply_book()
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
        self._ch_unlock = ConditionEditor("unlockConditions")
        dl.addWidget(self._ch_unlock)
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

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_char)
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
        self._ch_unlock.set_flag_pattern_context(self._model, None)
        self._ch_unlock.set_data(ch.get("unlockConditions", []))
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
                           {"conditions": [], "text": ""}, self._model)
        self._wire_cond_text_group(g)
        self._imp_widgets.append(g)
        self._ch_imp_layout.addWidget(g)

    def _add_known_info(self) -> None:
        g = _CondTextGroup(f"Info {len(self._ki_widgets) + 1}",
                           {"conditions": [], "text": ""}, self._model)
        self._wire_cond_text_group(g)
        self._ki_widgets.append(g)
        self._ch_ki_layout.addWidget(g)

    def _apply_char(self, refresh: bool = True) -> None:
        if self._char_idx < 0:
            return
        ch = self._model.archive_characters[self._char_idx]
        ch["id"] = self._ch_id.text().strip()
        ch["name"] = self._ch_name.text()
        ch["title"] = self._ch_title.text()
        ch["unlockConditions"] = self._ch_unlock.to_list()
        ch_fv = self._ch_first_view.to_list()
        if ch_fv:
            ch["firstViewActions"] = ch_fv
        elif "firstViewActions" in ch:
            del ch["firstViewActions"]
        ch["impressions"] = [w.to_dict() for w in self._imp_widgets]
        ch["knownInfo"] = [w.to_dict() for w in self._ki_widgets]
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_chars()
        else:
            self._set_list_label(
                self._char_list, self._char_idx,
                f"{ch.get('id', '?')}  [{ch.get('name', '')}]")

    def _add_char(self) -> None:
        self._model.archive_characters.append({
            "id": f"char_{len(self._model.archive_characters)}", "name": "New",
            "title": "", "impressions": [], "knownInfo": [], "unlockConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_chars()

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
        self._lo_cat.setToolTip("传说分类：legend 传说 / geography 地理 / folklore 风俗 / affairs 时事。")
        f.addRow("category", self._lo_cat)
        self._lo_cond = ConditionEditor("unlockConditions")
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_lore)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(scroll)
        scroll.setWidget(detail)
        rl.addWidget(self._lo_cond)
        rl.addWidget(QLabel("<b>首次阅览动作 firstViewActions</b>"))
        self._lo_first_view = ActionEditor("firstViewActions")
        rl.addWidget(self._lo_first_view)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._lore_idx = -1
        self._refresh_lore()
        return w

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
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_lore()
        else:
            self._set_list_label(
                self._lore_list, self._lore_idx,
                f"{e.get('id', '?')}  [{e.get('title', '')}]")

    def _add_lore(self) -> None:
        entries = self._lore_entries()
        entries.append({
            "id": f"lore_{len(entries)}", "title": "", "content": "",
            "source": "", "category": "legend", "unlockConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_lore()

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
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_doc)
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
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_docs()
        else:
            self._set_list_label(
                self._doc_list, self._doc_idx,
                f"{d.get('id', '?')}  [{d.get('name', '')}]")

    def _add_doc(self) -> None:
        self._model.archive_documents.append({
            "id": f"doc_{len(self._model.archive_documents)}", "name": "",
            "content": "", "discoverConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_docs()

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
        self._bk_pages_spin.setToolTip("书籍总页数（用于运行时分页显示），通常应与下方 Pages 数量一致。")
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
        ann_row = QHBoxLayout()
        self._en_annotation = RichTextTextEdit(self._model)
        self._en_annotation.setMinimumWidth(240)
        self._en_annotation.setMaximumHeight(100)
        self._en_annotation.setPlaceholderText("按语…")
        self._en_annotation.setToolTip(
            "按语；可点右侧插入 [tag:string:类:key]、[tag:flag:键]、[tag:item:道具id]",
        )
        ann_row.addWidget(self._en_annotation)
        ann_row.addWidget(_make_insert_game_tag_btn(self._en_annotation, self._model, self))
        ef.addRow("annotation", ann_row)
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

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_book)
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
        self._bk_pages_spin.setValue(b.get("totalPages", 0))
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

    def _add_page_entry(self) -> None:
        if self._book_idx < 0 or self._page_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].setdefault("pages", [])
        pg = pages[self._page_idx]
        ents = pg.setdefault("entries", [])
        ents.append({
            "id": f"book_entry_{len(ents) + 1}",
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
        i = self._entry_idx
        ents[i + 1], ents[i] = ents[i], ents[i + 1]
        self._entry_idx = -1
        self._model.mark_dirty("archive")
        self._refresh_entry_list()
        self._entry_list.setCurrentRow(i + 1)

    def _add_page(self) -> None:
        if self._book_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].setdefault("pages", [])
        pages.append({"pageNum": len(pages) + 1, "content": "", "unlockConditions": []})
        self._on_book_select(self._book_idx)

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
        b["id"] = self._bk_id.text().strip()
        b["title"] = self._bk_title.text()
        b["totalPages"] = self._bk_pages_spin.value()
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
        self._model.mark_dirty("archive")
        if refresh:
            self._refresh_books()
        else:
            self._set_list_label(
                self._book_list, self._book_idx,
                f"{b.get('id', '?')}  [{b.get('title', '')}]")

    def _add_book(self) -> None:
        self._model.archive_books.append({
            "id": f"book_{len(self._model.archive_books)}", "title": "",
            "totalPages": 0, "pages": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_books()

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
