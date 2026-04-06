"""Full-featured Ink dialogue editor with autocomplete, validation,
flow visualization, tag summary, reverse references, and simulation."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QListWidgetItem, QPlainTextEdit, QPushButton, QLabel, QTabWidget,
    QTreeWidget, QTreeWidgetItem, QCompleter, QMessageBox,
)
from PySide6.QtGui import (
    QFont, QColor, QTextCharFormat, QSyntaxHighlighter, QTextDocument,
    QTextCursor, QShortcut, QKeySequence, QAction,
)
from PySide6.QtCore import Qt, QRegularExpression, QStringListModel, QTimer

from ..project_model import ProjectModel
from ..file_io import read_text, write_text
from ..shared.action_editor import ACTION_TYPES
from .ink_parser import (
    parse_knots, parse_tags, validate_ink,
    extract_npc_references, InkTag,
    INK_EXTERNALS, all_external_signatures,
)
from .ink_flow_scene import InkFlowScene, InkFlowView
from .ink_simulator import InkSimulatorWidget

# ---------------------------------------------------------------------------
# Tag type -> action param ID source mapping
# ---------------------------------------------------------------------------

_ACTION_ID_SOURCES: dict[str, str] = {
    "giveRule": "rule",
    "giveFragment": "fragment",
    "updateQuest": "quest",
    "startEncounter": "encounter",
    "startCutscene": "cutscene",
    "openShop": "shop",
    "giveItem": "item",
    "removeItem": "item",
    "switchScene": "scene",
    "changeScene": "scene",
    "playBgm": "bgm",
    "stopBgm": "bgm",
    "playSfx": "sfx",
}

# Tag prefixes offered after typing `# `
_TAG_PREFIXES = [
    "action:", "require:", "speaker:", "ruleHint:", "cost:",
]

_INK_KEYWORDS = ["EXTERNAL ", "INCLUDE "]


# ---------------------------------------------------------------------------
# Enhanced Ink syntax highlighter with inline validation marks
# ---------------------------------------------------------------------------

class InkHighlighter(QSyntaxHighlighter):
    def __init__(self, parent: QTextDocument):
        super().__init__(parent)
        self._rules: list[tuple[QRegularExpression, QTextCharFormat]] = []
        self._error_lines: set[int] = set()
        self._warning_lines: set[int] = set()

        fmt_knot = QTextCharFormat()
        fmt_knot.setForeground(QColor(100, 200, 255))
        fmt_knot.setFontWeight(QFont.Weight.Bold)
        self._rules.append((QRegularExpression(r"^===.*===$"), fmt_knot))

        fmt_tag = QTextCharFormat()
        fmt_tag.setForeground(QColor(200, 180, 80))
        self._rules.append((QRegularExpression(r"#\s*[a-zA-Z_]\w*(?::[^\s#]*)*"), fmt_tag))

        fmt_choice = QTextCharFormat()
        fmt_choice.setForeground(QColor(150, 220, 150))
        self._rules.append((QRegularExpression(r"^\s*[\+\*].*$"), fmt_choice))

        fmt_ext = QTextCharFormat()
        fmt_ext.setForeground(QColor(200, 120, 120))
        self._rules.append((QRegularExpression(r"^EXTERNAL\s+.*$"), fmt_ext))

        fmt_divert = QTextCharFormat()
        fmt_divert.setForeground(QColor(180, 140, 220))
        self._rules.append((QRegularExpression(r"->\s*\S+"), fmt_divert))

        fmt_cond = QTextCharFormat()
        fmt_cond.setForeground(QColor(220, 160, 100))
        self._rules.append((QRegularExpression(r"^\{.*$"), fmt_cond))
        self._rules.append((QRegularExpression(r"^\s*-\s*else\s*:"), fmt_cond))
        self._rules.append((QRegularExpression(r"^\}\s*$"), fmt_cond))

    def set_issues(
        self, errors: set[int], warnings: set[int],
    ) -> None:
        self._error_lines = errors
        self._warning_lines = warnings
        self.rehighlight()

    def highlightBlock(self, text: str) -> None:
        for pattern, fmt in self._rules:
            it = pattern.globalMatch(text)
            while it.hasNext():
                m = it.next()
                self.setFormat(m.capturedStart(), m.capturedLength(), fmt)

        block_num = self.currentBlock().blockNumber()
        if block_num in self._error_lines:
            fmt_err = QTextCharFormat()
            fmt_err.setUnderlineColor(QColor(255, 80, 80))
            fmt_err.setUnderlineStyle(
                QTextCharFormat.UnderlineStyle.WaveUnderline,
            )
            self.setFormat(0, len(text), fmt_err)
        elif block_num in self._warning_lines:
            fmt_warn = QTextCharFormat()
            fmt_warn.setUnderlineColor(QColor(220, 180, 60))
            fmt_warn.setUnderlineStyle(
                QTextCharFormat.UnderlineStyle.WaveUnderline,
            )
            self.setFormat(0, len(text), fmt_warn)


# ---------------------------------------------------------------------------
# Ink text editor with context-aware autocomplete
# ---------------------------------------------------------------------------

class InkTextEdit(QPlainTextEdit):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self.setFont(QFont("Consolas", 10))
        self.setTabStopDistance(
            self.fontMetrics().horizontalAdvance(" ") * 4,
        )
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)

        self._completer = QCompleter(self)
        self._completer.setWidget(self)
        self._completer.setCompletionMode(
            QCompleter.CompletionMode.PopupCompletion,
        )
        self._completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self._completer_model = QStringListModel(self)
        self._completer.setModel(self._completer_model)
        self._completer.activated.connect(self._insert_completion)

        self._knot_names: list[str] = []

        ctx_menu_action = QAction("Insert Action Tag", self)
        ctx_menu_action.triggered.connect(lambda: self._insert_tag_template("action"))
        self._ctx_insert_action = ctx_menu_action

    def set_knot_names(self, names: list[str]) -> None:
        self._knot_names = list(names)

    def contextMenuEvent(self, event) -> None:
        menu = self.createStandardContextMenu()
        menu.addSeparator()

        insert_menu = menu.addMenu("Insert Tag")
        for prefix in _TAG_PREFIXES:
            tag_name = prefix.rstrip(":")
            act = insert_menu.addAction(f"# {prefix}")
            act.triggered.connect(
                lambda checked, p=prefix: self._insert_tag_template(p),
            )
        insert_menu.addSeparator()
        divert_act = insert_menu.addAction("-> (divert)")
        divert_act.triggered.connect(self._insert_divert_template)

        menu.exec(event.globalPos())

    def _insert_tag_template(self, prefix: str) -> None:
        cursor = self.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.EndOfBlock)
        line_text = cursor.block().text().strip()
        sep = " " if line_text else ""
        cursor.insertText(f"{sep}# {prefix}")
        self.setTextCursor(cursor)
        self._update_completions()

    def _insert_divert_template(self) -> None:
        cursor = self.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.EndOfBlock)
        cursor.insertText("\n-> ")
        self.setTextCursor(cursor)
        self._update_completions()

    def keyPressEvent(self, event) -> None:
        if self._completer.popup().isVisible():
            if event.key() in (
                Qt.Key.Key_Enter, Qt.Key.Key_Return,
                Qt.Key.Key_Escape, Qt.Key.Key_Tab, Qt.Key.Key_Backtab,
            ):
                event.ignore()
                return

        super().keyPressEvent(event)
        self._update_completions()

    def _update_completions(self) -> None:
        cursor = self.textCursor()
        block_text = cursor.block().text()
        col = cursor.positionInBlock()
        text_before = block_text[:col]

        candidates, prefix = self._get_completion_context(text_before)
        if not candidates:
            self._completer.popup().hide()
            return

        self._completer_model.setStringList(candidates)
        self._completer.setCompletionPrefix(prefix)

        if self._completer.completionCount() == 0:
            self._completer.popup().hide()
            return

        cr = self.cursorRect()
        cr.setWidth(
            min(300, self._completer.popup().sizeHintForColumn(0) + 40),
        )
        self._completer.complete(cr)

    def _get_completion_context(self, text_before: str) -> tuple[list[str], str]:
        """Return (candidates, prefix) for the current cursor context.

        Patterns are checked from most specific to least specific so that
        e.g. ``# action:setFlag:key:`` is matched before ``# action:setFlag:``.
        Each pattern captures the already-typed portion as *prefix* so
        QCompleter can filter continuously while the user types.
        """
        # -> divert target
        m = re.search(r'->\s*(\S*)$', text_before)
        if m:
            return self._knot_names + ["END"], m.group(1)

        # {externalFunc("arg -- argument inside any registered external call
        m = re.search(r'\{(\w+)\(\s*"([^"]*)$', text_before)
        if m:
            func_name = m.group(1)
            ext_def = INK_EXTERNALS.get(func_name)
            if ext_def and ext_def.params:
                candidates = self._candidates_for_param_type(ext_def.params[0].completion_type)
                if candidates:
                    return candidates, m.group(2)

        # {funcPrefix -- external function name after opening brace
        m = re.search(r'\{(\w*)$', text_before)
        if m:
            names = [f'{n}("' for n in INK_EXTERNALS]
            return names, m.group(1)

        # # action:setFlag:<key>:<value>
        m = re.search(r'#\s*action:setFlag:[^:\s]+:([^:\s]*)$', text_before)
        if m:
            return ["true", "false", "1", "0"], m.group(1)

        # # action:<type>:<param>
        m = re.search(r'#\s*action:(\w+):([^:\s]*)$', text_before)
        if m:
            return self._get_action_param_candidates(m.group(1)), m.group(2)

        # # action:<type>
        m = re.search(r'#\s*action:([^:\s]*)$', text_before)
        if m:
            return list(ACTION_TYPES), m.group(1)

        # # require:<flag>
        m = re.search(r'#\s*require:([^:\s]*)$', text_before)
        if m:
            return self._flag_keys(), m.group(1)

        # # speaker:<name>
        m = re.search(r'#\s*speaker:([^:\s]*)$', text_before)
        if m:
            return self._npc_names(), m.group(1)

        # # ruleHint:<rule>
        m = re.search(r'#\s*ruleHint:([^:\s]*)$', text_before)
        if m:
            return [r[0] for r in self._model.all_rule_ids()], m.group(1)

        # # cost:<type>
        m = re.search(r'#\s*cost:([^:\s]*)$', text_before)
        if m:
            return ["currency"], m.group(1)

        # # <tag_prefix> -- least specific tag pattern
        m = re.search(r'#\s*([^:\s]*)$', text_before)
        if m:
            return _TAG_PREFIXES, m.group(1)

        # EXTERNAL <func> -- external function declaration
        m = re.search(r'^\s*EXTERNAL\s+(\S*)$', text_before)
        if m:
            return all_external_signatures(), m.group(1)

        # Line-start Ink keyword (EXTERNAL, INCLUDE, ...)
        m = re.search(r'^\s*([A-Z]*)$', text_before)
        if m and m.group(1):
            return list(_INK_KEYWORDS), m.group(1)

        return [], ""

    def _get_action_param_candidates(self, act_type: str) -> list[str]:
        if act_type == "setFlag":
            return self._flag_keys()
        src = _ACTION_ID_SOURCES.get(act_type)
        if not src:
            return []
        tuple_getter = {
            "rule": self._model.all_rule_ids,
            "fragment": self._model.all_fragment_ids,
            "quest": self._model.all_quest_ids,
            "encounter": self._model.all_encounter_ids,
            "cutscene": self._model.all_cutscene_ids,
            "shop": self._model.all_shop_ids,
            "item": self._model.all_item_ids,
        }.get(src)
        if tuple_getter:
            return [item[0] for item in tuple_getter()]
        str_getter = {
            "scene": self._model.all_scene_ids,
            "bgm": lambda: self._model.all_audio_ids("bgm"),
            "sfx": lambda: self._model.all_audio_ids("sfx"),
        }.get(src)
        if callable(str_getter):
            return str_getter()
        return []

    def _candidates_for_param_type(self, completion_type: str) -> list[str]:
        """Map a param completion_type to actual candidate values."""
        if completion_type == "flag_key":
            return self._flag_keys()
        if completion_type == "item_id":
            return [item[0] for item in self._model.all_item_ids()]
        if completion_type == "scene_id":
            return self._model.all_scene_ids()
        return []

    def _flag_keys(self) -> list[str]:
        return self._model.registry_flag_choices()

    def _npc_names(self) -> list[str]:
        names: set[str] = set()
        for sc in self._model.scenes.values():
            for npc in sc.get("npcs", []):
                n = npc.get("name") or npc.get("id")
                if n:
                    names.add(str(n))
        return sorted(names)

    def _insert_completion(self, text: str) -> None:
        cursor = self.textCursor()
        block_text = cursor.block().text()
        col = cursor.positionInBlock()
        text_before = block_text[:col]

        _, prefix = self._get_completion_context(text_before)
        for _ in range(len(prefix)):
            cursor.deletePreviousChar()
        cursor.insertText(text)
        self.setTextCursor(cursor)
        QTimer.singleShot(0, self._update_completions)


# ---------------------------------------------------------------------------
# Main DialogueBrowser widget
# ---------------------------------------------------------------------------

class DialogueBrowser(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_path: Path | None = None
        self._current_filename: str = ""
        self._dirty = False
        self._loading = False

        root = QHBoxLayout(self)
        root.setContentsMargins(2, 2, 2, 2)
        main_splitter = QSplitter(Qt.Orientation.Horizontal)

        # ---- Left panel ----
        left = QWidget()
        left.setMinimumWidth(200)
        left.setMaximumWidth(320)
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.setSpacing(4)

        ll.addWidget(QLabel("<b>Ink Files</b>"))
        self._file_list = QListWidget()
        self._file_list.currentRowChanged.connect(self._on_file_row_changed)
        ll.addWidget(self._file_list, stretch=2)

        ll.addWidget(QLabel("<b>Knots</b>"))
        self._knot_list = QListWidget()
        self._knot_list.currentItemChanged.connect(self._on_knot_clicked)
        ll.addWidget(self._knot_list, stretch=1)

        self._tag_tree = QTreeWidget()
        self._tag_tree.setHeaderLabels(["Tags Summary"])
        self._tag_tree.setMaximumHeight(180)
        self._tag_tree.itemDoubleClicked.connect(self._on_tag_double_clicked)
        ll.addWidget(self._tag_tree, stretch=1)

        self._ref_list = QListWidget()
        self._ref_list.setMaximumHeight(100)
        ll.addWidget(QLabel("<b>References</b>"))
        ll.addWidget(self._ref_list)

        btn_row = QHBoxLayout()
        self._btn_save = QPushButton("Save")
        self._btn_save.clicked.connect(self._save_file)
        self._btn_save.setEnabled(False)
        btn_row.addWidget(self._btn_save)
        btn_open = QPushButton("VS Code")
        btn_open.clicked.connect(self._open_vscode)
        btn_row.addWidget(btn_open)
        ll.addLayout(btn_row)

        main_splitter.addWidget(left)

        # ---- Right panel (center + bottom) ----
        right_splitter = QSplitter(Qt.Orientation.Vertical)

        # Center tabs: Editor / Flow View
        self._center_tabs = QTabWidget()
        self._editor = InkTextEdit(model)
        self._editor.textChanged.connect(self._on_text_changed)
        self._highlighter: InkHighlighter | None = None
        self._center_tabs.addTab(self._editor, "Editor")

        self._flow_scene = InkFlowScene()
        self._flow_scene.knot_clicked.connect(self._on_flow_knot_clicked)
        self._flow_view = InkFlowView(self._flow_scene)
        self._center_tabs.addTab(self._flow_view, "Flow View")
        self._center_tabs.currentChanged.connect(self._on_center_tab_changed)
        right_splitter.addWidget(self._center_tabs)

        # Bottom tabs: Simulator / Validation
        self._bottom_tabs = QTabWidget()
        self._simulator = InkSimulatorWidget()
        self._simulator.line_highlighted.connect(self._scroll_to_line)
        self._bottom_tabs.addTab(self._simulator, "Simulator")

        self._issues_list = QListWidget()
        self._issues_list.itemDoubleClicked.connect(self._on_issue_double_clicked)
        self._bottom_tabs.addTab(self._issues_list, "Validation")
        right_splitter.addWidget(self._bottom_tabs)

        right_splitter.setSizes([500, 200])
        main_splitter.addWidget(right_splitter)
        main_splitter.setSizes([220, 700])
        root.addWidget(main_splitter)

        save_sc = QShortcut(QKeySequence("Ctrl+S"), self)
        save_sc.activated.connect(self._save_file)

        self._validation_timer = QTimer(self)
        self._validation_timer.setSingleShot(True)
        self._validation_timer.setInterval(800)
        self._validation_timer.timeout.connect(self._run_validation)

        self._refresh()

    # ---- File list --------------------------------------------------------

    def _refresh(self) -> None:
        self._file_list.blockSignals(True)
        self._file_list.clear()
        for name in self._model.all_ink_files():
            item = QListWidgetItem(name)
            item.setData(Qt.ItemDataRole.UserRole, name)
            self._file_list.addItem(item)
        self._file_list.blockSignals(False)

    def _on_file_row_changed(self, row: int) -> None:
        if row < 0:
            return
        item = self._file_list.item(row)
        if item is None:
            return
        name = item.data(Qt.ItemDataRole.UserRole)
        if not name or name == self._current_filename:
            return
        self._load_ink_file(name)

    def _load_ink_file(self, name: str) -> None:
        if self._dirty and self._current_path:
            self._do_save()

        path = self._model.dialogues_path / name
        if not path.exists():
            return

        self._loading = True
        self._current_path = path
        self._current_filename = name
        self._dirty = False
        self._btn_save.setEnabled(False)

        text = read_text(path)

        if self._highlighter is not None:
            self._highlighter.setDocument(None)
            self._highlighter = None

        self._editor.setPlainText(text)
        self._highlighter = InkHighlighter(self._editor.document())

        self._update_knots(text)
        self._update_tags(text)
        self._update_references(name)
        self._update_flow(text)
        self._simulator.load_ink(text)

        self._loading = False
        self._run_validation()

    # ---- Dirty tracking ---------------------------------------------------

    def _on_text_changed(self) -> None:
        if self._loading:
            return
        if not self._dirty:
            self._dirty = True
            self._btn_save.setEnabled(True)
            self._update_file_list_dirty(True)

        self._validation_timer.start()

        text = self._editor.toPlainText()
        self._update_knots(text)

    def _update_file_list_dirty(self, dirty: bool) -> None:
        self._file_list.blockSignals(True)
        for i in range(self._file_list.count()):
            item = self._file_list.item(i)
            if item is None:
                continue
            stored = item.data(Qt.ItemDataRole.UserRole)
            if stored == self._current_filename:
                if dirty:
                    if not item.text().endswith(" *"):
                        item.setText(stored + " *")
                else:
                    item.setText(stored)
                break
        self._file_list.blockSignals(False)

    def _save_file(self) -> None:
        if not self._current_path or not self._dirty:
            return
        self._do_save()
        text = self._editor.toPlainText()
        self._update_tags(text)
        self._update_flow(text)
        self._simulator.load_ink(text)
        self._run_validation()

    def _do_save(self) -> None:
        if not self._current_path or not self._dirty:
            return
        text = self._editor.toPlainText()
        try:
            write_text(self._current_path, text)
        except OSError as e:
            QMessageBox.critical(self, "Save failed", str(e))
            return
        self._dirty = False
        self._btn_save.setEnabled(False)
        self._update_file_list_dirty(False)

    # ---- Knot list --------------------------------------------------------

    def _update_knots(self, text: str) -> None:
        knots = parse_knots(text)
        self._knot_list.clear()
        names: list[str] = []
        for k in knots:
            item = QListWidgetItem(k.name)
            item.setData(Qt.ItemDataRole.UserRole, k.start_line)
            self._knot_list.addItem(item)
            names.append(k.name)
        self._editor.set_knot_names(names)

    def _on_knot_clicked(self, current: QListWidgetItem | None, _prev) -> None:
        if current is None:
            return
        line = current.data(Qt.ItemDataRole.UserRole)
        if isinstance(line, int):
            self._scroll_to_line(line)

    # ---- Tag summary ------------------------------------------------------

    def _update_tags(self, text: str) -> None:
        self._tag_tree.clear()
        tags = parse_tags(text)

        groups: dict[str, list[InkTag]] = {}
        for t in tags:
            groups.setdefault(t.tag_type, []).append(t)

        type_labels = {
            "action": "Actions",
            "require": "Requires",
            "speaker": "Speakers",
            "ruleHint": "Rule Hints",
            "cost": "Costs",
            "other": "Other",
        }
        for ttype in ("action", "require", "speaker", "ruleHint", "cost", "other"):
            items = groups.get(ttype, [])
            if not items:
                continue
            label = type_labels.get(ttype, ttype)
            root = QTreeWidgetItem(self._tag_tree, [f"{label} ({len(items)})"])
            for t in items:
                child = QTreeWidgetItem(root, [t.raw])
                child.setData(0, Qt.ItemDataRole.UserRole, t.line_number)

        self._tag_tree.expandAll()

    def _on_tag_double_clicked(self, item: QTreeWidgetItem, _col: int) -> None:
        line = item.data(0, Qt.ItemDataRole.UserRole)
        if isinstance(line, int):
            self._scroll_to_line(line)

    # ---- Reverse references -----------------------------------------------

    def _update_references(self, ink_filename: str) -> None:
        self._ref_list.clear()
        refs = extract_npc_references(self._model, ink_filename)
        if not refs:
            self._ref_list.addItem("(no references)")
            return
        for scene_id, npc_id, knot in refs:
            knot_info = f" (knot: {knot})" if knot else ""
            self._ref_list.addItem(f"{scene_id} > {npc_id}{knot_info}")

    # ---- Flow view --------------------------------------------------------

    def _update_flow(self, text: str) -> None:
        self._flow_scene.populate(text)
        if self._flow_scene.items():
            self._flow_view.fitInView(
                self._flow_scene.sceneRect().adjusted(-40, -40, 40, 40),
                Qt.AspectRatioMode.KeepAspectRatio,
            )

    def _on_center_tab_changed(self, idx: int) -> None:
        if idx == 1:
            text = self._editor.toPlainText()
            self._update_flow(text)

    def _on_flow_knot_clicked(self, knot_name: str, line: int) -> None:
        self._center_tabs.setCurrentIndex(0)
        self._scroll_to_line(line)

    # ---- Validation -------------------------------------------------------

    def _run_validation(self) -> None:
        text = self._editor.toPlainText()
        issues = validate_ink(text, self._model)

        self._issues_list.clear()
        error_lines: set[int] = set()
        warning_lines: set[int] = set()

        for iss in issues:
            prefix = "ERR" if iss.severity == "error" else "WARN"
            item = QListWidgetItem(
                f"[{prefix}] L{iss.line_number + 1}: {iss.message}",
            )
            item.setData(Qt.ItemDataRole.UserRole, iss.line_number)
            if iss.severity == "error":
                item.setForeground(QColor(255, 100, 100))
                error_lines.add(iss.line_number)
            else:
                item.setForeground(QColor(220, 180, 60))
                warning_lines.add(iss.line_number)
            self._issues_list.addItem(item)

        count = len(issues)
        tab_label = f"Validation ({count})" if count else "Validation"
        self._bottom_tabs.setTabText(1, tab_label)

        if self._highlighter:
            was_loading = self._loading
            self._loading = True
            self._highlighter.set_issues(error_lines, warning_lines)
            self._loading = was_loading

    def _on_issue_double_clicked(self, item: QListWidgetItem) -> None:
        line = item.data(Qt.ItemDataRole.UserRole)
        if isinstance(line, int):
            self._scroll_to_line(line)

    # ---- Navigation helpers -----------------------------------------------

    def _scroll_to_line(self, line: int) -> None:
        block = self._editor.document().findBlockByNumber(line)
        if not block.isValid():
            return
        cursor = QTextCursor(block)
        self._editor.setTextCursor(cursor)
        self._editor.centerCursor()

    def _open_vscode(self) -> None:
        if self._current_path and self._current_path.exists():
            try:
                subprocess.Popen(["code", str(self._current_path)])
            except FileNotFoundError:
                pass
