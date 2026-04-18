from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from tools.chronicle_sim.core.schema.models import NpcTier
from tools.chronicle_sim.core.storage import cold_storage


class TierApplyMode(str, Enum):
    NEXT_WEEK = "next_week"
    IMMEDIATE = "immediate"


@dataclass
class TierChangeRequest:
    agent_id: str
    new_tier: NpcTier
    author_note: str = ""
    mode: TierApplyMode = TierApplyMode.NEXT_WEEK


class TierManager:
    """Tier 变更队列与应用（降级冷存、升级回填在 orchestrator 里调）。"""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._pending: list[TierChangeRequest] = []

    def queue(self, req: TierChangeRequest) -> None:
        row = self._conn.execute(
            "SELECT current_tier FROM agents WHERE id = ?", (req.agent_id,)
        ).fetchone()
        if not row:
            return
        old = row[0]
        self._conn.execute(
            """
            INSERT INTO tier_changes (agent_id, old_tier, new_tier, pending_flag, applied_mode, applied_week)
            VALUES (?,?,?,?,?,NULL)
            """,
            (req.agent_id, old, req.new_tier.value, 1, req.mode.value),
        )
        if req.mode == TierApplyMode.IMMEDIATE:
            self._pending.append(req)
        else:
            self._pending.append(req)

    def apply_pending(
        self,
        week: int,
        on_upgrade: Callable[[str, NpcTier, NpcTier], None] | None = None,
        on_downgrade: Callable[[str, NpcTier, NpcTier], None] | None = None,
    ) -> None:
        rows = self._conn.execute(
            "SELECT * FROM tier_changes WHERE pending_flag = 1 ORDER BY change_id"
        ).fetchall()
        for r in rows:
            aid = r["agent_id"]
            old_t = NpcTier(r["old_tier"])
            new_t = NpcTier(r["new_tier"])
            if old_t == new_t:
                self._conn.execute(
                    "UPDATE tier_changes SET pending_flag = 0, applied_week = ? WHERE change_id = ?",
                    (week, r["change_id"]),
                )
                continue
            if new_t.value in ("S", "A") and old_t.value == "B":
                if on_upgrade:
                    on_upgrade(aid, old_t, new_t)
            elif new_t.value == "B" and old_t.value in ("S", "A"):
                if on_downgrade:
                    on_downgrade(aid, old_t, new_t)
            self._conn.execute(
                "UPDATE agents SET current_tier = ? WHERE id = ?", (new_t.value, aid)
            )
            self._conn.execute(
                "UPDATE tier_changes SET pending_flag = 0, applied_week = ? WHERE change_id = ?",
                (week, r["change_id"]),
            )

    def downgrade_to_b(
        self,
        agent_id: str,
        week: int,
        reason: str,
        dump_memories_fn: Callable[[], list[dict[str, Any]]],
        dump_state_fn: Callable[[], dict[str, Any]],
        run_dir: Path | None = None,
    ) -> None:
        mem_rows = dump_memories_fn()
        cold_storage.freeze_memories(self._conn, agent_id, week, reason, mem_rows)
        beliefs = cold_storage.clear_beliefs_for_holder(self._conn, agent_id)
        cold_storage.freeze_beliefs(self._conn, agent_id, week, beliefs)
        st = dump_state_fn()
        cold_storage.freeze_agent_state(self._conn, agent_id, week, st)
        cold_storage.clear_agent_memories_table(self._conn, agent_id)
        if run_dir is not None:
            from tools.chronicle_sim.core.runtime.memory_store import purge_chroma_for_owner

            purge_chroma_for_owner(run_dir, agent_id)
