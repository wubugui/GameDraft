"""包内「设定 MD 库」编辑：粗糙原文档，用于生成种子时合并送入 LLM。"""
from __future__ import annotations

import uuid
from pathlib import Path

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim.gui.layout_compact import tighten

from tools.chronicle_sim.core.storage.seed_md_catalog import (
    SeedMdEntry,
    delete_entry_files,
    load_manifest,
    read_entry_body,
    save_manifest,
    slug_from_title,
    write_entry_body,
)
from tools.chronicle_sim.gui.console_errors import log_messagebox_warning
from tools.chronicle_sim.gui.error_dialog import exc_human


_CATEGORY_CHOICES: list[tuple[str, str]] = [
    ("world", "世界观与背景"),
    ("npc", "角色与势力素材"),
    ("plot", "情节与冲突"),
    ("misc", "杂项 / 随笔"),
]


class SeedMdLibraryWidget(QWidget):
    """管理 data/seed_md_library 下的 manifest + md 文件。"""

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._manifest = load_manifest()
        self._current_id: str | None = None

        root = QVBoxLayout(self)
        tighten(root, margins=(4, 4, 4, 4), spacing=4)
        self.setToolTip(
            "粗糙原文 Markdown；生成种子时合并「已勾选」条目送入 LLM。\n"
            "路径：tools/chronicle_sim/data/seed_md_library/，可备份入库。"
        )
        hint = QLabel("粗糙设定原文；生成种子时合并已勾选条目。（悬停空白处见路径与说明）")
        hint.setStyleSheet("color: palette(mid); font-size: 11px;")
        root.addWidget(hint)

        split = QSplitter()
        left = QWidget()
        ll = QVBoxLayout(left)
        tighten(ll, margins=(0, 0, 0, 0), spacing=4)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_row_changed)
        ll.addWidget(self._list)
        row_btn = QHBoxLayout()
        self._btn_new = QPushButton("新建条目")
        self._btn_new.clicked.connect(self._new_entry)
        self._btn_import = QPushButton("导入 .md 文件")
        self._btn_import.setToolTip("可多选文件；导入后立即写入 manifest 与库内 .md 文件。")
        self._btn_import.clicked.connect(self._import_file)
        self._btn_del = QPushButton("删除条目")
        self._btn_del.clicked.connect(self._delete_entry)
        row_btn.addWidget(self._btn_new)
        row_btn.addWidget(self._btn_import)
        row_btn.addWidget(self._btn_del)
        ll.addLayout(row_btn)
        split.addWidget(left)

        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        right_inner = QWidget()
        rl = QVBoxLayout(right_inner)
        tighten(rl, margins=(4, 4, 4, 4), spacing=4)
        form_title = QHBoxLayout()
        form_title.addWidget(QLabel("标题"))
        self._title = QLineEdit()
        form_title.addWidget(self._title, 1)
        rl.addLayout(form_title)
        form_cat = QHBoxLayout()
        form_cat.addWidget(QLabel("分类"))
        self._category = QComboBox()
        for val, label in _CATEGORY_CHOICES:
            self._category.addItem(label, val)
        form_cat.addWidget(self._category, 1)
        rl.addLayout(form_cat)
        form_ord = QHBoxLayout()
        form_ord.addWidget(QLabel("排序"))
        self._sort_order = QSpinBox()
        self._sort_order.setRange(-999, 999)
        form_ord.addWidget(self._sort_order)
        self._enabled = QCheckBox("生成种子时包含此文档")
        self._enabled.setChecked(True)
        form_ord.addWidget(self._enabled)
        form_ord.addStretch(1)
        rl.addLayout(form_ord)
        self._editor = QTextEdit()
        self._editor.setPlaceholderText("在此写粗糙设定全文，保存后写入库内文件…")
        self._editor.setMinimumHeight(200)
        rl.addWidget(self._editor, 1)
        btn_save = QPushButton("保存当前条目到 MD 库")
        btn_save.clicked.connect(self._save_current)
        rl.addWidget(btn_save)
        right_scroll.setWidget(right_inner)
        split.addWidget(right_scroll)
        split.setStretchFactor(1, 2)
        root.addWidget(split, 1)

        self._reload_list(select_id=None)

    def _entry_by_id(self, eid: str) -> SeedMdEntry | None:
        for e in self._manifest.entries:
            if e.id == eid:
                return e
        return None

    def _reload_list(self, *, select_id: str | None) -> None:
        self._list.blockSignals(True)
        self._list.clear()
        for e in sorted(self._manifest.entries, key=lambda x: (x.sort_order, x.title)):
            cat_lbl = next((lb for v, lb in _CATEGORY_CHOICES if v == e.category), e.category)
            mark = "含" if e.enabled else "停"
            it = QListWidgetItem(f"{mark} [{cat_lbl}] {e.title}")
            it.setData(256, e.id)
            self._list.addItem(it)
        self._list.blockSignals(False)
        if select_id:
            for i in range(self._list.count()):
                it = self._list.item(i)
                if it and it.data(256) == select_id:
                    self._list.setCurrentRow(i)
                    return
        if self._list.count():
            self._list.setCurrentRow(0)

    def _on_row_changed(self, row: int) -> None:
        if row < 0:
            self._current_id = None
            self._title.clear()
            self._editor.clear()
            return
        it = self._list.item(row)
        if not it:
            return
        eid = it.data(256)
        if not eid:
            return
        self._current_id = str(eid)
        ent = self._entry_by_id(self._current_id)
        if not ent:
            return
        self._title.setText(ent.title)
        idx = self._category.findData(ent.category)
        if idx < 0:
            idx = 0
        self._category.setCurrentIndex(idx)
        self._sort_order.setValue(ent.sort_order)
        self._enabled.setChecked(ent.enabled)
        self._editor.setPlainText(read_entry_body(ent.id))

    def _new_entry(self) -> None:
        eid = uuid.uuid4().hex
        ent = SeedMdEntry(id=eid, title="新设定条目", category="misc", enabled=True, sort_order=0)
        self._manifest.entries.append(ent)
        save_manifest(self._manifest)
        write_entry_body(eid, "")
        self._reload_list(select_id=eid)
        self.changed.emit()

    def _import_file(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            "导入 Markdown（可多选）",
            "",
            "Markdown (*.md);;文本 (*.txt);;所有 (*.*)",
        )
        if not paths:
            return
        last_eid: str | None = None
        errors: list[str] = []
        ok = 0
        for path_str in paths:
            p = Path(path_str)
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                errors.append(f"{p.name}: {exc_human(e)}")
                continue
            eid = uuid.uuid4().hex
            title = p.stem
            ent = SeedMdEntry(
                id=eid,
                title=title,
                category="misc",
                enabled=True,
                sort_order=0,
            )
            self._manifest.entries.append(ent)
            write_entry_body(eid, text)
            last_eid = eid
            ok += 1
        if ok == 0:
            if errors:
                msg = "\n".join(errors)
                log_messagebox_warning("导入失败", msg)
                QMessageBox.warning(self, "导入失败", msg)
            return
        save_manifest(self._manifest)
        self._reload_list(select_id=last_eid)
        self.changed.emit()
        if errors:
            detail = "\n".join(errors)
            log_messagebox_warning("部分导入失败", f"成功 {ok} 个，失败 {len(errors)} 个。\n\n{detail}")
            QMessageBox.warning(
                self,
                "部分导入失败",
                f"已成功导入 {ok} 个文件并写入 MD 库；以下文件未导入：\n\n{detail}",
            )
        elif len(paths) > 1:
            QMessageBox.information(self, "导入完成", f"已导入 {ok} 个文件并写入 MD 库（manifest与正文已落盘）。")

    def _delete_entry(self) -> None:
        if not self._current_id:
            return
        eid = self._current_id
        reply = QMessageBox.question(
            self,
            "确认删除",
            f"将永久删除库内该条目及其 md 文件。\n\nid={eid}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        self._manifest.entries = [e for e in self._manifest.entries if e.id != eid]
        save_manifest(self._manifest)
        delete_entry_files(eid)
        self._current_id = None
        self._reload_list(select_id=None)
        if self._list.count():
            self._list.setCurrentRow(0)
        self.changed.emit()

    def _save_current(self) -> None:
        if not self._current_id:
            QMessageBox.information(self, "提示", "请先在左侧选择或新建一个条目。")
            return
        ent = self._entry_by_id(self._current_id)
        if not ent:
            return
        ent.title = self._title.text().strip() or slug_from_title("untitled")
        ent.category = str(self._category.currentData() or "misc")
        ent.sort_order = int(self._sort_order.value())
        ent.enabled = self._enabled.isChecked()
        save_manifest(self._manifest)
        write_entry_body(ent.id, self._editor.toPlainText())
        self._reload_list(select_id=ent.id)
        self.changed.emit()
        QMessageBox.information(self, "已保存", "条目已写入 MD 库。")
