from __future__ import annotations

import asyncio
import copy
import json
import re
import sys
import traceback
from html import escape as html_escape
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal
from PySide6.QtGui import QTextCursor
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim.core.agents.probe_agent import ProbeAgent
from tools.chronicle_sim.core.llm.client_factory import ClientFactory
from tools.chronicle_sim.core.llm.config_resolve import provider_profile_for_agent
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.storage.db import Database
from tools.chronicle_sim.gui import app_settings
from tools.chronicle_sim.gui.console_errors import log_line
from tools.chronicle_sim.gui.human_display import markdown_fragment_to_html, probe_reply_to_html
from tools.chronicle_sim.gui.layout_compact import tighten
from tools.chronicle_sim.paths import DATA_DIR


class ProbeSignals(QObject):
    done = Signal(str)
    err = Signal(str)
    idle = Signal()


class ProbeWorker(QRunnable):
    def __init__(
        self,
        db_path: Path,
        run_dir: Path,
        llm_cfg: dict[str, Any],
        q: str,
        focus: str | None,
        history: list[dict[str, str]],
        week_min: int | None,
        week_max: int | None,
    ) -> None:
        super().__init__()
        self.db_path = db_path
        self._run_dir = run_dir
        self._llm_cfg = llm_cfg
        self.q = q
        self.focus = focus
        self.history = list(history)
        self.week_min = week_min
        self.week_max = week_max
        self.signals = ProbeSignals()

    def run(self) -> None:
        async def _go() -> None:
            db = Database(self.db_path)
            conn = db.conn
            llm = None
            try:
                llm_cfg = self._llm_cfg
                prof = provider_profile_for_agent("probe", llm_cfg)
                llm = ClientFactory.build_for_agent(
                    "probe_agent", prof, llm_cfg, run_dir=self._run_dir
                )
                agent = ProbeAgent(
                    llm,
                    MemoryStore(conn, "probe_agent"),
                    HistoryBuffer(),
                    AgentState(),
                    EventBus(),
                    DATA_DIR / "prompts",
                    run_dir=self._run_dir,
                    llm_config=llm_cfg,
                )
                text, refs = await agent.answer(
                    conn,
                    self.q,
                    self.focus,
                    history=self.history,
                    week_min=self.week_min,
                    week_max=self.week_max,
                )
                foot = "\n\n--- 引用 ---\n" + json.dumps(refs, ensure_ascii=False, indent=2)
                self.signals.done.emit(text + foot)
            finally:
                if llm is not None:
                    try:
                        await llm.aclose()
                    except Exception:
                        pass
                db.close()

        try:
            asyncio.run(_go())
        except Exception as e:
            log_line(f"探针 Worker 异常: {type(e).__qualname__}: {e}")
            traceback.print_exception(type(e), e, e.__traceback__, file=sys.stderr)
            sys.stderr.flush()
            self.signals.err.emit(str(e))
        finally:
            self.signals.idle.emit()


def _parse_probe_directives(raw: str) -> tuple[str, str | None, int | None, int | None]:
    """从输入中剥离 /限定、/周 指令，返回 (正文, 限定 token, week_min, week_max)。"""
    focus_token: str | None = None
    week_min: int | None = None
    week_max: int | None = None
    body_lines: list[str] = []
    for line in raw.splitlines():
        s = line.strip()
        if s.startswith("/限定"):
            rest = s.removeprefix("/限定").strip()
            if rest:
                focus_token = rest
            continue
        if s.startswith("/周"):
            rest = re.sub(r"^/周\s*", "", s).strip()
            if not rest:
                continue
            m = re.match(r"^(\d+)\s*[-~至到]\s*(\d+)$", rest)
            if m:
                week_min, week_max = int(m.group(1)), int(m.group(2))
                continue
            parts = rest.split()
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                week_min, week_max = int(parts[0]), int(parts[1])
            elif parts and parts[0].isdigit():
                w = int(parts[0])
                week_min = week_max = w
            continue
        body_lines.append(line)
    body = "\n".join(body_lines).strip()
    return body, focus_token, week_min, week_max


