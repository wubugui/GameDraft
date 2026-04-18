from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, Signal

from html import escape as html_escape

from tools.chronicle_sim.gui import app_settings
from tools.chronicle_sim.gui.human_display import (
    chronicle_event_block_html,
    json_value_to_html,
    markdown_fragment_to_html,
)
from tools.chronicle_sim.gui.layout_compact import tighten
from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim.core.schema.models import NpcTier
from tools.chronicle_sim.core.storage.db import Database
from tools.chronicle_sim.core.storage.tier_manager import TierApplyMode, TierChangeRequest, TierManager


class ChronicleWidget(QWidget):
    """编年史浏览器：多浏览模式、真相/见证/belief/流传、涟漪区、Tier 右键队列。"""

    tierChangeQueued = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._db: Database | None = None
        self._run_dir: Path | None = None

        top = QHBoxLayout()
        top.setSpacing(6)
        top.addWidget(QLabel("浏览:"))
        self._browse = QComboBox()
        self._browse.addItems(["按周", "按地点", "按派系", "按 NPC", "按事件类型"])
        self._browse.currentIndexChanged.connect(self._reload_browser_lists)
        top.addWidget(self._browse)
        self._filter = QComboBox()
        self._filter.setMinimumWidth(200)
        self._filter.currentIndexChanged.connect(self._on_filter_changed)
        top.addWidget(self._filter, 1)
        self._density = QLabel("")
        top.addWidget(self._density)

        self._split_h = QSplitter(Qt.Orientation.Horizontal)
        mid = self._split_h
        self._item_list = QListWidget()
        self._item_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._item_list.customContextMenuRequested.connect(self._ctx_menu)
        self._item_list.currentItemChanged.connect(self._on_item_changed)
        mid.addWidget(self._item_list)

        self._split_v = QSplitter(Qt.Orientation.Vertical)
        right_split = self._split_v
        row = QHBoxLayout()
        row_w = QWidget()
        row_w.setLayout(row)
        row.addWidget(QLabel("视图:"))
        self._view = QComboBox()
        self._view.addItems(["真相 truth_json", "见证 witness", "belief 主观表", "流传 rumor"])
        self._view.currentIndexChanged.connect(self._refresh_detail)
        row.addWidget(self._view)
        row.addWidget(QLabel("NPC（见证/belief）"))
        self._npc_pick = QComboBox()
        row.addWidget(self._npc_pick, 1)
        self._npc_pick.currentIndexChanged.connect(self._refresh_detail)
        right_split.addWidget(row_w)

        self._detail = QTextEdit()
        self._detail.setReadOnly(True)
        self._detail.setAcceptRichText(True)
        right_split.addWidget(self._detail)
        self._ripple = QTextEdit()
        self._ripple.setReadOnly(True)
        self._ripple.setAcceptRichText(True)
        self._ripple.setPlaceholderText("涟漪：同周其它事件与传闻摘要")
        self._ripple.setMaximumHeight(120)
        right_split.addWidget(self._ripple)
        right_split.setSizes([32, 360, 100])

        mid.addWidget(right_split)
        mid.setSizes([220, 720])

        root = QVBoxLayout(self)
        tighten(root, margins=(4, 4, 4, 4), spacing=4)
        root.addLayout(top)
        root.addWidget(mid)

    def save_ui_prefs(self) -> None:
        app_settings.set_value("chronicle/browse", self._browse.currentIndex())
        app_settings.set_value("chronicle/view", self._view.currentIndex())
        aid = self._npc_pick.currentData()
        app_settings.set_value("chronicle/npc_pick", aid if aid is not None else "")
        fd = self._filter.currentData()
        app_settings.set_value(
            "chronicle/filter_data",
            json.dumps(fd, default=str) if fd is not None else "",
        )
        it = self._item_list.currentItem()
        pl = it.data(Qt.ItemDataRole.UserRole) if it else None
        if isinstance(pl, tuple):
            item_payload = json.dumps(list(pl))
        elif pl is not None:
            item_payload = json.dumps(pl, default=str)
        else:
            item_payload = ""
        app_settings.set_value("chronicle/item_payload", item_payload)
        app_settings.set_value("chronicle/split_h", self._split_h.saveState())
        app_settings.set_value("chronicle/split_v", self._split_v.saveState())

    def restore_ui_prefs(self) -> None:
        sh = app_settings.get_value("chronicle/split_h")
        if sh:
            self._split_h.restoreState(sh)
        sv = app_settings.get_value("chronicle/split_v")
        if sv:
            self._split_v.restoreState(sv)
        br = app_settings.get_value("chronicle/browse", 0)
        try:
            bi = int(br)
        except (TypeError, ValueError):
            bi = 0
        bi = max(0, min(bi, self._browse.count() - 1))
        self._browse.blockSignals(True)
        self._browse.setCurrentIndex(bi)
        self._browse.blockSignals(False)
        if not self._db:
            return
        self._reload_browser_lists()
        if self._browse.currentIndex() != 0:
            raw_fd = app_settings.get_value("chronicle/filter_data", "")
            if raw_fd:
                try:
                    fd = json.loads(str(raw_fd))
                except json.JSONDecodeError:
                    fd = str(raw_fd)
                for i in range(self._filter.count()):
                    if self._filter.itemData(i) == fd:
                        self._filter.setCurrentIndex(i)
                        break
            self._on_filter_changed()
        raw_pl = app_settings.get_value("chronicle/item_payload", "")
        if raw_pl:
            try:
                pl = json.loads(str(raw_pl))
            except json.JSONDecodeError:
                pl = None
            if pl is not None:
                pl_t = tuple(pl) if isinstance(pl, list) else pl
                for i in range(self._item_list.count()):
                    it = self._item_list.item(i)
                    cur = it.data(Qt.ItemDataRole.UserRole)
                    cur_n = tuple(cur) if isinstance(cur, list) else cur
                    if cur_n == pl_t:
                        self._item_list.setCurrentItem(it)
                        break
        vi = app_settings.get_value("chronicle/view", 0)
        try:
            vidx = int(vi)
        except (TypeError, ValueError):
            vidx = 0
        vidx = max(0, min(vidx, self._view.count() - 1))
        self._view.blockSignals(True)
        self._view.setCurrentIndex(vidx)
        self._view.blockSignals(False)
        npc_saved = app_settings.get_value("chronicle/npc_pick", "")
        if npc_saved:
            idx = self._npc_pick.findData(npc_saved)
            if idx >= 0:
                self._npc_pick.setCurrentIndex(idx)
        self._refresh_detail()

    def set_database(self, db: Database | None, run_dir: Path | None) -> None:
        self._db = db
        self._run_dir = run_dir
        self.refresh()

    def go_to_week(self, week: int) -> None:
        self._browse.setCurrentIndex(0)
        self._reload_browser_lists()
        for i in range(self._item_list.count()):
            it = self._item_list.item(i)
            if it and it.data(Qt.ItemDataRole.UserRole) == week:
                self._item_list.setCurrentItem(it)
                break

    def refresh(self) -> None:
        self._reload_density()
        self._npc_pick.clear()
        if self._db:
            for a in self._db.conn.execute("SELECT id, name FROM agents ORDER BY id").fetchall():
                self._npc_pick.addItem(f"{a['name']} ({a['id']})", userData=a["id"])
        self._reload_browser_lists()

    def _reload_density(self) -> None:
        self._density.setText("")
        if not self._db:
            return
        rows = self._db.conn.execute(
            "SELECT week_number, COUNT(*) AS c FROM events GROUP BY week_number ORDER BY week_number"
        ).fetchall()
        parts = [f"{r['week_number']}:{r['c']}" for r in rows[:20]]
        self._density.setText("周事件数 " + " | ".join(parts))

    def _reload_browser_lists(self) -> None:
        self._item_list.clear()
        self._filter.blockSignals(True)
        self._filter.clear()
        self._filter.blockSignals(False)
        if not self._db:
            return
        mode = self._browse.currentIndex()
        if mode == 0:
            for r in self._db.conn.execute(
                "SELECT week_number, COUNT(*) AS c FROM events GROUP BY week_number ORDER BY week_number"
            ).fetchall():
                wn = int(r["week_number"])
                it = QListWidgetItem(f"第 {wn} 周（{r['c']} 条事件）")
                it.setData(Qt.ItemDataRole.UserRole, ("week", wn))
                self._item_list.addItem(it)
        elif mode == 1:
            for r in self._db.conn.execute("SELECT id, name FROM locations ORDER BY id").fetchall():
                self._filter.addItem(r["name"], userData=r["id"])
            if self._filter.count():
                self._refill_items_for_location()
        elif mode == 2:
            for r in self._db.conn.execute("SELECT id, name FROM factions ORDER BY id").fetchall():
                self._filter.addItem(r["name"], userData=r["id"])
            if self._filter.count():
                self._refill_items_for_faction()
        elif mode == 3:
            for r in self._db.conn.execute("SELECT id, name, current_tier FROM agents ORDER BY id").fetchall():
                self._filter.addItem(f"{r['name']} ({r['current_tier']})", userData=r["id"])
            if self._filter.count():
                self._refill_items_for_npc()
        else:
            for r in self._db.conn.execute("SELECT DISTINCT type_id FROM events ORDER BY type_id").fetchall():
                self._filter.addItem(r["type_id"], userData=r["type_id"])
            if self._filter.count():
                self._refill_items_for_type()

    def _on_filter_changed(self) -> None:
        mode = self._browse.currentIndex()
        if mode == 1:
            self._refill_items_for_location()
        elif mode == 2:
            self._refill_items_for_faction()
        elif mode == 3:
            self._refill_items_for_npc()
        elif mode == 4:
            self._refill_items_for_type()

    def _refill_items_for_location(self) -> None:
        self._item_list.clear()
        if not self._db:
            return
        lid = self._filter.currentData()
        if not lid:
            return
        for e in self._db.conn.execute(
            "SELECT id, week_number, type_id FROM events WHERE location_id = ? ORDER BY week_number",
            (lid,),
        ).fetchall():
            it = QListWidgetItem(f"周{e['week_number']} {e['type_id']} {e['id'][:8]}")
            it.setData(Qt.ItemDataRole.UserRole, ("event", e["id"]))
            self._item_list.addItem(it)

    def _refill_items_for_faction(self) -> None:
        self._item_list.clear()
        if not self._db:
            return
        fid = self._filter.currentData()
        if not fid:
            return
        for e in self._db.conn.execute(
            """
            SELECT DISTINCT ev.id, ev.week_number, ev.type_id
            FROM events ev
            JOIN agents ag ON ag.faction_id = ? AND (
                ev.witness_accounts_json LIKE '%' || ag.id || '%'
                OR ev.truth_json LIKE '%' || ag.id || '%'
            )
            ORDER BY ev.week_number
            """,
            (fid,),
        ).fetchall():
            it = QListWidgetItem(f"周{e['week_number']} {e['type_id']}")
            it.setData(Qt.ItemDataRole.UserRole, ("event", e["id"]))
            self._item_list.addItem(it)

    def _refill_items_for_npc(self) -> None:
        self._item_list.clear()
        if not self._db:
            return
        aid = self._filter.currentData()
        if not aid:
            return
        for e in self._db.conn.execute(
            """
            SELECT id, week_number, type_id FROM events
            WHERE witness_accounts_json LIKE ? OR truth_json LIKE ?
            ORDER BY week_number
            """,
            (f"%{aid}%", f"%{aid}%"),
        ).fetchall():
            it = QListWidgetItem(f"周{e['week_number']} {e['type_id']}")
            it.setData(Qt.ItemDataRole.UserRole, ("event", e["id"]))
            self._item_list.addItem(it)

    def _refill_items_for_type(self) -> None:
        self._item_list.clear()
        if not self._db:
            return
        tid = self._filter.currentData()
        if not tid:
            return
        for e in self._db.conn.execute(
            "SELECT id, week_number FROM events WHERE type_id = ? ORDER BY week_number",
            (tid,),
        ).fetchall():
            it = QListWidgetItem(f"周{e['week_number']} {e['id'][:8]}")
            it.setData(Qt.ItemDataRole.UserRole, ("event", e["id"]))
            self._item_list.addItem(it)

    def _on_item_changed(self) -> None:
        self._refresh_detail()
        self._refresh_ripple()

    def _current_week_and_events(self) -> tuple[int | None, list[Any]]:
        if not self._db:
            return None, []
        it = self._item_list.currentItem()
        if not it:
            return None, []
        payload = it.data(Qt.ItemDataRole.UserRole)
        if not payload:
            return None, []
        kind, val = payload[0], payload[1]
        if kind == "week":
            wn = int(val)
            evs = self._db.conn.execute(
                "SELECT * FROM events WHERE week_number = ? ORDER BY id", (wn,)
            ).fetchall()
            return wn, list(evs)
        if kind == "event":
            eid = str(val)
            ev = self._db.conn.execute("SELECT * FROM events WHERE id = ?", (eid,)).fetchone()
            if not ev:
                return None, []
            return int(ev["week_number"]), [ev]
        return None, []

    def _refresh_detail(self) -> None:
        self._detail.clear()
        if not self._db:
            return
        wn, evs = self._current_week_and_events()
        if wn is None:
            return
        mode = self._view.currentIndex()
        blocks: list[str] = []
        aid = self._npc_pick.currentData()
        for e in evs:
            body = ""
            if mode == 0:
                try:
                    tj = json.loads(e["truth_json"] or "{}")
                    body = json_value_to_html(tj)
                except json.JSONDecodeError:
                    body = f"<pre>{html_escape(str(e['truth_json']))}</pre>"
            elif mode == 1:
                try:
                    ws = json.loads(e["witness_accounts_json"] or "[]")
                    wparts: list[str] = []
                    for w in ws:
                        if aid and w.get("agent_id") != aid:
                            continue
                        wa = html_escape(str(w.get("agent_id", "")))
                        tx = str(w.get("account_text", ""))
                        hint = str(w.get("supernatural_hint", "") or "")
                        inner = (
                            markdown_fragment_to_html(tx)
                            if ("\n" in tx or "**" in tx or "`" in tx)
                            else f"<p>{html_escape(tx)}</p>"
                        )
                        hint_html = (
                            f'<div style="margin-top:4px;font-size:12px;color:#744210">异兆暗示：{html_escape(hint)}</div>'
                            if hint
                            else ""
                        )
                        wparts.append(
                            f'<div style="margin:10px 0;padding:10px;background:#fff;border:1px solid #e2e8f0;'
                            f'border-radius:6px"><div style="font-weight:600;color:#2c5282">{wa}</div>{inner}{hint_html}</div>'
                        )
                    body = "".join(wparts) if wparts else "<p>（无见证或当前 NPC 无记录）</p>"
                except json.JSONDecodeError:
                    body = f"<pre>{html_escape(str(e['witness_accounts_json']))}</pre>"
            elif mode == 2:
                if not aid:
                    body = "<p>请在下拉框选择 NPC 以查看其 belief 表。</p>"
                else:
                    bparts: list[str] = []
                    for b in self._db.conn.execute(
                        """
                        SELECT topic, claim_text, confidence, distortion_level, source_event_id
                        FROM beliefs
                        WHERE holder_id = ? AND (last_updated_week = ? OR first_heard_week = ?)
                        ORDER BY topic
                        """,
                        (aid, wn, wn),
                    ).fetchall():
                        src = b["source_event_id"] or ""
                        bparts.append(
                            f'<div style="margin:8px 0;padding:8px;background:#f7fafc;border-radius:4px">'
                            f'<div style="font-weight:600;color:#2d3748">{html_escape(str(b["topic"]))}</div>'
                            f'<div style="margin:4px 0">{html_escape(str(b["claim_text"])[:800])}</div>'
                            f'<div style="font-size:11px;color:#718096">置信度 {b["confidence"]:.2f} · '
                            f'扭曲 {b["distortion_level"]}'
                            f'{f" · 来源事件 {html_escape(str(src))}" if src else ""}</div></div>'
                        )
                    body = "".join(bparts) if bparts else "<p>（本周无 belief 记录）</p>"
            else:
                try:
                    rv = json.loads(e["rumor_versions_json"] or "[]")
                    if isinstance(rv, list):
                        lis = "".join(f"<li>{html_escape(str(x))}</li>" for x in rv)
                        body = f"<ul>{lis}</ul>" if lis else "<p>（无）</p>"
                    else:
                        body = json_value_to_html(rv)
                except json.JSONDecodeError:
                    body = f"<pre>{html_escape(str(e['rumor_versions_json']))}</pre>"
            blocks.append(
                chronicle_event_block_html(
                    str(e["id"]),
                    str(e["type_id"]),
                    int(e["week_number"]),
                    body,
                )
            )
        self._detail.setHtml(
            '<div style="font-family:\'Microsoft YaHei UI\',\'Segoe UI\',sans-serif;font-size:13px">'
            + "".join(blocks)
            + "</div>"
        )

    def _refresh_ripple(self) -> None:
        self._ripple.clear()
        if not self._db:
            return
        wn, evs = self._current_week_and_events()
        if wn is None:
            return
        lis: list[str] = []
        for e in self._db.conn.execute(
            "SELECT id, type_id FROM events WHERE week_number = ? ORDER BY id", (wn,)
        ).fetchall():
            if evs and e["id"] == evs[0]["id"] and len(evs) == 1:
                continue
            lis.append(
                f"<li><b>{html_escape(str(e['type_id']))}</b> · "
                f"<span style='color:#718096'>{html_escape(str(e['id'])[:12])}…</span></li>"
            )
        for r in self._db.conn.execute(
            "SELECT content, distortion_level FROM rumors WHERE week_emerged = ? LIMIT 12", (wn,)
        ).fetchall():
            ct = str(r["content"])[:120]
            lis.append(
                f"<li>传闻 <span style='color:#553c9a'>{html_escape(ct)}</span>… "
                f"<span style='color:#718096;font-size:11px'>（扭曲 {r['distortion_level']}）</span></li>"
            )
        html = (
            '<div style="font-size:12px;color:#2d3748"><p style="margin:0 0 6px;font-weight:600">同周其它动态</p><ul style="margin:0">'
            + "".join(lis)
            + "</ul></div>"
            if lis
            else "<p style='color:#718096'>（无更多涟漪）</p>"
        )
        self._ripple.setHtml(html)

    def _ctx_menu(self, pos) -> None:
        if not self._db:
            return
        it = self._item_list.itemAt(pos)
        if not it:
            return
        payload = it.data(Qt.ItemDataRole.UserRole)
        if not payload or payload[0] != "event":
            return
        menu = QMenu(self)
        for label, tier in [("升为 Tier S", NpcTier.S), ("升为 Tier A", NpcTier.A), ("降为 Tier B", NpcTier.B)]:
            act = menu.addAction(label)
            act.triggered.connect(lambda checked=False, t=tier: self._queue_tier_for_ctx(it, t))
        menu.exec(self._item_list.mapToGlobal(pos))

    def _queue_tier_for_ctx(self, item: QListWidgetItem, new_tier: NpcTier) -> None:
        if not self._db:
            return
        payload = item.data(Qt.ItemDataRole.UserRole)
        if not payload or payload[0] != "event":
            return
        eid = str(payload[1])
        ev = self._db.conn.execute("SELECT witness_accounts_json FROM events WHERE id = ?", (eid,)).fetchone()
        if not ev:
            return
        try:
            ws = json.loads(ev["witness_accounts_json"] or "[]")
        except json.JSONDecodeError:
            return
        if not ws:
            return
        aid = str(ws[0].get("agent_id", ""))
        if not aid:
            return
        TierManager(self._db.conn).queue(
            TierChangeRequest(agent_id=aid, new_tier=new_tier, mode=TierApplyMode.NEXT_WEEK)
        )
        self._db.conn.commit()
        self.tierChangeQueued.emit()
