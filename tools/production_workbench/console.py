"""Reusable dockable console widgets for the production workbench."""
from __future__ import annotations

import json
import html
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QTextCursor, QTextDocument
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QDockWidget,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSizePolicy,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.editor.shared.project_paths import ProjectPaths


SEVERITIES = ("debug", "info", "warning", "error")
SEVERITY_LABELS = {
    "debug": "DEBUG",
    "info": "INFO",
    "warning": "WARNING",
    "error": "ERROR",
}
SEVERITY_COLORS = {
    "debug": "#6b7280",
    "info": "",
    "warning": "#b45309",
    "error": "#dc2626",
}
CONSOLE_LINE_HEIGHT = "1.15"


@dataclass(frozen=True)
class ConsoleEntry:
    timestamp: str
    context_id: str
    severity: str
    message: str
    info: str = ""


def console_log_root(project_root: Path) -> Path:
    return ProjectPaths(project_root.resolve()).editor_data_root / "production_workbench" / "console_logs"


def console_context_log_dir(project_root: Path, context_id: str) -> Path:
    return console_log_root(project_root) / _safe_context_name(context_id)


class ConsoleLogWriter:
    def __init__(self, project_root: Path, context_id: str) -> None:
        self.project_root = project_root.resolve()
        self.context_id = context_id
        self.root = console_context_log_dir(self.project_root, context_id)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self._new_log_path()

    def set_project_root(self, project_root: Path) -> None:
        project_root = project_root.resolve()
        if project_root == self.project_root:
            return
        self.project_root = project_root
        self.root = console_context_log_dir(self.project_root, self.context_id)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self._new_log_path()

    def append(self, entry: ConsoleEntry) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "timestamp": entry.timestamp,
            "context": entry.context_id,
            "severity": entry.severity,
            "info": entry.info,
            "message": entry.message,
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def _new_log_path(self) -> Path:
        stem = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = self.root / f"{stem}.jsonl"
        suffix = 1
        while path.exists():
            suffix += 1
            path = self.root / f"{stem}-{suffix}.jsonl"
        return path


