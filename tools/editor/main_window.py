"""Main application window for GameDraft Editor."""
from __future__ import annotations

import os
import re
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from PySide6.QtWidgets import (
    QMainWindow, QStatusBar, QFileDialog,
    QMessageBox, QTextEdit, QDialog, QVBoxLayout, QHBoxLayout, QLabel,
    QSizePolicy, QWidget, QStyle, QSplitter, QTreeWidget,
    QTreeWidgetItem, QStackedWidget, QToolButton, QMenu,
)
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtCore import Qt, QProcess, QProcessEnvironment, QTimer, QSize, QSettings

from . import theme
from .project_model import ProjectModel
from .validator import validate, Issue
from .editors.game_browser import GAME_DEV_URL, GameBrowserTab, GamePlayWindow
from tools.dev.paths import env_with_node_path, npm_command

# Vite 就绪行示例:  Local:   http://127.0.0.1:5173/
_VITE_DEV_URL_RE = re.compile(
    r"https?://(?:127\.0\.0\.1|localhost):\d{2,5}(?:/[^\s]*)?",
    re.IGNORECASE,
)

SOURCE_NAVIGATION_TABS = {
    "quest": "Quest",
    "encounter": "Encounter",
    "scene": "Scene",
    "scene_npc": "Scene",
    "scene_hotspot": "Scene",
    "scene_zone": "Scene",
    "scene_zone_rule": "Scene",
    "plane": "位面",
}

SOURCE_NAVIGATION_SELECTORS = {
    "scene": "select_scene_by_id",
    "scene_npc": "select_npc_by_id",
    "scene_hotspot": "select_hotspot_by_id",
    "scene_zone": "select_zone_by_id",
    "scene_zone_rule": "select_zone_by_id",
    "plane": "select_by_id",
}

# 导航历史栈单条记录。kind 决定重放时走哪个 navigate_to_*（见 _replay_nav），
# args 是可原样透传给该方法的参数元组。frozen → 可哈希、可去重相等比较。
_NAV_HISTORY_LIMIT = 100


@dataclass(frozen=True)
class _NavLocation:
    kind: str
    args: tuple = ()


def _vite_dev_url_from_log(log: str) -> str | None:
    plain = re.sub(r"\x1b\[[0-9;]*m", "", log)
    matches = list(_VITE_DEV_URL_RE.finditer(plain))
    if not matches:
        return None
    url = matches[-1].group(0).rstrip()
    if not url.endswith("/"):
        url += "/"
    return url


def _augment_env_for_nodejs(env: QProcessEnvironment) -> None:
    """GUI 启动的进程常缺少终端里的 PATH；补全常见 Node/npm 目录。"""
    path_key = "PATH"
    if not env.contains(path_key):
        for alt in ("PATH", "Path"):
            if env.contains(alt):
                path_key = alt
                break
    current = env.value(path_key, "")
    prefixes: list[str] = []

    npm = shutil.which("npm")
    if npm:
        prefixes.append(str(Path(npm).resolve().parent))

        nvm_link = os.environ.get("NVM_SYMLINK", "")
        if nvm_link and os.path.isdir(nvm_link):
            prefixes.insert(0, nvm_link)
    else:
        # macOS/Linux: GUI launches (Finder/Dock) often start with a minimal
        # PATH that omits Homebrew / volta / nvm node installs.
        home = os.path.expanduser("~")
        for d in (
            "/opt/homebrew/bin",
            "/usr/local/bin",
            os.path.join(home, ".volta", "bin"),
        ):
            if os.path.isdir(d):
                prefixes.append(d)
        nvm_dir = os.environ.get("NVM_DIR", "")
        if nvm_dir:
            nvm_current = os.path.join(nvm_dir, "current", "bin")
            if os.path.isdir(nvm_current):
                prefixes.insert(0, nvm_current)

    seen: set[str] = set()
    merged: list[str] = []
    for p in prefixes:
        if not p:
            continue
        norm = os.path.normcase(os.path.abspath(p))
        if os.path.isdir(p) and norm not in seen:
            seen.add(norm)
            merged.append(p)
    if merged:
        env.insert(path_key, os.pathsep.join(merged) + os.pathsep + current)


def _copy_env_to_qprocess(env: QProcessEnvironment, values: dict[str, str]) -> None:
    for key, value in values.items():
        env.insert(key, value)


def _npm_run_command(*args: str) -> tuple[str, list[str]]:
    npm = npm_command()
    if os.name == "nt":
        comspec = os.environ.get("ComSpec") or "cmd.exe"
        return comspec, ["/d", "/c", npm, *args]
    return npm, list(args)


_GAME_BROWSER_SENTINEL = object()


