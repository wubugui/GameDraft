"""Main application window for GameDraft Editor."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PySide6.QtWidgets import (
    QMainWindow, QTabWidget, QStatusBar, QToolBar, QFileDialog,
    QMessageBox, QTextEdit, QDialog, QVBoxLayout, QLabel,
    QSizePolicy, QWidget, QStyle,
)
from PySide6.QtGui import QAction, QKeySequence, QActionGroup
from PySide6.QtCore import Qt, QProcess, QProcessEnvironment, QTimer, QSize
from PySide6.QtWidgets import QApplication

from . import theme
from .project_model import ProjectModel
from .validator import validate, Issue
from .editors.game_browser import GAME_DEV_URL, GameBrowserTab, GamePlayWindow

# Vite 就绪行示例:  Local:   http://127.0.0.1:3000/
_VITE_DEV_URL_RE = re.compile(
    r"https?://(?:127\.0\.0\.1|localhost):\d{2,5}(?:/[^\s]*)?",
    re.IGNORECASE,
)


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
    path_key = "Path" if sys.platform == "win32" else "PATH"
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

    if sys.platform == "win32":
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pfx86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        home = os.environ.get("USERPROFILE", "")
        for d in (
            os.path.join(pf, "nodejs"),
            os.path.join(pfx86, "nodejs"),
            os.path.join(home, "AppData", "Roaming", "npm"),
            os.path.join(home, ".volta", "bin"),
        ):
            if os.path.isdir(d):
                prefixes.append(d)
        nvm_link = os.environ.get("NVM_SYMLINK", "")
        if nvm_link and os.path.isdir(nvm_link):
            prefixes.insert(0, nvm_link)

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


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("GameDraft Editor")
        self.resize(1400, 900)

        self._model = ProjectModel(self)
        self._game_proc: QProcess | None = None
        self._game_server_ready_for_current_run = False
        self._game_ready_timer = QTimer(self)
        self._game_ready_timer.setSingleShot(True)
        self._game_ready_timer.timeout.connect(self._on_game_server_ready_timeout)
        self._game_browser: GameBrowserTab | None = None
        self._game_play_window: GamePlayWindow | None = None
        self._game_proc_log: str = ""
        self._game_user_stopped: bool = False
        self._last_vite_dev_url: str | None = None
        self._pending_cutscene_id: str | None = None
        self._tabs = QTabWidget()
        self.setCentralWidget(self._tabs)
        self._editor_instances: list = []

        self._build_menus()
        self._build_toolbar()
        self._status = QStatusBar()
        self.setStatusBar(self._status)

        self._model.dirty_changed.connect(self._on_dirty)

    # ---- menu / toolbar ---------------------------------------------------

    def _build_menus(self) -> None:
        mb = self.menuBar()

        file_menu = mb.addMenu("File")
        self._act(file_menu, "Open Project...", self._open_project, QKeySequence("Ctrl+O"))
        self._act(file_menu, "Save All", self._save_all, QKeySequence("Ctrl+Shift+S"))
        file_menu.addSeparator()
        self._act(file_menu, "Exit", self.close, QKeySequence("Alt+F4"))

        edit_menu = mb.addMenu("Edit")
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
        self._act(tools_menu, "Open Graph Editor", self._open_graph_editor)

        view_menu = mb.addMenu("View")
        ag_theme = QActionGroup(self)
        self._act_theme_light = QAction("浅色主题", self, checkable=True)
        self._act_theme_dark = QAction("深色主题", self, checkable=True)
        ag_theme.addAction(self._act_theme_light)
        ag_theme.addAction(self._act_theme_dark)
        self._act_theme_light.triggered.connect(
            lambda: self._apply_ui_theme(theme.THEME_LIGHT))
        self._act_theme_dark.triggered.connect(
            lambda: self._apply_ui_theme(theme.THEME_DARK))
        view_menu.addAction(self._act_theme_light)
        view_menu.addAction(self._act_theme_dark)
        tid = theme.current_theme_id()
        self._act_theme_light.setChecked(tid == theme.THEME_LIGHT)
        self._act_theme_dark.setChecked(tid == theme.THEME_DARK)

    def _apply_ui_theme(self, theme_id: str) -> None:
        app = QApplication.instance()
        if app is None:
            return
        theme.apply_application_theme(app, theme_id)
        theme.settings_save_theme(theme_id)
        self._act_theme_light.setChecked(theme_id == theme.THEME_LIGHT)
        self._act_theme_dark.setChecked(theme_id == theme.THEME_DARK)
        self._sync_theme_to_editors()

    def _sync_theme_to_editors(self) -> None:
        tid = theme.current_theme_id()
        theme.refresh_all_graphics_views(self, tid)
        for inst in self._editor_instances:
            fn = getattr(inst, "on_editor_theme_changed", None)
            if callable(fn):
                fn(tid)

    def _build_toolbar(self) -> None:
        tb = QToolBar("Main")
        tb.setMovable(False)
        tb.setIconSize(QSize(24, 24))
        self.addToolBar(tb)
        tb.addAction("Save All", self._save_all)
        tb.addSeparator()
        tb.addAction("Validate", self._validate)

        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        tb.addWidget(spacer)

        st = self.style()
        act_run = QAction(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaPlay),
            "",
            self,
        )
        act_run.setToolTip("运行游戏 (F5)")
        act_run.setShortcut(QKeySequence("F5"))
        act_run.triggered.connect(self._run_game)
        tb.addAction(act_run)

        act_stop = QAction(
            st.standardIcon(QStyle.StandardPixmap.SP_MediaStop),
            "",
            self,
        )
        act_stop.setToolTip("停止游戏 (Shift+F5)")
        act_stop.setShortcut(QKeySequence("Shift+F5"))
        act_stop.triggered.connect(self._stop_game)
        tb.addAction(act_stop)

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
        assets = path / "public" / "assets"
        if not assets.is_dir():
            QMessageBox.critical(self, "Error",
                                 f"Invalid project: {assets} not found")
            return
        self._model.load_project(path)
        self.setWindowTitle(f"GameDraft Editor - {path.name}")
        self._status.showMessage(f"Loaded: {path}", 5000)
        self._populate_tabs()

    def _open_graph_editor(self) -> None:
        if self._model.project_path is None:
            QMessageBox.information(
                self, "Graph Editor", "Please open a project first.")
            return
        root = str(self._model.project_path.resolve())
        try:
            subprocess.Popen(
                [sys.executable, "-m", "tools.graph_editor", "--project", root],
                cwd=root,
            )
        except OSError as e:
            QMessageBox.critical(self, "Graph Editor", str(e))

    def _populate_tabs(self) -> None:
        self._tabs.clear()
        self._editor_instances.clear()

        from .editors.scene_editor import SceneEditor
        from .editors.quest_editor import QuestEditor
        from .editors.encounter_editor import EncounterEditor
        from .editors.cutscene_editor import CutsceneEditor
        from .editors.item_editor import ItemEditor
        from .editors.rule_editor import RuleEditor
        from .editors.shop_editor import ShopEditor
        from .editors.map_editor import MapEditor
        from .editors.archive_editor import ArchiveEditor
        from .editors.dialogue_browser import DialogueBrowser
        from .editors.audio_editor import AudioEditor
        from .editors.anim_editor import AnimEditor
        from .editors.string_editor import StringEditor
        from .editors.game_config_editor import GameConfigEditor
        from .editors.flag_registry_editor import FlagRegistryEditor
        from .editors.filter_editor import FilterEditor
        from .editors.action_registry_editor import ActionRegistryEditor

        editors = [
            ("Scene", SceneEditor),
            ("Quest", QuestEditor),
            ("Encounter", EncounterEditor),
            ("Cutscene", CutsceneEditor),
            ("Item", ItemEditor),
            ("Rule", RuleEditor),
            ("Shop", ShopEditor),
            ("Map", MapEditor),
            ("Archive", ArchiveEditor),
            ("Dialogue", DialogueBrowser),
            ("Audio", AudioEditor),
            ("Filters", FilterEditor),
            ("Animation", AnimEditor),
            ("Strings", StringEditor),
            ("Config", GameConfigEditor),
            ("Flags", FlagRegistryEditor),
            ("Actions", ActionRegistryEditor),
        ]
        for label, cls in editors:
            ed = cls(self._model)
            self._tabs.addTab(ed, label)
            self._editor_instances.append(ed)
            if isinstance(ed, CutsceneEditor):
                ed.play_requested.connect(self._on_cutscene_play_requested)

        self._game_browser = GameBrowserTab(self)
        self._game_browser.run_requested.connect(self._run_game)
        self._game_browser.stop_requested.connect(self._stop_game)
        self._tabs.addTab(self._game_browser, "Game")

        self._connect_action_nav()
        self._sync_theme_to_editors()

    # ---- save / dirty -----------------------------------------------------

    def _save_all(self) -> None:
        if self._model.project_path is None:
            return
        try:
            for inst in self._editor_instances:
                flush = getattr(inst, "flush_to_model", None)
                if callable(flush):
                    flush()
            self._model.save_all()
            self._status.showMessage("Saved.", 3000)
        except Exception as e:
            QMessageBox.critical(self, "Save Error", str(e))

    def _on_dirty(self, dirty: bool) -> None:
        title = self.windowTitle().rstrip(" *")
        self.setWindowTitle(title + (" *" if dirty else ""))

    # ---- run game ---------------------------------------------------------

    def _compile_ink(self) -> bool:
        """Compile all .ink -> .ink.json. Returns True on success."""
        proj = self._model.project_path
        if proj is None:
            return True
        script = proj / "scripts" / "compile-ink.cjs"
        if not script.is_file():
            return True
        env = os.environ.copy()
        npm_path = shutil.which("npm")
        if npm_path:
            node_dir = str(Path(npm_path).resolve().parent)
            env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")
        node = shutil.which("node", path=env.get("PATH"))
        if node is None:
            QMessageBox.warning(self, "Ink Compile",
                                "node not found in PATH, cannot compile ink.")
            return False
        r = subprocess.run(
            [node, str(script)],
            cwd=str(proj), capture_output=True, text=True, env=env,
            timeout=30,
        )
        if r.returncode != 0:
            msg = (r.stdout + "\n" + r.stderr).strip()
            QMessageBox.critical(
                self, "Ink Compile Failed",
                f"Ink compilation errors:\n\n{msg}",
            )
            return False
        ok_lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
        if ok_lines:
            self._status.showMessage(
                f"Ink compiled: {len(ok_lines)} file(s)", 3000,
            )
        return True

    def _run_game(self) -> None:
        if self._model.project_path is None:
            return
        self._save_all()

        if not self._compile_ink():
            return

        proj = self._model.project_path
        pkg_json = proj / "package.json"
        if not pkg_json.is_file():
            QMessageBox.warning(self, "Error", "package.json not found")
            return
        if self._game_browser is None:
            return

        if (self._game_proc is not None
                and self._game_proc.state() != QProcess.ProcessState.NotRunning):
            self._focus_game_tab_and_load(self._last_vite_dev_url)
            self._status.showMessage("Dev server already running; reloaded Game tab.", 3000)
            return

        self._game_server_ready_for_current_run = False
        self._game_user_stopped = False
        self._game_proc_log = ""
        self._game_ready_timer.stop()

        proc = QProcess(self)
        proc.setWorkingDirectory(str(proj))
        env = QProcessEnvironment.systemEnvironment()
        env.insert("GAMEDRAFT_EDITOR_EMBED", "1")
        _augment_env_for_nodejs(env)
        proc.setProcessEnvironment(env)
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        proc.readyReadStandardOutput.connect(self._on_game_proc_output)
        proc.errorOccurred.connect(self._on_game_proc_error)
        proc.finished.connect(self._on_game_proc_finished)
        self._game_proc = proc
        self._game_proc.start("cmd.exe", ["/c", "npm run dev"])
        self._status.showMessage("Starting Vite dev server…", 5000)
        self._game_browser.show_message("Starting dev server…")
        self._tabs.setCurrentWidget(self._game_browser)
        self._game_ready_timer.start(60_000)

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
            self._tabs.setCurrentWidget(self._game_browser)

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
        if self._game_server_ready_for_current_run:
            return
        self._game_server_ready_for_current_run = True
        self._last_vite_dev_url = url
        self._game_ready_timer.stop()
        params = ""
        if self._pending_cutscene_id:
            params = f"mode=dev&play_cutscene={self._pending_cutscene_id}"
            self._pending_cutscene_id = None
        self._focus_game_tab_and_load(url, extra_params=params)
        self._status.showMessage("Dev server ready.", 3000)

    def _on_game_proc_output(self) -> None:
        if self._game_server_ready_for_current_run or self._game_proc is None:
            return
        chunk = bytes(self._game_proc.readAllStandardOutput()).decode(
            "utf-8", errors="replace",
        )
        if not chunk:
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
                "若已安装 Node，请尝试从「开始菜单」启动本编辑器，或检查安全软件是否拦截。",
            )

    def _on_game_server_ready_timeout(self) -> None:
        if self._game_server_ready_for_current_run:
            return
        if self._game_proc is None:
            return
        if self._game_proc.state() == QProcess.ProcessState.NotRunning:
            return
        self._game_server_ready_for_current_run = True
        url = _vite_dev_url_from_log(self._game_proc_log) or self._last_vite_dev_url or GAME_DEV_URL
        self._focus_game_tab_and_load(url)
        self._status.showMessage(
            "Timeout: opened dev URL; if the page fails, check Game tab or Run output.",
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
        was_ready = self._game_server_ready_for_current_run
        self._game_server_ready_for_current_run = False
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
                self._show_game_proc_failure(
                    f"开发服务器异常结束（退出码 {exit_code}）。常见原因：未安装 Node/npm、"
                    "脚本编译失败、或端口被占用。",
                )
            else:
                self._show_game_proc_failure("开发进程已结束，未输出就绪信息。")
            return

        if self._game_browser is not None and self._game_browser.is_webengine_available():
            self._game_browser.show_message(
                "Dev server stopped. Press Run (F5) to start again.",
            )

    def _on_cutscene_play_requested(self, cutscene_id: str) -> None:
        if not cutscene_id:
            return
        self._save_all()
        if not self._compile_ink():
            return

        is_running = (self._game_proc is not None
                      and self._game_proc.state() != QProcess.ProcessState.NotRunning)

        if is_running and self._game_play_window is not None:
            js = f'window.__gameDevAPI && window.__gameDevAPI.playCutscene("{cutscene_id}")'
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
            self._pending_cutscene_id = cutscene_id
            self._run_game()

    def _on_game_play_window_closed(self) -> None:
        self._game_play_window = None

    def _close_game_play_window(self) -> None:
        if self._game_play_window is not None:
            # 不 disconnect closed、不 deleteLater：关闭流程在 GamePlayWindow 内异步完成，
            # 否则 Qt 会在首次 close(ignore) 后误删窗口；引用在 closed 信号里清掉
            self._game_play_window.close()

    def _stop_game(self) -> None:
        if self._model.project_path is None:
            return
        self._game_user_stopped = True
        self._game_ready_timer.stop()
        self._game_server_ready_for_current_run = False
        self._close_game_play_window()
        cmd_path = self._model.project_path / "stop-game.cmd"
        if cmd_path.exists():
            subprocess.run(["cmd", "/c", str(cmd_path), "nopause"],
                           cwd=str(self._model.project_path))
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
                proc.kill()
            proc.deleteLater()
        if self._game_browser is not None and self._game_browser.is_webengine_available():
            self._game_browser.show_message(
                "Game stopped. Press Run (F5) to start the dev server.",
            )
        self._status.showMessage("Game stopped.", 3000)

    def _build_game(self) -> None:
        if self._model.project_path is None:
            return
        self._save_all()
        result = subprocess.run(
            ["cmd", "/c", "npm run build"],
            cwd=str(self._model.project_path),
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            QMessageBox.information(self, "Build", "Build successful!\nOutput: dist/")
        else:
            QMessageBox.critical(self, "Build Error", result.stderr or result.stdout)

    # ---- validation -------------------------------------------------------

    def _validate(self) -> None:
        if self._model.project_path is None:
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

    def _on_navigate_to_source(self, source_type: str, source_id: str, scene_id: str) -> None:
        tab_map = {
            "quest": "Quest",
            "encounter": "Encounter",
            "scene_hotspot": "Scene",
            "scene_zone": "Scene",
            "scene_zone_rule": "Scene",
        }
        target_label = tab_map.get(source_type)
        if not target_label:
            return
        for i, ed in enumerate(self._editor_instances):
            label = self._tabs.tabText(i)
            if label == target_label:
                self._tabs.setCurrentIndex(i)
                select = getattr(ed, "select_by_id", None)
                if callable(select):
                    select(source_id, scene_id)
                break

    # ---- close ------------------------------------------------------------

    def closeEvent(self, event) -> None:
        if self._model.is_dirty:
            r = QMessageBox.question(
                self, "Unsaved Changes",
                "You have unsaved changes. Save before exit?",
                QMessageBox.StandardButton.Save |
                QMessageBox.StandardButton.Discard |
                QMessageBox.StandardButton.Cancel,
            )
            if r == QMessageBox.StandardButton.Save:
                self._save_all()
            elif r == QMessageBox.StandardButton.Cancel:
                event.ignore()
                return
        self._stop_game()
        super().closeEvent(event)