class WorkbenchConsoleWidget(QWidget):
    """Filterable/searchable console with per-context log persistence."""

    def __init__(self, project_root: Path, context_id: str, *, title: str = "", info: str = "") -> None:
        super().__init__()
        self.project_root = project_root.resolve()
        self.context_id = context_id
        self.title = title or context_id
        self.context_info = info
        self._entries: list[ConsoleEntry] = []
        self._visible_entries: list[ConsoleEntry] = []
        self._last_html = ""
        self._log_writer = ConsoleLogWriter(self.project_root, self.context_id)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMinimumSize(0, 0)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(2, 2, 2, 2)
        layout.setSpacing(2)

        header = QHBoxLayout()
        header.setContentsMargins(0, 0, 0, 0)
        header.setSpacing(4)
        self.title_label = QLabel(self.title)
        self.info_label = QLabel(self.context_info)
        self.info_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.info_label.setMinimumWidth(0)
        self.info_label.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        header.addWidget(self.title_label)
        header.addWidget(self.info_label, 1)
        layout.addLayout(header)

        filters = QHBoxLayout()
        filters.setContentsMargins(0, 0, 0, 0)
        filters.setSpacing(4)
        self.severity_checks: dict[str, QCheckBox] = {}
        for severity in SEVERITIES:
            check = QCheckBox(SEVERITY_LABELS[severity])
            check.setChecked(True)
            check.setMinimumWidth(0)
            check.stateChanged.connect(lambda _state=0, sev=severity: self._apply_filters())
            self.severity_checks[severity] = check
            filters.addWidget(check)
        filters.addWidget(QLabel("Filter"))
        self.filter_edit = QLineEdit()
        self.filter_edit.setMinimumWidth(0)
        self.filter_edit.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.filter_edit.setPlaceholderText("过滤当前 console 内容")
        self.filter_edit.textChanged.connect(lambda _text="": self._apply_filters())
        filters.addWidget(self.filter_edit, 1)
        layout.addLayout(filters)

        search = QHBoxLayout()
        search.setContentsMargins(0, 0, 0, 0)
        search.setSpacing(4)
        search.addWidget(QLabel("Search"))
        self.search_edit = QLineEdit()
        self.search_edit.setMinimumWidth(0)
        self.search_edit.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.search_edit.setPlaceholderText("搜索可见日志")
        self.search_edit.returnPressed.connect(self.search_next)
        self.btn_prev = QPushButton("上一个")
        self.btn_next = QPushButton("下一个")
        self.btn_copy = QPushButton("复制可见")
        self.btn_clear = QPushButton("清空")
        self.btn_prev.clicked.connect(self.search_previous)
        self.btn_next.clicked.connect(self.search_next)
        self.btn_copy.clicked.connect(self.copy_visible)
        self.btn_clear.clicked.connect(self.clear)
        search.addWidget(self.search_edit, 1)
        search.addWidget(self.btn_prev)
        search.addWidget(self.btn_next)
        search.addWidget(self.btn_copy)
        search.addWidget(self.btn_clear)
        layout.addLayout(search)

        self.output = QTextEdit()
        self.output.setReadOnly(True)
        self.output.setMinimumSize(0, 0)
        self.output.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Ignored)
        self.output.setAcceptRichText(True)
        self.output.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse | Qt.TextInteractionFlag.TextSelectableByKeyboard
        )
        self.output.document().setDocumentMargin(2)
        self.output.setStyleSheet("QTextEdit { padding: 2px; }")
        layout.addWidget(self.output, 1)

    def set_project_root(self, project_root: Path) -> None:
        self.project_root = project_root.resolve()
        self._log_writer.set_project_root(self.project_root)

    def set_context_info(self, text: str) -> None:
        self.context_info = text
        self.info_label.setText(text)

    def setPlaceholderText(self, text: str) -> None:  # noqa: N802 - QTextEdit compatibility.
        self.output.setPlaceholderText(text)

    def append(self, message: str, *, severity: str = "info", info: str = "", write_log: bool = True) -> ConsoleEntry:
        clean_severity = _clean_severity(severity)
        entry = ConsoleEntry(
            timestamp=datetime.now().astimezone().isoformat(timespec="seconds"),
            context_id=self.context_id,
            severity=clean_severity,
            message=str(message or ""),
            info=str(info or ""),
        )
        self._entries.append(entry)
        self._apply_filters()
        if write_log:
            self._log_writer.append(entry)
        return entry

    def setPlainText(self, text: str) -> None:  # noqa: N802 - QTextEdit compatibility for existing tabs/tests.
        self.clear(write_log=False)
        for line in str(text or "").splitlines():
            clean_line = line.rstrip()
            if not clean_line:
                continue
            self.append(clean_line, severity=infer_severity(clean_line))

    def appendPlainText(self, text: str) -> None:  # noqa: N802 - QTextEdit compatibility.
        for line in str(text or "").splitlines():
            clean_line = line.rstrip()
            if clean_line:
                self.append(clean_line, severity=infer_severity(clean_line))

    def clear(self, *, write_log: bool = False) -> None:  # noqa: ARG002 - write_log reserved for API symmetry.
        self._entries.clear()
        self._visible_entries = []
        self._render_entries()

    def toPlainText(self) -> str:  # noqa: N802 - QTextEdit compatibility.
        return "\n".join(entry.message for entry in self.visible_entries())

    def entries(self) -> list[ConsoleEntry]:
        return list(self._entries)

    def visible_entries(self) -> list[ConsoleEntry]:
        return list(self._visible_entries)

    def rendered_html(self) -> str:
        return self._last_html

    def set_filter_text(self, text: str) -> None:
        self.filter_edit.setText(text)

    def set_severity_enabled(self, severity: str, enabled: bool) -> None:
        check = self.severity_checks.get(_clean_severity(severity))
        if check is not None:
            check.setChecked(enabled)
        self._apply_filters()

    def search_next(self) -> bool:
        return self._search(direction=1)

    def search_previous(self) -> bool:
        return self._search(direction=-1)

    def copy_visible(self) -> None:
        QApplication.clipboard().setText(self.toPlainText())

    def _apply_filters(self) -> None:
        tokens = _tokens(self.filter_edit.text())
        self._visible_entries = []
        for entry in self._entries:
            severity_ok = self.severity_checks[entry.severity].isChecked()
            haystack = f"{entry.message} {entry.info}".lower()
            text_ok = all(token in haystack for token in tokens)
            if severity_ok and text_ok:
                self._visible_entries.append(entry)
        self._render_entries()

    def _search(self, *, direction: int) -> bool:
        query = self.search_edit.text().strip()
        if not query:
            return False
        flags = QTextDocument.FindFlag.FindBackward if direction < 0 else QTextDocument.FindFlag(0)
        if self.output.find(query, flags):
            return True
        cursor = self.output.textCursor()
        cursor.movePosition(
            QTextCursor.MoveOperation.End if direction < 0 else QTextCursor.MoveOperation.Start
        )
        self.output.setTextCursor(cursor)
        return self.output.find(query, flags)

    def _render_entries(self) -> None:
        self._last_html = _entries_html(self._visible_entries)
        self.output.setHtml(self._last_html)

    def minimumSizeHint(self) -> QSize:  # noqa: N802 - Qt override name.
        return QSize(0, 0)