class _EditorLoadErrorPage(QWidget):
    """某编辑页构造失败时的占位页：保住 stack 索引对齐，其余页面照常可用。

    不实现 flush_to_model / confirm_close 等钩子（鸭子协议 getattr 自动跳过），
    对保存/关闭流程零参与。
    """

    def __init__(self, label: str, error: Exception, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        lay = QVBoxLayout(self)
        msg = QLabel(
            f"「{label}」页载入失败：\n\n{error}\n\n"
            "多为数据结构异常或代码缺陷；其余页面不受影响。\n"
            "修复后重新打开工程即可恢复本页。",
        )
        msg.setWordWrap(True)
        lay.addWidget(msg)
        lay.addStretch(1)


class _StackPageHost(QWidget):
    """Each stacked tab reports the same small minimum so hidden editors do not block maximize."""

    _MIN = QSize(320, 240)

    def __init__(self, content: QWidget, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        content.setMinimumSize(0, 0)
        content.setSizePolicy(
            QSizePolicy.Policy.Ignored,
            QSizePolicy.Policy.Ignored,
        )
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(content, 1)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )

    def minimumSize(self) -> QSize:  # noqa: N802 — Qt API
        return self._MIN

    def minimumSizeHint(self) -> QSize:
        return self._MIN


class MainWindow(QMainWindow):
    def _stack_index_of_page(self, page: QWidget | None) -> int:
        """页都包在 _StackPageHost 里，QStackedWidget.indexOf 对孙子控件恒返 -1——
        必须逐页解包比较（审查 P1-29：F5 不再自动切「运行与预览」页的根因）。"""
        if page is None:
            return -1
        for i in range(self._stack.count()):
            w = self._stack.widget(i)
            if w is page:
                return i
            if isinstance(w, _StackPageHost):
                lay = w.layout()
                if lay is not None and lay.count() > 0:
                    item = lay.itemAt(0)
                    if item is not None and item.widget() is page:
                        return i
        return -1

    def __init__(self) -> None:
        super().__init__()
        self.resize(1400, 900)

        self._model = ProjectModel(self)
        self._game_proc: QProcess | None = None
        self._game_server_ready = False
        self._game_open_when_ready = False
        self._game_ready_timer = QTimer(self)
        self._game_ready_timer.setSingleShot(True)
        self._game_ready_timer.timeout.connect(self._on_game_server_ready_timeout)
        self._game_browser: GameBrowserTab | None = None
        self._game_play_window: GamePlayWindow | None = None
        self._game_proc_log: str = ""
        self._game_user_stopped: bool = False
        self._last_vite_dev_url: str | None = None
        self._pending_launch_params: str | None = None
        self._nav_tree = QTreeWidget()
        self._nav_tree.setHeaderHidden(True)
        self._nav_tree.setRootIsDecorated(True)
        self._nav_tree.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._nav_tree.setMinimumWidth(0)
        self._nav_tree.setSizePolicy(
            QSizePolicy.Policy.Fixed,
            QSizePolicy.Policy.Expanding,
        )
        self._stack = QStackedWidget()
        # 切页时让激活的编辑器重拉跨域引用候选(别处新增的 item/encounter/filter 等)。
        self._stack.currentChanged.connect(self._on_stack_page_changed)
        self._splitter = QSplitter(Qt.Orientation.Horizontal)
        self._splitter.addWidget(self._nav_tree)
        self._splitter.addWidget(self._stack)
        self._splitter.setStretchFactor(0, 0)
        self._splitter.setStretchFactor(1, 1)
        self._splitter.setSizes([200, 1200])
        self.setCentralWidget(self._splitter)
        # 跨重启记忆主窗口大小/位置(弹窗外的窗口状态);多显示器/越界由 restoreGeometry 处理。
        self._settings = QSettings("GameDraft", "Editor")
        _geo = self._settings.value("mainWindowGeometry")
        if _geo is not None:
            try:
                self.restoreGeometry(_geo)
            except Exception:
                pass
        self._stack_index_to_item: dict[int, QTreeWidgetItem] = {}
        self._editor_instances: list = []
        self._editor_labels: list[str] = []
        self._nav_tree.currentItemChanged.connect(self._on_nav_tree_current_changed)

        # 导航历史栈（浏览器式后退/前进）——见 _record_nav / _replay_nav。
        self._nav_history: list[_NavLocation] = []
        self._nav_cursor: int = -1
        self._nav_replaying: bool = False

        self._build_menus()
        self._build_menu_bar_corner()
        self._status = QStatusBar()
        self.setStatusBar(self._status)

        self._model.dirty_changed.connect(self._on_dirty)
        self._refresh_window_title()

    # ---- menu / toolbar ---------------------------------------------------

    def _build_menus(self) -> None:
        mb = self.menuBar()

        file_menu = mb.addMenu("File")
        self._act(file_menu, "Open Project...", self._open_project, QKeySequence("Ctrl+O"))
        self._act(file_menu, "Save All", self._save_all, QKeySequence("Ctrl+Shift+S"))
        file_menu.addSeparator()
        self._act(file_menu, "Exit", self.close, QKeySequence("Alt+F4"))

        edit_menu = mb.addMenu("Edit")
        self._act(edit_menu, "Save", self._save_current_editor, QKeySequence.StandardKey.Save)
        self._undo_action = self._act(edit_menu, "Undo", lambda: self._model.undo_stack.undo(),
                                       QKeySequence.StandardKey.Undo)
        self._redo_action = self._act(edit_menu, "Redo", lambda: self._model.undo_stack.redo(),
                                       QKeySequence.StandardKey.Redo)

        run_menu = mb.addMenu("Run")
        st = self.style()
        a_run = QAction(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaPlay),
            "Run Game",
            self,
        )
        a_run.setShortcut(QKeySequence("F5"))
        a_run.triggered.connect(self._run_game)
        run_menu.addAction(a_run)
        a_run_dev = QAction(
            st.standardIcon(QStyle.StandardPixmap.SP_ArrowForward),
            "Run Game (Dev Mode)",
            self,
        )
        a_run_dev.setShortcut(QKeySequence("Ctrl+F5"))
        a_run_dev.setToolTip("启动并进入开发模式（URL ?mode=dev）")
        a_run_dev.triggered.connect(self._run_game_dev)
        run_menu.addAction(a_run_dev)
        a_stop = QAction(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaStop),
            "Stop Game",
            self,
        )
        a_stop.setShortcut(QKeySequence("Shift+F5"))
        a_stop.triggered.connect(self._stop_game)
        run_menu.addAction(a_stop)
        run_menu.addSeparator()
        self._act(run_menu, "Build (Export)", self._build_game)

        tools_menu = mb.addMenu("Tools")
        self._act(tools_menu, "Validate Data", self._validate)
        tools_menu.addSeparator()
        ext = tools_menu.addMenu("External tools (new process)")
        self._act(ext, "Graph Editor", self._launch_graph_editor_external)
        self._act(ext, "Dialogue Graph Editor", self._launch_dialogue_graph_editor_external)
        self._act(ext, "Scene Depth Editor", self._launch_scene_depth_editor_external)
        self._act(ext, "Filter Tool", self._launch_filter_tool_external)
        self._act(ext, "Image Resizer", self._launch_image_resizer_external)
        self._act(ext, "Copy Manager", self._launch_copy_manager_external)
        self._act(ext, "Video to Atlas", self._launch_video_to_atlas_external)
        self._act(ext, "Production Workbench", self._launch_production_workbench_external)
        self._act(ext, "Parallax 场景编辑器", self._launch_parallax_editor_external)

        view_menu = mb.addMenu("View")
        self._act(view_menu, "编辑器设置…", self._open_editor_settings, "Ctrl+,")

    def _open_editor_settings(self) -> None:
        from .editors.settings_dialog import EditorSettingsDialog

        EditorSettingsDialog(self).exec()

    def on_appearance_changed(self) -> None:
        """主题/字体被设置对话框改动后,刷新图形视图与各编辑器。"""
        self._sync_theme_to_editors()

    def _sync_theme_to_editors(self) -> None:
        tid = theme.current_theme_id()
        theme.refresh_all_graphics_views(self, tid)
        for inst in self._editor_instances:
            fn = getattr(inst, "on_editor_theme_changed", None)
            if callable(fn):
                fn(tid)

    def _build_menu_bar_corner(self) -> None:
        """导航后退/前进 + Save/Validate/运行控制并入菜单栏右侧，避免单独工具栏占垂直空间。"""
        # corner 需长期存活：offscreen 等平台上 setCornerWidget 不接管所有权时，
        # 局部变量被回收会连带删掉子按钮（踩过）——存到 self 上兜底。
        corner = QWidget()
        corner.setObjectName("menuBarCorner")
        self._menu_corner = corner
        layout = QHBoxLayout(corner)
        layout.setContentsMargins(8, 0, 4, 0)
        layout.setSpacing(6)

        st = self.style()

        # ---- 导航历史：◀ 后退（带下拉历史） / ▶ 前进（像浏览器）--------------
        self._nav_back_btn = QToolButton(corner)
        self._nav_back_btn.setIcon(st.standardIcon(QStyle.StandardPixmap.SP_ArrowBack))
        self._nav_back_btn.setToolTip("后退 (Alt+←)　·　点右侧箭头看历史")
        self._nav_back_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonIconOnly)
        self._nav_back_btn.setAutoRaise(True)
        self._nav_back_btn.setPopupMode(QToolButton.ToolButtonPopupMode.MenuButtonPopup)
        self._nav_back_menu = QMenu(self._nav_back_btn)
        self._nav_back_menu.aboutToShow.connect(self._rebuild_back_menu)
        self._nav_back_btn.setMenu(self._nav_back_menu)
        self._nav_back_btn.clicked.connect(self._nav_back)
        layout.addWidget(self._nav_back_btn)

        self._nav_fwd_btn = QToolButton(corner)
        self._nav_fwd_btn.setIcon(st.standardIcon(QStyle.StandardPixmap.SP_ArrowForward))
        self._nav_fwd_btn.setToolTip("前进 (Alt+→)")
        self._nav_fwd_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonIconOnly)
        self._nav_fwd_btn.setAutoRaise(True)
        self._nav_fwd_btn.clicked.connect(self._nav_forward)
        layout.addWidget(self._nav_fwd_btn)

        # 窗口级快捷键：即便焦点在某编辑器内，Alt+←/→ 仍可后退/前进。
        self._nav_back_action = QAction("后退", self)
        self._nav_back_action.setShortcut(QKeySequence("Alt+Left"))
        self._nav_back_action.triggered.connect(self._nav_back)
        self.addAction(self._nav_back_action)
        self._nav_forward_action = QAction("前进", self)
        self._nav_forward_action.setShortcut(QKeySequence("Alt+Right"))
        self._nav_forward_action.triggered.connect(self._nav_forward)
        self.addAction(self._nav_forward_action)

        layout.addSpacing(12)

        def text_btn(label: str, tip: str, slot) -> QToolButton:
            btn = QToolButton(corner)
            btn.setText(label)
            btn.setToolTip(tip)
            btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
            btn.setAutoRaise(True)
            btn.clicked.connect(slot)
            layout.addWidget(btn)
            return btn

        text_btn("Save All", "全部保存 (Ctrl+Shift+S)", self._save_all)
        text_btn("Validate", "校验工程数据", self._validate)

        layout.addSpacing(8)

        def icon_btn(icon, tip: str, slot) -> QToolButton:
            btn = QToolButton(corner)
            btn.setIcon(icon)
            btn.setToolTip(tip)
            btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonIconOnly)
            btn.setAutoRaise(True)
            btn.clicked.connect(slot)
            layout.addWidget(btn)
            return btn

        icon_btn(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaPlay),
            "运行游戏 (F5)",
            self._run_game,
        )
        icon_btn(
            st.standardIcon(QStyle.StandardPixmap.SP_ArrowForward),
            "运行游戏 — 开发模式 (Ctrl+F5)",
            self._run_game_dev,
        )
        icon_btn(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaStop),
            "停止游戏 (Shift+F5)",
            self._stop_game,
        )

        self.menuBar().setCornerWidget(corner, Qt.Corner.TopRightCorner)
        self._update_nav_buttons()

    # ---- navigation history (后退 / 前进) ---------------------------------

    def _record_nav(self, loc: _NavLocation) -> None:
        """把一次落地位置压入历史栈（浏览器语义：截断前进分支、去重相邻重复）。

        重放（后退/前进）过程中不记录，避免自成环。"""
        if self._nav_replaying:
            return
        hist = self._nav_history
        cur = self._nav_cursor
        if 0 <= cur < len(hist) and hist[cur] == loc:
            return
        del hist[cur + 1:]
        hist.append(loc)
        if len(hist) > _NAV_HISTORY_LIMIT:
            del hist[: len(hist) - _NAV_HISTORY_LIMIT]
        self._nav_cursor = len(hist) - 1
        self._update_nav_buttons()

    def _replay_nav(self, loc: _NavLocation) -> None:
        """重放一个历史位置：复用既有 navigate_to_*，全程抑制记录。"""
        self._nav_replaying = True
        try:
            k, a = loc.kind, loc.args
            if k == "page":
                self._show_stack_page(a[0])
            elif k == "dialogue_graph":
                self.navigate_to_dialogue_graph(a[0])
            elif k == "scenario":
                self.navigate_to_scenario_catalog(a[0])
            elif k == "minigame":
                self.navigate_to_minigame(a[0])
            elif k == "cutscene":
                self.navigate_to_cutscene(a[0])
            elif k == "narrative_state":
                self.navigate_to_narrative_state(a[0], a[1])
            elif k == "scene_entity":
                self.navigate_to_scene_entity(*a)
            elif k == "plane":
                self.navigate_to_plane(a[0])
            elif k == "source":
                self._on_navigate_to_source(*a)
        finally:
            self._nav_replaying = False
        self._update_nav_buttons()

    def _nav_go_to_index(self, index: int) -> None:
        if not (0 <= index < len(self._nav_history)):
            return
        self._nav_cursor = index
        self._replay_nav(self._nav_history[index])

    def _nav_back(self) -> None:
        if self._nav_cursor > 0:
            self._nav_go_to_index(self._nav_cursor - 1)

    def _nav_forward(self) -> None:
        if self._nav_cursor < len(self._nav_history) - 1:
            self._nav_go_to_index(self._nav_cursor + 1)

    def _update_nav_buttons(self) -> None:
        can_back = self._nav_cursor > 0
        can_fwd = 0 <= self._nav_cursor < len(self._nav_history) - 1
        for w in (getattr(self, "_nav_back_btn", None), getattr(self, "_nav_back_action", None)):
            if w is not None:
                w.setEnabled(can_back)
        for w in (getattr(self, "_nav_fwd_btn", None), getattr(self, "_nav_forward_action", None)):
            if w is not None:
                w.setEnabled(can_fwd)

    def _nav_location_label(self, loc: _NavLocation) -> str:
        k, a = loc.kind, loc.args
        if k == "page":
            idx = a[0]
            if 0 <= idx < len(self._editor_labels):
                return self._editor_labels[idx]
            return "页面"
        if k == "dialogue_graph":
            return f"图对话 · {a[0]}"
        if k == "scenario":
            return f"Scenario · {a[0]}"
        if k == "minigame":
            return f"小游戏 · {a[0]}"
        if k == "cutscene":
            return f"过场 · {a[0]}"
        if k == "narrative_state":
            return f"叙事 · {a[0]} / {a[1]}"
        if k == "scene_entity":
            return f"场景{a[0]} · {a[1]}"
        if k == "plane":
            return f"位面 · {a[0]}"
        if k == "source":
            return f"{a[0]} · {a[1]}"
        return k

    def _rebuild_back_menu(self) -> None:
        """下拉列出当前位置之前的每一站（最近在上），点击一键直达。"""
        menu = self._nav_back_menu
        menu.clear()
        for idx in range(self._nav_cursor - 1, -1, -1):
            act = menu.addAction(self._nav_location_label(self._nav_history[idx]))
            act.triggered.connect(lambda _checked=False, i=idx: self._nav_go_to_index(i))
        if menu.isEmpty():
            act = menu.addAction("（无更早的位置）")
            act.setEnabled(False)

    @staticmethod
    def _act(menu, text, slot, shortcut=None) -> QAction:
        a = menu.addAction(text)
        a.triggered.connect(slot)
        if shortcut:
            a.setShortcut(shortcut)
        return a

    # ---- project ----------------------------------------------------------

    def _open_project(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "Select GameDraft Project Root")
        if not path:
            return
        self.load_project(Path(path))

    def load_project(self, path: Path) -> None:
        if not self._confirm_can_replace_project():
            return
        if self._model.project_path is not None:
            self._stop_game(show_status=False)
        assets = path / "public" / "assets"
        if not assets.is_dir():
            QMessageBox.critical(self, "Error",
                                 f"Invalid project: {assets} not found")
            return
        try:
            self._model.load_project(path)
        except Exception as e:
            QMessageBox.critical(self, "Open Project Error", str(e))
            return
        self._refresh_window_title()
        self._status.showMessage(f"Loaded: {path}", 5000)
        self._populate_tabs()
        QTimer.singleShot(500, self._prewarm_game_backend)

    def _confirm_pending_editor_changes(self) -> bool:
        from .editors.timeline_editor import TimelineEditor

        for ed in self._editor_instances:
            if isinstance(ed, TimelineEditor) and ed.has_pending_changes():
                if ed.confirm_apply_or_discard(self) == "cancel":
                    return False
        for ed in self._editor_instances:
            if isinstance(ed, TimelineEditor):
                continue
            confirm = getattr(ed, "confirm_close", None)
            if callable(confirm) and not confirm(self):
                return False
        return True

    def _confirm_can_replace_project(self) -> bool:
        if self._model.project_path is None:
            return True
        if not self._confirm_pending_editor_changes():
            return False
        if not self._model.is_dirty:
            return True
        r = QMessageBox.question(
            self,
            "Unsaved Changes",
            "You have unsaved changes. Save before opening another project?",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            return self._save_all()
        return True

    @staticmethod
    def _editor_package_parents() -> Path:
        """tools/editor → GameDraft 仓库根（含 public/assets 时可作为默认 cwd）。"""
        return Path(__file__).resolve().parent.parent.parent

    def _external_tool_cwd(self) -> Path:
        """外部工具工作目录：当前工程根，否则为编辑器所在仓库根。"""
        if self._model.project_path is not None:
            return self._model.project_path
        return self._editor_package_parents()

    def _ensure_valid_tool_root(self) -> Path | None:
        root = self._external_tool_cwd()
        if not (root / "public" / "assets").is_dir():
            QMessageBox.information(
                self,
                "External tools",
                "Need a valid GameDraft root (folder containing public/assets). "
                "Use File → Open Project, or launch the editor from the GameDraft repo.",
            )
            return None
        return root

    def _launch_external_tool(
        self,
        module: str,
        extra_args: list[str],
        label: str,
        *,
        root: Path | None = None,
    ) -> None:
        """另起独立本地 Python 进程运行模块，不与主编辑器共享进程。"""
        r = root if root is not None else self._ensure_valid_tool_root()
        if r is None:
            return
        cwd = str(r.resolve())
        cmd = [sys.executable, "-m", module, *extra_args]
        try:
            subprocess.Popen(cmd, cwd=cwd)
        except OSError as e:
            QMessageBox.critical(self, "External tools", f"Failed to start {label}:\n{e}")
            return
        self._status.showMessage(f"Started in new process: {label}", 4000)

    def _launch_graph_editor_external(self) -> None:
        root = self._ensure_valid_tool_root()
        if root is None:
            return
        self._launch_external_tool(
            "tools.graph_editor",
            ["--project", str(root.resolve())],
            "Graph Editor",
            root=root,
        )

    def _launch_dialogue_graph_editor_external(self) -> None:
        root = self._ensure_valid_tool_root()
        if root is None:
            return
        self._launch_external_tool(
            "tools.dialogue_graph_editor",
            ["--project", str(root.resolve())],
            "Dialogue Graph Editor",
            root=root,
        )

    def _launch_scene_depth_editor_external(self) -> None:
        self._launch_external_tool("tools.scene_depth_editor", [], "Scene Depth Editor")

    def _launch_filter_tool_external(self) -> None:
        self._launch_external_tool("tools.filter_tool", [], "Filter Tool")

    def _launch_image_resizer_external(self) -> None:
        self._launch_external_tool(
            "tools.image_resizer",
            [],
            "Image Resizer",
            root=self._external_tool_cwd(),
        )

    def _launch_copy_manager_external(self) -> None:
        self._launch_external_tool("tools.copy_manager", [], "Copy Manager")

    def _launch_video_to_atlas_external(self) -> None:
        root = self._ensure_valid_tool_root()
        if root is None:
            return
        from .shared.project_paths import (
            DIR_KIND_EDITOR_ANIMATION_PROJECT,
            ProjectPaths,
        )
        ws = ProjectPaths(root.resolve()).default_dir(DIR_KIND_EDITOR_ANIMATION_PROJECT)
        args = [str(ws.resolve())] if (ws / "project.json").is_file() else []
        self._launch_external_tool("tools.video_to_atlas", args, "Video to Atlas", root=root)

    def _launch_production_workbench_external(self) -> None:
        root = self._ensure_valid_tool_root()
        if root is None:
            return
        self._launch_external_tool(
            "tools.production_workbench",
            [str(root.resolve())],
            "Production Workbench",
            root=root,
        )

    def _launch_parallax_editor_external(self) -> None:
        """Parallax 视差场景编辑器：另起 Vite dev(端口 5205)+开浏览器；已在跑则复用。

        与 anim_preview 同款：Vite 服务的是编辑器自身仓库的 public/（图片扫描 +
        parallax_scenes.json 读写都在此仓库），且 `-m tools.parallax_editor` 需要 tools
        包可导入，故 cwd 固定用编辑器仓库根，而非用户当前打开的工程目录。
        """
        self._launch_external_tool(
            "tools.parallax_editor",
            [],
            "Parallax Editor",
            root=self._editor_package_parents(),
        )

    def _clear_editor_stack(self) -> None:
        while self._stack.count():
            w = self._stack.widget(0)
            self._stack.removeWidget(w)
            w.deleteLater()

    @staticmethod
    def _ensure_nav_path(tree: QTreeWidget, segments: list[str]) -> QTreeWidgetItem:
        parent: QTreeWidgetItem | None = None
        for seg in segments:
            container: QTreeWidgetItem | None = None
            if parent is None:
                for i in range(tree.topLevelItemCount()):
                    it = tree.topLevelItem(i)
                    if it.text(0) == seg:
                        container = it
                        break
                if container is None:
                    container = QTreeWidgetItem([seg])
                    tree.addTopLevelItem(container)
            else:
                for i in range(parent.childCount()):
                    ch = parent.child(i)
                    if ch.text(0) == seg:
                        container = ch
                        break
                if container is None:
                    container = QTreeWidgetItem([seg])
                    parent.addChild(container)
            parent = container
        assert parent is not None
        return parent

    def _expand_nav_tree(self) -> None:
        def expand_rec(item: QTreeWidgetItem) -> None:
            item.setExpanded(True)
            for i in range(item.childCount()):
                expand_rec(item.child(i))

        for i in range(self._nav_tree.topLevelItemCount()):
            expand_rec(self._nav_tree.topLevelItem(i))

    def _on_nav_tree_current_changed(
        self,
        current: QTreeWidgetItem | None,
        _previous: QTreeWidgetItem | None,
    ) -> None:
        if current is None:
            return
        idx = current.data(0, Qt.ItemDataRole.UserRole)
        if not isinstance(idx, int):
            return
        self._stack.setCurrentIndex(idx)
        # 手动点左侧导航树切页也入历史（程序化跳转经 _show_stack_page 屏蔽了本信号，不会重复记录）。
        self._record_nav(_NavLocation("page", (idx,)))

    def _show_stack_page(self, index: int) -> None:
        self._stack.setCurrentIndex(index)
        item = self._stack_index_to_item.get(index)
        if item is None:
            return
        self._nav_tree.blockSignals(True)
        try:
            self._nav_tree.setCurrentItem(item)
        finally:
            self._nav_tree.blockSignals(False)

    def _on_stack_page_changed(self, index: int) -> None:
        """切到某编辑器页时,让它重拉跨域引用候选(保留各自当前选中值)。

        _editor_instances 与 stack 前缀对齐(Game 浏览页在末尾且不入该列表),
        故按 index 取实例;hook 缺省时跳过。重拉走各编辑器 reload_refs_from_model,
        只刷新引用下拉,不重置表单字段。
        """
        if 0 <= index < len(self._editor_instances):
            inst = self._editor_instances[index]
            fn = getattr(inst, "reload_refs_from_model", None)
            if callable(fn):
                fn()

    def _populate_tabs(self) -> None:
        self._clear_editor_stack()
        self._nav_tree.clear()
        self._stack_index_to_item.clear()
        self._editor_instances.clear()
        self._editor_labels.clear()
        # 换工程/重建页面栈 → 旧导航历史失效，清空重开。
        self._nav_history.clear()
        self._nav_cursor = -1

        from .editors.scene_editor import SceneEditor
        from .editors.quest_editor import QuestEditor
        from .editors.encounter_editor import EncounterEditor
        from .editors.timeline_editor import TimelineEditor
        from .editors.item_editor import ItemEditor
        from .editors.rule_editor import RuleEditor
        from .editors.shop_editor import ShopEditor
        from .editors.map_editor import MapEditor
        from .editors.archive_editor import ArchiveEditor
        from .editors.audio_editor import AudioEditor
        from .editors.anim_editor import AnimEditor
        from .editors.string_editor import StringEditor
        from .editors.character_registry_editor import CharacterRegistryEditor
        from .editors.game_config_editor import GameConfigEditor
        from .editors.player_avatar_editor import PlayerAvatarEditor
        from .editors.flag_registry_editor import FlagRegistryEditor
        from .editors.filter_editor import FilterEditor
        from .editors.action_registry_editor import ActionRegistryEditor
        from .editors.overlay_images_editor import OverlayImagesEditor
        from .editors.narrative_data_editors import (
            ScenariosCatalogEditor,
            DocumentRevealsEditor,
        )
        from .editors.narrative_state_editor import NarrativeStateEditor
        from .editors.dialogue_graph_editor_tab import DialogueGraphEditorTab
        from .editors.water_minigame_editor import WaterMinigameEditor
        from .editors.sugar_wheel_editor import SugarWheelEditor
        from .editors.paper_craft_editor import PaperCraftEditor
        from .editors.pressure_signal_editor import PressureHoldEditor, SignalCueEditor
        from .editors.smell_profile_editor import SmellProfileEditor
        from .editors.plane_editor import PlaneEditor

        rows: list[tuple[list[str], str, Any]] = [
            (["物理世界"], "Scene", SceneEditor),
            (["物理世界"], "角色", CharacterRegistryEditor),
            (["物理世界"], "Map", MapEditor),
            (["数据编辑", "叙事编排"], "过场", TimelineEditor),
            (["数据编辑", "叙事编排"], "图对话", DialogueGraphEditorTab),
            (["数据编辑", "叙事编排"], "叙事状态机", NarrativeStateEditor),
            (["数据编辑", "叙事编排"], "位面", PlaneEditor),
            (["数据编辑", "叙事编排"], "Encounter", EncounterEditor),
            (["数据编辑", "叙事编排"], "临场长按", PressureHoldEditor),
            (["数据编辑", "叙事编排"], "信号Cue", SignalCueEditor),
            (["数据编辑", "叙事编排"], "水域小游戏", WaterMinigameEditor),
            (["数据编辑", "叙事编排"], "转盘小游戏", SugarWheelEditor),
            (["数据编辑", "叙事编排"], "扎纸小游戏", PaperCraftEditor),
            (["数据编辑", "叙事编排"], "Scenarios", ScenariosCatalogEditor),
            (["数据编辑", "叙事编排"], "Quest", QuestEditor),
            (["数据编辑", "规则与经济"], "Rule", RuleEditor),
            (["数据编辑", "规则与经济"], "Shop", ShopEditor),
            (["数据编辑", "规则与经济"], "Item", ItemEditor),
            (["数据编辑", "规则与经济"], "Filters", FilterEditor),
            (["数据编辑", "注册表与扩展"], "Flags", FlagRegistryEditor),
            (["数据编辑", "注册表与扩展"], "Actions", ActionRegistryEditor),
            (["数据编辑", "资源与本地化"], "Archive", ArchiveEditor),
            (["数据编辑", "资源与本地化"], "Strings", StringEditor),
            (["数据编辑", "资源与本地化"], "Audio", AudioEditor),
            (["数据编辑", "资源与本地化"], "动画浏览", AnimEditor),
            (["数据编辑", "资源与本地化"], "玩家化身", PlayerAvatarEditor),
            (["数据编辑", "资源与本地化"], "叠图 ID", OverlayImagesEditor),
            (["数据编辑", "资源与本地化"], "文档揭示", DocumentRevealsEditor),
            (["数据编辑", "资源与本地化"], "气味Profile", SmellProfileEditor),
            (["数据编辑", "工程与全局"], "Config", GameConfigEditor),
            (["运行与预览"], "Game", _GAME_BROWSER_SENTINEL),
        ]

        stack_idx = 0
        failed_pages: list[tuple[str, Exception]] = []
        for path, label, cls in rows:
            if cls is _GAME_BROWSER_SENTINEL:
                self._game_browser = GameBrowserTab(self)
                self._game_browser.run_requested.connect(self._run_game)
                self._game_browser.run_dev_requested.connect(self._run_game_dev)
                self._game_browser.stop_requested.connect(self._stop_game)
                widget: QWidget = self._game_browser
            else:
                # 单页构造隔离：某页遇到异常数据结构抛错时，用错误占位页顶位，
                # 其余页面照常可用，不让整个工程载入留在半切换状态。
                try:
                    ed: QWidget = cls(self._model)
                except Exception as e:  # noqa: BLE001 — 页面构造失败必须兜底
                    import traceback
                    traceback.print_exc()
                    ed = _EditorLoadErrorPage(label, e)
                    failed_pages.append((label, e))
                widget = ed
                self._editor_instances.append(ed)
                self._editor_labels.append(label)
                if isinstance(ed, TimelineEditor):
                    ed.play_requested.connect(self._on_cutscene_play_requested)
                preview_sig = getattr(ed, "preview_requested", None)
                if preview_sig is not None:
                    if isinstance(ed, SugarWheelEditor):
                        preview_sig.connect(self._on_sugar_wheel_preview_requested)
                    elif isinstance(ed, PaperCraftEditor):
                        preview_sig.connect(self._on_paper_craft_preview_requested)
                    else:
                        preview_sig.connect(self._on_water_minigame_preview_requested)

            self._stack.addWidget(_StackPageHost(widget, self))
            parent_item = self._ensure_nav_path(self._nav_tree, path)
            leaf = QTreeWidgetItem([label])
            parent_item.addChild(leaf)
            leaf.setData(0, Qt.ItemDataRole.UserRole, stack_idx)
            self._stack_index_to_item[stack_idx] = leaf
            stack_idx += 1

        if failed_pages:
            names = "、".join(lbl for lbl, _e in failed_pages)
            first_err = failed_pages[0][1]
            QMessageBox.warning(
                self, "部分编辑页载入失败",
                f"以下页面构造失败，已用占位页顶替：{names}\n\n"
                f"首个错误：{first_err}\n"
                "其余页面不受影响；修复数据/代码后重新打开工程即可恢复。",
            )

        self._expand_nav_tree()
        if self._stack_index_to_item:
            self._show_stack_page(0)
            self._record_nav(_NavLocation("page", (0,)))

        self._connect_action_nav()
        self._sync_theme_to_editors()
        QTimer.singleShot(0, self._apply_nav_tree_width_from_content)

    def _apply_nav_tree_width_from_content(self) -> None:
        """左侧导航宽度按最长条目略留边距，避免大块留白。"""
        self._nav_tree.resizeColumnToContents(0)
        col = int(self._nav_tree.sizeHintForColumn(0))
        if col < 12:
            col = self._nav_tree.fontMetrics().horizontalAdvance("文档揭示") + 32
        frame = int(self._nav_tree.frameWidth() * 2)
        pad = 22
        nav_w = col + frame + pad
        nav_w = max(96, min(nav_w, 520))
        # 用 minimumWidth + splitter 初始尺寸,而非 setFixedWidth:否则分割条拖不动、
        # 超长标签既被截断又无法拖宽查看(配合 ScrollBarAsNeeded)。
        self._nav_tree.setMinimumWidth(min(nav_w, 160))

        total = max(int(sum(self._splitter.sizes())), int(self.width() or 0), 900)
        right = max(320, total - nav_w)
        self._splitter.setSizes([nav_w, right])

    # ---- save / dirty -----------------------------------------------------

    def _save_current_editor(self) -> None:
        idx = self._stack.currentIndex()
        if 0 <= idx < len(self._editor_instances):
            inst = self._editor_instances[idx]
            from .editors.narrative_state_editor import NarrativeStateEditor

            if isinstance(inst, NarrativeStateEditor):
                if inst.flush_to_model():
                    self._status.showMessage("叙事状态图已写入工程模型。", 3000)
                return
        self._save_all()

    def _flush_editors_to_model(self) -> bool:
        from .editors.timeline_editor import TimelineEditor

        for inst in self._editor_instances:
            if isinstance(inst, TimelineEditor) and inst.has_pending_changes():
                if inst.confirm_apply_or_discard(self) == "cancel":
                    return False
        from .editor_perf import PerfClock, maybe_stamp, perf_log_enabled

        flush_clk = PerfClock(label="SaveAll.flush") if perf_log_enabled() else None
        maybe_stamp(PerfClock(label="SaveAll.flush.begin"), "开始 flush 编辑器")
        for inst in self._editor_instances:
            flush = getattr(inst, "flush_to_model", None)
            if callable(flush):
                name = type(inst).__name__
                t0 = time.perf_counter()
                try:
                    result = flush(for_save_all=True)
                except TypeError:
                    result = flush()
                dt = time.perf_counter() - t0
                maybe_stamp(flush_clk, f"{name} ok {dt*1000:.1f}ms")
                if result is False:
                    pop_error = getattr(inst, "pop_flush_error", None)
                    detail = pop_error() if callable(pop_error) else None
                    raise RuntimeError(detail or f"{name} 无法写入待保存的编辑内容")
        return True

    def _save_all(self) -> bool:
        if self._model.project_path is None:
            QMessageBox.warning(
                self,
                "保存",
                "未打开工程目录，无法保存。\n"
                "请先通过「打开工程」选择包含 public/assets 的 GameDraft 仓库根目录。",
            )
            return False
        from .editor_perf import PerfClock, maybe_stamp

        clk = PerfClock(label="MainWindow.SaveAll")

        try:
            maybe_stamp(clk, "开始 flush 编辑器")
            if not self._flush_editors_to_model():
                return False
            maybe_stamp(clk, "全部 flush 完成，调用 model.save_all")
            _saved_types = sorted(getattr(self._model, "_dirty", set()))
            self._model.save_all()
            maybe_stamp(clk, "model.save_all 完成")
            if _saved_types:
                _shown = "、".join(_saved_types[:6]) + ("…" if len(_saved_types) > 6 else "")
                self._status.showMessage(
                    f"已保存 {len(_saved_types)} 类数据：{_shown}", 4000)
            else:
                self._status.showMessage("无改动需保存。", 3000)
            return True
        except Exception as e:
            print(f"[SaveAll] 失败: {e!r}", flush=True)
            QMessageBox.critical(self, "Save Error", str(e))
            return False

    # 标题栏常驻导航提示——把易忘的后退/前进快捷键写在标题里,时刻可见。
    _NAV_TITLE_HINT = "导航后退/前进 Alt+←/→(◀▶ 在右上角)"

    def _compose_window_title(self) -> str:
        base = "GameDraft Editor"
        proj = self._model.project_path
        if proj is not None:
            base += f" - {proj.name}"
        base += f"　｜　{self._NAV_TITLE_HINT}"
        if self._model.is_dirty:
            base += " *"
        return base

    def _refresh_window_title(self) -> None:
        self.setWindowTitle(self._compose_window_title())

    def _on_dirty(self, dirty: bool) -> None:
        self._refresh_window_title()

    # ---- run game ---------------------------------------------------------

    def _is_game_backend_running(self) -> bool:
        return (
            self._game_proc is not None
            and self._game_proc.state() != QProcess.ProcessState.NotRunning
        )

    def _prewarm_game_backend(self) -> None:
        if self._model.project_path is None:
            return
        if self._is_game_backend_running():
            return
        self._start_game_backend(open_when_ready=False)

    def _run_game(self, *, launch_params: str | None = None) -> None:
        if self._model.project_path is None:
            return
        if not self._save_all():
            return

        proj = self._model.project_path
        pkg_json = proj / "package.json"
        if not pkg_json.is_file():
            QMessageBox.warning(self, "Error", "package.json not found")
            return
        if self._game_browser is None:
            return

        if self._is_game_backend_running():
            if self._game_server_ready:
                self._focus_game_tab_and_load(
                    self._last_vite_dev_url,
                    extra_params=launch_params or "",
                )
                self._status.showMessage("开发服务器已就绪；已打开游戏预览。", 3000)
            else:
                self._pending_launch_params = launch_params
                self._game_open_when_ready = True
                self._status.showMessage("开发服务器正在启动；就绪后会自动打开预览。", 5000)
                if self._game_browser is not None:
                    self._game_browser.show_message("Starting dev server…")
                    idx = self._stack_index_of_page(self._game_browser)
                    if idx >= 0:
                        self._show_stack_page(idx)
            return

        self._start_game_backend(open_when_ready=True, launch_params=launch_params)

    def _start_game_backend(self, *, open_when_ready: bool,
                            launch_params: str | None = None) -> None:
        if self._model.project_path is None:
            return
        if self._is_game_backend_running():
            if open_when_ready:
                self._pending_launch_params = launch_params
                self._game_open_when_ready = True
            return

        proj = self._model.project_path
        pkg_json = proj / "package.json"
        if not pkg_json.is_file():
            if open_when_ready:
                QMessageBox.warning(self, "Error", "package.json not found")
            return

        self._game_server_ready = False
        self._game_open_when_ready = open_when_ready
        self._game_user_stopped = False
        self._game_proc_log = ""
        self._game_ready_timer.stop()

        proc = QProcess(self)
        proc.setWorkingDirectory(str(proj))
        env = QProcessEnvironment.systemEnvironment()
        _copy_env_to_qprocess(env, env_with_node_path())
        env.insert("GAMEDRAFT_EDITOR_EMBED", "1")
        _augment_env_for_nodejs(env)
        proc.setProcessEnvironment(env)
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        proc.readyReadStandardOutput.connect(self._on_game_proc_output)
        proc.errorOccurred.connect(self._on_game_proc_error)
        proc.finished.connect(self._on_game_proc_finished)
        self._game_proc = proc
        self._pending_launch_params = launch_params
        program, args = _npm_run_command("run", "dev")
        self._game_proc_log += f"$ {program} {' '.join(args)}\n"
        self._game_proc.start(program, args)
        self._status.showMessage(
            "Starting Vite dev server…" if open_when_ready else "Prewarming Vite dev server…",
            5000,
        )
        if open_when_ready and self._game_browser is not None:
            self._game_browser.show_message("Starting dev server…")
            idx = self._stack_index_of_page(self._game_browser)
            if idx >= 0:
                self._show_stack_page(idx)
        self._game_ready_timer.start(60_000)

    def _run_game_dev(self) -> None:
        """与 F5 相同流程，但加载 URL 带 mode=dev（开发模式 UI）。"""
        self._run_game(launch_params="mode=dev")

    def _on_water_minigame_preview_requested(self, instance_id: str) -> None:
        """编辑器「水域小游戏」页一键预览：保存后以开发模式启动并直达指定实例。"""
        from urllib.parse import quote

        iid = (instance_id or "").strip()
        if not iid:
            return
        self._run_game(launch_params=f"mode=dev&waterPreview={quote(iid)}")

    def _on_sugar_wheel_preview_requested(self, instance_id: str) -> None:
        """编辑器「转盘小游戏」页一键预览：保存后以开发模式启动并直达指定实例。"""
        from urllib.parse import quote

        iid = (instance_id or "").strip()
        if not iid:
            return
        self._run_game(launch_params=f"mode=dev&sugarWheelPreview={quote(iid)}")

    def _on_paper_craft_preview_requested(self, instance_id: str) -> None:
        """编辑器「扎纸小游戏」页一键预览：保存后以开发模式启动并直达指定实例。"""
        from urllib.parse import quote

        iid = (instance_id or "").strip()
        if not iid:
            return
        self._run_game(launch_params=f"mode=dev&paperCraftPreview={quote(iid)}")

    def _get_game_window_size(self) -> tuple[int, int]:
        cfg = self._model.game_config
        ws = cfg.get("windowSize")
        if isinstance(ws, dict) and ws.get("width") and ws.get("height"):
            return (int(ws["width"]), int(ws["height"]))
        vp = cfg.get("viewport")
        if isinstance(vp, dict) and vp.get("width") and vp.get("height"):
            return (int(vp["width"]), int(vp["height"]))
        return (1280, 720)

    def _focus_game_tab_and_load(self, url: str | None = None,
                                extra_params: str = "") -> None:
        target = (url or GAME_DEV_URL).strip()
        if not target.endswith("/"):
            target += "/"
        if extra_params:
            sep = "&" if "?" in target else "?"
            target = target + sep + extra_params

        if self._game_browser is not None:
            self._game_browser.show_message(
                "Game is running in a separate window.\n"
                "Press F5 to reopen if closed.",
            )
            idx = self._stack_index_of_page(self._game_browser)
            if idx >= 0:
                self._show_stack_page(idx)

        if self._game_play_window is None:
            w, h = self._get_game_window_size()
            self._game_play_window = GamePlayWindow(w, h, parent=self)
            if not self._game_play_window.is_available():
                from PySide6.QtGui import QDesktopServices
                from PySide6.QtCore import QUrl
                QDesktopServices.openUrl(QUrl(target))
                self._game_play_window = None
                return
            self._game_play_window.closed.connect(self._on_game_play_window_closed)

        self._game_play_window.load_url(target)
        self._game_play_window.show()
        self._game_play_window.raise_()
        self._game_play_window.activateWindow()

    def _mark_game_server_ready(self, url: str) -> None:
        if self._game_server_ready:
            return
        self._game_server_ready = True
        self._last_vite_dev_url = url
        self._game_ready_timer.stop()
        if self._game_open_when_ready:
            params = self._pending_launch_params or ""
            self._pending_launch_params = None
            self._game_open_when_ready = False
            self._focus_game_tab_and_load(url, extra_params=params)
            self._status.showMessage("Dev server ready.", 3000)
        else:
            self._pending_launch_params = None
            self._status.showMessage("Dev server prewarmed.", 3000)

    def _on_game_proc_output(self) -> None:
        if self._game_proc is None:
            return
        # ready 之后也要持续读走输出：不读则 QProcess 内部缓冲随 HMR 日志无界增长
        # （长开发会话内存泄漏）；读出后直接丢弃，不再解析。
        chunk = bytes(self._game_proc.readAllStandardOutput()).decode(
            "utf-8", errors="replace",
        )
        if self._game_server_ready or not chunk:
            return
        self._game_proc_log += chunk
        url = _vite_dev_url_from_log(self._game_proc_log)
        if url:
            self._mark_game_server_ready(url)

    def _on_game_proc_error(self, error: QProcess.ProcessError) -> None:
        if error == QProcess.ProcessError.FailedToStart:
            self._game_ready_timer.stop()
            QMessageBox.critical(
                self,
                "Run Game",
                "无法启动开发服务器子进程（FailedToStart）。\n"
                f"启动命令：{self._game_proc_log.strip() or 'npm run dev'}\n"
                "若已安装 Node，请检查 Node/npm 是否在 PATH 中，或安全软件是否拦截。",
            )

    def _on_game_server_ready_timeout(self) -> None:
        if self._game_server_ready:
            return
        if self._game_proc is None:
            return
        if self._game_proc.state() == QProcess.ProcessState.NotRunning:
            return
        self._game_server_ready = True
        url = _vite_dev_url_from_log(self._game_proc_log) or self._last_vite_dev_url or GAME_DEV_URL
        if self._game_open_when_ready:
            params = self._pending_launch_params or ""
            self._pending_launch_params = None
            self._game_open_when_ready = False
            self._focus_game_tab_and_load(url, extra_params=params)
            self._status.showMessage(
                "超时：已打开开发 URL；若页面异常请查看「运行与预览」或终端输出。",
                8000,
            )
        else:
            self._pending_launch_params = None
            self._status.showMessage(
                "开发服务器预热超时；按 F5/Ctrl+F5 时会继续尝试打开。",
                8000,
            )

    def _show_game_proc_failure(self, headline: str) -> None:
        tail = self._game_proc_log.strip()
        if len(tail) > 6000:
            tail = tail[-6000:]
        msg = headline
        if tail:
            msg += "\n\n--- npm / Vite 输出（尾部）---\n" + tail
        QMessageBox.warning(self, "Run Game", msg)
        if self._game_browser is not None and self._game_browser.is_webengine_available():
            self._game_browser.show_message(
                f"{headline}\n\n按 F5 重试。若提示找不到 npm，请将 Node.js 加入系统 PATH。",
            )

    def _on_game_proc_finished(self, exit_code: int, _exit_status) -> None:
        self._game_ready_timer.stop()
        was_ready = self._game_server_ready
        wanted_open = self._game_open_when_ready
        self._game_server_ready = False
        self._game_open_when_ready = False
        self._pending_launch_params = None
        self._close_game_play_window()
        proc = self.sender()
        if isinstance(proc, QProcess):
            tail = bytes(proc.readAllStandardOutput()).decode("utf-8", errors="replace")
            self._game_proc_log += tail
        if proc is self._game_proc:
            self._game_proc = None
        user_stop = self._game_user_stopped
        self._game_user_stopped = False

        if user_stop:
            if self._game_browser is not None and self._game_browser.is_webengine_available():
                self._game_browser.show_message(
                    "Game stopped. Press Run (F5) to start again.",
                )
            return

        if not was_ready:
            if exit_code != 0:
                msg = (
                    f"开发服务器异常结束（退出码 {exit_code}）。常见原因：未安装 Node/npm、"
                    "脚本编译失败、或端口被占用。"
                )
                if wanted_open:
                    self._show_game_proc_failure(msg)
                else:
                    self._status.showMessage(msg, 8000)
            else:
                if wanted_open:
                    self._show_game_proc_failure("开发进程已结束，未输出就绪信息。")
                else:
                    self._status.showMessage("开发服务器预热进程已结束，未输出就绪信息。", 8000)
            return

        if self._game_browser is not None and self._game_browser.is_webengine_available():
            self._game_browser.show_message(
                "Dev server stopped. Press Run (F5) to start again.",
            )

    def _on_cutscene_play_requested(self, cutscene_id: str) -> None:
        if not cutscene_id:
            return
        if not self._save_all():
            return
        is_running = (self._game_proc is not None
                      and self._game_proc.state() != QProcess.ProcessState.NotRunning)

        if is_running and self._game_play_window is not None:
            cid_js = json.dumps(cutscene_id)
            js = f'window.__gameDevAPI && window.__gameDevAPI.playCutscene({cid_js})'
            self._game_play_window.run_js(js)
            self._game_play_window.raise_()
            self._game_play_window.activateWindow()
            self._status.showMessage(f"Playing cutscene: {cutscene_id}", 3000)
        elif is_running:
            self._focus_game_tab_and_load(
                self._last_vite_dev_url,
                extra_params=f"mode=dev&play_cutscene={cutscene_id}",
            )
            self._status.showMessage(f"Playing cutscene: {cutscene_id}", 3000)
        else:
            self._run_game(
                launch_params=f"mode=dev&play_cutscene={cutscene_id}",
            )

    def _on_game_play_window_closed(self) -> None:
        self._game_play_window = None

    def _close_game_play_window(self) -> None:
        if self._game_play_window is not None:
            # 不 disconnect closed、不 deleteLater：关闭流程在 GamePlayWindow 内异步完成，
            # 否则 Qt 会在首次 close(ignore) 后误删窗口；引用在 closed 信号里清掉
            self._game_play_window.close()

    def _stop_game(self, _checked: bool = False, *, show_status: bool = True) -> None:
        if self._model.project_path is None:
            return
        self._game_user_stopped = True
        self._game_ready_timer.stop()
        self._game_server_ready = False
        self._game_open_when_ready = False
        self._pending_launch_params = None
        self._close_game_play_window()
        # Free the Vite dev-server ports before closing the embedded preview.
        try:
            from tools.dev.game import stop_dev_ports

            stop_dev_ports()
        except Exception:
            pass
        proc = self._game_proc
        if proc is not None:
            try:
                proc.readyReadStandardOutput.disconnect()
            except (TypeError, RuntimeError):
                pass
            try:
                proc.finished.disconnect()
            except (TypeError, RuntimeError):
                pass
            self._game_proc = None
            if proc.state() != QProcess.ProcessState.NotRunning:
                proc.terminate()
                if not proc.waitForFinished(1500):
                    proc.kill()
                    proc.waitForFinished(1500)
            proc.deleteLater()
        if show_status and self._game_browser is not None and self._game_browser.is_webengine_available():
            self._game_browser.show_message(
                "Game stopped. Press Run (F5) to start the dev server.",
            )
        if show_status:
            self._status.showMessage("Game stopped.", 3000)

    def _build_game(self) -> None:
        """异步 QProcess 构建：不再同步 subprocess.run 冻结整个编辑器；
        并与 dev server 一致走 _npm_run_command + PATH 补全（Dock/Finder 启动也找得到 npm）。"""
        if self._model.project_path is None:
            return
        if not self._save_all():
            return
        if getattr(self, "_build_proc", None) is not None:
            QMessageBox.information(self, "Build", "已有构建在进行中。")
            return
        program, args = _npm_run_command("run", "build")
        proc = QProcess(self)
        proc.setWorkingDirectory(str(self._model.project_path))
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        env = QProcessEnvironment.systemEnvironment()
        _augment_env_for_nodejs(env)
        proc.setProcessEnvironment(env)
        self._build_log = ""

        def _on_out() -> None:
            self._build_log += bytes(proc.readAllStandardOutput()).decode("utf-8", "replace")

        def _on_done(code: int, _status: QProcess.ExitStatus) -> None:
            _on_out()
            self._build_proc = None
            self._status.showMessage("", 1)
            if code == 0:
                QMessageBox.information(self, "Build", "Build successful!\nOutput: dist/")
            else:
                tail = "\n".join(self._build_log.splitlines()[-40:])
                QMessageBox.critical(self, "Build Error", tail or f"npm run build 退出码 {code}")

        proc.readyReadStandardOutput.connect(_on_out)
        proc.finished.connect(_on_done)
        proc.errorOccurred.connect(
            lambda _e: QMessageBox.critical(
                self, "Build Error",
                "未找到 npm，请确认已安装 Node.js 且 npm 在 PATH 中。",
            ) if proc.error() == QProcess.ProcessError.FailedToStart else None,
        )
        proc.start(program, args)
        if not proc.waitForStarted(4000):
            self._build_proc = None
            proc.deleteLater()
            return
        self._build_proc = proc
        self._status.showMessage("正在后台构建（npm run build）…", 10000)

    # ---- validation -------------------------------------------------------

    def _validate(self) -> None:
        if self._model.project_path is None:
            QMessageBox.warning(self, "校验", "未打开工程目录，无法校验数据。")
            return
        try:
            if not self._flush_editors_to_model():
                return
        except Exception as e:
            QMessageBox.critical(self, "Validate", f"Cannot validate pending edits:\n{e}")
            return
        issues = validate(self._model)
        if not issues:
            QMessageBox.information(self, "Validate", "No issues found.")
            return
        dlg = QDialog(self)
        dlg.setWindowTitle(f"Validation: {len(issues)} issues")
        dlg.resize(700, 500)
        lay = QVBoxLayout(dlg)
        te = QTextEdit()
        te.setReadOnly(True)
        lines = []
        for iss in issues:
            prefix = "ERR " if iss.severity == "error" else "WARN"
            lines.append(f"[{prefix}] [{iss.data_type}] {iss.item_id}: {iss.message}")
        te.setPlainText("\n".join(lines))
        lay.addWidget(te)
        dlg.exec()

    # ---- action navigation -------------------------------------------------

    def _connect_action_nav(self) -> None:
        from .editors.action_registry_editor import ActionRegistryEditor
        for ed in self._editor_instances:
            if isinstance(ed, ActionRegistryEditor):
                ed.navigate_to_source.connect(self._on_navigate_to_source)
                break

    def navigate_to_dialogue_graph(self, graph_id: str) -> None:
        """切换到「图对话」页并按资源 id 打开对应 graphs/*.json。"""
        from .editors.dialogue_graph_editor_tab import DialogueGraphEditorTab

        gid = (graph_id or "").strip()
        if not gid:
            return
        self._record_nav(_NavLocation("dialogue_graph", (gid,)))
        for i, ed in enumerate(self._editor_instances):
            if isinstance(ed, DialogueGraphEditorTab):
                self._show_stack_page(i)
                ed.open_graph_by_id(gid)
                return

    def navigate_to_scenario_catalog(self, scenario_id: str) -> None:
        """切换到「Scenarios」页并选中指定 scenarioId。"""
        from .editors.narrative_data_editors import ScenariosCatalogEditor

        sid = (scenario_id or "").strip()
        if not sid:
            return
        self._record_nav(_NavLocation("scenario", (sid,)))
        for i, ed in enumerate(self._editor_instances):
            if isinstance(ed, ScenariosCatalogEditor):
                self._show_stack_page(i)
                ed.select_scenario_by_id(sid)
                return

    def navigate_to_minigame(self, instance_id: str) -> None:
        from .editors.paper_craft_editor import PaperCraftEditor
        from .editors.sugar_wheel_editor import SugarWheelEditor
        from .editors.water_minigame_editor import WaterMinigameEditor

        iid = (instance_id or "").strip()
        if not iid:
            return
        self._record_nav(_NavLocation("minigame", (iid,)))
        candidates: list[type] = []
        if iid in getattr(self._model, "water_minigames_instances", {}):
            candidates.append(WaterMinigameEditor)
        if iid in getattr(self._model, "sugar_wheel_instances", {}):
            candidates.append(SugarWheelEditor)
        if iid in getattr(self._model, "paper_craft_instances", {}):
            candidates.append(PaperCraftEditor)
        for cls in candidates:
            for i, ed in enumerate(self._editor_instances):
                if not isinstance(ed, cls):
                    continue
                self._show_stack_page(i)
                select = getattr(ed, "select_by_id", None)
                if callable(select):
                    select(iid)
                return

    def navigate_to_cutscene(self, cutscene_id: str) -> None:
        from .editors.timeline_editor import TimelineEditor

        cid = (cutscene_id or "").strip()
        if not cid:
            return
        self._record_nav(_NavLocation("cutscene", (cid,)))
        for i, ed in enumerate(self._editor_instances):
            if isinstance(ed, TimelineEditor):
                self._show_stack_page(i)
                select = getattr(ed, "select_by_id", None)
                if callable(select):
                    select(cid)
                return

    def navigate_to_narrative_state(self, graph_id: str, state_id: str) -> None:
        """切换到「叙事状态机」页并让 web 编辑器聚焦指定图的状态（位面面板 Tab2 跳转落点）。"""
        from .editors.narrative_state_editor import NarrativeStateEditor

        gid = (graph_id or "").strip()
        sid = (state_id or "").strip()
        if not gid or not sid:
            return
        self._record_nav(_NavLocation("narrative_state", (gid, sid)))
        for i, ed in enumerate(self._editor_instances):
            if isinstance(ed, NarrativeStateEditor):
                self._show_stack_page(i)
                if not ed.focus_state(gid, sid):
                    self._status.showMessage(
                        f"未能在叙事编辑器中定位 {gid}.{sid}（图不存在或 web 编辑器未就绪）", 5000,
                    )
                return

    def navigate_to_scene_entity(
        self, kind: str, entity_id: str, scene_id: str, plane_view: str = "",
    ) -> None:
        """切换到「Scene」页选中场景实体；plane_view 非空时同时打开该位面的位面视图
        （位面面板 Tab3 跳转落点）。"""
        from .editors.scene_editor import SceneEditor

        kind = (kind or "").strip()
        selector_name = {
            "npc": "select_npc_by_id",
            "hotspot": "select_hotspot_by_id",
            "zone": "select_zone_by_id",
        }.get(kind)
        if not selector_name:
            return
        self._record_nav(_NavLocation(
            "scene_entity",
            (kind, (entity_id or "").strip(), (scene_id or "").strip(), (plane_view or "").strip()),
        ))
        for i, ed in enumerate(self._editor_instances):
            if isinstance(ed, SceneEditor):
                self._show_stack_page(i)
                pv = (plane_view or "").strip()
                if pv:
                    activate = getattr(ed, "activate_plane_view", None)
                    if callable(activate):
                        activate(pv)
                select = getattr(ed, selector_name, None)
                if callable(select):
                    select((entity_id or "").strip(), (scene_id or "").strip())
                return

    def navigate_to_plane(self, plane_id: str) -> None:
        """切换到「位面」页并选中指定 planeId（叙事状态 state.activePlane 跳转落点）。"""
        from .editors.plane_editor import PlaneEditor

        pid = (plane_id or "").strip()
        if not pid:
            return
        self._record_nav(_NavLocation("plane", (pid,)))
        for i, ed in enumerate(self._editor_instances):
            if isinstance(ed, PlaneEditor):
                self._show_stack_page(i)
                select = getattr(ed, "select_by_id", None)
                if callable(select):
                    select(pid)
                return

    def _on_navigate_to_source(self, source_type: str, source_id: str, scene_id: str) -> None:
        if source_type == "dialogue_graph":
            self.navigate_to_dialogue_graph(source_id)
            return
        target_label = SOURCE_NAVIGATION_TABS.get(source_type)
        if not target_label:
            return
        for i, label in enumerate(self._editor_labels):
            if label == target_label:
                self._record_nav(_NavLocation("source", (source_type, source_id, scene_id)))
                self._show_stack_page(i)
                ed = self._editor_instances[i]
                selector_name = SOURCE_NAVIGATION_SELECTORS.get(source_type, "select_by_id")
                select = getattr(ed, selector_name, None)
                if callable(select):
                    select(source_id, scene_id)
                break

    # ---- close ------------------------------------------------------------

    def closeEvent(self, event) -> None:
        if not self._confirm_pending_editor_changes():
            event.ignore()
            return
        # 先把各面板未应用的编辑 flush 进模型再判 dirty——否则"改了字段没 Ctrl+S 直接关窗"
        # 会绕过下面的保存询问被静默丢弃（审查 P1-5）。各 flush 均已条件化：零编辑时不产生伪脏。
        try:
            if not self._flush_editors_to_model():
                event.ignore()
                return
        except Exception as e:
            r = QMessageBox.question(
                self, "未保存的编辑无法提交",
                f"{e}\n\n仍要关闭并丢弃这些编辑吗？",
                QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            )
            if r != QMessageBox.StandardButton.Discard:
                event.ignore()
                return
        if self._model.is_dirty:
            r = QMessageBox.question(
                self, "Unsaved Changes",
                "You have unsaved changes. Save before exit?",
                QMessageBox.StandardButton.Save |
                QMessageBox.StandardButton.Discard |
                QMessageBox.StandardButton.Cancel,
            )
            if r == QMessageBox.StandardButton.Save:
                if not self._save_all():
                    event.ignore()
                    return
            elif r == QMessageBox.StandardButton.Cancel:
                event.ignore()
                return
        try:
            self._settings.setValue("mainWindowGeometry", self.saveGeometry())
        except Exception:
            pass
        self._stop_game()
        super().closeEvent(event)
