"""Rich text widgets with insert-[tag:…] dialog (策划勿手打引用)."""
from __future__ import annotations

from PySide6.QtCore import QEvent, QObject, Qt, Signal, QTimer
from PySide6.QtGui import QAction, QColor, QIcon, QPixmap, QTextCursor
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from .. import theme
from .ref_validator import scan_refs
from .tag_catalog import TagCatalog, TagItem
from .text_palette import load_text_palette, wrap_with_color


_KIND_LABELS = [
    ("string", "strings.json（文/数/布尔）"),
    ("flag", "Flag"),
    ("item", "道具"),
    ("npc", "NPC"),
    ("player", "玩家"),
    ("quest", "任务"),
    ("rule", "规矩"),
    ("scene", "场景"),
]


def _color_swatch(hex_color: str) -> QIcon:
    """色板菜单项左边那块颜色（策划靠它认色，不靠 id 认色）。"""
    pix = QPixmap(14, 14)
    pix.fill(QColor(hex_color))
    return QIcon(pix)


def build_color_button(
    owner: QWidget,
    model_getter,
    apply_wrap,
) -> QPushButton:
    """「染色」按钮：点开列出 game_config.textPalette 的档位，选中即把选区裹上 ``[c:id]…[/c]``。

    刻意不给自由取色：这套木框/纸纹观感下逐处填色号一定走形，且语义档位改一次全局生效
    （与运行时同读 game_config.textPalette，不存在第二份色表）。
    """
    btn = QPushButton("染色")
    btn.setMaximumWidth(44)
    btn.setToolTip("给选中的文字上色（语义色板 [c:…]，勿手打）")

    def popup() -> None:
        menu = QMenu(owner)
        for entry in load_text_palette(model_getter()):
            act = QAction(_color_swatch(entry["color"]), f'{entry["label"]}（{entry["id"]}）', menu)
            act.triggered.connect(lambda _=False, e=entry: apply_wrap(e["id"]))
            menu.addAction(act)
        menu.exec(btn.mapToGlobal(btn.rect().bottomLeft()))

    btn.clicked.connect(popup)
    return btn


class InsertRefDialog(QDialog):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("插入项目引用")
        self.setMinimumWidth(520)
        self.setMinimumHeight(420)
        self._model = model
        self._catalog = TagCatalog(model)
        self._marker = ""

        root = QVBoxLayout(self)
        kind_row = QHBoxLayout()
        kind_row.addWidget(QLabel("类型"))
        self._kind = QComboBox()
        for k, lab in _KIND_LABELS:
            self._kind.addItem(lab, k)
        kind_row.addWidget(self._kind, 1)
        root.addLayout(kind_row)

        self._filter = QLineEdit()
        self._filter.setPlaceholderText("筛选 id / 名称…")
        root.addWidget(self._filter)

        self._stack = QStackedWidget()
        self._lists: dict[str, QListWidget] = {}
        for k, _lab in _KIND_LABELS:
            lw = QListWidget()
            lw.itemDoubleClicked.connect(self._accept_current)
            self._lists[k] = lw
            self._stack.addWidget(lw)
        root.addWidget(self._stack, 1)

        preview = QLabel("")
        preview.setWordWrap(True)
        preview.setStyleSheet("color: #666;")
        self._preview = preview
        root.addWidget(preview)

        bb = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        bb.accepted.connect(self._on_ok)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)

        self._kind.currentIndexChanged.connect(self._on_kind_changed)
        self._filter.textChanged.connect(self._refresh_list)
        self._on_kind_changed(0)

    def marker(self) -> str:
        return self._marker

    def _on_kind_changed(self, idx: int) -> None:
        k = self._kind.itemData(idx)
        if isinstance(k, str):
            self._stack.setCurrentWidget(self._lists[k])
        self._refresh_list()

    def _refresh_list(self) -> None:
        idx = self._kind.currentIndex()
        k = str(self._kind.itemData(idx) or "string")
        lw = self._lists[k]
        lw.clear()
        q = self._filter.text().strip().lower()
        items = self._catalog.list_by_kind(k)
        if q:
            items = [it for it in items if q in f"{it.ref_id} {it.label} {it.hint}".lower()]
        for it in items:
            lw.addItem(QListWidgetItem(f"{it.label}  [{it.ref_id}]"))
            lw.item(lw.count() - 1).setData(Qt.ItemDataRole.UserRole, it)
        self._preview.setText("")

    def _current_item(self) -> TagItem | None:
        idx = self._kind.currentIndex()
        k = str(self._kind.itemData(idx) or "string")
        lw = self._lists[k]
        row = lw.currentRow()
        if row < 0:
            return None
        it = lw.item(row)
        if not it:
            return None
        data = it.data(Qt.ItemDataRole.UserRole)
        return data if isinstance(data, TagItem) else None

    def _accept_current(self) -> None:
        self._on_ok()

    def _on_ok(self) -> None:
        item = self._current_item()
        if item is None:
            QMessageBox.warning(self, "插入引用", "请选择一项")
            return
        self._marker = self._catalog.marker_for(item)
        if not self._marker:
            QMessageBox.warning(self, "插入引用", "无法生成标记")
            return
        self.accept()


