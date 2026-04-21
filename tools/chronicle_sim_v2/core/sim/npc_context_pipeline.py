"""NPC 意图增强数据：可观察环境、邻接摘要、公开摘要、信念更新、意图结果（全落盘）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.fs import read_json, write_json
from tools.chronicle_sim_v2.core.world.seed_reader import read_agent, read_all_locations
from tools.chronicle_sim_v2.core.world.social_graph import get_neighbors
from tools.chronicle_sim_v2.core.world.week_state import (
    read_week_events,
    read_week_intents,
    read_week_rumors,
    week_dir_name,
)
from tools.chronicle_sim_v2.core.sim.npc_event_visibility import event_directly_involves_agent


def location_id_for_agent(run_dir: Path, agent: dict[str, Any]) -> str:
    """从 NPC 的 ``current_location`` / ``location_hint`` 尽量对齐到 ``locations`` 里的 ``id``。"""
    locs = read_all_locations(run_dir)
    by_name = {str(l.get("name", "")).strip(): str(l.get("id", "")).strip() for l in locs if l.get("id")}
    by_id = {str(l.get("id", "")).strip(): str(l.get("id", "")).strip() for l in locs if l.get("id")}
    cur = str(agent.get("current_location", "") or "").strip()
    hint = str(agent.get("location_hint", "") or "").strip()
    for key in (cur, hint):
        if not key:
            continue
        if key in by_id:
            return key
        if key in by_name:
            return by_name[key]
    return ""


def build_world_observation(run_dir: Path, week: int, active_agent_ids: list[str]) -> dict[str, Any]:
    """聚合「本周意图生成前」可观察在场：地点 → 可能出现的 NPC（不设剧情真相）。

    依据：各 NPC ``world/agents`` 内 ``current_location``/``location_hint`` 对齐到 ``loc_*``；
    上周意图里 ``current_location`` 若存在；上周事件的 ``location_id`` + 参与人。
    """
    prev = week - 1
    loc_to_agents: dict[str, set[str]] = {}

    def add(loc: str, aid: str) -> None:
        if not loc or not aid:
            return
        loc = str(loc).strip()
        aid = str(aid).strip()
        if aid == "tier_b_group":
            return
        loc_to_agents.setdefault(loc, set()).add(aid)

    for aid in active_agent_ids:
        ag = read_agent(run_dir, aid) or {}
        lid = location_id_for_agent(run_dir, ag)
        if lid:
            add(lid, aid)

    if prev >= 1:
        wdir = week_dir_name(prev)
        for intent in read_week_intents(run_dir, prev):
            if not isinstance(intent, dict):
                continue
            ia = str(intent.get("agent_id", "") or intent.get("npc_id", "") or "").strip()
            if not ia or ia not in active_agent_ids:
                continue
            loc = str(intent.get("current_location", "") or intent.get("location_id", "") or "").strip()
            if loc and loc.startswith("loc_"):
                add(loc, ia)

        for ev in read_week_events(run_dir, prev):
            if not isinstance(ev, dict):
                continue
            lid = str(ev.get("location_id") or "").strip()
            if not lid:
                continue
            for key in ("actor_ids", "related_agents", "spread_agents"):
                raw = ev.get(key)
                if isinstance(raw, list):
                    for x in raw:
                        s = str(x).strip()
                        if s and s != "tier_b_group":
                            add(lid, s)
            for w in ev.get("witness_accounts") or []:
                if isinstance(w, dict):
                    waid = str(w.get("agent_id", "") or "").strip()
                    if waid and waid != "tier_b_group":
                        add(lid, waid)

    locs_meta = read_all_locations(run_dir)
    id_to_name = {str(l.get("id", "")): str(l.get("name", "")) for l in locs_meta if l.get("id")}

    spots: list[dict[str, Any]] = []
    for lid, ids in sorted(loc_to_agents.items(), key=lambda x: x[0]):
        spots.append(
            {
                "location_id": lid,
                "location_name": id_to_name.get(lid, lid),
                "present_agent_ids": sorted(ids)[:40],
                "headcount": len(ids),
            }
        )

    return {"week": week, "schema_version": 1, "locations": spots}


def neighbor_subgraph_for_prompt(run_dir: Path, agent_id: str, *, limit: int = 14) -> list[dict[str, Any]]:
    neigh = get_neighbors(run_dir, agent_id)
    neigh.sort(key=lambda t: -float(t[1] or 0))
    out: list[dict[str, Any]] = []
    for nid, strength, etype in neigh[:limit]:
        sid = str(nid).strip()
        if sid:
            out.append({"peer_id": sid, "edge_type": str(etype or ""), "strength": float(strength or 0.5)})
    return out


def _truth_public_line(truth: dict[str, Any]) -> str:
    """只摘「公开层」字段，不用 ``what_happened`` 全文，避免把 GM 私密叙述当布告。"""
    wk = truth.get("who_knows_what")
    if isinstance(wk, dict):
        for k in ("公开", "public", "坊间"):
            v = wk.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()[:220]
    for k in ("public_summary", "street_talk"):
        v = truth.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:220]
    return ""


def build_public_digest(run_dir: Path, week: int, events: list[dict[str, Any]]) -> dict[str, Any]:
    """仅从已落盘事件的「公开层」字段摘句，不含 GM 私密键的专门展开。"""
    notices: list[dict[str, Any]] = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        truth = ev.get("truth_json") if isinstance(ev.get("truth_json"), dict) else {}
        line = _truth_public_line(truth)
        if not line:
            continue
        notices.append(
            {
                "event_id": ev.get("id"),
                "type_id": ev.get("type_id"),
                "location_id": ev.get("location_id"),
                "text": line,
            }
        )
    return {"week": week, "schema_version": 1, "notices": notices[:20]}


def _ensure_chronicle_state(agent: dict[str, Any]) -> dict[str, Any]:
    cs = agent.get("chronicle_state")
    if not isinstance(cs, dict):
        cs = {}
    cs.setdefault("purse_silver", 0)
    cs.setdefault("stress", 0)
    cs.setdefault("flags", {})
    return cs


def apply_chronicle_state_from_events(run_dir: Path, week: int, events: list[dict[str, Any]]) -> None:
    """规则向 ``world/agents/*.json`` 的 ``chronicle_state`` 写入轻量 delta（无 GM 全量 truth）。"""
    involved: set[str] = set()

    def collect(ev: dict[str, Any]) -> None:
        for key in ("actor_ids", "related_agents"):
            raw = ev.get(key)
            if isinstance(raw, list):
                for x in raw:
                    s = str(x).strip()
                    if s and s != "tier_b_group":
                        involved.add(s)
        for w in ev.get("witness_accounts") or []:
            if isinstance(w, dict):
                s = str(w.get("agent_id", "") or "").strip()
                if s and s != "tier_b_group":
                    involved.add(s)

    for ev in events:
        if isinstance(ev, dict):
            collect(ev)

    for ev in events:
        if not isinstance(ev, dict):
            continue
        tid = str(ev.get("type_id", "") or "").lower()
        local: set[str] = set()
        for key in ("actor_ids", "related_agents"):
            raw = ev.get(key)
            if isinstance(raw, list):
                for x in raw:
                    s = str(x).strip()
                    if s and s != "tier_b_group":
                        local.add(s)
        for aid in local:
            path = f"world/agents/{aid}.json"
            data = read_json(run_dir, path)
            if not isinstance(data, dict):
                continue
            cs = _ensure_chronicle_state(data)
            old = dict(cs.get("flags", {})) if isinstance(cs.get("flags"), dict) else {}
            if "supernatural" in tid or "omen" in tid:
                cs["stress"] = min(10, int(cs.get("stress", 0) or 0) + 1)
            if "debt" in tid:
                old["debt_pressure_week"] = week
                cs["flags"] = old
            data["chronicle_state"] = cs
            write_json(run_dir, path, data)


def _beliefs_path(run_dir: Path, week: int, agent_id: str) -> str:
    return f"chronicle/{week_dir_name(week)}/beliefs/{agent_id}.json"


def load_beliefs(run_dir: Path, week: int, agent_id: str) -> dict[str, Any]:
    p = _beliefs_path(run_dir, week, agent_id)
    data = read_json(run_dir, p)
    if isinstance(data, dict) and isinstance(data.get("claims"), list):
        return data
    return {"claims": [], "schema_version": 1}


def save_beliefs(run_dir: Path, week: int, agent_id: str, payload: dict[str, Any]) -> None:
    wdir = week_dir_name(week)
    (run_dir / "chronicle" / wdir / "beliefs").mkdir(parents=True, exist_ok=True)
    write_json(run_dir, _beliefs_path(run_dir, week, agent_id), payload)


def update_beliefs_end_of_week(
    run_dir: Path,
    week: int,
    events: list[dict[str, Any]],
    rumors: list[dict[str, Any]],
    active_ids: set[str],
) -> None:
    """周末更新信念：亲历事件提高置信度；谣言较低；跨周衰减。"""
    decay = 0.92
    for aid in active_ids:
        prev = load_beliefs(run_dir, week - 1, aid) if week > 1 else {"claims": [], "schema_version": 1}
        claims: list[dict[str, Any]] = []
        for c in prev.get("claims") or []:
            if not isinstance(c, dict):
                continue
            conf = float(c.get("confidence", 0.5) or 0) * decay
            if conf >= 0.12:
                c2 = dict(c)
                c2["confidence"] = round(conf, 3)
                claims.append(c2)

        for ev in events:
            if not isinstance(ev, dict):
                continue
            if not event_directly_involves_agent(run_dir, aid, ev):
                continue
            eid = str(ev.get("id", "") or "")
            truth = ev.get("truth_json") if isinstance(ev.get("truth_json"), dict) else {}
            snippet = str(truth.get("what_happened", "") or "")[:200]
            claims.append(
                {
                    "source": "event",
                    "ref_id": eid,
                    "text": snippet,
                    "confidence": 0.82,
                }
            )

        for r in rumors:
            if not isinstance(r, dict):
                continue
            tid = str(r.get("teller_id", "") or "").strip()
            hid = str(r.get("hearer_id", "") or "").strip()
            if tid != aid and hid != aid:
                continue
            role = "heard" if hid == aid else "spread"
            claims.append(
                {
                    "source": "rumor",
                    "ref_id": str(r.get("originating_event_id", "") or ""),
                    "role": role,
                    "text": str(r.get("content", "") or "")[:200],
                    "confidence": 0.38 if role == "heard" else 0.55,
                }
            )

        claims.sort(key=lambda x: -float(x.get("confidence", 0)))
        save_beliefs(run_dir, week, aid, {"schema_version": 1, "claims": claims[:24]})


def write_world_observation_file(run_dir: Path, week: int, active_agent_ids: list[str]) -> None:
    obs = build_world_observation(run_dir, week, active_agent_ids)
    wdir = week_dir_name(week)
    write_json(run_dir, f"chronicle/{wdir}/world_observation.json", obs)


def write_public_digest_file(run_dir: Path, week: int, events: list[dict[str, Any]]) -> None:
    pub = build_public_digest(run_dir, week, events)
    wdir = week_dir_name(week)
    write_json(run_dir, f"chronicle/{wdir}/public_digest.json", pub)


def write_intent_outcomes(run_dir: Path, week: int, intents: list[dict[str, Any]], events: list[dict[str, Any]]) -> None:
    """粗粒度：若本周有事涉及该 NPC，标 involved；否则 unclear。"""
    wdir = week_dir_name(week)
    outp = run_dir / "chronicle" / wdir / "intent_outcomes"
    outp.mkdir(parents=True, exist_ok=True)
    for it in intents:
        if not isinstance(it, dict):
            continue
        aid = str(it.get("agent_id", "") or "").strip()
        if not aid or aid == "tier_b_group":
            continue
        involved = any(
            isinstance(ev, dict) and event_directly_involves_agent(run_dir, aid, ev) for ev in events
        )
        rec = {
            "week": week,
            "agent_id": aid,
            "status": "involved_in_event" if involved else "unclear",
            "intent_excerpt": str(it.get("intent_text", "") or "")[:160],
            "schema_version": 1,
        }
        write_json(run_dir, f"chronicle/{wdir}/intent_outcomes/{aid}.json", rec)


def faction_pressure_lines(run_dir: Path, *, limit: int = 6) -> list[str]:
    """``world/factions/*.json`` 若含 ``weekly_pressure`` 文本则纳入。"""
    fac_dir = run_dir / "world" / "factions"
    if not fac_dir.is_dir():
        return []
    lines: list[str] = []
    for p in sorted(fac_dir.glob("*.json")):
        data = read_json(run_dir, f"world/factions/{p.name}")
        if not isinstance(data, dict):
            continue
        txt = data.get("weekly_pressure") or data.get("this_week_pressure")
        if isinstance(txt, str) and txt.strip():
            name = str(data.get("name", p.stem))
            lines.append(f"{name}: {txt.strip()[:200]}")
        if len(lines) >= limit:
            break
    return lines
