"""Main window: menu bar, toolbar, search, tree view, detail panel."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDockWidget,
    QFileDialog,
    QLabel,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QSplitter,
    QStatusBar,
    QTreeView,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from tools.copy_manager.exporters.backfiller import Backfiller
from tools.copy_manager.exporters.json_exporter import JsonExporter
from tools.copy_manager.scanner.base import TextEntry
from tools.copy_manager.scanner.cutscene_scanner import CutsceneScanner
from tools.copy_manager.scanner.ink_scanner import InkScanner
from tools.copy_manager.scanner.json_scanner import JsonScanner
from tools.copy_manager.scanner.registry import RegistryManager
from tools.copy_manager.widgets.entry_detail import EntryDetailPanel
from tools.copy_manager.widgets.entry_tree import EntryTreeModel
from tools.copy_manager.widgets.export_dialog import ExportDialog
from tools.copy_manager.widgets.search_filter_bar import SearchFilterBar, matches_filter


class MainWindow(QMainWindow):
    """Main application window."""

    def __init__(self, project_root: Path):
        super().__init__()
        self.project_root = project_root
        self.registry = RegistryManager(project_root / "tools" / "copy_manager" / "registry.json")
        self.registry.load()

        self.setWindowTitle(f"Copy Manager — {project_root.name}")
        self.resize(1400, 800)

        self._init_models()
        self._init_ui()
        self._init_menu()
        self._init_toolbar()
        self._connect_signals()

        # Auto-scan on launch if registry is empty
        if not self.registry.get_entries():
            self._scan_all()

    def _init_models(self) -> None:
        self.tree_model = EntryTreeModel(self)
        # Use registry data as dicts (not TextEntry objects) for consistency
        self._filter_text = ""
        self._filter_category = "all"
        self._filter_status = "all"
        self.tree_model.set_entries(self.registry.data.get("entries", []))

    def _expand_categories_only(self) -> None:
        """Expand only the top-level category nodes, collapse groups."""
        model = self.tree_model
        for i in range(model.rowCount()):
            cat_idx = model.index(i, 0)
            self.tree_view.expand(cat_idx)
            # Collapse all group children
            for j in range(model.rowCount(cat_idx)):
                group_idx = model.index(j, 0, cat_idx)
                self.tree_view.collapse(group_idx)

    def _apply_filters(self) -> None:
        """Rebuild the tree model with filtered entries."""
        all_entries = self.registry.data.get("entries", [])
        filtered = [
            e for e in all_entries
            if matches_filter(e, self._filter_text, self._filter_category, self._filter_status)
        ]
        self.tree_model.set_entries(filtered)

    def _init_ui(self) -> None:
        central = QWidget()
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Splitter: tree area (left) + detail (right)
        splitter = QSplitter(Qt.Horizontal)

        # Left side: search bar on top of tree
        left_widget = QWidget()
        left_layout = QVBoxLayout(left_widget)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(0)

        # Search/filter bar
        self.search_bar = SearchFilterBar()
        left_layout.addWidget(self.search_bar)

        # Tree view
        self.tree_view = QTreeView()
        self.tree_view.setModel(self.tree_model)
        self.tree_view.setSelectionBehavior(QTreeView.SelectRows)
        self.tree_view.setSelectionMode(QTreeView.SingleSelection)
        self.tree_view.setAlternatingRowColors(True)
        self.tree_view.setWordWrap(True)
        self.tree_view.setHeaderHidden(False)
        self.tree_view.header().setStretchLastSection(True)
        self.tree_view.setColumnWidth(0, 300)
        self.tree_view.setColumnWidth(1, 120)
        self.tree_view.setColumnWidth(2, 80)
        self.tree_view.setColumnWidth(3, 70)
        self.tree_view.setColumnWidth(4, 120)
        # Expand category level only (collapse groups)
        self._expand_categories_only()
        left_layout.addWidget(self.tree_view)

        splitter.addWidget(left_widget)

        # Detail panel
        self.detail_panel = EntryDetailPanel()
        splitter.addWidget(self.detail_panel)
        splitter.setSizes([800, 600])

        layout.addWidget(splitter)
        self.setCentralWidget(central)

    def _init_menu(self) -> None:
        menubar = self.menuBar()

        # File menu
        file_menu = menubar.addMenu("文件")
        save_action = file_menu.addAction("保存注册表")
        save_action.setShortcut("Ctrl+S")
        save_action.triggered.connect(self._save_registry)

        file_menu.addSeparator()
        quit_action = file_menu.addAction("退出")
        quit_action.setShortcut("Ctrl+Q")
        quit_action.triggered.connect(self.close)

        # Scan menu
        scan_menu = menubar.addMenu("扫描")
        scan_all_action = scan_menu.addAction("全部扫描")
        scan_all_action.setShortcut("F5")
        scan_all_action.triggered.connect(self._scan_all)

        # Export menu
        export_menu = menubar.addMenu("导出")
        export_trans = export_menu.addAction("导出翻译...")
        export_trans.triggered.connect(self._export_translations)
        backfill_action = export_menu.addAction("回写优化...")
        backfill_action.triggered.connect(self._backfill)

    def _init_toolbar(self) -> None:
        toolbar = QToolBar("主工具栏")
        toolbar.setMovable(False)
        self.addToolBar(toolbar)

        scan_btn = toolbar.addAction("🔍 全部扫描")
        scan_btn.triggered.connect(self._scan_all)

        toolbar.addSeparator()

        save_btn = toolbar.addAction("💾 保存")
        save_btn.triggered.connect(self._save_registry)

        toolbar.addSeparator()

        export_btn = toolbar.addAction("📤 导出翻译")
        export_btn.triggered.connect(self._export_translations)

        toolbar.addSeparator()

        backfill_btn = toolbar.addAction("✏️ 回写优化")
        backfill_btn.triggered.connect(self._backfill)

    def _connect_signals(self) -> None:
        # Search/filter
        self.search_bar.text_changed.connect(self._on_filter_text_changed)
        self.search_bar.category_changed.connect(self._on_filter_category_changed)
        self.search_bar.status_changed.connect(self._on_filter_status_changed)

        # Tree selection → detail panel
        self.tree_view.selectionModel().selectionChanged.connect(self._on_selection_changed)

        # Detail panel signals
        self.detail_panel.notes_changed.connect(self._on_notes_changed)
        self.detail_panel.status_changed.connect(self._on_status_changed)
        self.detail_panel.translation_changed.connect(self._on_translation_changed)
        self.detail_panel.language_added.connect(self._on_language_added)
        self.detail_panel.source_changed.connect(self._on_source_changed)

        # Auto-save on any registry change
        self.registry.data  # trigger

    def _on_filter_text_changed(self, text: str) -> None:
        self._filter_text = text.lower()
        self._apply_filters()
        self._expand_categories_only()

    def _on_filter_category_changed(self, category: str) -> None:
        self._filter_category = category
        self._apply_filters()
        self._expand_categories_only()

    def _on_filter_status_changed(self, status: str) -> None:
        self._filter_status = status
        self._apply_filters()
        self._expand_categories_only()

    def _scan_all(self) -> None:
        """Run all scanners and merge results."""
        scanners = [JsonScanner(), InkScanner(), CutsceneScanner()]
        all_entries: list[TextEntry] = []

        self.statusBar().showMessage("正在扫描...")
        for scanner in scanners:
            try:
                entries = scanner.scan(self.project_root)
                all_entries.extend(entries)
                self.statusBar().showMessage(f"扫描完成: {scanner.name} — {len(entries)} 条")
            except Exception as e:
                self.statusBar().showMessage(f"扫描失败: {scanner.name} — {e}")

        new_uids = self.registry.merge_entries(all_entries)

        # Refresh tree
        self._apply_filters()

        # Update status
        stats = self.registry.stats()
        msg = (
            f"共 {stats['total']} 条文案 | "
            f"{stats['pending']} 待审 | {stats['reviewed']} 已审 | "
            f"{stats['translated']} 已译 | {stats['optimized']} 已优化"
        )
        if new_uids:
            msg += f" | 新增 {len(new_uids)} 条"
        self.statusBar().showMessage(msg)
        self._save_registry()

    def _save_registry(self) -> None:
        self.registry.save()
        self.statusBar().showMessage("注册表已保存")

    def _on_selection_changed(self) -> None:
        indexes = self.tree_view.selectionModel().selectedRows()
        if indexes:
            entry = self.tree_model.get_entry(indexes[0])
            self.detail_panel.load_entry(entry)
        else:
            self.detail_panel.load_entry(None)

    def _on_source_changed(self, uid: str, new_text: str) -> None:
        """Save user's source text edit to registry."""
        self.registry.update_entry(uid, {"source_text": new_text})
        # Refresh the tree to show the updated text
        self._apply_filters()
        self.tree_view.expandAll()

    def _on_notes_changed(self, uid: str, notes: str) -> None:
        self.registry.update_entry(uid, {"context_notes": notes})

    def _on_status_changed(self, uid: str, status: str) -> None:
        self.registry.update_entry(uid, {"status": status})
        # Refresh the tree row display
        self._apply_filters()
        self.tree_view.expandAll()

    def _on_translation_changed(self, uid: str, lang: str, text: str) -> None:
        entry = self.registry.get_entry(uid)
        if entry:
            trans = entry.get("translations", {})
            trans[lang] = text
            self.registry.update_entry(uid, {"translations": trans})
            # Update status if text is non-empty
            if text.strip() and entry.get("status") == "pending":
                self.registry.update_entry(uid, {"status": "translated"})

    def _on_language_added(self, uid: str, lang: str) -> None:
        if lang not in self.registry.languages:
            langs = self.registry.languages
            langs.append(lang)
            self.registry.languages = langs

    def _export_translations(self) -> None:
        languages = self.registry.languages
        if not languages:
            languages = ["en"]

        dialog = ExportDialog(self, languages=languages)
        if dialog.exec() != dialog.DialogCode.Accepted:
            return

        lang = dialog.selected_language
        if not lang:
            return

        categories = dialog.get_selected_categories()
        entries = self.registry.get_entries()

        exporter = JsonExporter(self.project_root)
        written = exporter.export(
            [e.to_dict() for e in entries], lang, categories or None
        )

        if written:
            msg = f"已导出 {len(written)} 个文件到 public/assets/data/{lang}/:\n"
            msg += "\n".join(f"  - {p}" for p in written)
            QMessageBox.information(self, "导出完成", msg)
        else:
            QMessageBox.warning(self, "导出为空", "没有找到该语言的翻译内容。")

    def _backfill(self) -> None:
        """Backfill optimized source text to original files."""
        entries = self.registry.get_entries()
        modified = [e.to_dict() for e in entries if e.status == "optimized"]
        if not modified:
            QMessageBox.information(self, "无需回写", "没有状态为 'optimized' 的文案需要回写。")
            return

        # Confirm
        files = set(e["file_path"] for e in modified)
        msg = f"将回写以下 {len(files)} 个文件（会创建 .bak 备份）:\n\n"
        msg += "\n".join(f"  - {f}" for f in sorted(files))
        msg += "\n\n确定继续？"

        reply = QMessageBox.question(self, "确认回写", msg)
        if reply != QMessageBox.StandardButton.Yes:
            return

        backfiller = Backfiller(self.project_root)
        results = backfiller.backfill(modified)

        if results:
            msg = f"已回写 {len(results)} 个文件:\n"
            for fp, bak in results.items():
                msg += f"  {fp} → 备份: {bak.name}\n"
            QMessageBox.information(self, "回写完成", msg)
        else:
            QMessageBox.warning(self, "回写失败", "没有需要回写的改动。")

    def closeEvent(self, event) -> None:
        """Auto-save registry on close."""
        if self.registry.is_dirty:
            self.registry.save()
        super().closeEvent(event)
