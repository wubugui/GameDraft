"""Seed 写入：SeedDraft → world/ 目录树。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.chroma import add_world_doc
from tools.chronicle_sim_v2.core.world.fs import write_json


def validate_seed_agents(seed: dict[str, Any]) -> list[str]:
    """校验 agents 数组中的重复 ID 和重名，返回问题列表。"""
    issues: list[str] = []
    agents = seed.get("agents") or []
    seen_ids: dict[str, int] = {}
    seen_names: dict[str, int] = {}
    for i, agent in enumerate(agents):
        aid = agent.get("id", agent.get("name", "unknown"))
        name = agent.get("name", agent.get("id", ""))
        if not aid:
            issues.append(f"第 {i + 1} 个 agent 缺少 id 和 name")
        elif aid in seen_ids:
            issues.append(f"id \"{aid}\" 重复（第 {seen_ids[aid] + 1} 和第 {i + 1} 个 agent）")
        else:
            seen_ids[aid] = i
        if name:
            if name in seen_names:
                issues.append(f"name \"{name}\" 重复（第 {seen_names[name] + 1} 和第 {i + 1} 个 agent）")
            else:
                seen_names[name] = i
    return issues


def write_seed_to_fs(run_dir: Path, seed: dict[str, Any]) -> None:
    """将 SeedDraft 写入世界目录树。

    seed 格式灵活，不强制字段匹配。期望包含：
    - agents: list[dict] — NPC 列表
    - factions: list[dict] — 势力列表
    - locations: list[dict] — 地点列表
    - relationships: list[dict] — 关系边
    - world_setting: dict — 世界背景
    - anchor_events: list[dict] — 锚点事件
    - social_graph_edges: list[dict] — 社交图
    - 其他自定义字段
    """
    # 写入 agents
    agents = seed.get("agents") or []
    for agent in agents:
        aid = agent.get("id", agent.get("name", "unknown"))
        write_json(run_dir, f"world/agents/{aid}.json", agent)

    # 写入 factions
    factions = seed.get("factions") or []
    for fac in factions:
        fid = fac.get("id", fac.get("name", "unknown"))
        write_json(run_dir, f"world/factions/{fid}.json", fac)

    # 写入 locations
    locations = seed.get("locations") or []
    for loc in locations:
        lid = loc.get("id", loc.get("name", "unknown"))
        write_json(run_dir, f"world/locations/{lid}.json", loc)

    # 写入关系图
    relationships = seed.get("relationships") or seed.get("social_graph_edges") or []
    if relationships:
        write_json(run_dir, "world/relationships/graph.json", relationships)

    # 写入世界设定
    world_setting = seed.get("world_setting") or {}
    if world_setting:
        write_json(run_dir, "world/world_setting.json", world_setting)

    # 写入设计支柱
    design_pillars = seed.get("design_pillars") or []
    if design_pillars:
        write_json(run_dir, "world/design_pillars.json", design_pillars)

    # 写入锚点事件
    anchor_events = seed.get("anchor_events") or []
    if anchor_events:
        write_json(run_dir, "world/anchor_events.json", anchor_events)

    # 写入自定义段落
    custom = seed.get("custom_sections") or {}
    if custom:
        write_json(run_dir, "world/custom_sections.json", custom)

    # 索引到 ChromaDB world collection
    _index_to_chroma(run_dir, seed)


def _index_to_chroma(run_dir: Path, seed: dict[str, Any]) -> None:
    """将种子内容索引到 world ChromaDB。"""
    # 世界设定摘要
    ws = seed.get("world_setting") or {}
    if isinstance(ws, dict):
        text = json.dumps(ws, ensure_ascii=False)
        add_world_doc(run_dir, "world_setting", text, {"kind": "world_setting"})

    # NPC 摘要
    for agent in seed.get("agents") or []:
        aid = agent.get("id", agent.get("name", "unknown"))
        text = json.dumps(agent, ensure_ascii=False)
        add_world_doc(run_dir, f"agent:{aid}", text, {"kind": "agent", "agent_id": aid})

    # 势力摘要
    for fac in seed.get("factions") or []:
        fid = fac.get("id", fac.get("name", "unknown"))
        text = json.dumps(fac, ensure_ascii=False)
        add_world_doc(run_dir, f"faction:{fid}", text, {"kind": "faction"})

    # 地点摘要
    for loc in seed.get("locations") or []:
        lid = loc.get("id", loc.get("name", "unknown"))
        text = json.dumps(loc, ensure_ascii=False)
        add_world_doc(run_dir, f"location:{lid}", text, {"kind": "location"})