class WorkbenchConsoleDock(QDockWidget):
    def __init__(self, project_root: Path, context_id: str, title: str, parent: QWidget | None = None) -> None:
        super().__init__(title, parent)
        self.setObjectName(f"consoleDock-{_safe_context_name(context_id)}")
        self.setAllowedAreas(
            Qt.DockWidgetArea.LeftDockWidgetArea
            | Qt.DockWidgetArea.RightDockWidgetArea
            | Qt.DockWidgetArea.BottomDockWidgetArea
            | Qt.DockWidgetArea.TopDockWidgetArea
        )
        self.setFeatures(
            QDockWidget.DockWidgetFeature.DockWidgetClosable
            | QDockWidget.DockWidgetFeature.DockWidgetFloatable
            | QDockWidget.DockWidgetFeature.DockWidgetMovable
        )
        self.setMinimumSize(0, 0)
        self.console = WorkbenchConsoleWidget(project_root, context_id, title=title)
        self.setWidget(self.console)

    def minimumSizeHint(self) -> QSize:  # noqa: N802 - Qt override name.
        return QSize(0, 0)


def infer_severity(text: str) -> str:
    lower = str(text or "").lower()
    if re.search(r"(?:^|[^a-z])error\s*=\s*[1-9]", lower) or any(
        token in lower for token in ["error:", "[error]", "错误", "失败", "failed", "exception", "traceback"]
    ):
        return "error"
    if re.search(r"(?:^|[^a-z])warning\s*=\s*[1-9]", lower) or any(
        token in lower for token in ["warning:", "[warning]", "警告", "warning", "阻塞"]
    ):
        return "warning"
    if any(token in lower for token in ["debug", "trace"]):
        return "debug"
    return "info"


def _clean_severity(value: str) -> str:
    clean = str(value or "").strip().lower()
    return clean if clean in SEVERITIES else "info"


def _item_text(entry: ConsoleEntry) -> str:
    label = SEVERITY_LABELS.get(entry.severity, "INFO")
    return f"[{label}] {entry.message}"


def _entries_html(entries: list[ConsoleEntry]) -> str:
    body = "\n".join(_entry_html(entry) for entry in entries)
    return (
        "<html><head><style>"
        "body { margin: 0; }"
        f".entry {{ margin: 0; padding: 0; line-height: {CONSOLE_LINE_HEIGHT}; white-space: pre-wrap; }}"
        ".badge { font-weight: 700; }"
        "</style></head><body>"
        f"{body}"
        "</body></html>"
    )


def _entry_html(entry: ConsoleEntry) -> str:
    label = SEVERITY_LABELS.get(entry.severity, "INFO")
    color = SEVERITY_COLORS.get(entry.severity, "")
    color_style = f" color: {color};" if color else ""
    return (
        '<div class="entry">'
        f'<span class="badge" style="{color_style}">[{html.escape(label)}]</span> '
        f"<span>{html.escape(entry.message)}</span>"
        "</div>"
    )


def _safe_context_name(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "").strip()).strip("-")
    return text or "console"


def _tokens(value: str) -> list[str]:
    return [token.lower() for token in str(value or "").split() if token.strip()]
