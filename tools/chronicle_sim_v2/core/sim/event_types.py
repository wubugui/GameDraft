"""事件类型：加载 YAML、评分、选择 top-k。"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

from tools.chronicle_sim_v2.core.schema.event_type import ActorSlotDef, EventTypeDef
from tools.chronicle_sim_v2.core.world.week_state import list_weeks, read_week_events
from tools.chronicle_sim_v2.paths import DATA_DIR


def load_event_types() -> list[EventTypeDef]:
    path = DATA_DIR / "event_types.yaml"
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


def evaluate_condition(expr: str, ctx: dict[str, Any]) -> bool:
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


def last_event_week_of_type(run_dir: Path, type_id: str) -> int | None:
    """查找该类型事件最后一次出现的周。"""
    weeks = list_weeks(run_dir)
    for w in reversed(weeks):
        events = read_week_events(run_dir, w)
        for ev in events:
            if ev.get("type_id") == type_id:
                return w
    return None


def score_event_type(
    et: EventTypeDef,
    week: int,
    pacing_multiplier: float,
    run_dir: Path,
) -> tuple[float, str]:
    ctx = {"week": week}
    if not evaluate_condition(et.conditions, ctx):
        return 0.0, "条件不满足"
    lw = last_event_week_of_type(run_dir, et.id)
    if et.cooldown_weeks > 0 and lw is not None:
        if week - lw < et.cooldown_weeks:
            return 0.0, f"冷却中 (上次周 {lw})"
    score = et.weight * pacing_multiplier
    return score, "ok"


def pick_top_event_types(
    types: list[EventTypeDef],
    week: int,
    pacing_multiplier: float,
    run_dir: Path,
    k: int = 5,
) -> list[tuple[EventTypeDef, float, str]]:
    scored: list[tuple[EventTypeDef, float, str]] = []
    for et in types:
        s, reason = score_event_type(et, week, pacing_multiplier, run_dir)
        if s > 0:
            scored.append((et, s, reason))
    scored.sort(key=lambda x: -x[1])
    return scored[:k]


def event_types_text_for_prompt(types: list[EventTypeDef]) -> str:
    """将事件类型格式化为可读文本，供 LLM prompt 使用。"""
    import json
    parts = []
    for et in types:
        parts.append(
            f"类型: {et.id}\n"
            f"  分类: {et.category}\n"
            f"  权重: {et.weight}\n"
            f"  冷却: {et.cooldown_weeks} 周\n"
            f"  角色槽: {json.dumps([{'role': s.role, 'tier_min': s.tier_min, 'tier_max': s.tier_max} for s in et.actor_slots], ensure_ascii=False)}"
        )
    return "\n\n".join(parts)
