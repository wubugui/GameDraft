"""Tier 管理：动态升降级 + 冷存储。"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.fs import read_json, read_text, write_json, write_text


def apply_pending_tier_changes(run_dir: Path) -> list[tuple[str, str, str]]:
    """应用 pending 的 tier 变更，返回 [(agent_id, old_tier, new_tier)]。"""
    pending_dir = run_dir / "config" / "pending"
    if not pending_dir.is_dir():
        return []

    results = []
    for f in sorted(os.listdir(pending_dir)):
        if not f.startswith("tier_") or not f.endswith(".json"):
            continue
        data = read_json(run_dir, f"config/pending/{f}")
        if not data:
            continue
        agent_id = data.get("agent_id", "")
        new_tier = data.get("new_tier", "")
        if not agent_id or not new_tier:
            continue

        # 读取当前 tier
        agent_file = f"world/agents/{agent_id}.json"
        agent_data = read_json(run_dir, agent_file)
        if agent_data is None:
            continue
        old_tier = agent_data.get("current_tier", agent_data.get("tier", "B"))

        if str(old_tier) == str(new_tier):
            continue

        # 处理升降级
        if _is_upgrade(old_tier, new_tier):
            _do_upgrade(run_dir, agent_id, old_tier, new_tier)
        elif _is_downgrade(old_tier, new_tier):
            _do_downgrade(run_dir, agent_id, old_tier, new_tier)

        # 更新 agent 文件
        agent_data["current_tier"] = new_tier
        agent_data["tier"] = new_tier
        write_json(run_dir, agent_file, agent_data)

        results.append((agent_id, str(old_tier), str(new_tier)))

        # 删除 pending 文件
        try:
            os.unlink(pending_dir / f)
        except OSError:
            pass

    return results


def queue_tier_change(run_dir: Path, agent_id: str, new_tier: str) -> None:
    """将 tier 变更写入 pending 目录。"""
    from uuid import uuid4
    pending_dir = run_dir / "config" / "pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    data = {"agent_id": agent_id, "new_tier": new_tier}
    write_json(run_dir, f"config/pending/tier_{agent_id}_{uuid4().hex[:6]}.json", data)


def _is_upgrade(old: str, new: str) -> bool:
    order = {"B": 0, "C": 0, "A": 1, "S": 2}
    return order.get(str(new).upper(), 0) > order.get(str(old).upper(), 0)


def _is_downgrade(old: str, new: str) -> bool:
    order = {"B": 0, "C": 0, "A": 1, "S": 2}
    return order.get(str(new).upper(), 0) < order.get(str(old).upper(), 0)


def _do_upgrade(run_dir: Path, agent_id: str, old_tier: str, new_tier: str) -> None:
    """升级：从冷存储恢复记忆（如果有）。"""
    cold_dir = run_dir / "cold_storage" / agent_id
    if not cold_dir.is_dir():
        return

    # 恢复记忆文件
    memories_file = cold_dir / "memories.jsonl"
    if memories_file.is_file():
        content = memories_file.read_text(encoding="utf-8")
        # 写入最新周的记忆目录
        from tools.chronicle_sim_v2.core.world.week_state import list_weeks
        weeks = list_weeks(run_dir)
        current_week = weeks[-1] if weeks else 1
        week_name = f"week_{current_week:03d}"
        mem_dir = run_dir / "chronicle" / week_name / "memories"
        mem_dir.mkdir(parents=True, exist_ok=True)
        (mem_dir / f"{agent_id}.jsonl").write_text(content, encoding="utf-8")

    # 清理冷存储
    shutil.rmtree(cold_dir, ignore_errors=True)


def _do_downgrade(run_dir: Path, agent_id: str, old_tier: str, new_tier: str) -> None:
    """降级：将记忆归档到冷存储。"""
    cold_dir = run_dir / "cold_storage" / agent_id
    cold_dir.mkdir(parents=True, exist_ok=True)

    # 查找该 agent 的所有记忆文件
    chronicle_dir = run_dir / "chronicle"
    if not chronicle_dir.is_dir():
        return

    all_memories = []
    for week_dir in sorted(os.listdir(chronicle_dir)):
        mem_file = chronicle_dir / week_dir / "memories" / f"{agent_id}.json"
        if mem_file.is_file():
            data = read_json(run_dir, f"chronicle/{week_dir}/memories/{agent_id}.json")
            if data:
                all_memories.append(data)
            # 删除原文件
            try:
                os.unlink(mem_file)
            except OSError:
                pass

    if all_memories:
        # 写入冷存储
        cold_file = cold_dir / "memories.jsonl"
        with open(cold_file, "w", encoding="utf-8") as f:
            for m in all_memories:
                f.write(json.dumps(m, ensure_ascii=False) + "\n")
