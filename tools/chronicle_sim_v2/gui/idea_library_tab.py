"""设定库标签页。"""
from __future__ import annotations

import os
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDialog, QDialogButtonBox, QFileDialog, QFormLayout,
    QHBoxLayout, QHeaderView, QLabel, QLineEdit,
    QPushButton, QTableWidget, QTableWidgetItem, QTextEdit, QVBoxLayout, QWidget,
)

from tools.chronicle_sim_v2.core.world import idea_library as idea_lib
from tools.chronicle_sim_v2.gui.app_settings import save_last_run_path


class IdeaLibraryTab(QWidget):
    log_signal = Signal(str)
    run_changed = Signal(object)  # Path | None

    def __init__(self) -> None:
        super().__init__()
        self._run_dir: Path | None = None

        layout = QVBoxLayout(self)

        # 工具栏
        toolbar = QHBoxLayout()
        self.btn_new = QPushButton("新建灵感")
        self.btn_new.clicked.connect(self._new_idea)
        toolbar.addWidget(self.btn_new)
        self.btn_import = QPushButton("导入 MD")
        self.btn_import.clicked.connect(self._import_md)
        toolbar.addWidget(self.btn_import)
        self.btn_delete = QPushButton("删除选中")
        self.btn_delete.clicked.connect(self._delete_idea)
        toolbar.addWidget(self.btn_delete)

        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("搜索（回车=文本过滤）...")
        self.search_edit.returnPressed.connect(self._filter_table)
        toolbar.addWidget(self.search_edit)

        self.btn_semantic = QPushButton("语义搜索")
        self.btn_semantic.clicked.connect(self._semantic_search)
        toolbar.addWidget(self.btn_semantic)

        self.btn_clear = QPushButton("清除")
        self.btn_clear.clicked.connect(self._clear_search)
        self.btn_clear.setVisible(False)
        toolbar.addWidget(self.btn_clear)

        self.btn_rebuild = QPushButton("重建索引")
        self.btn_rebuild.clicked.connect(self._rebuild_index)
        toolbar.addWidget(self.btn_rebuild)

        toolbar.addStretch()
        layout.addLayout(toolbar)

        # 表格
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["标题", "标签", "来源", "创建时间"])
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.cellDoubleClicked.connect(self._edit_idea)
        layout.addWidget(self.table)

        # 详情面板
        detail_layout = QFormLayout()
        self.detail_view = QTextEdit()
        self.detail_view.setReadOnly(True)
        detail_layout.addRow("内容:", self.detail_view)
        layout.addLayout(detail_layout)

        self.table.cellClicked.connect(self._show_detail)

    def set_run_dir(self, run_dir: Path | None) -> None:
        self._run_dir = run_dir
        if run_dir:
            save_last_run_path(str(run_dir))
            self._reload_table()
        else:
            self.table.setRowCount(0)
            self.detail_view.clear()

    def _reload_table(self) -> None:
        if not self._run_dir:
            return
        self.table.setRowCount(0)
        ideas = idea_lib.list_ideas(self._run_dir)
        for i, idea in enumerate(ideas):
            self.table.insertRow(i)
            self.table.setItem(i, 0, QTableWidgetItem(idea.title))
            self.table.setItem(i, 1, QTableWidgetItem(", ".join(idea.tags)))
            self.table.setItem(i, 2, QTableWidgetItem(idea.source))
            self.table.setItem(i, 3, QTableWidgetItem(idea.created_at[:19] if idea.created_at else ""))

    def _show_detail(self, row: int, _col: int) -> None:
        if not self._run_dir:
            return
        item = self.table.item(row, 0)
        if not item:
            return
        title = item.text()
        ideas = idea_lib.list_ideas(self._run_dir)
        for idea in ideas:
            if idea.title == title:
                self.detail_view.setPlainText(idea.body)
                break

    def _filter_table(self) -> None:
        self.btn_clear.setVisible(False)
        q = self.search_edit.text().lower()
        if not self._run_dir or not q:
            self._reload_table()
            return
        self._reload_table()  # 先恢复全量，再隐藏不匹配
        for row in range(self.table.rowCount()):
            match = False
            for col in range(self.table.columnCount()):
                item = self.table.item(row, col)
                if item and q in item.text().lower():
                    match = True
                    break
            self.table.setRowHidden(row, not match)
        self.btn_clear.setVisible(True)

    def _clear_search(self) -> None:
        self.search_edit.clear()
        self.btn_clear.setVisible(False)
        self._reload_table()

    def _semantic_search(self) -> None:
        if not self._run_dir:
            return
        q = self.search_edit.text().strip()
        if not q:
            return
        from tools.chronicle_sim_v2.core.world.chroma import is_embedding_configured
        if not is_embedding_configured(self._run_dir):
            self.log_signal.emit("语义搜索未配置嵌入模型。请在种子编辑器 > LLM 配置 > 「嵌入」区域设置 OpenAI 兼容 API")
            return
        results = idea_lib.search_ideas_semantic(self._run_dir, q, n_results=10)
        self.table.setRowCount(0)
        for i, idea in enumerate(results):
            self.table.insertRow(i)
            self.table.setItem(i, 0, QTableWidgetItem(idea.title))
            self.table.setItem(i, 1, QTableWidgetItem(", ".join(idea.tags)))
            self.table.setItem(i, 2, QTableWidgetItem(idea.source))
            self.table.setItem(i, 3, QTableWidgetItem(idea.created_at[:19] if idea.created_at else ""))
        self.btn_clear.setVisible(True)
        self.log_signal.emit(f"语义搜索 '{q}' → {len(results)} 条结果")

    def _new_idea(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        dlg = _IdeaDialog(self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            idea_lib.create_idea(self._run_dir, dlg.title(), dlg.body(), dlg.tags())
            self._reload_table()
            self.log_signal.emit("新建灵感已保存")

    def _import_md(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        files, _ = QFileDialog.getOpenFileNames(self, "导入 MD 文件", "", "Markdown 文件 (*.md);;所有文件 (*)")
        for fp in files:
            result = idea_lib.import_md_file(self._run_dir, fp)
            if result:
                self._reload_table()
                self.log_signal.emit(f"导入: {os.path.basename(fp)}")

    def _delete_idea(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        rows = sorted({r.row() for r in self.table.selectedIndexes()}, reverse=True)
        ideas = idea_lib.list_ideas(self._run_dir)
        for row in rows:
            item = self.table.item(row, 0)
            if item:
                title = item.text()
                for idea in ideas:
                    if idea.title == title:
                        idea_lib.delete_idea(self._run_dir, idea.id)
                        self.log_signal.emit(f"删除: {idea.title}")
                        break
        self._reload_table()

    def _rebuild_index(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        from tools.chronicle_sim_v2.core.world.chroma import rebuild_ideas_collection
        n = rebuild_ideas_collection(self._run_dir)
        self.log_signal.emit(f"重建索引完成（{n} 条）")
        self._reload_table()

    def _edit_idea(self, row: int, _col: int) -> None:
        if not self._run_dir:
            return
        item = self.table.item(row, 0)
        if not item:
            return
        title = item.text()
        ideas = idea_lib.list_ideas(self._run_dir)
        for idea in ideas:
            if idea.title == title:
                dlg = _IdeaDialog(self, title=idea.title, body=idea.body, tags=", ".join(idea.tags))
                if dlg.exec() == QDialog.DialogCode.Accepted:
                    idea_lib.update_idea(self._run_dir, idea.id, title=dlg.title(), body=dlg.body(), tags=dlg.tags())
                    self._reload_table()
                    self.log_signal.emit("更新灵感")
                break


class _IdeaDialog(QDialog):
    def __init__(self, parent=None, title: str = "", body: str = "", tags: str = ""):
        super().__init__(parent)
        self.setWindowTitle("灵感编辑")
        self.resize(600, 500)
        layout = QFormLayout(self)

        self.title_edit = QLineEdit(title)
        layout.addRow("标题:", self.title_edit)

        self.tags_edit = QLineEdit(tags)
        layout.addRow("标签 (逗号分隔):", self.tags_edit)

        self.body_edit = QTextEdit()
        self.body_edit.setPlainText(body)
        layout.addRow("内容:", self.body_edit)

        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        layout.addRow(btns)

    def title(self) -> str:
        return self.title_edit.text().strip()

    def body(self) -> str:
        return self.body_edit.toPlainText().strip()

    def tags(self) -> list[str]:
        return [t.strip() for t in self.tags_edit.text().split(",") if t.strip()]
