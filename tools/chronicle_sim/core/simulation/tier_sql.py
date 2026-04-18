from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.storage import cold_storage


def apply_tier_downgrade_sql(
    conn: sqlite3.Connection,
    agent_id: str,
    week: int,
    reason: str = "tier_queue",
    *,
    run_dir: Path | None = None,
) -> None:
    rows = conn.execute(
        "SELECT * FROM agent_memories WHERE owner_agent_id = ?", (agent_id,)
    ).fetchall()
    cold_storage.freeze_memories(
        conn, agent_id, week, reason, [dict(r) for r in rows]
    )
    bel = cold_storage.clear_beliefs_for_holder(conn, agent_id)
    cold_storage.freeze_beliefs(conn, agent_id, week, bel)
    cold_storage.freeze_agent_state(conn, agent_id, week, {})
    cold_storage.clear_agent_memories_table(conn, agent_id)
    if run_dir is not None:
        from tools.chronicle_sim.core.runtime.memory_store import purge_chroma_for_owner

        purge_chroma_for_owner(run_dir, agent_id)


def apply_tier_upgrade_sql(conn: sqlite3.Connection, agent_id: str, week: int) -> None:
    payload = cold_storage.latest_cold_memories(conn, agent_id)
    if payload:
        for m in payload:
            conn.execute(
                """
                INSERT INTO agent_memories (owner_agent_id, week, content)
                VALUES (?,?,?)
                """,
                (agent_id, int(m.get("week", week)), str(m.get("content", ""))),
            )
        conn.execute(
            "INSERT INTO agent_memories (owner_agent_id, week, content) VALUES (?,?,?)",
            (agent_id, week, "[回到舞台] 自冷存恢复记忆，上周起重新参与周循环。"),
        )
        return
    rows = conn.execute(
        """
        SELECT e.week_number, w.account_text
        FROM event_witnesses w
        JOIN events e ON e.id = w.event_id
        WHERE w.agent_id = ?
        ORDER BY e.week_number DESC
        LIMIT 12
        """,
        (agent_id,),
    ).fetchall()
    for r in rows:
        conn.execute(
            "INSERT INTO agent_memories (owner_agent_id, week, content) VALUES (?,?,?)",
            (agent_id, int(r[0]), "回溯亲历：" + str(r[1])[:1500]),
        )
    if rows:
        conn.execute(
            "INSERT INTO agent_memories (owner_agent_id, week, content) VALUES (?,?,?)",
            (agent_id, week, "[升格] 自事件见证回溯生成初始记忆。"),
        )