class ProbeWidget(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._db: Database | None = None
        self._run_dir: Path | None = None
        self._llm_fn: Callable[[], dict[str, Any]] | None = None
        self._pool = QThreadPool.globalInstance()
        self._llm_history: list[dict[str, str]] = []
        self._busy = False

        lay = QVBoxLayout(self)
        tighten(lay, margins=(6, 6, 6, 6), spacing=4)
        row = QHBoxLayout()
        lbl_npc = QLabel("限定 NPC")
        lbl_npc.setToolTip("可空。输入框内可用 /限定 id或姓名。")
        row.addWidget(lbl_npc)
        self._focus = QComboBox()
        self._focus.addItem("(无)", userData=None)
        row.addWidget(self._focus, 1)
        lay.addLayout(row)
        hint = QLabel("指令：/限定 …；/周 3-8 或 /周 12（悬停见示例）")
        hint.setStyleSheet("color: palette(mid); font-size: 11px;")
        hint.setToolTip("/限定 关二狗 或 /限定 hero_guan；/周 3-8 限定周范围；/周 12 单周。")
        lay.addWidget(hint)
        inp = QHBoxLayout()
        self._input = QTextEdit()
        self._input.setPlaceholderText("输入问题；可多行，指令单独成行")
        self._input.setMinimumHeight(56)
        self._input.setMaximumHeight(120)
        self._btn_send = QPushButton("发送")
        btn_clear = QPushButton("清空对话")
        self._btn_send.clicked.connect(self._send)
        btn_clear.clicked.connect(self._clear_chat)
        inp.addWidget(self._input, 1)
        inp.addWidget(self._btn_send)
        inp.addWidget(btn_clear)
        lay.addLayout(inp)
        self._out = QTextEdit()
        self._out.setReadOnly(True)
        self._out.setAcceptRichText(True)
        self._out.setMinimumHeight(200)
        lay.addWidget(self._out, 1)

    def save_ui_prefs(self) -> None:
        fid = self._focus.currentData()
        app_settings.set_value("probe/focus_agent", fid if fid else "")

    def restore_ui_prefs(self) -> None:
        if not self._db:
            return
        fid = app_settings.get_value("probe/focus_agent", "")
        if not fid:
            return
        for i in range(self._focus.count()):
            if self._focus.itemData(i) == fid:
                self._focus.setCurrentIndex(i)
                break

    def set_database(
        self,
        db: Database | None,
        run_dir: Path | None,
        llm_cfg_fn: Callable[[], dict[str, Any]] | None,
    ) -> None:
        self._db = db
        self._run_dir = run_dir
        self._llm_fn = llm_cfg_fn
        self._focus.clear()
        self._focus.addItem("(无)", userData=None)
        self._llm_history.clear()
        self._out.clear()
        if db:
            for r in db.conn.execute("SELECT id, name FROM agents ORDER BY id").fetchall():
                self._focus.addItem(f"{r['name']} ({r['id']})", userData=r["id"])
        self.restore_ui_prefs()

    def _clear_chat(self) -> None:
        self._llm_history.clear()
        self._out.clear()

    def _apply_focus_token(self, token: str) -> None:
        t = token.strip()
        if not t:
            return
        for i in range(self._focus.count()):
            if self._focus.itemData(i) == t:
                self._focus.setCurrentIndex(i)
                return
        tl = t.lower()
        for i in range(self._focus.count()):
            if tl in self._focus.itemText(i).lower():
                self._focus.setCurrentIndex(i)
                return

    def _send(self) -> None:
        if self._busy:
            self._append_block("（系统）", "上一则请求仍在处理，请稍候。")
            return
        if not self._db or not self._run_dir:
            self._out.setHtml(
                "<p style='color:#c53030'>请先打开 run。</p>"
            )
            return
        raw = self._input.toPlainText().strip()
        if not raw:
            return
        body, focus_token, week_min, week_max = _parse_probe_directives(raw)
        if focus_token:
            self._apply_focus_token(focus_token)
        if not body:
            self._append_block("（系统）", "指令已应用，请输入正文问题。")
            self._input.clear()
            return
        focus = self._focus.currentData()
        self._append_block("你", raw)
        self._input.clear()
        self._busy = True
        self._btn_send.setEnabled(False)
        fn = self._llm_fn
        llm_cfg_snap = copy.deepcopy(fn()) if fn else {}
        w = ProbeWorker(
            self._run_dir / "run.db",
            self._run_dir,
            llm_cfg_snap,
            body,
            focus,
            self._llm_history,
            week_min,
            week_max,
        )

        def _on_done(full: str) -> None:
            self._append_block("探针", full)
            if "--- 引用 ---" in full:
                assistant_only = full.split("--- 引用 ---", 1)[0].strip()
            else:
                assistant_only = full.strip()
            self._llm_history.append({"role": "user", "content": body})
            self._llm_history.append({"role": "assistant", "content": assistant_only})

        def _on_idle() -> None:
            self._busy = False
            self._btn_send.setEnabled(True)

        w.signals.done.connect(_on_done)
        w.signals.err.connect(lambda m: self._append_block("错误", m))
        w.signals.idle.connect(_on_idle)
        self._pool.start(w)

    def _append_block(self, who: str, text: str) -> None:
        cur = self._out.textCursor()
        cur.movePosition(QTextCursor.MoveOperation.End)
        who_esc = html_escape(who)
        if who == "探针":
            body = probe_reply_to_html(text)
        elif who == "你":
            body = (
                markdown_fragment_to_html(text)
                if any(x in text for x in ("\n", "#", "**", "`", "- "))
                else f"<p style='white-space:pre-wrap'>{html_escape(text)}</p>"
            )
        else:
            body = f"<pre style='background:#fff5f5;padding:8px;border-radius:4px;white-space:pre-wrap'>{html_escape(text)}</pre>"
        cur.insertHtml(
            f'<div style="margin-top:10px;padding-top:8px;border-top:1px solid #e2e8f0">'
            f'<div style="color:#4a5568;font-weight:600;margin-bottom:6px;font-size:12px">[{who_esc}]</div>'
            f"{body}</div>"
        )
        cur.insertBlock()
        self._out.setTextCursor(cur)
        self._out.verticalScrollBar().setValue(self._out.verticalScrollBar().maximum())
