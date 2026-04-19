"""周数据读写。"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.fs import read_json, read_text, write_json, write_text, list_dir


def week_dir_name(week: int) -> str:
    return f"week_{week:03d}"


def write_week_intent(run_dir: Path, week: int, agent_id: str, intent: dict[str, Any]) -> None:
    """写入 NPC 周意图。"""
    wdir = week_dir_name(week)
    write_json(run_dir, f"chronicle/{wdir}/intents/{agent_id}.json", intent)


def read_week_intents(run_dir: Path, week: int) -> list[dict[str, Any]]:
    """读取该周所有意图。"""
    wdir = week_dir_name(week)
    intents = []
    for fname in list_dir(run_dir, f"chronicle/{wdir}/intents"):
        data = read_json(run_dir, f"chronicle/{wdir}/intents/{fname}")
        if data is not None:
            intents.append(data)
    return intents


def write_event_record(run_dir: Path, week: int, event: dict[str, Any]) -> None:
    """写入事件记录。"""
    eid = event.get("id", event.get("type_id", "unknown"))
    wdir = week_dir_name(week)
    write_json(run_dir, f"chronicle/{wdir}/events/{eid}.json", event)


def read_week_events(run_dir: Path, week: int) -> list[dict[str, Any]]:
    """读取该周所有事件。"""
    wdir = week_dir_name(week)
    events = []
    for fname in list_dir(run_dir, f"chronicle/{wdir}/events"):
        data = read_json(run_dir, f"chronicle/{wdir}/events/{fname}")
        if data is not None:
            events.append(data)
    return events


def write_week_summary(run_dir: Path, week: int, text: str) -> None:
    """写入周总结。"""
    wdir = week_dir_name(week)
    write_text(run_dir, f"chronicle/{wdir}/summary.md", text)


def read_week_summary(run_dir: Path, week: int) -> str:
    """读取周总结。"""
    wdir = week_dir_name(week)
    return read_text(run_dir, f"chronicle/{wdir}/summary.md")


def write_week_rumors(run_dir: Path, week: int, rumors: list[dict[str, Any]]) -> None:
    """写入周谣言。"""
    wdir = week_dir_name(week)
    write_json(run_dir, f"chronicle/{wdir}/rumors.json", rumors)


def read_week_rumors(run_dir: Path, week: int) -> list[dict[str, Any]]:
    """读取周谣言。"""
    wdir = week_dir_name(week)
    data = read_json(run_dir, f"chronicle/{wdir}/rumors.json")
    return data if isinstance(data, list) else []


def write_agent_memory(run_dir: Path, week: int, agent_id: str, memory: dict[str, Any]) -> None:
    """写入 S 类 NPC 记忆。"""
    wdir = week_dir_name(week)
    write_json(run_dir, f"chronicle/{wdir}/memories/{agent_id}.json", memory)


def week_exists(run_dir: Path, week: int) -> bool:
    """检查该周目录是否存在。"""
    wdir = run_dir / "chronicle" / week_dir_name(week)
    return wdir.is_dir()


def list_weeks(run_dir: Path) -> list[int]:
    """列出已有周。"""
    chronicle = run_dir / "chronicle"
    if not chronicle.is_dir():
        return []
    weeks = []
    for d in os.listdir(chronicle):
        if d.startswith("week_") and (chronicle / d).is_dir():
            try:
                weeks.append(int(d.split("_")[1]))
            except ValueError:
                pass
    return sorted(weeks)


def write_week_trace(run_dir: Path, week: int, agent_id: str, record: dict[str, Any]) -> None:
    """写入 LLM 审计记录（追加）。"""
    wdir = week_dir_name(week)
    trace_dir = run_dir / "traces" / wdir
    trace_dir.mkdir(parents=True, exist_ok=True)
    trace_file = trace_dir / f"{agent_id}.jsonl"
    import json as _json
    with open(trace_file, "a", encoding="utf-8") as f:
        f.write(_json.dumps(record, ensure_ascii=False) + "\n")
