"""GameDraft 项目资源内容浏览器：目录树+收藏+网格/表+搜索/筛选+文件服务+缩略图+右侧预览。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional, Tuple

from PySide6.QtCore import QDir, QItemSelectionModel, QPoint, QSize, QTimer, QUrl, Qt, Slot, QModelIndex
from PySide6.QtGui import QCloseEvent, QDesktopServices, QIcon, QKeySequence, QShortcut, QStandardItemModel
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFileSystemModel,
    QFrame,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListView,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QStackedWidget,
    QStatusBar,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from .asset_drop_views import (
    AssetQListView,
    AssetQTableView,
    AssetTreeView,
    internal_drop_wants_copy,
    parse_asset_mime,
    MIME_ASSETS,
)
from .asset_model import (
    PATH_ROLE,
    IS_DIR_ROLE,
    SIZE_NUM_ROLE,
    MTIME_ROLE,
    PopulateOptions,
    populate_dir_model,
    path_at,
)
from .batch_rename_dialog import BatchRenameDialog
from .file_ops import (
    FileOpResult,
    FileOpsService,
    mkdir_p,
    rel_to_repo,
    rename_path,
)
from .metadata_store import (
    load_metadata,
    load_state,
    save_metadata,
    save_state,
    append_op_log,
    norm_key,
    BrowserState,
    AssetMetadata,
)
from .preview_panel import PREVIEW_PREFERRED, PreviewPanel
from .fs_proxy_model import ProjectFileFilterModel
from .thumbnail_service import ThumbnailService


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _is_under(root: Path, p: str) -> bool:
    try:
        Path(p).resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _first_previewable_file(paths: List[str]) -> str | None:
    for p in paths:
        if os.path.isfile(p):
            e = Path(p).suffix.lower()
            if e in PREVIEW_PREFERRED or e in {".tga", ".jxl"}:
                return p
    for p in paths:
        if os.path.isfile(p):
            return p
    return None


class BrowserWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self._root = _repo_root()
        self._state: BrowserState = load_state()
        self._metadata: AssetMetadata = load_metadata()
        self._file_ops = FileOpsService(self)
        self._thumbs = ThumbnailService(self)
        self._clip: Optional[Tuple[str, list[str]]] = None
        self._cur_dir: str = self._state.last_dir or str(self._root)
        if not os.path.isdir(self._cur_dir) or not _is_under(
            self._root, self._cur_dir
        ):
            self._cur_dir = str(self._root)

        self.setWindowTitle("GameDraft 资源浏览")
        self.setMinimumSize(1000, 600)
        if self._state.window_w and self._state.window_h:
            self.resize(
                int(self._state.window_w), int(self._state.window_h)
            )
        else:
            self.resize(1280, 800)
        if self._state.window_x is not None and self._state.window_y is not None:
            self.move(self._state.window_x, self._state.window_y)
        self.setAcceptDrops(True)

        # --- 文件系统树 ---
        self._fs = QFileSystemModel()
        self._fs.setReadOnly(False)
        self._fs.setNameFilterDisables(True)
        self._fs.setFilter(
            QDir.Filter.AllEntries | QDir.Filter.NoDotAndDotDot
        )
        ridx = self._fs.setRootPath(str(self._root))
        if not ridx.isValid():
            ridx = self._fs.index(str(self._root))
        self._proxy = ProjectFileFilterModel()
        self._proxy.setSourceModel(self._fs)
        p_root = self._proxy.mapFromSource(ridx)

        self._tree = AssetTreeView(self)
        self._tree.setModel(self._proxy)
        self._tree.setRootIndex(p_root)
        for c in (1, 2, 3):
            self._tree.setColumnHidden(c, True)
        self._tree.setHeaderHidden(True)
        self._tree.setAnimated(True)
        self._tree.setSelectionMode(
            QAbstractItemView.SelectionMode.ExtendedSelection
        )
        tsel = self._tree.selectionModel()
        if tsel is not None:
            tsel.currentChanged.connect(self._on_tree_current)

        # --- 收藏夹 ---
        self._fav = QListWidget()
        self._fav.setMinimumWidth(200)
        for p in self._state.favorites:
            if p and (os.path.isdir(p) or os.path.isfile(p)):
                it = QListWidgetItem(p)
                it.setData(Qt.ItemDataRole.UserRole, p)
                self._fav.addItem(it)
        self._fav.itemDoubleClicked.connect(
            self._on_fav_double
        )
        fav_w = QVBoxLayout()
        self._btn_fav_add = QPushButton("将当前目录加入收藏")
        self._btn_fav_add.clicked.connect(self._act_fav_add)
        self._btn_fav_remove = QPushButton("删除所选收藏")
        self._btn_fav_remove.clicked.connect(
            self._act_fav_remove
        )
        fav_w.addWidget(self._btn_fav_add)
        fav_w.addWidget(self._btn_fav_remove)
        fav_w.addWidget(self._fav, 1)
        _fav_box = QFrame()
        _fav_box.setLayout(fav_w)

        left_v = QSplitter(Qt.Orientation.Vertical)
        left_v.addWidget(self._tree)
        left_v.addWidget(_fav_box)
        try:
            left_v.setSizes(
                [int(self._state.splitter_v_fav[0]), int(self._state.splitter_v_fav[1])]
            )
        except (IndexError, TypeError, ValueError):
            left_v.setSizes([240, 320])
        self._left_split = left_v

        # --- 中央：筛选 + 视图 ---
        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索名/相对路径/标签(需匹配)")
        self._search.setClearButtonEnabled(True)
        self._search.setText(self._state.search)
        self._type_combo = QComboBox()
        for label, k in [
            ("全部", "all"),
            ("仅文件夹", "folders"),
            ("仅图片", "images"),
            ("仅视频", "video"),
            ("仅音频", "audio"),
            ("文本/JSON", "text"),
            ("3D/模型", "3d"),
            ("关联赛场/资源", "scene_related"),
        ]:
            self._type_combo.addItem(label, k)
        ti = self._type_combo.findData(
            self._state.filter_type
        )
        if ti >= 0:
            self._type_combo.setCurrentIndex(ti)
        self._recurse = QCheckBox("子目录(递归搜索)")
        self._recurse.setChecked(self._state.search_recursive)

        self._thumb_size = QSpinBox()
        self._thumb_size.setRange(48, 256)
        self._thumb_size.setValue(int(self._state.thumb_size or 96))
        self._btn_view = QPushButton("切换: 表/网")
        self._btn_view.clicked.connect(
            self._toggle_view
        )
        htop = QHBoxLayout()
        htop.addWidget(QLabel("搜索:"), 0)
        htop.addWidget(self._search, 1)
        htop.addWidget(QLabel("类型:"), 0)
        htop.addWidget(self._type_combo, 0)
        htop.addWidget(self._recurse, 0)
        htop.addWidget(QLabel("缩略边长:"), 0)
        htop.addWidget(self._thumb_size, 0)
        htop.addWidget(self._btn_view, 0)
        h_top = QFrame()
        h_top.setLayout(htop)

        self._list_model = QStandardItemModel(0, 3)
        self._list_model.setHorizontalHeaderLabels(
            ["名称", "大小", "修改时间"]
        )

        self._grid = AssetQListView(self)
        self._grid.setViewMode(QListView.ViewMode.IconMode)
        self._grid.setModel(self._list_model)
        self._grid.setModelColumn(0)
        self._grid.setWordWrap(True)
        self._grid.setSpacing(8)
        self._grid.setUniformItemSizes(True)
        self._grid.setWrapping(True)
        self._grid.activated.connect(self._on_activated)
        lselg = self._grid.selectionModel()
        if lselg is not None:
            lselg.selectionChanged.connect(self._on_sel_changed)

        self._table = AssetQTableView(self)
        self._table.setModel(self._list_model)
        self._table.setShowGrid(True)
        hdr = self._table.horizontalHeader()
        if hdr is not None:
            hdr.setStretchLastSection(True)
        self._table.doubleClicked.connect(self._on_activated)
        tsel2 = self._table.selectionModel()
        if tsel2 is not None:
            tsel2.selectionChanged.connect(
                self._on_sel_changed
            )
        for v in (self._grid, self._table):
            v.setContextMenuPolicy(
                Qt.ContextMenuPolicy.CustomContextMenu
            )
        self._grid.customContextMenuRequested.connect(
            lambda p: self._show_item_menu(self._grid, p)
        )
        self._table.customContextMenuRequested.connect(
            lambda p: self._show_item_menu(self._table, p)
        )

        self._stack = QStackedWidget()
        self._stack.addWidget(self._grid)
        self._stack.addWidget(self._table)
        if (self._state.view_mode or "grid") == "table":
            self._stack.setCurrentIndex(1)
        else:
            self._stack.setCurrentIndex(0)

        mid = QVBoxLayout()
        mid.setContentsMargins(0, 0, 0, 0)
        mid.addWidget(h_top, 0)
        mid.addWidget(self._stack, 1)
        mid_w = QWidget()
        mid_w.setLayout(mid)

        self._preview = PreviewPanel()
        self._preview_timer = QTimer(self)
        self._preview_timer.setSingleShot(True)
        self._preview_timer.setInterval(100)
        self._preview_timer.timeout.connect(self._flush_preview)

        self._main_split = QSplitter(Qt.Orientation.Horizontal)
        self._main_split.addWidget(self._left_split)
        self._main_split.addWidget(mid_w)
        self._main_split.addWidget(self._preview)
        # PySide6 QSplitter.addWidget 仅接受 QWidget，拉伸用 setStretchFactor
        self._main_split.setStretchFactor(0, 0)
        self._main_split.setStretchFactor(1, 1)
        self._main_split.setStretchFactor(2, 0)
        try:
            if len(self._state.splitter_h) >= 3:
                self._main_split.setSizes(
                    [int(self._state.splitter_h[0]), int(self._state.splitter_h[1]), int(self._state.splitter_h[2])]
                )
        except (TypeError, ValueError, IndexError):
            self._main_split.setSizes([280, 560, 420])

        self.setCentralWidget(self._main_split)
        self._bar: QStatusBar | None = self.statusBar()
        if self._bar:
            self._bar.showMessage(self._cur_dir)

        # --- 缩略图 ---
        self._thumbs.set_thumb_size(self._thumb_size.value())
        self._thumb_size.valueChanged.connect(
            self._on_thumb_size
        )
        self._thumbs.thumbReady.connect(self._on_thumb_ready)

        # --- 信号 ---
        self._search.textChanged.connect(
            self._on_filter_change
        )
        self._type_combo.currentIndexChanged.connect(
            self._on_filter_change
        )
        self._recurse.toggled.connect(self._on_filter_change)

        self._build_menus_and_toolbar()
        self._connect_shortcuts()

        self._apply_list()
        self._sync_tree_to_dir(self._cur_dir)

    # --- 对外：供自定义视图 / 子类 调用（名称稳定）---
    def _show_item_menu(
        self, view: QWidget, pos: QPoint
    ) -> None:
        m = QMenu(self)
        m.addAction("打开/进入", self._act_ctx_open)
        m.addAction("在资源管理器中显示", self._act_open_explorer)
        m.addSeparator()
        m.addAction("重命名 (F2)", self._act_rename)
        m.addAction("删除(回收站)", self._act_delete)
        m.addSeparator()
        m.addAction("复制相对路径", self._act_copy_relpath)
        m.addAction("加标签", self._act_tag)
        m.addSeparator()
        m.addAction("剪切", self._act_cut)
        m.addAction("复制", self._act_copy)
        m.addAction("粘贴", self._act_paste)
        idx = view.indexAt(
            pos
        ) if view is not None else None
        if idx is not None and idx.isValid():
            sel = view.selectionModel()
            if sel is not None and not sel.isSelected(idx):
                sel.clearSelection()
                sel.select(
                    idx,
                    QItemSelectionModel.SelectionFlag.Select
                    | QItemSelectionModel.SelectionFlag.Rows,
                )
            view.setCurrentIndex(
                idx
            )
        m.exec(
            view.mapToGlobal(
                pos
            )
        )

    def _act_ctx_open(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if len(ps) != 1:
            return
        p = ps[0]
        if os.path.isdir(
            p
        ):
            self._go_dir(
                p
            )
        else:
            QDesktopServices.openUrl(
                QUrl.fromLocalFile(
                    p
                )
            )

    def _handle_list_drop(self, e) -> None:  # noqa: ANN001
        dest = self._cur_dir
        self._do_drop(e, dest)

    def _handle_tree_drop(
        self, index: QModelIndex, e
    ) -> None:  # noqa: ANN001
        if not index.isValid():
            dest = str(self._root)
        else:
            s = self._proxy.mapToSource(index)
            if not s.isValid():
                e.ignore()
                return
            p = self._fs.filePath(s)
            if os.path.isfile(p):
                dest = str(Path(p).parent)
            else:
                dest = p
        self._do_drop(e, dest)

    def _is_internal_drag_source(self, o: object) -> bool:
        return o in (self._grid, self._table, self._tree)

    def _do_drop(self, e, dest: str) -> None:
        if not _is_under(self._root, dest):
            e.ignore()
            return
        md = e.mimeData()
        internal: list[str] | None = parse_asset_mime(md)
        if not internal and md.hasUrls() and self._is_internal_drag_source(
            e.source()
        ):
            internal = [
                p
                for p in self._url_paths(md.urls())
                if _is_under(self._root, p)
            ]
        if internal:
            for p in internal:
                if not _is_under(self._root, p):
                    e.ignore()
                    return
            copy_ = internal_drop_wants_copy(e)
            if copy_:
                r = self._file_ops.copyTo(
                    dest, internal, overwrite=False, autorename=True
                )
            else:
                r = self._file_ops.moveTo(dest, internal, overwrite=False)
            self._after_op("copy" if copy_ else "move", r, internal)
            e.setDropAction(
                Qt.DropAction.CopyAction if copy_ else Qt.DropAction.MoveAction
            )
            e.accept()
            self._fs_refresh_touched()
            self._apply_list()
            return
        if md.hasUrls():
            paths = self._url_paths(md.urls())
            if not paths:
                e.ignore()
                return
            r = self._file_ops.copyTo(
                dest, paths, overwrite=False, autorename=True
            )
            append_op_log("import", paths, r.ok, r.failed)
            e.setDropAction(Qt.DropAction.CopyAction)
            e.accept()
            self._fs_refresh_touched()
            self._apply_list()
            if self._bar:
                self._bar.showMessage(
                    f"已导入 {len(r.ok)} 个到 {dest}"
                    + (f"，失败 {len(r.failed)} 个" if r.failed else ""),
                    5000,
                )
            return
        e.ignore()

    @staticmethod
    def _url_paths(
        ul: list[QUrl],
    ) -> list[str]:
        out: list[str] = []
        for u in ul:
            p = u.toLocalFile()
            if p and os.path.exists(p):
                out.append(p)
        return out

    def _after_op(
        self,
        name: str,
        r: FileOpResult,
        items: list[str],
    ) -> None:
        append_op_log(
            name,
            items,
            r.ok,
            r.failed,
        )
        if r.failed and self._bar:
            self._bar.showMessage(
                f"部分失败: {len(r.failed)} 项。见 editor_data/asset_browser_ops.jsonl",  # noqa: E501
                8000,
            )
        elif self._bar and r.ok:
            self._bar.showMessage(
                f"完成: {name} 成功 {len(r.ok)} 项", 5000
            )

    def _fs_refresh_touched(self) -> None:
        try:
            _ = self._fs.setRootPath(
                str(self._root)
            )
        except OSError:
            pass

    @Slot(QModelIndex, QModelIndex)
    def _on_tree_current(
        self,
        current: QModelIndex,
        _prev: QModelIndex,
    ) -> None:
        if not current.isValid():
            return
        s = self._proxy.mapToSource(current)
        if not s.isValid():
            return
        p = self._fs.filePath(s)
        if os.path.isfile(p):
            s = self._fs.index(str(Path(p).parent))
        if s.isValid() and self._fs.isDir(s):
            self._go_dir(self._fs.filePath(s))

    def _on_fav_double(
        self, it: QListWidgetItem
    ) -> None:
        p = it.data(Qt.ItemDataRole.UserRole) or it.text()
        if isinstance(p, str) and p:
            d = p if os.path.isdir(p) else str(Path(p).parent)
            if os.path.isdir(d):
                self._go_dir(d)

    def _on_filter_change(
        self, *_a: object
    ) -> None:
        self._apply_list()

    def _on_thumb_size(
        self, v: int
    ) -> None:
        s = int(v)
        self._thumbs.set_thumb_size(s)
        self._grid.setIconSize(QSize(s + 8, s + 8))
        g = self._thumbs.bump_generation()
        self._request_thumbs(g)

    def _toggle_view(
        self, *_: object
    ) -> None:
        if self._stack.currentIndex() == 0:
            self._stack.setCurrentIndex(1)
        else:
            self._stack.setCurrentIndex(0)
        g = self._thumbs.bump_generation()
        self._request_thumbs(g)

    def _go_dir(
        self, d: str
    ) -> None:
        d = str(Path(d))
        if not os.path.isdir(d) or not _is_under(
            self._root, d
        ):
            return
        self._cur_dir = d
        self._state.last_dir = d
        if d not in self._state.recent_dirs:
            self._state.recent_dirs.insert(0, d)
        self._state.recent_dirs = self._state.recent_dirs[:30]
        self._apply_list()
        self._sync_tree_to_dir(
            d
        )
        if self._bar:
            self._bar.showMessage(f"当前: {d}")

    def _sync_tree_to_dir(
        self, d: str
    ) -> None:
        s = self._fs.index(
            d
        )
        if s.isValid():
            px = self._proxy.mapFromSource(s)
            if px.isValid():
                self._tree.setCurrentIndex(
                    px
                )
                self._tree.scrollTo(
                    px
                )

    def _apply_list(
        self, *_: object
    ) -> None:
        opts = PopulateOptions(
            filter_type=self._type_combo.currentData() or "all",  # type: ignore[arg-type]
            search=self._search.text(),
            metadata=self._metadata,
            recursive=self._recurse.isChecked(),
        )
        g = self._thumbs.bump_generation()
        populate_dir_model(
            self._list_model, self._cur_dir, opts, set_placeholder_icon=True
        )
        if self._bar:
            self._bar.showMessage(
                f"{self._cur_dir} | {self._list_model.rowCount()} 项"
            )
        s = int(self._thumb_size.value())
        self._grid.setIconSize(QSize(s + 8, s + 8))
        self._thumbs.set_thumb_size(s)
        self._request_thumbs(
            g
        )
        tsel2 = self._table.selectionModel()
        if tsel2 is not None:
            tsel2.clear()
        tsel1 = self._grid.selectionModel()
        if tsel1 is not None:
            tsel1.clear()

    def _request_thumbs(
        self, gen: int
    ) -> None:
        for r in range(self._list_model.rowCount()):
            it0 = self._list_model.item(r, 0)
            if it0 is None:
                continue
            p = it0.data(PATH_ROLE)
            is_dir = it0.data(IS_DIR_ROLE)
            if not p or is_dir:
                continue
            sz = int(it0.data(SIZE_NUM_ROLE) or 0)
            mtime = it0.data(MTIME_ROLE)
            mt: float | None
            if mtime is None:
                mt = None
            else:
                try:
                    mt = float(mtime)
                except (TypeError, ValueError):
                    mt = None
            self._thumbs.request_for_row(
                gen, r, str(p), mt, int(sz)
            )

    @Slot(int, QIcon, str)
    def _on_thumb_ready(
        self, row: int, icon: QIcon, path: str
    ) -> None:
        it = self._list_model.item(row, 0)
        if it is not None and it.data(
            PATH_ROLE
        ) == path:
            it.setIcon(
                icon
            )

    def _selected_paths(
        self, *_: object
    ) -> list[str]:
        w = self._stack.currentWidget()
        if w is self._grid:
            m = self._list_model
            sm = self._grid.selectionModel()
        else:
            m = self._list_model
            sm = self._table.selectionModel()
        if sm is None or m is None or not sm.hasSelection():
            return []
        out: list[str] = []
        for idx in (
            sm.selectedRows(0) if w is not self._grid else sm.selectedIndexes()
        ):
            if w is self._grid and idx.column() != 0:
                continue
            if w is not self._grid and idx.column() > 0:
                continue
            p = path_at(m, idx)
            if p and p not in out:
                out.append(
                    p
                )
        return out

    @Slot("QItemSelection", "QItemSelection")
    def _on_sel_changed(
        self, *_: object
    ) -> None:
        self._preview_timer.start()

    @Slot()
    def _flush_preview(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        pr = _first_previewable_file(ps)
        self._preview.set_selection(
            ps,
            primary_preview_path=pr,
        )

    @Slot("QModelIndex")
    def _on_activated(
        self, index: QModelIndex
    ) -> None:
        m = self._list_model
        p = path_at(m, index)
        if not p:
            return
        if os.path.isdir(
            p
        ):
            self._go_dir(
                p
            )
        else:
            QDesktopServices.openUrl(
                QUrl.fromLocalFile(
                    p
                )
            )

    def _build_menus_and_toolbar(
        self, *_: object
    ) -> None:
        tb = QToolBar("主")
        self.addToolBar(
            tb
        )
        tb.addAction("导入到当前", self._act_import)
        tb.addAction("新建文件夹", self._act_mkdir)
        tb.addAction("重命名 (F2)", self._act_rename)
        tb.addSeparator()
        tb.addAction("剪切", self._act_cut)
        tb.addAction("复制", self._act_copy)
        tb.addAction("粘贴", self._act_paste)
        tb.addSeparator()
        tb.addAction("删除(回收站)", self._act_delete)
        tb.addAction("移动到…", self._act_move_to)
        tb.addAction("打开所在位置", self._act_open_explorer)
        tb.addAction("复制相对路径", self._act_copy_relpath)
        tb.addSeparator()
        tb.addAction("加标签(所选)", self._act_tag)
        tb.addAction("批量重命名…", self._act_batch_rename)
        tb.addSeparator()
        tb.addAction("全选", self._act_select_all)
        tb.addAction("刷新 (F5)", self._act_refresh)
        m = self.menuBar().addMenu("近期目录")
        self._menu_recent = m
        self._fill_recent()
        m2 = self.menuBar().addMenu("帮助")
        m2.addAction("操作日志: editor_data/asset_browser_ops.jsonl", lambda: None)

    def _fill_recent(
        self, *_: object
    ) -> None:
        m = self._menu_recent
        m.clear()
        for d in self._state.recent_dirs[:20]:
            if d and os.path.isdir(d) and _is_under(self._root, d):
                m.addAction(
                    d, lambda p=d: self._go_dir(p)  # noqa: B023
                )

    def _validate_ops(
        self, paths: list[str]
    ) -> bool:
        for p in paths:
            if not _is_under(
                self._root, p
            ):
                QMessageBox.warning(
                    self,
                    "拒绝",
                    f"仅允许在工程内操作:\n{p}",
                )
                return False
        return True

    def _act_import(
        self, *_: object
    ) -> None:
        dest = self._cur_dir
        files, _ = QFileDialog.getOpenFileNames(
            self,
            "选择要导入",
            str(Path.home()),
        )
        if not files:
            return
        r = self._file_ops.copyTo(
            dest, list(files), overwrite=False, autorename=True
        )
        self._after_op("import", r, list(files))
        self._fs_refresh_touched()
        self._apply_list()

    def _act_mkdir(
        self, *_: object
    ) -> None:
        parent = self._cur_dir
        name, ok = QInputDialog.getText(
            self,
            "新建文件夹",
            "名称",
            text="新文件夹",
        )
        if not ok or not (name or "").strip():
            return
        r = mkdir_p(
            parent,
            name.strip(),
        )
        self._after_op("mkdir", r, [parent])
        self._fs_refresh_touched()
        self._apply_list()

    def _act_rename(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if len(ps) != 1:
            QMessageBox.information(
                self,
                "重命名",
                "请只选中一个项。",
            )
            return
        p = ps[0]
        old = Path(
            p
        ).name
        n, ok = QInputDialog.getText(
            self,
            "重命名",
            "新名",
            text=old,
        )
        if not ok or n == old:
            return
        r = rename_path(
            p, n
        )
        self._after_op("rename", r, [p])
        self._fs_refresh_touched()
        self._apply_list()

    def _act_cut(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if not ps or not self._validate_ops(
            ps
        ):
            return
        self._clip = (
            "cut", list(
                ps
            )
        )

    def _act_copy(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if not ps or not self._validate_ops(
            ps
        ):
            return
        self._clip = (
            "copy", list(
                ps
            )
        )

    def _act_paste(
        self, *_: object
    ) -> None:
        if not self._clip:
            return
        op, srcs = self._clip
        dest = self._cur_dir
        if not _is_under(
            self._root, dest
        ):
            return
        copy_ = op == "copy"
        if copy_:
            r = self._file_ops.copyTo(
                dest, srcs, overwrite=False, autorename=True
            )
        else:
            r = self._file_ops.moveTo(dest, srcs, overwrite=False)
        if op == "cut":
            remaining = [
                p
                for p in srcs
                if p not in r.ok and str(Path(dest) / Path(p).name) not in r.ok
            ]
            self._clip = ("cut", remaining) if remaining else None
        self._after_op(
            "copy" if copy_ else "move",
            r, srcs,
        )
        self._fs_refresh_touched()
        self._apply_list()

    def _act_delete(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if not ps or not self._validate_ops(
            ps
        ):
            return
        r0 = QMessageBox.question(
            self,
            "删除",
            f"将 {len(ps)} 项移入回收站。若未安装 send2trash，本次删除会失败而不会永久删除。",  # noqa: E501
        )
        if r0 != QMessageBox.StandardButton.Yes:
            return
        r = self._file_ops.trash(ps)
        self._after_op(
            "trash", r, ps
        )
        if r.failed and self._bar:
            self._bar.showMessage(
                "有失败项(可能未装 send2trash)。见日志。",
                8000,
            )
        self._fs_refresh_touched()
        self._apply_list()

    def _act_move_to(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if not ps or not self._validate_ops(
            ps
        ):
            return
        d = QFileDialog.getExistingDirectory(
            self,
            "目标",
            str(
                self._root
            ),
        )
        if not d or not _is_under(
            self._root, d
        ):
            return
        r = self._file_ops.moveTo(d, ps, overwrite=False)
        self._after_op("move", r, ps)
        self._fs_refresh_touched()
        self._apply_list()

    def _act_open_explorer(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        p = self._cur_dir
        if len(ps) == 1:
            p = (
                str(Path(ps[0]).parent)
                if os.path.isfile(
                    ps[0]
                )
                else ps[0]
            )
        QDesktopServices.openUrl(
            QUrl.fromLocalFile(
                p
            )
        )

    def _act_copy_relpath(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if not ps:
            return
        lines = [rel_to_repo(x) for x in ps]
        QApplication.clipboard().setText(
            "\n".join(
                lines
            )
        )
        if self._bar:
            self._bar.showMessage("已复制相对路径", 3000)

    def _act_tag(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if not ps or not self._validate_ops(
            ps
        ):
            return
        t, ok = QInputDialog.getText(
            self,
            "标签",
            "逗号分隔(追加到已存在)",
        )
        if not ok or not t.strip():
            return
        parts = [x.strip() for x in t.split(",") if x.strip()]
        for p in ps:
            k = norm_key(
                p
            )
            cur = self._metadata.tags.get(
                k, []
            )
            for x in parts:
                if x not in cur:
                    cur.append(
                        x
                    )
            self._metadata.tags[k] = cur
        save_metadata(
            self._metadata
        )
        self._apply_list()

    def _act_batch_rename(
        self, *_: object
    ) -> None:
        ps = self._selected_paths()
        if not ps or not self._validate_ops(
            ps
        ):
            if not ps:
                QMessageBox.information(
                    self,
                    "无选择",
                    "请先多选。",
                )
            return
        d = BatchRenameDialog(
            ps, self
        )
        d.exec()
        r = d.result
        if r and self._bar:
            self._bar.showMessage(
                f"重命名: 成 {len(r.ok)} 失 {len(r.failed)}",  # noqa: E501
                5000,
            )
        if r and r.ok:
            self._after_op("batch_rename", r, ps)
        self._fs_refresh_touched()
        self._apply_list()

    def _act_fav_add(
        self, *_: object
    ) -> None:
        d = self._cur_dir
        if d in self._state.favorites:
            return
        self._state.favorites.append(
            d
        )
        it = QListWidgetItem(
            d
        )
        it.setData(
            Qt.ItemDataRole.UserRole, d
        )
        self._fav.addItem(
            it
        )
        if self._bar:
            self._bar.showMessage("已加收藏", 2000)

    def _act_fav_remove(
        self, *_: object
    ) -> None:
        # 自高行向低行删除，避免 takeItem 后行号错位
        items = self._fav.selectedItems()
        for itm in sorted(
            items,
            key=lambda i: self._fav.row(i),
            reverse=True,
        ):
            p = itm.data(Qt.ItemDataRole.UserRole) or itm.text()
            if p in self._state.favorites:
                self._state.favorites = [x for x in self._state.favorites if x != p]
            r = self._fav.row(itm)
            self._fav.takeItem(r)
        if self._bar:
            self._bar.showMessage("已移除收藏", 2000)

    def _act_select_all(
        self, *_: object
    ) -> None:
        w = self._stack.currentWidget()
        m = self._list_model
        lsel = None
        if w is self._grid:
            lsel = self._grid.selectionModel()
        else:
            lsel = self._table.selectionModel()
        if w is not None and lsel is not None and m is not None:
            n = m.rowCount()
            lsel.clear()
            for i in range(n):
                if w is self._grid:
                    lsel.select(
                        m.index(
                            i, 0
                        ),
                        QItemSelectionModel.Select,
                    )
                else:
                    lsel.select(
                        m.index(
                            i, 0
                        ),
                        QItemSelectionModel.Select,
                    )

    def _act_refresh(
        self, *_: object
    ) -> None:
        self._fs_refresh_touched()
        self._go_dir(
            self._cur_dir
        )
        self._fill_recent()

    def _connect_shortcuts(
        self, *_: object
    ) -> None:
        QShortcut(
            QKeySequence.StandardKey.Cut, self, self._act_cut
        )
        QShortcut(
            QKeySequence.StandardKey.Copy, self, self._act_copy
        )
        QShortcut(
            QKeySequence.StandardKey.Paste, self, self._act_paste
        )
        QShortcut(
            QKeySequence.StandardKey.Delete, self, self._act_delete
        )
        QShortcut(
            QKeySequence("F2"), self, self._act_rename
        )
        QShortcut(
            QKeySequence.StandardKey.SelectAll, self, self._act_select_all
        )
        QShortcut(
            QKeySequence.StandardKey.Refresh, self, self._act_refresh
        )

    def dragEnterEvent(
        self, e
    ) -> None:  # noqa: N802, ANN001
        if e.mimeData().hasUrls() or e.mimeData().hasFormat(
            MIME_ASSETS
        ):
            e.acceptProposedAction()
        else:
            e.ignore()

    def dropEvent(
        self, e
    ) -> None:  # noqa: N802, ANN001
        self._handle_list_drop(
            e
        )

    def contextMenuEvent(
        self, e
    ) -> None:  # noqa: N802, ANN001
        pass  # 可选：在视图上用自定义菜单

    def closeEvent(
        self, e: QCloseEvent
    ) -> None:  # noqa: N802
        self._state.last_dir = self._cur_dir
        g = self.geometry()
        self._state.window_x = int(g.x())
        self._state.window_y = int(g.y())
        self._state.window_w = int(g.width())
        self._state.window_h = int(g.height())
        if self._main_split is not None:
            self._state.splitter_h = [int(x) for x in self._main_split.sizes()]
        if self._left_split is not None:
            self._state.splitter_v_fav = [int(x) for x in self._left_split.sizes()]  # noqa: E501
        self._state.view_mode = (
            "table" if self._stack.currentIndex() == 1 else "grid"
        )
        self._state.thumb_size = int(
            self._thumb_size.value()
        )
        self._state.filter_type = str(
            self._type_combo.currentData() or "all"
        )
        self._state.search = self._search.text()
        self._state.search_recursive = self._recurse.isChecked()
        self._state.favorites = []
        for i in range(self._fav.count()):
            itm = self._fav.item(i)
            p = (itm.data(Qt.ItemDataRole.UserRole) or itm.text()) if itm is not None else None
            if isinstance(p, str) and p.strip():
                if p not in self._state.favorites:
                    self._state.favorites.append(p)
        save_state(self._state)
        self._preview.shutdown()
        e.accept()