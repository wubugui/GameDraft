"""替换或删除 agent 前清理关联行，避免孤儿数据。"""
from __future__ import annotations

import sqlite3


def purge_agent_graph_data(conn: sqlite3.Connection, agent_id: str) -> None:
    """删除与 agent_id 相关的图、意图、记忆、见证、belief holder、冷存、传闻端点等。"""
    aid = agent_id
    conn.execute("DELETE FROM week_intents WHERE agent_id = ?", (aid,))
    conn.execute("DELETE FROM agent_memories WHERE owner_agent_id = ?", (aid,))
    conn.execute("DELETE FROM beliefs WHERE holder_id = ?", (aid,))
    conn.execute("DELETE FROM event_witnesses WHERE agent_id = ?", (aid,))
    conn.execute("DELETE FROM tier_changes WHERE agent_id = ?", (aid,))
    conn.execute("DELETE FROM cold_memories WHERE agent_id = ?", (aid,))
    conn.execute("DELETE FROM cold_beliefs WHERE agent_id = ?", (aid,))
    conn.execute("DELETE FROM cold_agent_states WHERE agent_id = ?", (aid,))
    conn.execute(
        "DELETE FROM social_graph_edges WHERE from_agent_id = ? OR to_agent_id = ?",
        (aid, aid),
    )
    conn.execute(
        "DELETE FROM relationships WHERE from_agent_id = ? OR to_agent_id = ?",
        (aid, aid),
    )
    conn.execute(
        "DELETE FROM rumors WHERE teller_id = ? OR hearer_id = ?",
        (aid, aid),
    )
    conn.execute("DELETE FROM npc_state_cards WHERE agent_id = ?", (aid,))
