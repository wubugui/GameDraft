"""Seed 读取：world/ 目录树 → 上下文文本。"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.fs import read_json, read_text


def read_world_setting(run_dir: Path) -> dict[str, Any]:
    """读取世界背景设定。"""
    return read_json(run_dir, "world/world_setting.json") or {}


def read_all_agents(run_dir: Path) -> list[dict[str, Any]]:
    """读取所有 NPC。"""
    agents_dir = run_dir / "world" / "agents"
    if not agents_dir.is_dir():
        return []
    agents = []
    for f in sorted(os.listdir(agents_dir)):
        if not f.endswith(".json"):
            continue
        data = read_json(run_dir, f"world/agents/{f}")
        if data is not None:
            agents.append(data)
    return agents


def read_agent(run_dir: Path, agent_id: str) -> dict[str, Any] | None:
    """读取单个 NPC。"""
    return read_json(run_dir, f"world/agents/{agent_id}.json")


def read_all_factions(run_dir: Path) -> list[dict[str, Any]]:
    """读取所有势力。"""
    factions_dir = run_dir / "world" / "factions"
    if not factions_dir.is_dir():
        return []
    factions = []
    for f in sorted(os.listdir(factions_dir)):
        if not f.endswith(".json"):
            continue
        data = read_json(run_dir, f"world/factions/{f}")
        if data is not None:
            factions.append(data)
    return factions


def read_all_locations(run_dir: Path) -> list[dict[str, Any]]:
    """读取所有地点。"""
    locs_dir = run_dir / "world" / "locations"
    if not locs_dir.is_dir():
        return []
    locs = []
    for f in sorted(os.listdir(locs_dir)):
        if not f.endswith(".json"):
            continue
        data = read_json(run_dir, f"world/locations/{f}")
        if data is not None:
            locs.append(data)
    return locs


def read_social_graph(run_dir: Path) -> list[dict[str, Any]]:
    """读取社交图。"""
    data = read_json(run_dir, "world/relationships/graph.json")
    return data if isinstance(data, list) else []


def read_anchor_events(run_dir: Path) -> list[dict[str, Any]]:
    """读取锚点事件。"""
    data = read_json(run_dir, "world/anchor_events.json")
    return data if isinstance(data, list) else []


def read_design_pillars(run_dir: Path) -> list[Any]:
    """读取设计支柱。"""
    data = read_json(run_dir, "world/design_pillars.json")
    return data if isinstance(data, list) else []


def build_world_bible_text(run_dir: Path) -> str:
    """构建世界设定全文（用于 Agent prompt 上下文）。"""
    parts = []

    ws = read_world_setting(run_dir)
    if ws:
        parts.append("【世界背景】\n" + json.dumps(ws, ensure_ascii=False))

    pillars = read_design_pillars(run_dir)
    if pillars:
        parts.append("【设计支柱】\n" + json.dumps(pillars, ensure_ascii=False))

    factions = read_all_factions(run_dir)
    if factions:
        parts.append("【势力】\n" + json.dumps(factions, ensure_ascii=False))

    locations = read_all_locations(run_dir)
    if locations:
        parts.append("【地点】\n" + json.dumps(locations, ensure_ascii=False))

    anchors = read_anchor_events(run_dir)
    if anchors:
        parts.append("【锚点事件】\n" + json.dumps(anchors, ensure_ascii=False))

    return "\n\n".join(parts)


def build_agent_context(run_dir: Path, agent_id: str) -> str:
    """构建单个 NPC 的上下文文本。"""
    agent = read_agent(run_dir, agent_id)
    if not agent:
        return ""
    parts = [f"【{agent.get('name', agent_id)}】"]
    parts.append(json.dumps(agent, ensure_ascii=False))

    graph = read_social_graph(run_dir)
    relations = [e for e in graph if e.get("from_agent_id") == agent_id or e.get("to_agent_id") == agent_id]
    if relations:
        parts.append("【关系】\n" + json.dumps(relations, ensure_ascii=False))

    return "\n\n".join(parts)


def load_active_agent_ids_with_tier(run_dir: Path) -> list[tuple[str, str]]:
    """返回 [(agent_id, tier)] 列表，仅包含活跃 NPC。"""
    agents = read_all_agents(run_dir)
    result = []
    for a in agents:
        aid = a.get("id", a.get("name"))
        tier = a.get("current_tier", a.get("tier", a.get("suggested_tier", "B")))
        life = a.get("life_status", "alive")
        if aid and life == "alive":
            result.append((str(aid), str(tier)))
    return result
