"""事件类型：加载 YAML、冷却/条件、按权重抽样当周候选。"""
from __future__ import annotations

import hashlib
import random
import re
from pathlib import Path
from typing import Any

import yaml

from tools.chronicle_sim_v2.core.schema.event_type import ActorSlotDef, EventTypeDef
from tools.chronicle_sim_v2.core.world.week_state import list_weeks, read_week_events
from tools.chronicle_sim_v2.paths import DATA_DIR

DEFAULT_EVENT_PICK_MIN = 3
DEFAULT_EVENT_PICK_MAX = 6


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
        pw = it.get("pick_weight")
        if pw is None:
            pw = it.get("weight", 1.0)
        dbrief = it.get("dramatic_brief")
        if dbrief is None:
            dbrief = it.get("narrative_template", "")
        ebrief = it.get("effect_brief")
        if ebrief is None:
            ebrief = it.get("consequences_template", "")
        out.append(
            EventTypeDef(
                id=str(it["id"]),
                category=str(it.get("category", "misc")),
                tier=str(it.get("tier", "minor")),
                conditions=str(it.get("conditions", "true")),
                actor_slots=slots,
                pick_weight=float(pw),
                cooldown_weeks=int(it.get("cooldown_weeks", 0)),
                supernatural_prob=float(it.get("supernatural_prob", 0.0)),
                dramatic_brief=str(dbrief),
                effect_brief=str(ebrief),
                period_every_n_weeks=int(it.get("period_every_n_weeks", 0)),
                period_phase=int(it.get("period_phase", 0)),
                period_weight_mult=float(it.get("period_weight_mult", 2.0)),
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


def period_multiplier(et: EventTypeDef, week: int) -> float:
    n = et.period_every_n_weeks
    if n <= 0:
        return 1.0
    ph = et.period_phase % n
    if week % n == ph:
        return max(0.01, et.period_weight_mult)
    return 1.0


def eligibility_and_score(
    et: EventTypeDef,
    week: int,
    pacing_multiplier: float,
    run_dir: Path,
    *,
    ignore_cooldown: bool = False,
) -> tuple[float, str]:
    ctx = {"week": week}
    if not evaluate_condition(et.conditions, ctx):
        return 0.0, "条件不满足"
    if not ignore_cooldown:
        lw = last_event_week_of_type(run_dir, et.id)
        if et.cooldown_weeks > 0 and lw is not None:
            if week - lw < et.cooldown_weeks:
                return 0.0, f"冷却中 (上次周 {lw})"
    pm = period_multiplier(et, week)
    score = et.pick_weight * pacing_multiplier * pm
    if pm > 1.0:
        return score, f"ok (周期×{pm:g})"
    return score, "ok"


def score_event_type(
    et: EventTypeDef,
    week: int,
    pacing_multiplier: float,
    run_dir: Path,
) -> tuple[float, str]:
    """兼容旧调用：可参与排序的得分；0 表示本周不可用。"""
    return eligibility_and_score(et, week, pacing_multiplier, run_dir, ignore_cooldown=False)


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


def _week_rng(run_dir: Path, week: int) -> random.Random:
    raw = f"{run_dir.resolve()}|evpick|{week}".encode("utf-8")
    seed = int.from_bytes(hashlib.sha256(raw).digest()[:8], "little")
    return random.Random(seed)


def _weighted_sample_without_replacement(
    scored: list[tuple[EventTypeDef, float, str]], k: int, rng: random.Random
) -> list[tuple[EventTypeDef, float, str]]:
    pool = list(scored)
    out: list[tuple[EventTypeDef, float, str]] = []
    for _ in range(min(k, len(pool))):
        if not pool:
            break
        weights = [max(s, 1e-9) for _, s, _ in pool]
        total = sum(weights)
        if total <= 0:
            idx = rng.randrange(len(pool))
        else:
            idx = rng.choices(range(len(pool)), weights=weights, k=1)[0]
        out.append(pool.pop(idx))
    return out


def select_event_types_for_week(
    types: list[EventTypeDef],
    week: int,
    pacing_multiplier: float,
    run_dir: Path,
    *,
    min_types: int = DEFAULT_EVENT_PICK_MIN,
    max_types: int = DEFAULT_EVENT_PICK_MAX,
    rng: random.Random | None = None,
) -> tuple[list[EventTypeDef], str]:
    """
    从全集中按条件/冷却过滤后，用 pick_weight×节奏×周期 加权无放回抽样，得到当周交给 Director 的类型列表。
    返回 (入选列表, 给人读的说明文本)。
    """
    rng = rng or _week_rng(run_dir, week)
    min_t = max(1, min_types)
    max_t = max(min_t, max_types)

    scored: list[tuple[EventTypeDef, float, str]] = []
    for et in types:
        s, reason = eligibility_and_score(et, week, pacing_multiplier, run_dir, ignore_cooldown=False)
        if s > 0:
            scored.append((et, s, reason))

    detail_lines: list[str] = []
    if not scored:
        for et in types:
            s, reason = eligibility_and_score(et, week, pacing_multiplier, run_dir, ignore_cooldown=True)
            if s > 0:
                scored.append((et, s, reason))
                detail_lines.append("（当周无完全可用类型，已暂时忽略冷却以保底推进剧情。）")
                break

    if not scored:
        return [], "（错误：无任何可用事件类型，请检查 event_types.yaml 与周次条件。）"

    target = min(max_t, len(scored))
    low = min(min_t, len(scored))
    picked = _weighted_sample_without_replacement(scored, target, rng)
    picked_set = {et.id for et, _, _ in picked}

    if len(picked) < low:
        rest = [(et, s, r) for et, s, r in scored if et.id not in picked_set]
        rest.sort(key=lambda x: -x[1])
        for et, s, r in rest:
            if len(picked) >= low:
                break
            picked.append((et, s, r))
            picked_set.add(et.id)

    selected = [et for et, s, r in picked]
    lines = [
        f"本周第 {week} 周；系统从 {len(scored)} 个可用类型中加权抽样 {len(selected)} 个（min={min_t}, max={max_t}，节奏系数={pacing_multiplier:g}）。",
        "下列类型须各写一条草案（勿自造未列出 type_id）：",
    ]
    for i, (et, s, r) in enumerate(picked, 1):
        per = period_multiplier(et, week)
        per_note = f"，周期系数×{per:g}" if per > 1.0 else ""
        lines.append(
            f"{i}. `{et.id}`（{et.category}）— 有效权重≈{s:.3f}{per_note} ({r})；"
            f"戏剧母题：{et.dramatic_brief}"
        )
    lines.extend(detail_lines)
    return selected, "\n".join(lines)


def event_types_text_for_prompt(types: list[EventTypeDef]) -> str:
    """将事件类型格式化为可读文本，供 LLM prompt 使用。"""
    import json

    parts = []
    for et in types:
        per = ""
        pn = et.period_every_n_weeks
        if pn > 0:
            ph = et.period_phase % pn
            per = (
                f"\n  周期加码: 每 {pn} 周当 week%{pn}=={ph} 时 pick×{et.period_weight_mult:g}"
            )
        parts.append(
            f"类型: {et.id}\n"
            f"  分类: {et.category}\n"
            f"  pick_weight: {et.pick_weight}\n"
            f"  冷却: {et.cooldown_weeks} 周{per}\n"
            f"  戏剧母题（仅类型学，不得照抄为剧情）: {et.dramatic_brief}\n"
            f"  后果维度（抽象）: {et.effect_brief}\n"
            f"  角色槽（编排用，具体人选来自意图与种子）: {json.dumps([{'role': s.role, 'tier_min': s.tier_min, 'tier_max': s.tier_max} for s in et.actor_slots], ensure_ascii=False)}"
        )
    return "\n\n".join(parts)