def _needs_check(text: str) -> bool:
    """要不要跑校验：有项目引用/色标记/线索标记才跑（无则不占一行提示）。

    [clue:] 与 [c:] 同理必须进这道门：未知/非法线索 id 会被 validate_refs_for_save
    硬拦保存，编辑期零反馈会让两边口径反着。
    """
    return (
        "[tag:" in text or "[c:" in text or "[/c]" in text
        or "[clue:" in text or "[/clue]" in text
    )


def _format_errs(errs: list[str]) -> str:
    if not errs:
        return "（引用与色标记校验通过）"
    return "问题:\n" + "\n".join(errs[:5])


class RichTextTextEdit(QWidget):
    """QTextEdit + 插入引用；API 兼容 toPlainText / setPlainText / textChanged。"""

    textChanged = Signal()

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        self._edit = QTextEdit()
        self._edit.textChanged.connect(self.textChanged.emit)
        row.addWidget(self._edit, 1)
        btn = QPushButton("引用")
        btn.setMaximumWidth(44)
        btn.setToolTip("插入项目引用 [tag:…]（勿手打）")
        btn.clicked.connect(self._insert_ref)
        row.addWidget(btn)
        row.addWidget(build_color_button(self, lambda: self._model, self._wrap_color))
        # 「插入标记 ▾」：线索词条走弹窗选择器（勿手打 id），块级标记纯文本插入。
        # 只挂在多行控件上——[h]/[quote]/[hr]/[caption] 是行首/块级语义，单行字段没用。
        mark_btn = QPushButton("标记 ▾")
        mark_btn.setMaximumWidth(56)
        mark_btn.setToolTip(
            "插入标记：线索词条 [clue:id]…[/clue]（弹窗选择，勿手打 id），\n"
            "以及块级标记 [h] 小节标题 / [quote] 引文 / [hr] 分隔线 / [caption] 图注。")
        mark_btn.clicked.connect(self._marker_menu_popup)
        self._mark_btn = mark_btn
        row.addWidget(mark_btn)
        lay.addLayout(row)
        self._hint = QLabel("")
        self._hint.setWordWrap(True)
        self._hint.setStyleSheet("color:#888;")
        theme.set_editor_font_role(self._hint, theme.FONT_ROLE_HINT)
        lay.addWidget(self._hint)
        self._hint_timer = QTimer(self)
        self._hint_timer.setSingleShot(True)
        self._hint_timer.setInterval(240)
        self._hint_timer.timeout.connect(self._flush_hint)
        self._edit.textChanged.connect(self._schedule_hint)
        self._edit.installEventFilter(self)

    def eventFilter(self, obj: QObject, ev: QEvent) -> bool:  # noqa: ANN001
        if obj is self._edit and ev.type() == QEvent.Type.FocusOut:
            self._hint_timer.stop()
            self._flush_hint()
        return super().eventFilter(obj, ev)

    def set_model(self, model: ProjectModel) -> None:
        """切换工程模型（图编辑器 PropertyStack 在载入工程后注入）。"""
        self._model = model
        self._schedule_hint()

    def core_text_edit(self) -> QTextEdit:
        """供插入图片等需直接操作 QTextCursor 的逻辑使用。"""
        return self._edit

    def _schedule_hint(self) -> None:
        # 无引用也无色标记时不显示提示行（避免常驻"（校验通过）"占位噪声）。
        # ⚠ 色标记必须一起进这道门：否则 [c:打错的id] / 漏 [/c] 在编辑时零反馈，
        # 到「保存全部」才被 validate_refs_for_save 硬拦下整桶（两边口径反着）。
        if not _needs_check(self._edit.toPlainText()):
            self._hint.setText("")
            return
        self._hint_timer.start()

    def _flush_hint(self) -> None:
        t = self._edit.toPlainText()
        if not _needs_check(t):
            self._hint.setText("")
            return
        errs = scan_refs(t, "预览", self._model)
        self._hint.setText(_format_errs(errs))

    def _insert_ref(self) -> None:
        dlg = InsertRefDialog(self._model, self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        m = dlg.marker()
        if not m:
            return
        self._edit.textCursor().insertText(m)
        self._hint_timer.stop()
        self._flush_hint()

    def _wrap_color(self, palette_id: str) -> None:
        cur = self._edit.textCursor()
        sel = cur.selectedText()
        # Qt 的 selectedText 用 U+2029 表示换行，直接回写会把段落分隔符写进 JSON
        sel = sel.replace("\u2029", "\n")
        cur.insertText(wrap_with_color(sel, palette_id))
        if not sel:
            # 空选区：把光标停到一对标记中间，接着打字就是带色的
            cur.setPosition(cur.position() - len("[/c]"))
            self._edit.setTextCursor(cur)
        self._hint_timer.stop()
        self._flush_hint()

    # ---- 插入标记（[clue:] 弹窗选择 + 块级标记）----------------------------

    def _marker_menu_popup(self) -> None:
        menu = QMenu(self)
        act_clue = menu.addAction("线索词条…（[clue:id]…[/clue]，有选区则包裹）")
        act_clue.triggered.connect(lambda _=False: self._insert_clue_marker())
        menu.addSeparator()
        act_h = menu.addAction("[h] 小节标题（行首，标记后接着打标题）")
        act_h.triggered.connect(lambda _=False: self._insert_block_line("[h]"))
        act_q = menu.addAction("[quote] 引文块（有选区则包裹）")
        act_q.triggered.connect(lambda _=False: self._insert_quote_marker())
        act_hr = menu.addAction("[hr] 分隔线（独立一行）")
        act_hr.triggered.connect(lambda _=False: self._insert_block_line("[hr]"))
        act_cap = menu.addAction("[caption] 图注（紧跟 [img:] 行之后）")
        act_cap.triggered.connect(lambda _=False: self._insert_block_line("[caption]"))
        menu.exec(self._mark_btn.mapToGlobal(self._mark_btn.rect().bottomLeft()))

    def _insert_clue_marker(self) -> None:
        """弹窗选线索词条（候选=ProjectModel 活数据），包裹选区或插入空对停光标于中间。"""
        from .ref_validator import clue_registry_rows
        from .reference_picker import ReferencePickerDialog

        rows: list[tuple[str, str, str]] = []
        for c in clue_registry_rows(self._model):
            cid = str(c.get("id") or "").strip()
            if not cid:
                continue
            title = str(c.get("title") or "").strip() or cid
            desc = str(c.get("desc") or "").strip().replace("\n", " ")
            detail = desc[:60] + ("…" if len(desc) > 60 else "")
            cat = str(c.get("category") or "").strip()
            if cat:
                detail = f"[{cat}] {detail}".rstrip()
            rows.append((cid, title, detail))
        if not rows:
            QMessageBox.information(
                self, "插入线索词条",
                "线索注册表为空——先在 档案 → 线索 Clues 页新建词条。")
            return
        dlg = ReferencePickerDialog(
            rows,
            title="插入线索词条（[clue:id]…[/clue]）",
            parent=self,
            geometry_key="clue_marker_picker",
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        cid = dlg.selected_value()
        if not cid:
            return
        cur = self._edit.textCursor()
        sel = cur.selectedText().replace("\u2029", "\n")
        cur.insertText(f"[clue:{cid}]{sel}[/clue]")
        if not sel:
            # 空选区：光标停在一对标记中间，接着打字就是被圈住的词条
            cur.setPosition(cur.position() - len("[/clue]"))
        self._edit.setTextCursor(cur)
        self._hint_timer.stop()
        self._flush_hint()

    def _insert_block_line(self, marker: str) -> None:
        """行首语义标记（[h]/[hr]/[caption]）：当前行空则落行首，非空则先换到下一行。"""
        cur = self._edit.textCursor()
        cur.clearSelection()
        if cur.block().text().strip():
            cur.movePosition(QTextCursor.MoveOperation.EndOfBlock)
            cur.insertText("\n" + marker)
        else:
            cur.movePosition(QTextCursor.MoveOperation.StartOfBlock)
            cur.insertText(marker)
        self._edit.setTextCursor(cur)
        self._hint_timer.stop()
        self._flush_hint()

    def _insert_quote_marker(self) -> None:
        """[quote] 引文块：包裹选区（选区不在行首时先换行保住行首语义）；无选区插空对。"""
        cur = self._edit.textCursor()
        sel = cur.selectedText().replace("\u2029", "\n")
        if sel:
            start_cur = QTextCursor(cur)
            start_cur.setPosition(cur.selectionStart())
            prefix = "" if start_cur.positionInBlock() == 0 else "\n"
            close = "\n[/quote]" if "\n" in sel else "[/quote]"
            cur.insertText(f"{prefix}[quote]{sel}{close}")
        else:
            if cur.block().text().strip():
                cur.movePosition(QTextCursor.MoveOperation.EndOfBlock)
                cur.insertText("\n[quote][/quote]")
            else:
                cur.movePosition(QTextCursor.MoveOperation.StartOfBlock)
                cur.insertText("[quote][/quote]")
            cur.setPosition(cur.position() - len("[/quote]"))
        self._edit.setTextCursor(cur)
        self._hint_timer.stop()
        self._flush_hint()

    def toPlainText(self) -> str:
        return self._edit.toPlainText()

    def setPlainText(self, text: str) -> None:
        self._edit.setPlainText(text)
        self._hint_timer.stop()
        self._flush_hint()

    def setMaximumHeight(self, maxh: int) -> None:
        self._edit.setMaximumHeight(maxh)

    def setPlaceholderText(self, text: str) -> None:
        self._edit.setPlaceholderText(text)

    def clear(self) -> None:
        self._edit.clear()


class RichTextLineEdit(QWidget):
    """QLineEdit + 插入引用。"""

    textChanged = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        self._edit = QLineEdit()
        self._edit.textChanged.connect(self.textChanged.emit)
        btn = QPushButton("引用")
        btn.setMaximumWidth(44)
        btn.setToolTip("插入项目引用 [tag:…]（勿手打）")
        btn.clicked.connect(self._insert_ref)
        row.addWidget(self._edit, 1)
        row.addWidget(btn)
        row.addWidget(build_color_button(self, lambda: self._model, self._wrap_color))
        outer.addLayout(row)
        self._hint = QLabel("")
        self._hint.setWordWrap(True)
        self._hint.setStyleSheet("color:#888;")
        theme.set_editor_font_role(self._hint, theme.FONT_ROLE_HINT)
        outer.addWidget(self._hint)
        self._hint_timer = QTimer(self)
        self._hint_timer.setSingleShot(True)
        self._hint_timer.setInterval(240)
        self._hint_timer.timeout.connect(self._flush_hint)
        self._edit.textChanged.connect(self._schedule_hint)
        self._edit.editingFinished.connect(self._flush_hint_after_edit)

    def set_model(self, model: ProjectModel) -> None:
        self._model = model
        self._schedule_hint()

    def _schedule_hint(self) -> None:
        if not _needs_check(self._edit.text()):
            self._hint.setText("")
            return
        self._hint_timer.start()

    def _flush_hint_after_edit(self) -> None:
        self._hint_timer.stop()
        self._flush_hint()

    def _flush_hint(self) -> None:
        t = self._edit.text()
        if not _needs_check(t):
            self._hint.setText("")
            return
        errs = scan_refs(t, "单行预览", self._model)
        self._hint.setText(_format_errs(errs))

    def _insert_ref(self) -> None:
        dlg = InsertRefDialog(self._model, self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        m = dlg.marker()
        if not m:
            return
        self.insert(m)

    def insert(self, text: str) -> None:
        """在光标处插入（供「插入 {{player}}」等菜单与其它控件复用）。"""
        self._edit.insert(text)
        self._hint_timer.stop()
        self._flush_hint()

    def _wrap_color(self, palette_id: str) -> None:
        sel = self._edit.selectedText().replace("\u2029", "\n")
        self._edit.insert(wrap_with_color(sel, palette_id))
        if not sel:
            self._edit.setCursorPosition(self._edit.cursorPosition() - len("[/c]"))
        self._hint_timer.stop()
        self._flush_hint()

    def text(self) -> str:
        return self._edit.text()

    def setText(self, text: str) -> None:
        self._edit.setText(text)
        self._hint_timer.stop()
        self._flush_hint()

    def setPlaceholderText(self, text: str) -> None:
        self._edit.setPlaceholderText(text)

    def clear(self) -> None:
        self._edit.clear()
