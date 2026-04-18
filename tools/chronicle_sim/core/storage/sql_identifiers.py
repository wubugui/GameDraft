"""SQLite 动态片段白名单：表名与列名校验。"""
from __future__ import annotations

import re

# 与 db.init_schema 中业务表一致（不含仅内部使用的可选项）
CHRONICLE_TABLE_NAMES: frozenset[str] = frozenset(
    {
        "runs",
        "agents",
        "tier_changes",
        "cold_memories",
        "cold_beliefs",
        "cold_agent_states",
        "npc_state_cards",
        "factions",
        "locations",
        "relationships",
        "social_graph_edges",
        "anchor_events",
        "event_types",
        "events",
        "event_witnesses",
        "beliefs",
        "rumors",
        "week_intents",
        "summaries",
        "week_snapshots",
        "director_decisions",
        "probe_sessions",
        "agent_memories",
    }
)

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def require_chronicle_table(name: str) -> str:
    if name not in CHRONICLE_TABLE_NAMES:
        raise ValueError(f"不允许的表名: {name!r}")
    return name


def validate_column_identifiers(columns: list[str]) -> None:
    for c in columns:
        if not _IDENTIFIER_RE.fullmatch(c):
            raise ValueError(f"非法列名: {c!r}")
