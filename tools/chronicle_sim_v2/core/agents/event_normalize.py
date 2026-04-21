"""GM 产出的事件在入库前做与「相关人 / 传播人」一致的规整（兼容旧数据无两字段）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def _valid_agent_ids(run_dir: Path) -> set[str]:
    from tools.chronicle_sim_v2.core.world.seed_reader import read_all_agents

    out: set[str] = set()
    for a in read_all_agents(run_dir):
        aid = a.get("id") or a.get("name")
        if aid:
            out.add(str(aid).strip())
    return out


def normalize_event_for_rumors(run_dir: Path, rec: dict[str, Any]) -> None:
    """就地补全/修正 ``related_agents``、``spread_agents``；校验 ``witness_accounts`` 仅含已知 NPC。

    - ``related_agents``：相关人 id 列表（``witness`` 合法 id ∪ 事件 ``actor_ids`` ∪ ``truth_json.actor_ids``）。
    - ``spread_agents``：传播人，须为 ``related_agents`` 子集；若 GM 未给或非法，则用后备启发（优先 ``actor_ids``∩相关）。
    """
    valid = _valid_agent_ids(run_dir)
    witnesses = rec.get("witness_accounts") or []
    wit_ids: list[str] = []
    if isinstance(witnesses, list):
        for w in witnesses:
            if not isinstance(w, dict):
                continue
            aid = str(w.get("agent_id", "")).strip()
            if aid and aid in valid:
                wit_ids.append(aid)

    related: list[str] = list(dict.fromkeys(wit_ids))

    actors_raw = rec.get("actor_ids")
    if isinstance(actors_raw, list):
        for a in actors_raw:
            s = str(a).strip()
            if s and s in valid and s not in related:
                related.append(s)

    tj = rec.get("truth_json") or {}
    if isinstance(tj, dict):
        ta = tj.get("actor_ids")
        if isinstance(ta, list):
            for a in ta:
                s = str(a).strip()
                if s and s in valid and s not in related:
                    related.append(s)

    raw_rel = rec.get("related_agents")
    if isinstance(raw_rel, list):
        for a in raw_rel:
            s = str(a).strip()
            if s and s in valid and s not in related:
                related.append(s)

    rec["related_agents"] = related

    spread: list[str] = []
    raw_spread = rec.get("spread_agents")
    if isinstance(raw_spread, list):
        for a in raw_spread:
            s = str(a).strip()
            if s and s in valid and s in related and s not in spread:
                spread.append(s)

    if not spread:
        actors_set: set[str] = set()
        if isinstance(actors_raw, list):
            actors_set = {str(x).strip() for x in actors_raw if str(x).strip() in valid}
        cand = [x for x in related if x in actors_set]
        if cand:
            spread = cand
        elif related:
            spread = [related[0]]
        else:
            spread = []

    rec["spread_agents"] = spread
