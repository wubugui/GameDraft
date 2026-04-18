from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from tools.chronicle_sim.core.schema.models import NpcTier, SeedDraft
from tools.chronicle_sim.core.storage.agent_purge import purge_agent_graph_data


def apply_seed_draft(conn: sqlite3.Connection, draft: SeedDraft, default_tier: NpcTier = NpcTier.B) -> None:
    ws = draft.world_setting if isinstance(draft.world_setting, dict) else {}
    pillars = draft.design_pillars or []
    customs = draft.custom_sections or []
    conn.execute(
        """
        INSERT OR REPLACE INTO world_seed (id, world_setting_json, design_pillars_json, custom_sections_json, updated_at)
        VALUES (1, ?, ?, ?, datetime('now'))
        """,
        (
            json.dumps(ws, ensure_ascii=False),
            json.dumps(pillars, ensure_ascii=False),
            json.dumps(customs, ensure_ascii=False),
        ),
    )
    for f in draft.factions:
        conn.execute(
            "INSERT OR REPLACE INTO factions (id, name, description) VALUES (?,?,?)",
            (f.get("id"), f.get("name", ""), f.get("description", "")),
        )
    for loc in draft.locations:
        conn.execute(
            "INSERT OR REPLACE INTO locations (id, name, description) VALUES (?,?,?)",
            (loc.get("id"), loc.get("name", ""), loc.get("description", "")),
        )
    for a in draft.agents:
        tid = str(a.get("id"))
        exists = conn.execute("SELECT 1 FROM agents WHERE id = ?", (tid,)).fetchone()
        if exists:
            purge_agent_graph_data(conn, tid)
        st = a.get("suggested_tier") or default_tier.value
        name = str(a.get("name", tid))
        reason = str(a.get("reason", ""))
        conn.execute(
            """
            INSERT OR REPLACE INTO agents (
                id, name, initial_tier, current_tier, faction_id, location_id,
                personality_tags_json, secret_tags_json, style_fingerprint_id, life_status,
                init_agent_suggested_tier, init_agent_suggestion_reason
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                tid,
                name,
                default_tier.value,
                default_tier.value,
                a.get("faction_id") or a.get("faction_hint") or None,
                a.get("location_id") or a.get("location_hint") or None,
                json.dumps(a.get("personality_tags") or [], ensure_ascii=False),
                json.dumps(a.get("secret_tags") or [], ensure_ascii=False),
                a.get("style_fingerprint_id"),
                a.get("life_status", "alive"),
                st,
                reason,
            ),
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO npc_state_cards (agent_id, traits_json, current_location_id, relationship_summary, last_touched_week)
            VALUES (?,?,?,?,0)
            """,
            (
                tid,
                json.dumps({"hints": a.get("faction_hint", "")}, ensure_ascii=False),
                a.get("location_id") or a.get("location_hint"),
                "",
            ),
        )
    for r in draft.relationships:
        fa = r.get("from_agent_id") or r.get("source")
        ta = r.get("to_agent_id") or r.get("target")
        if not fa or not ta:
            continue
        rid = r.get("id") or uuid.uuid4().hex[:12]
        conn.execute(
            """
            INSERT OR REPLACE INTO relationships (id, from_agent_id, to_agent_id, rel_type, strength, grudge, shared_secret_id)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                rid,
                fa,
                ta,
                r.get("rel_type", "knows"),
                float(r.get("strength", 0.5)),
                1 if r.get("grudge") else 0,
                r.get("shared_secret_id"),
            ),
        )
    for e in draft.anchor_events:
        title = e.get("title") or e.get("name") or ""
        conn.execute(
            """
            INSERT OR REPLACE INTO anchor_events (id, week_number, title, description, locked)
            VALUES (?,?,?,?,1)
            """,
            (e.get("id"), int(e.get("week_number", 1)), title, e.get("description", "")),
        )
    for edge in draft.social_graph_edges:
        fa = edge.get("from_agent_id") or edge.get("source")
        ta = edge.get("to_agent_id") or edge.get("target")
        if not fa or not ta:
            continue
        nature = edge.get("edge_type") or edge.get("nature") or "熟人"
        conn.execute(
            """
            INSERT INTO social_graph_edges (from_agent_id, to_agent_id, edge_type, strength, propagation_factor)
            VALUES (?,?,?,?,?)
            """,
            (
                fa,
                ta,
                nature,
                float(edge.get("strength", edge.get("weight", 0.5))),
                float(edge.get("propagation_factor", 1.0)),
            ),
        )


def set_agent_tier(conn: sqlite3.Connection, agent_id: str, tier: NpcTier) -> None:
    """首次落档：current 与 initial 一并写入。"""
    conn.execute(
        "UPDATE agents SET current_tier = ?, initial_tier = ? WHERE id = ?",
        (tier.value, tier.value, agent_id),
    )


def set_agent_current_tier(conn: sqlite3.Connection, agent_id: str, tier: NpcTier) -> None:
    """运行中或审阅时只改 current_tier。"""
    conn.execute(
        "UPDATE agents SET current_tier = ? WHERE id = ?",
        (tier.value, agent_id),
    )
