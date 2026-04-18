from __future__ import annotations

import sqlite3
from html import escape as html_escape
from pathlib import Path

from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim.gui import app_settings
from tools.chronicle_sim.gui.human_display import format_jsonl_log_html
from tools.chronicle_sim.gui.layout_compact import tighten

_MAX_INSPECT_BYTES = 1_500_000


class AgentInspectorWidget(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._run_dir: Path | None = None
        lay = QVBoxLayout(self)
        tighten(lay, margins=(6, 6, 6, 6), spacing=4)
        mode_row = QHBoxLayout()
        mode_row.addWidget(QLabel("视图"))
        self._mode = QComboBox()
        self._mode.addItem("NPC agent_logs", userData="agent")
        self._mode.addItem("Director 周轨迹", userData="director")
        self._mode.currentIndexChanged.connect(self._on_mode_changed)
        mode_row.addWidget(self._mode, 1)
        lay.addLayout(mode_row)
        row = QHBoxLayout()
        row.addWidget(QLabel("角色"))
        self._aid = QComboBox()
        self._aid.setMinimumWidth(220)
        self._aid.setToolTip("自当前 run 数据库或 agent_logs 目录加载，可直接选择。")
        row.addWidget(self._aid, 1)
        row.addWidget(QLabel("week"))
        self._wk = QSpinBox()
        self._wk.setRange(1, 520)
        row.addWidget(self._wk)
        btn = QPushButton("加载")
        btn.clicked.connect(self._load)
        row.addWidget(btn)
        lay.addLayout(row)
        self._text = QTextEdit()
        self._text.setReadOnly(True)
        self._text.setAcceptRichText(True)
        self._text.setMinimumHeight(220)
        lay.addWidget(self._text, 1)
        self._on_mode_changed()

    def save_ui_prefs(self) -> None:
        app_settings.set_value("inspector/mode_index", self._mode.currentIndex())
        aid = self._aid.currentData()
        app_settings.set_value("inspector/agent_id", aid if aid else "")
        app_settings.set_value("inspector/week", self._wk.value())

    def restore_ui_prefs(self) -> None:
        m = app_settings.get_value("inspector/mode_index", 0)
        try:
            mi = int(m)
        except (TypeError, ValueError):
            mi = 0
        mi = max(0, min(mi, self._mode.count() - 1))
        self._mode.blockSignals(True)
        self._mode.setCurrentIndex(mi)
        self._mode.blockSignals(False)
        self._on_mode_changed()
        aid = app_settings.get_value("inspector/agent_id", "")
        if aid:
            idx = self._aid.findData(aid)
            if idx >= 0:
                self._aid.setCurrentIndex(idx)
        wv = app_settings.get_value("inspector/week", 1)
        try:
            self._wk.setValue(int(wv))
        except (TypeError, ValueError):
            pass

    def set_run_dir(self, path: Path | None) -> None:
        self._run_dir = path
        self._refill_agent_combo()

    def _refill_agent_combo(self) -> None:
        self._aid.blockSignals(True)
        self._aid.clear()
        rd = self._run_dir
        if rd:
            dbp = rd / "run.db"
            if dbp.is_file():
                conn = sqlite3.connect(str(dbp))
                conn.row_factory = sqlite3.Row
                try:
                    for r in conn.execute("SELECT id, name FROM agents ORDER BY id"):
                        self._aid.addItem(f"{r['name']} ({r['id']})", userData=r["id"])
                finally:
                    conn.close()
            if self._aid.count() == 0:
                logs = rd / "agent_logs"
                if logs.is_dir():
                    for p in sorted(logs.iterdir()):
                        if p.is_dir():
                            self._aid.addItem(p.name, userData=p.name)
        self._aid.blockSignals(False)

    def _on_mode_changed(self) -> None:
        is_agent = self._mode.currentData() == "agent"
        self._aid.setEnabled(is_agent)

    def _read_log_limited(self, p: Path) -> str:
        try:
            sz = p.stat().st_size
        except OSError as e:
            return f"无法读取文件: {p}\n{e}"
        if sz <= _MAX_INSPECT_BYTES:
            return p.read_text(encoding="utf-8", errors="replace")
        with p.open("rb") as f:
            chunk = f.read(_MAX_INSPECT_BYTES)
        text = chunk.decode("utf-8", errors="replace")
        return (
            text
            + f"\n\n…（已截断：文件约 {sz} 字节，仅读取前 {_MAX_INSPECT_BYTES} 字节。请改用外部编辑器查看全量。）"
        )

    def _load(self) -> None:
        if not self._run_dir:
            self._text.setHtml("<p style='color:#c53030'>无 run 目录</p>")
            return
        wk = self._wk.value()
        if self._mode.currentData() == "director":
            p = self._run_dir / "director_trace" / f"week_{wk:03d}.jsonl"
            if not p.is_file():
                self._text.setHtml(f"<p>无文件: {html_escape(str(p))}</p>")
                return
            raw = self._read_log_limited(p)
            if raw.startswith("无法读取"):
                self._text.setHtml(f"<pre>{html_escape(raw)}</pre>")
                return
            self._text.setHtml(
                '<div style="font-family:\'Microsoft YaHei UI\',sans-serif;font-size:13px">'
                + format_jsonl_log_html(raw)
                + "</div>"
            )
            return
        aid = self._aid.currentData()
        if not aid:
            self._text.setHtml("<p style='color:#c53030'>请选择角色</p>")
            return
        aid_s = str(aid)
        p = self._run_dir / "agent_logs" / aid_s / f"week_{wk:03d}.jsonl"
        if not p.is_file():
            self._text.setHtml(f"<p>无文件: {html_escape(str(p))}</p>")
            return
        raw = self._read_log_limited(p)
        if raw.startswith("无法读取"):
            self._text.setHtml(f"<pre>{html_escape(raw)}</pre>")
            return
        self._text.setHtml(
            '<div style="font-family:\'Microsoft YaHei UI\',sans-serif;font-size:13px">'
            + format_jsonl_log_html(raw)
            + "</div>"
        )
