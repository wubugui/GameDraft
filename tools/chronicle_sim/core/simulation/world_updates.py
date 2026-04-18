from __future__ import annotations

import json
import sqlite3
from typing import Any

from tools.chronicle_sim.core.schema.belief import BeliefRecord
from tools.chronicle_sim.core.schema.event_record import EventRecord
from tools.chronicle_sim.core.storage.belief_store import BeliefStore


def sync_beliefs_from_witnesses(conn: sqlite3.Connection, week: int, records: list[EventRecord]) -> None:
    """GM 落库后：将见证文本写入各 holder 的 belief（亲历层，先于 Rumor 扭曲）。"""
    holders = {
        r["id"]
        for r in conn.execute(
            "SELECT id FROM agents WHERE current_tier IN ('S','A','B') AND life_status = 'alive'"
        ).fetchall()
    }
    store = BeliefStore(conn)
    for rec in records:
        for w in rec.witness_accounts:
            if w.agent_id not in holders:
                continue
            b = BeliefRecord(
                holder_id=w.agent_id,
                subject_id=rec.id,
                topic="亲历",
                claim_text=w.account_text,
                source_event_id=rec.id,
                distortion_level=0,
                first_heard_week=week,
                last_updated_week=week,
                confidence=0.75,
            )
            store.upsert(b)


def touch_tier_b_state_cards(conn: sqlite3.Connection, week: int, records: list[EventRecord]) -> None:
    """事件涉及之 NPC 若为龙套，更新状态卡最近被触及周次。"""
    tier_b = {r["id"] for r in conn.execute("SELECT id FROM agents WHERE current_tier = 'B'").fetchall()}
    for rec in records:
        ids: set[str] = set()
        for w in rec.witness_accounts:
            ids.add(w.agent_id)
        draft = rec.director_draft_json if isinstance(rec.director_draft_json, dict) else {}
        for x in draft.get("actor_ids") or []:
            ids.add(str(x))
        for aid in ids:
            if aid in tier_b:
                conn.execute(
                    """
                    UPDATE npc_state_cards SET last_touched_week = ?
                    WHERE agent_id = ?
                    """,
                    (week, aid),
                )


def anchor_reminders_for_week(conn: sqlite3.Connection, week: int) -> str:
    rows = conn.execute(
        "SELECT id, title, description FROM anchor_events WHERE week_number = ?",
        (week,),
    ).fetchall()
    if not rows:
        return ""
    parts = ["【本周锚点年表】"]
    for r in rows:
        parts.append(f"- {r['title']}: {r['description']}")
    return "\n".join(parts)
