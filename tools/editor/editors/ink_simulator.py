"""Ink dialogue simulator widget for in-editor preview."""
from __future__ import annotations

from typing import Any

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTextEdit, QScrollArea, QGroupBox, QFormLayout, QCheckBox,
    QFrame, QComboBox, QSizePolicy,
)
from PySide6.QtGui import QFont, QTextCharFormat, QTextCursor
from PySide6.QtCore import Qt, Signal

from .. import theme as app_theme

from .ink_parser import (
    SimNode, SimChoice, build_sim_tree, parse_knots,
    _extract_line_tags, RE_SPEAKER_TAG,
)


class InkSimulatorWidget(QWidget):
    """Interactive dialogue simulator that walks through Ink content."""
    line_highlighted = Signal(int)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._sim_tree: dict[str, list[SimNode]] = {}
        self._knot_names: list[str] = []
        self._flags: dict[str, Any] = {}
        self._current_knot: str = ""
        self._pending_nodes: list[SimNode] = []
        self._history: list[tuple[str, str]] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)
        root.setSpacing(4)

        top = QHBoxLayout()
        top.addWidget(QLabel("Start knot:"))
        self._knot_combo = QComboBox()
        self._knot_combo.setMinimumWidth(140)
        top.addWidget(self._knot_combo, stretch=1)
        self._btn_start = QPushButton("Start")
        self._btn_start.clicked.connect(self._on_start)
        top.addWidget(self._btn_start)
        self._btn_reset = QPushButton("Reset")
        self._btn_reset.clicked.connect(self._on_reset)
        top.addWidget(self._btn_reset)
        self._btn_flags = QPushButton("Flags...")
        self._btn_flags.clicked.connect(self._toggle_flags_panel)
        top.addWidget(self._btn_flags)
        root.addLayout(top)

        self._flags_panel = QFrame()
        self._flags_panel.setVisible(False)
        fp_layout = QVBoxLayout(self._flags_panel)
        fp_layout.setContentsMargins(4, 2, 4, 2)
        fp_label = QLabel("Manual flag overrides (comma-separated key=value):")
        fp_label.setWordWrap(True)
        fp_layout.addWidget(fp_label)
        self._flags_input = QTextEdit()
        self._flags_input.setMaximumHeight(50)
        self._flags_input.setFont(QFont("Consolas", 9))
        self._flags_input.setPlaceholderText(
            "e.g. has_talisman=1, waiter_met=true, coins=120",
        )
        fp_layout.addWidget(self._flags_input)
        root.addWidget(self._flags_panel)

        self._output = QTextEdit()
        self._output.setReadOnly(True)
        self._output.setFont(QFont("Microsoft YaHei", 10))
        root.addWidget(self._output, stretch=1)

        self._actions_label = QLabel("")
        self._actions_label.setWordWrap(True)
        self._theme_id = app_theme.current_theme_id()
        self._actions_label.setStyleSheet(
            app_theme.ink_actions_label_stylesheet(self._theme_id))
        root.addWidget(self._actions_label)

        self._choices_widget = QWidget()
        self._choices_layout = QVBoxLayout(self._choices_widget)
        self._choices_layout.setContentsMargins(0, 0, 0, 0)
        self._choices_layout.setSpacing(2)
        root.addWidget(self._choices_widget)

    def apply_theme(self, theme_id: str) -> None:
        self._theme_id = theme_id
        self._actions_label.setStyleSheet(
            app_theme.ink_actions_label_stylesheet(theme_id))

    def load_ink(self, text: str) -> None:
        self._sim_tree = build_sim_tree(text)
        self._knot_names = [k.name for k in parse_knots(text)]
        self._knot_combo.clear()
        for name in self._knot_names:
            self._knot_combo.addItem(name)
        self._on_reset()

    def _sim_external_value(self, name: str) -> float:
        if name.lower() == "getcoins":
            v = self._flags.get("coins", 0)
            return float(v) if isinstance(v, (int, float)) else 0.0
        return 0.0

    @staticmethod
    def _cmp(lhs: float, op: str | None, rhs: float | None) -> bool:
        if op is None or rhs is None:
            return bool(lhs and lhs != 0)
        if op == ">":
            return lhs > rhs
        if op == ">=":
            return lhs >= rhs
        if op == "<":
            return lhs < rhs
        if op == "<=":
            return lhs <= rhs
        if op == "==":
            return lhs == rhs
        if op == "!=":
            return lhs != rhs
        return bool(lhs and lhs != 0)

    def _parse_flags_input(self) -> dict[str, Any]:
        text = self._flags_input.toPlainText().strip()
        flags: dict[str, Any] = {}
        if not text:
            return flags
        for part in text.replace("\n", ",").split(","):
            part = part.strip()
            if "=" not in part:
                continue
            k, v = part.split("=", 1)
            k = k.strip()
            v = v.strip()
            if v.lower() in ("true", "1"):
                flags[k] = 1
            elif v.lower() in ("false", "0"):
                flags[k] = 0
            else:
                try:
                    flags[k] = float(v)
                except ValueError:
                    flags[k] = v
        return flags

    def _toggle_flags_panel(self) -> None:
        self._flags_panel.setVisible(not self._flags_panel.isVisible())

    def _on_start(self) -> None:
        knot = self._knot_combo.currentText()
        if not knot or knot not in self._sim_tree:
            return
        self._flags = self._parse_flags_input()
        self._history.clear()
        self._output.clear()
        self._clear_choices()
        self._actions_label.setText("")
        self._current_knot = knot
        self._pending_nodes = list(self._sim_tree.get(knot, []))
        self._advance()

    def _on_reset(self) -> None:
        self._output.clear()
        self._clear_choices()
        self._actions_label.setText("")
        self._pending_nodes.clear()
        self._flags.clear()
        self._history.clear()
        self._current_knot = ""

    def _advance(self) -> None:
        self._clear_choices()
        actions_collected: list[str] = []

        while self._pending_nodes:
            node = self._pending_nodes.pop(0)

            if node.kind == "text":
                self._append_dialogue(node.speaker, node.text)
                for t in node.tags:
                    if t.startswith("action:"):
                        actions_collected.append(t)
                    elif t.startswith("speaker:"):
                        pass
                self.line_highlighted.emit(node.line_number)
                continue

            if node.kind == "tag":
                for t in node.tags:
                    if t.startswith("action:"):
                        actions_collected.append(t)
                        parts = t.split(":")
                        if len(parts) >= 4 and parts[1] == "setFlag":
                            fk, fv = parts[2], parts[3]
                            try:
                                self._flags[fk] = float(fv)
                            except ValueError:
                                self._flags[fk] = (
                                    1 if fv.lower() == "true" else 0
                                )
                continue

            if node.kind == "divert":
                target = node.divert_target
                if target == "END":
                    self._append_system("[END]")
                    break
                if target in self._sim_tree:
                    self._current_knot = target
                    self._pending_nodes = list(self._sim_tree[target])
                    self._append_system(f"-> {target}")
                    continue
                else:
                    self._append_system(f"[divert target '{target}' not found]")
                    break

            if node.kind == "conditional":
                if getattr(node, "condition_mode", "flag") == "external":
                    val = self._sim_external_value(node.condition_external_name)
                    ok = self._cmp(val, node.condition_cmp, node.condition_rhs)
                else:
                    flag_val = self._flags.get(node.condition_flag, 0)
                    ok = bool(flag_val and flag_val != 0)
                branch = list(node.true_children) if ok else list(node.false_children)
                self._pending_nodes = branch + self._pending_nodes
                continue

            if node.kind == "choice_group":
                self._show_choices(node.choices)
                break

        if actions_collected:
            self._actions_label.setText(
                "Actions: " + " | ".join(actions_collected)
            )
        else:
            self._actions_label.setText("")

    def _show_choices(self, choices: list[SimChoice]) -> None:
        self._clear_choices()
        for i, ch in enumerate(choices):
            btn = QPushButton(f"  {ch.display_text}  ")
            btn.setStyleSheet(
                "QPushButton { text-align: left; padding: 4px 8px; }"
            )
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.clicked.connect(lambda checked, idx=i: self._on_choice(idx, choices))
            self._choices_layout.addWidget(btn)

    def _on_choice(self, idx: int, choices: list[SimChoice]) -> None:
        if idx >= len(choices):
            return
        ch = choices[idx]
        self._append_dialogue("", f"> {ch.display_text}", choice=True)
        self._history.append((self._current_knot, ch.display_text))
        for t in ch.tags:
            if t.startswith("action:"):
                parts = t.split(":")
                if len(parts) >= 4 and parts[1] == "setFlag":
                    try:
                        self._flags[parts[2]] = float(parts[3])
                    except ValueError:
                        self._flags[parts[2]] = 1
        self._pending_nodes = list(ch.body) + self._pending_nodes
        self._advance()

    def _clear_choices(self) -> None:
        while self._choices_layout.count():
            item = self._choices_layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

    def _append_dialogue(
        self, speaker: str, text: str, choice: bool = False,
    ) -> None:
        cursor = self._output.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)

        col = app_theme.ink_simulator_text_colors(self._theme_id)
        if choice:
            fmt = QTextCharFormat()
            fmt.setForeground(col["choice"])
            cursor.insertText(text + "\n", fmt)
        elif speaker:
            fmt_speaker = QTextCharFormat()
            fmt_speaker.setForeground(col["speaker"])
            fmt_speaker.setFontWeight(QFont.Weight.Bold)
            fmt_text = QTextCharFormat()
            fmt_text.setForeground(col["body"])
            if text.startswith(speaker):
                cursor.insertText(text + "\n", fmt_text)
            else:
                cursor.insertText(f"{speaker}: ", fmt_speaker)
                cursor.insertText(text + "\n", fmt_text)
        else:
            fmt = QTextCharFormat()
            fmt.setForeground(col["plain"])
            cursor.insertText(text + "\n", fmt)

        self._output.setTextCursor(cursor)
        self._output.ensureCursorVisible()

    def _append_system(self, text: str) -> None:
        cursor = self._output.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        fmt = QTextCharFormat()
        col = app_theme.ink_simulator_text_colors(self._theme_id)
        fmt.setForeground(col["system"])
        fmt.setFontItalic(True)
        cursor.insertText(text + "\n", fmt)
        self._output.setTextCursor(cursor)
        self._output.ensureCursorVisible()
