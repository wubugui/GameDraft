from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

from tools.chronicle_sim.core.schema.event_type import ActorSlotDef, EventTypeDef


def load_event_types_yaml(path: Path) -> list[EventTypeDef]:
    if not path.is_file():
        return []
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    items = raw.get("event_types") or raw.get("types") or []
    out: list[EventTypeDef] = []
    for it in items:
        slots_raw = it.get("actor_slots") or []
        slots: list[ActorSlotDef] = []
        for s in slots_raw:
            if isinstance(s, dict):
                slots.append(ActorSlotDef(**s))
        out.append(
            EventTypeDef(
                id=str(it["id"]),
                category=str(it.get("category", "misc")),
                tier=str(it.get("tier", "minor")),
                conditions=str(it.get("conditions", "true")),
                actor_slots=slots,
                weight=float(it.get("weight", 1.0)),
                cooldown_weeks=int(it.get("cooldown_weeks", 0)),
                supernatural_prob=float(it.get("supernatural_prob", 0.0)),
                narrative_template=str(it.get("narrative_template", "")),
                consequences_template=str(it.get("consequences_template", "")),
            )
        )
    return out


def sync_event_types_to_db(conn: Any, types: list[EventTypeDef]) -> None:
    import json

    conn.execute(
        """
        INSERT OR IGNORE INTO event_types (
            id, category, tier, conditions, actor_slots_json, weight,
            cooldown_weeks, supernatural_prob, narrative_template, consequences_template
        ) VALUES (
            'misc', 'misc', 'minor', 'true', '[]', 0.5,
            0, 0.0, '', ''
        )
        """
    )

    for et in types:
        conn.execute(
            """
            INSERT OR REPLACE INTO event_types (
                id, category, tier, conditions, actor_slots_json, weight,
                cooldown_weeks, supernatural_prob, narrative_template, consequences_template
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                et.id,
                et.category,
                et.tier,
                et.conditions,
                json.dumps([s.model_dump() for s in et.actor_slots], ensure_ascii=False),
                et.weight,
                et.cooldown_weeks,
                et.supernatural_prob,
                et.narrative_template,
                et.consequences_template,
            ),
        )


def evaluate_condition(expr: str, ctx: dict[str, Any]) -> bool:
    """极简条件 DSL：true/false、week>=N、简单比较。复杂表达式可后续扩展。"""
    expr = (expr or "true").strip()
    if expr.lower() in ("true", "1", "yes"):
        return True
    if expr.lower() in ("false", "0", "no"):
        return False
    m = re.match(r"^\s*week\s*([><=]+)\s*(\d+)\s*$", expr, re.I)
    if m:
        op, n = m.group(1), int(m.group(2))
        w = int(ctx.get("week", 0))
        if op == ">=":
            return w >= n
        if op == "<=":
            return w <= n
        if op == ">":
            return w > n
        if op == "<":
            return w < n
        if op == "==":
            return w == n
    return False


def last_event_week_of_type(conn: Any, type_id: str) -> int | None:
    row = conn.execute(
        "SELECT MAX(week_number) FROM events WHERE type_id = ?", (type_id,)
    ).fetchone()
    if row and row[0] is not None:
        return int(row[0])
    return None


def score_event_type(
    et: EventTypeDef,
    week: int,
    pacing_multiplier: float,
    conn: Any,
) -> tuple[float, str]:
    ctx = {"week": week}
    if not evaluate_condition(et.conditions, ctx):
        return 0.0, "条件不满足"
    lw = last_event_week_of_type(conn, et.id)
    if et.cooldown_weeks > 0 and lw is not None:
        if week - lw < et.cooldown_weeks:
            return 0.0, f"冷却中 (上次周 {lw})"
    score = et.weight * pacing_multiplier
    return score, "ok"


def pick_top_event_types(
    types: list[EventTypeDef],
    week: int,
    pacing_multiplier: float,
    conn: Any,
    k: int = 5,
) -> list[tuple[EventTypeDef, float, str]]:
    scored: list[tuple[EventTypeDef, float, str]] = []
    for et in types:
        s, reason = score_event_type(et, week, pacing_multiplier, conn)
        if s > 0:
            scored.append((et, s, reason))
    scored.sort(key=lambda x: -x[1])
    return scored[:k]
