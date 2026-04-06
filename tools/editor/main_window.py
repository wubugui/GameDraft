"""Main application window for GameDraft Editor."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PySide6.QtWidgets import (
    QMainWindow, QTabWidget, QStatusBar, QToolBar, QFileDialog,
    QMessageBox, QTextEdit, QDialog, QVBoxLayout, QLabel,
)
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtCore import Qt, QProcess

from .project_model import ProjectModel
from .validator import validate, Issue


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("GameDraft Editor")
        self.resize(1400, 900)

        self._model = ProjectModel(self)
        self._game_proc: QProcess | None = None
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
        self._act(run_menu, "Run Game", self._run_game, QKeySequence("F5"))
        self._act(run_menu, "Stop Game", self._stop_game, QKeySequence("Shift+F5"))
        run_menu.addSeparator()
        self._act(run_menu, "Build (Export)", self._build_game)

        tools_menu = mb.addMenu("Tools")
        self._act(tools_menu, "Validate Data", self._validate)

    def _build_toolbar(self) -> None:
        tb = QToolBar("Main")
        tb.setMovable(False)
        self.addToolBar(tb)
        tb.addAction("Save All", self._save_all)
        tb.addSeparator()
        tb.addAction("Run", self._run_game)
        tb.addAction("Stop", self._stop_game)
        tb.addSeparator()
        tb.addAction("Validate", self._validate)

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

        self._connect_action_nav()

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

    def _run_game(self) -> None:
        if self._model.project_path is None:
            return
        self._save_all()
        cmd_path = self._model.project_path / "start-game.cmd"
        if not cmd_path.exists():
            QMessageBox.warning(self, "Error", "start-game.cmd not found")
            return
        self._game_proc = QProcess(self)
        self._game_proc.setWorkingDirectory(str(self._model.project_path))
        self._game_proc.start("cmd", ["/c", str(cmd_path)])
        self._status.showMessage("Game started.", 3000)

    def _stop_game(self) -> None:
        if self._model.project_path is None:
            return
        cmd_path = self._model.project_path / "stop-game.cmd"
        if cmd_path.exists():
            subprocess.run(["cmd", "/c", str(cmd_path), "nopause"],
                           cwd=str(self._model.project_path))
        if self._game_proc and self._game_proc.state() != QProcess.ProcessState.NotRunning:
            self._game_proc.kill()
        self._game_proc = None
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
