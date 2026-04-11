"""Full-featured Ink dialogue editor with autocomplete, validation,
flow visualization, tag summary, reverse references, and simulation."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QListWidgetItem, QPlainTextEdit, QPushButton, QLabel, QTabWidget,
    QTreeWidget, QTreeWidgetItem, QCompleter, QMessageBox, QInputDialog,
)
from PySide6.QtGui import (
    QFont, QColor, QTextCharFormat, QSyntaxHighlighter, QTextDocument,
    QTextCursor, QShortcut, QKeySequence, QAction, QKeyEvent,
)
from PySide6.QtCore import Qt, QRegularExpression, QStringListModel, QTimer, QEvent, QObject

from ..project_model import ProjectModel
from ..file_io import read_text, write_text
from .. import theme as app_theme
from ..shared.ink_find_replace import InkFindReplaceBar
from ..shared.action_editor import (
    ACTION_TYPES, _NOTIFICATION_TYPES, _ARCHIVE_BOOK_TYPES,
)
from .ink_parser import (
    parse_knots, parse_tags, validate_ink,
    extract_npc_references, InkTag,
    INK_EXTERNALS, all_external_signatures,
)
from .ink_flow_scene import InkFlowScene, InkFlowView
from .ink_simulator import InkSimulatorWidget

# ---------------------------------------------------------------------------
# Autocomplete data tables
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
    "pickup": "item",
    "shopPurchase": "item",
    "inventoryDiscard": "item",
}

_TAG_PREFIXES = [
    "action:", "require:", "speaker:", "ruleHint:", "cost:",
]

_INK_KEYWORDS = ["EXTERNAL ", "INCLUDE "]

_EMOTE_NAMES = [
    "happy", "sad", "angry", "surprised", "confused",
    "scared", "neutral", "thinking",
]


# ---------------------------------------------------------------------------
# Enhanced Ink syntax highlighter with inline validation marks
# ---------------------------------------------------------------------------

class InkHighlighter(QSyntaxHighlighter):
    def __init__(self, parent: QTextDocument):
        super().__init__(parent)
        self._rules: list[tuple[QRegularExpression, QTextCharFormat]] = []
        self._error_lines: set[int] = set()
        self._warning_lines: set[int] = set()
        self._theme_id = app_theme.current_theme_id()
        self._rebuild_rules()

    def _rebuild_rules(self) -> None:
        c = app_theme.ink_syntax_base_colors(self._theme_id)
        self._rules = []

        fmt_knot = QTextCharFormat()
        fmt_knot.setForeground(c["knot"])
        fmt_knot.setFontWeight(QFont.Weight.Bold)
        self._rules.append((QRegularExpression(r"^===.*===$"), fmt_knot))

        fmt_tag = QTextCharFormat()
        fmt_tag.setForeground(c["tag"])
        self._rules.append((QRegularExpression(r"#\s*[a-zA-Z_]\w*(?::[^\s#]*)*"), fmt_tag))

        fmt_choice = QTextCharFormat()
        fmt_choice.setForeground(c["choice"])
        self._rules.append((QRegularExpression(r"^\s*[\+\*].*$"), fmt_choice))

        fmt_ext = QTextCharFormat()
        fmt_ext.setForeground(c["ext"])
        self._rules.append((QRegularExpression(r"^EXTERNAL\s+.*$"), fmt_ext))

        fmt_divert = QTextCharFormat()
        fmt_divert.setForeground(c["divert"])
        self._rules.append((QRegularExpression(r"->\s*\S+"), fmt_divert))

        fmt_cond = QTextCharFormat()
        fmt_cond.setForeground(c["cond"])
        self._rules.append((QRegularExpression(r"^\{.*$"), fmt_cond))
        self._rules.append((QRegularExpression(r"^\s*-\s*else\s*:"), fmt_cond))
        self._rules.append((QRegularExpression(r"^\}\s*$"), fmt_cond))

    def apply_theme(self, theme_id: str) -> None:
        self._theme_id = theme_id
        self._rebuild_rules()
        self.rehighlight()

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
        uc = app_theme.ink_syntax_base_colors(self._theme_id)
        if block_num in self._error_lines:
            fmt_err = QTextCharFormat()
            fmt_err.setUnderlineColor(uc["err_line"])
            fmt_err.setUnderlineStyle(
                QTextCharFormat.UnderlineStyle.WaveUnderline,
            )
            self.setFormat(0, len(text), fmt_err)
        elif block_num in self._warning_lines:
            fmt_warn = QTextCharFormat()
            fmt_warn.setUnderlineColor(uc["warn_line"])
            fmt_warn.setUnderlineStyle(
                QTextCharFormat.UnderlineStyle.WaveUnderline,
            )
            self.setFormat(0, len(text), fmt_warn)


# ---------------------------------------------------------------------------
# Ink text editor with context-aware autocomplete
# ---------------------------------------------------------------------------

class _CompletionRule:
    """A single context-aware autocomplete rule.

    Attributes:
        pattern:       Compiled regex matched against the text before cursor.
        candidates_fn: ``(match, editor) -> list[str]``  returns candidates.
        prefix_group:  Which regex group holds the already-typed prefix.
    """
    __slots__ = ("pattern", "candidates_fn", "prefix_group")

    def __init__(
        self,
        pattern: str,
        candidates_fn,
        prefix_group: int = 1,
    ):
        self.pattern = re.compile(pattern, re.IGNORECASE)
        self.candidates_fn = candidates_fn
        self.prefix_group = prefix_group


def _build_completion_rules() -> list[_CompletionRule]:
    """Return the ordered rule list (most-specific first)."""
    R = _CompletionRule

    # --- helpers referenced by lambdas (closures capture *editor* at call) --

    def _divert(m, e):
        return e._knot_names + ["END"]

    def _ext_arg(m, e):
        ext_def = INK_EXTERNALS.get(m.group(1))
        if ext_def and ext_def.params:
            return e._candidates_for_param_type(ext_def.params[0].completion_type)
        return []

    def _ext_func(m, e):
        return [f'{n}("' for n in INK_EXTERNALS]

    def _cond_else(m, e):
        return ["else:"]

    def _setflag_val(m, e):
        return ['"', "'", "true", "false", "1", "0"]

    def _action_archive_book(m, e):
        return list(_ARCHIVE_BOOK_TYPES)

    def _action_notif_type(m, e):
        return list(_NOTIFICATION_TYPES)

    def _action_emote_target(m, e):
        return e._npc_names()

    def _action_emote_name(m, e):
        return list(_EMOTE_NAMES)

    def _action_scene_spawn(m, e):
        scene_id = m.group(1)
        return e._model.spawn_point_keys_for_scene(scene_id)

    def _action_param(m, e):
        return e._get_action_param_candidates(m.group(1))

    def _action_type(m, e):
        return list(ACTION_TYPES)

    def _require(m, e):
        return e._flag_keys()

    def _speaker(m, e):
        return e._npc_names()

    def _rule_hint(m, e):
        return [r[0] for r in e._model.all_rule_ids()]

    def _cost(m, e):
        return ["currency"]

    def _tag_prefix(m, e):
        return list(_TAG_PREFIXES)

    def _ext_decl(m, e):
        return all_external_signatures()

    def _ink_kw(m, e):
        return list(_INK_KEYWORDS)

    return [
        # ---- Divert -------------------------------------------------------
        R(r'->\s*(\S*)$',                                  _divert),

        # ---- Conditional block { func("arg"): ... } ----------------------
        R(r'\{\s*(\w+)\(\s*"([^"]*)$',                     _ext_arg,    2),
        R(r'\{\s*(\w*)$',                                  _ext_func),

        # ---- Conditional else inside block --------------------------------
        R(r'^\s*-\s*(\w*)$',                               _cond_else),

        # ---- Tag: action (most-specific first) ----------------------------
        # setFlag / appendFlag 第二参数（含引号、冒号）
        R(r'#\s*action:setFlag:[^:\s#]+:(.*)$', _setflag_val),
        R(r'#\s*action:appendFlag:[^:\s#]+:(.*)$', _setflag_val),
        # addArchiveEntry:bookType (no data source for entryId, skip second level)
        R(r'#\s*action:addArchiveEntry:([^:\s]*)$',        _action_archive_book),
        # showNotification:text:type
        R(r'#\s*action:showNotification:[^:\s]+:([^:\s]*)$', _action_notif_type),
        # showEmote:target:emote
        R(r'#\s*action:showEmote:[^:\s]+:([^:\s]*)$',      _action_emote_name),
        R(r'#\s*action:showEmote:([^:\s]*)$',              _action_emote_target),
        R(r'#\s*action:setEntityEnabled:[^:\s#]+:([^:\s]*)$',
          lambda _m, _e: ["true", "false"],                1),
        # switchScene/changeScene:sceneId:spawnPoint
        R(r'#\s*action:(?:switchScene|changeScene):([^:\s]+):([^:\s]*)$',
                                                            _action_scene_spawn, 2),
        # generic action first param
        R(r'#\s*action:(\w+):([^:\s]*)$',                  _action_param, 2),
        # action type
        R(r'#\s*action:([^:\s]*)$',                        _action_type),

        # ---- Tag: other types ---------------------------------------------
        R(r'#\s*require:([^:\s]*)$',                       _require),
        R(r'#\s*speaker:([^:\s]*)$',                       _speaker),
        R(r'#\s*ruleHint:([^:\s]*)$',                      _rule_hint),
        R(r'#\s*cost:([^:\s]*)$',                          _cost),
        R(r'#\s*([^:\s]*)$',                               _tag_prefix),

        # ---- Line-start keywords ------------------------------------------
        R(r'^\s*EXTERNAL\s+(\S*)$',                        _ext_decl),
        R(r'^\s*([A-Z]+)$',                                _ink_kw),
    ]


_COMPLETION_RULES = _build_completion_rules()


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
        self._completion_popup_filter_installed = False
        self._esc_shortcut_editor: QShortcut | None = None
        self._esc_shortcut_popup: QShortcut | None = None

        self._knot_names: list[str] = []

        ctx_menu_action = QAction("Insert Action Tag", self)
        ctx_menu_action.triggered.connect(lambda: self._insert_tag_template("action"))
        self._ctx_insert_action = ctx_menu_action

    def set_knot_names(self, names: list[str]) -> None:
        self._knot_names = list(names)

    # ---- Context menu helpers ---------------------------------------------

    def contextMenuEvent(self, event) -> None:
        menu = self.createStandardContextMenu()
        menu.addSeparator()

        insert_menu = menu.addMenu("Insert Tag")
        for prefix in _TAG_PREFIXES:
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

    # ---- Autocomplete core ------------------------------------------------

    def _set_completion_esc_shortcuts_enabled(self, on: bool) -> None:
        if self._esc_shortcut_editor is not None:
            self._esc_shortcut_editor.setEnabled(on)
        if self._esc_shortcut_popup is not None:
            self._esc_shortcut_popup.setEnabled(on)

    def _ensure_esc_shortcuts(self) -> None:
        """补全弹层常为独立 Popup窗口，Esc 进不了 QPlainTextEdit；用 Shortcut 绑在编辑区 + 弹层上。"""
        if self._esc_shortcut_editor is None:
            s = QShortcut(QKeySequence(Qt.Key.Key_Escape), self)
            s.setContext(Qt.ShortcutContext.WidgetShortcut)
            s.activated.connect(self._hide_completion_popup)
            s.setEnabled(False)
            self._esc_shortcut_editor = s
        popup = self._completer.popup()
        if popup is not None and self._esc_shortcut_popup is None:
            s = QShortcut(QKeySequence(Qt.Key.Key_Escape), popup)
            s.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            s.activated.connect(self._hide_completion_popup)
            s.setEnabled(False)
            self._esc_shortcut_popup = s

    def _hide_completion_popup(self) -> None:
        self._set_completion_esc_shortcuts_enabled(False)
        p = self._completer.popup()
        if p is not None:
            p.hide()
        self.setFocus()

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        # __init__ 里 setFont 等会早于 _completer 赋值触发本过滤；不得访问未创建的 _completer
        completer = getattr(self, "_completer", None)
        if completer is None:
            return super().eventFilter(watched, event)
        popup = completer.popup()
        if popup is None:
            return super().eventFilter(watched, event)
        vp = popup.viewport()
        targets = (popup, vp) if vp is not None else (popup,)
        if (
            watched in targets
            and event.type() == QEvent.Type.KeyPress
            and isinstance(event, QKeyEvent)
            and event.key() == Qt.Key.Key_Escape
        ):
            self._hide_completion_popup()
            event.accept()
            return True
        # QListView 补全弹层无 aboutToHide；点外部关闭时收 Hide，关掉 Esc 快捷方式
        if watched == popup and event.type() == QEvent.Type.Hide:
            self._set_completion_esc_shortcuts_enabled(False)
        return super().eventFilter(watched, event)

    def keyPressEvent(self, event) -> None:
        if self._completer.popup().isVisible():
            if event.key() == Qt.Key.Key_Escape:
                self._hide_completion_popup()
                event.accept()
                return
            if event.key() in (
                Qt.Key.Key_Enter,
                Qt.Key.Key_Return,
                Qt.Key.Key_Tab,
                Qt.Key.Key_Backtab,
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
            self._set_completion_esc_shortcuts_enabled(False)
            return

        popup = self._completer.popup()
        if popup is not None and not self._completion_popup_filter_installed:
            popup.installEventFilter(self)
            vp = popup.viewport()
            if vp is not None:
                vp.installEventFilter(self)
            self._completion_popup_filter_installed = True

        self._completer_model.setStringList(candidates)
        self._completer.setCompletionPrefix(prefix)

        if self._completer.completionCount() == 0:
            self._completer.popup().hide()
            self._set_completion_esc_shortcuts_enabled(False)
            return

        cr = self.cursorRect()
        cr.setWidth(
            min(300, self._completer.popup().sizeHintForColumn(0) + 40),
        )
        self._completer.complete(cr)
        self._ensure_esc_shortcuts()
        self._set_completion_esc_shortcuts_enabled(True)

    def _get_completion_context(self, text_before: str) -> tuple[list[str], str]:
        """Walk the rule table and return (candidates, prefix) for the first
        matching rule, or ([], '') if nothing matches."""
        for rule in _COMPLETION_RULES:
            m = rule.pattern.search(text_before)
            if m:
                candidates = rule.candidates_fn(m, self)
                if candidates:
                    return candidates, m.group(rule.prefix_group)
        return [], ""

    # ---- Candidate data helpers -------------------------------------------

    def _get_action_param_candidates(self, act_type: str) -> list[str]:
        if act_type == "setFlag":
            return self._flag_keys()
        if act_type == "setEntityEnabled":
            ids = sorted({item[0] for item in self._model.all_npc_ids_global()} | {"player"})
            return list(ids)
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
        if completion_type == "flag_key":
            return self._flag_keys()
        if completion_type == "item_id":
            return [item[0] for item in self._model.all_item_ids()]
        if completion_type == "scene_id":
            return self._model.all_scene_ids()
        if completion_type == "actor_id":
            ids = [t[0] for t in self._model.all_npc_ids_global()]
            return sorted(set(ids) | {"@", "#"})
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

    # ---- Insert completion ------------------------------------------------

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

        file_header = QHBoxLayout()
        file_header.addWidget(QLabel("<b>Ink Files</b>"), stretch=1)
        btn_new = QPushButton("+")
        btn_new.setFixedWidth(28)
        btn_new.setToolTip("New ink file")
        btn_new.clicked.connect(self._new_ink_file)
        file_header.addWidget(btn_new)
        btn_del = QPushButton("\u2212")
        btn_del.setFixedWidth(28)
        btn_del.setToolTip("Delete ink file")
        btn_del.clicked.connect(self._delete_ink_file)
        file_header.addWidget(btn_del)
        ll.addLayout(file_header)
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

        compile_row = QHBoxLayout()
        self._btn_compile_sel = QPushButton("编译当前 Ink")
        self._btn_compile_sel.setToolTip(
            "运行 scripts/compile-ink.cjs，仅编译列表当前选中的 .ink",
        )
        self._btn_compile_sel.clicked.connect(self._compile_selected_ink)
        compile_row.addWidget(self._btn_compile_sel)
        self._btn_compile_all = QPushButton("编译全部 Ink")
        self._btn_compile_all.setToolTip(
            "运行 scripts/compile-ink.cjs，编译 public/assets/dialogues 下全部 .ink",
        )
        self._btn_compile_all.clicked.connect(self._compile_all_ink)
        compile_row.addWidget(self._btn_compile_all)
        ll.addLayout(compile_row)

        main_splitter.addWidget(left)

        # ---- Right panel (center + bottom) ----
        right_splitter = QSplitter(Qt.Orientation.Vertical)

        # Center tabs: Editor / Flow View
        self._center_tabs = QTabWidget()
        self._editor = InkTextEdit(model)
        self._editor.textChanged.connect(self._on_text_changed)
        self._highlighter: InkHighlighter | None = None

        editor_tab = QWidget()
        editor_tab_lo = QVBoxLayout(editor_tab)
        editor_tab_lo.setContentsMargins(0, 0, 0, 0)
        editor_tab_lo.setSpacing(0)
        self._find_bar = InkFindReplaceBar(self._editor)
        self._find_bar.hide()
        editor_tab_lo.addWidget(self._find_bar)
        editor_tab_lo.addWidget(self._editor, stretch=1)
        self._center_tabs.addTab(editor_tab, "Editor")

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

        sc_find = QShortcut(QKeySequence(QKeySequence.StandardKey.Find), self)
        sc_find.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        sc_find.activated.connect(lambda: self._show_find_bar(replace_focus=False))
        sc_rep = QShortcut(QKeySequence("Ctrl+H"), self)
        sc_rep.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        sc_rep.activated.connect(lambda: self._show_find_bar(replace_focus=True))
        sc_next = QShortcut(QKeySequence(QKeySequence.StandardKey.FindNext), self)
        sc_next.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        sc_next.activated.connect(self._shortcut_find_next)
        sc_prev = QShortcut(QKeySequence("Shift+F3"), self)
        sc_prev.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        sc_prev.activated.connect(self._shortcut_find_prev)
        sc_esc = QShortcut(QKeySequence(Qt.Key.Key_Escape), self)
        sc_esc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        sc_esc.activated.connect(self._hide_find_bar_if_visible)

        self._validation_timer = QTimer(self)
        self._validation_timer.setSingleShot(True)
        self._validation_timer.setInterval(800)
        self._validation_timer.timeout.connect(self._run_validation)

        self._refresh()

    # ---- File list --------------------------------------------------------

    def _new_ink_file(self) -> None:
        name, ok = QInputDialog.getText(
            self, "New Ink File", "File name (without .ink):",
        )
        if not ok or not name.strip():
            return
        name = name.strip()
        if not name.endswith(".ink"):
            name += ".ink"
        target = self._model.dialogues_path / name
        if target.exists():
            QMessageBox.warning(self, "New Ink File", f"{name} already exists.")
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        write_text(
            target,
            "EXTERNAL getFlag(key)\nEXTERNAL getCoins()\n\n=== start ===\n-> END\n",
        )
        self._refresh()
        for i in range(self._file_list.count()):
            item = self._file_list.item(i)
            if item and item.data(Qt.ItemDataRole.UserRole) == name:
                self._file_list.setCurrentRow(i)
                break

    def _delete_ink_file(self) -> None:
        item = self._file_list.currentItem()
        if item is None:
            return
        name = item.data(Qt.ItemDataRole.UserRole)
        if not name:
            return
        r = QMessageBox.question(
            self, "Delete Ink File",
            f"Are you sure you want to delete '{name}'?\nThis cannot be undone.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        target = self._model.dialogues_path / name
        if target.exists():
            target.unlink()
        json_target = self._model.dialogues_path / (name + ".json")
        if json_target.exists():
            json_target.unlink()
        if name == self._current_filename:
            self._current_path = None
            self._current_filename = ""
            self._dirty = False
            self._btn_save.setEnabled(False)
            self._editor.clear()
            self._knot_list.clear()
            self._tag_tree.clear()
            self._ref_list.clear()
        self._refresh()

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

    def _selected_ink_basename(self) -> str | None:
        item = self._file_list.currentItem()
        if item is None:
            return None
        name = item.data(Qt.ItemDataRole.UserRole)
        return str(name) if name else None

    def _run_ink_compile(self, ink_basenames: list[str] | None) -> None:
        root = self._model.project_path
        if root is None:
            QMessageBox.warning(self, "编译 Ink", "未加载项目。")
            return
        script = root / "scripts" / "compile-ink.cjs"
        if not script.is_file():
            QMessageBox.critical(
                self, "编译 Ink", f"找不到编译脚本：\n{script}",
            )
            return
        cmd = ["node", str(script)]
        if ink_basenames:
            cmd.extend(ink_basenames)
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(root),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError:
            QMessageBox.critical(
                self, "编译 Ink",
                "未找到 node 命令，请安装 Node.js 并加入 PATH。",
            )
            return
        except OSError as e:
            QMessageBox.critical(self, "编译 Ink", str(e))
            return
        detail = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if proc.returncode != 0:
            mb = QMessageBox(self)
            mb.setIcon(QMessageBox.Icon.Critical)
            mb.setWindowTitle("Ink 编译失败")
            mb.setText("编译过程报错，详情见下方。")
            mb.setDetailedText(detail or "(无输出)")
            mb.exec()
            return
        mb = QMessageBox(self)
        mb.setIcon(QMessageBox.Icon.Information)
        mb.setWindowTitle("Ink 编译")
        mb.setText("Ink 编译成功。")
        if detail:
            mb.setDetailedText(detail)
        mb.exec()

    def _compile_selected_ink(self) -> None:
        name = self._selected_ink_basename()
        if not name:
            QMessageBox.information(self, "编译 Ink", "请先在列表中选中一个 .ink 文件。")
            return
        if self._dirty:
            self._save_file()
        self._run_ink_compile([name])

    def _compile_all_ink(self) -> None:
        if self._dirty:
            r = QMessageBox.question(
                self, "编译全部 Ink",
                "当前文件有未保存修改。是否先保存再编译全部？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Save,
            )
            if r == QMessageBox.StandardButton.Cancel:
                return
            if r == QMessageBox.StandardButton.Save:
                self._save_file()
        self._run_ink_compile(None)

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

    # ---- Find / replace ---------------------------------------------------

    def _show_find_bar(self, replace_focus: bool = False) -> None:
        self._center_tabs.setCurrentIndex(0)
        self._find_bar.show()
        if replace_focus:
            self._find_bar.focus_replace()
        else:
            self._find_bar.focus_find()

    def _hide_find_bar_if_visible(self) -> None:
        if self._find_bar.isVisible():
            self._find_bar.hide()
            self._editor.setFocus()

    def _shortcut_find_next(self) -> None:
        if self._find_bar.isVisible():
            self._find_bar.find_next()

    def _shortcut_find_prev(self) -> None:
        if self._find_bar.isVisible():
            self._find_bar.find_prev()

    def on_editor_theme_changed(self, theme_id: str) -> None:
        if self._highlighter:
            self._highlighter.apply_theme(theme_id)
        self._simulator.apply_theme(theme_id)
