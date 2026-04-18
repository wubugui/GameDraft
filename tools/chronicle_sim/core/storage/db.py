from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator, Iterator

SCHEMA_VERSION = 3


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS schema_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            start_week INTEGER NOT NULL DEFAULT 1,
            total_weeks INTEGER NOT NULL DEFAULT 13,
            pacing_profile_id TEXT NOT NULL DEFAULT 'default',
            llm_config_json TEXT NOT NULL DEFAULT '{}',
            current_week INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            initial_tier TEXT NOT NULL,
            current_tier TEXT NOT NULL,
            faction_id TEXT,
            location_id TEXT,
            personality_tags_json TEXT NOT NULL DEFAULT '[]',
            secret_tags_json TEXT NOT NULL DEFAULT '[]',
            style_fingerprint_id TEXT,
            life_status TEXT NOT NULL DEFAULT 'alive',
            init_agent_suggested_tier TEXT,
            init_agent_suggestion_reason TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS tier_changes (
            change_id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            old_tier TEXT NOT NULL,
            new_tier TEXT NOT NULL,
            applied_week INTEGER,
            author_note TEXT NOT NULL DEFAULT '',
            pending_flag INTEGER NOT NULL DEFAULT 1,
            applied_mode TEXT NOT NULL DEFAULT 'next_week',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        );

        CREATE TABLE IF NOT EXISTS cold_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            frozen_at_week INTEGER NOT NULL,
            frozen_reason TEXT NOT NULL DEFAULT '',
            payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS cold_beliefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            frozen_at_week INTEGER NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS cold_agent_states (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            frozen_at_week INTEGER NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS npc_state_cards (
            agent_id TEXT PRIMARY KEY,
            traits_json TEXT NOT NULL DEFAULT '{}',
            current_location_id TEXT,
            relationship_summary TEXT NOT NULL DEFAULT '',
            last_touched_week INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        );

        CREATE TABLE IF NOT EXISTS factions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS locations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS relationships (
            id TEXT PRIMARY KEY,
            from_agent_id TEXT NOT NULL,
            to_agent_id TEXT NOT NULL,
            rel_type TEXT NOT NULL,
            strength REAL NOT NULL DEFAULT 0.5,
            grudge INTEGER NOT NULL DEFAULT 0,
            shared_secret_id TEXT,
            FOREIGN KEY (from_agent_id) REFERENCES agents(id),
            FOREIGN KEY (to_agent_id) REFERENCES agents(id)
        );

        CREATE TABLE IF NOT EXISTS social_graph_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_agent_id TEXT NOT NULL,
            to_agent_id TEXT NOT NULL,
            edge_type TEXT NOT NULL,
            strength REAL NOT NULL DEFAULT 0.5,
            propagation_factor REAL NOT NULL DEFAULT 1.0,
            FOREIGN KEY (from_agent_id) REFERENCES agents(id),
            FOREIGN KEY (to_agent_id) REFERENCES agents(id)
        );

        CREATE TABLE IF NOT EXISTS anchor_events (
            id TEXT PRIMARY KEY,
            week_number INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            locked INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS event_types (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'minor',
            conditions TEXT NOT NULL DEFAULT 'true',
            actor_slots_json TEXT NOT NULL DEFAULT '[]',
            weight REAL NOT NULL DEFAULT 1.0,
            cooldown_weeks INTEGER NOT NULL DEFAULT 0,
            supernatural_prob REAL NOT NULL DEFAULT 0.0,
            narrative_template TEXT NOT NULL DEFAULT '',
            consequences_template TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            week_number INTEGER NOT NULL,
            location_id TEXT,
            type_id TEXT NOT NULL,
            truth_json TEXT NOT NULL DEFAULT '{}',
            director_draft_json TEXT NOT NULL DEFAULT '{}',
            witness_accounts_json TEXT NOT NULL DEFAULT '[]',
            rumor_versions_json TEXT NOT NULL DEFAULT '[]',
            tags_json TEXT NOT NULL DEFAULT '[]',
            supernatural_level TEXT NOT NULL DEFAULT 'none',
            FOREIGN KEY (type_id) REFERENCES event_types(id)
        );

        CREATE TABLE IF NOT EXISTS event_witnesses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            account_text TEXT NOT NULL,
            supernatural_hint TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (event_id) REFERENCES events(id),
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        );

        CREATE TABLE IF NOT EXISTS beliefs (
            holder_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            claim_text TEXT NOT NULL,
            source_event_id TEXT,
            distortion_level INTEGER NOT NULL DEFAULT 0,
            first_heard_week INTEGER NOT NULL DEFAULT 0,
            last_updated_week INTEGER NOT NULL DEFAULT 0,
            confidence REAL NOT NULL DEFAULT 0.5,
            PRIMARY KEY (holder_id, subject_id, topic),
            FOREIGN KEY (holder_id) REFERENCES agents(id),
            FOREIGN KEY (subject_id) REFERENCES events(id)
        );

        CREATE TABLE IF NOT EXISTS rumors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            originating_event_id TEXT NOT NULL,
            week_emerged INTEGER NOT NULL,
            teller_id TEXT,
            hearer_id TEXT,
            content TEXT NOT NULL,
            distortion_level INTEGER NOT NULL DEFAULT 0,
            propagation_hop INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (originating_event_id) REFERENCES events(id)
        );

        CREATE TABLE IF NOT EXISTS week_intents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id TEXT NOT NULL,
            week INTEGER NOT NULL,
            mood_delta TEXT NOT NULL DEFAULT '',
            intent_text TEXT NOT NULL DEFAULT '',
            target_ids_json TEXT NOT NULL DEFAULT '[]',
            relationship_hints_json TEXT NOT NULL DEFAULT '[]',
            UNIQUE(agent_id, week),
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        );

        CREATE TABLE IF NOT EXISTS summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL,
            week_start INTEGER NOT NULL,
            week_end INTEGER NOT NULL,
            text TEXT NOT NULL,
            style_applied INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS week_snapshots (
            week_number INTEGER PRIMARY KEY,
            snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS director_decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            week INTEGER NOT NULL,
            candidate_event_type TEXT NOT NULL,
            score REAL NOT NULL,
            chosen INTEGER NOT NULL DEFAULT 0,
            reason TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS probe_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT '',
            messages_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agent_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_agent_id TEXT NOT NULL,
            week INTEGER NOT NULL,
            content TEXT NOT NULL,
            embedding_blob BLOB,
            FOREIGN KEY (owner_agent_id) REFERENCES agents(id)
        );

        CREATE INDEX IF NOT EXISTS idx_memories_owner ON agent_memories(owner_agent_id);
        CREATE INDEX IF NOT EXISTS idx_events_week ON events(week_number);
        CREATE INDEX IF NOT EXISTS idx_intents_week ON week_intents(week);

        CREATE TABLE IF NOT EXISTS world_seed (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            world_setting_json TEXT NOT NULL DEFAULT '{}',
            design_pillars_json TEXT NOT NULL DEFAULT '[]',
            custom_sections_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)",
        (str(SCHEMA_VERSION),),
    )
    conn.commit()
    migrate_legacy_beliefs_subject_fk(conn)


def migrate_legacy_beliefs_subject_fk(conn: sqlite3.Connection) -> None:
    """旧库 beliefs.subject_id 误指向 agents；业务上存的是事件 id，应指向 events。"""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='beliefs'"
    ).fetchone()
    if not row or not row[0]:
        return
    ddl = row[0]
    if "FOREIGN KEY (subject_id) REFERENCES events(id)" in ddl:
        return
    if "FOREIGN KEY (subject_id) REFERENCES agents(id)" not in ddl:
        return
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.executescript(
        """
        CREATE TABLE beliefs__migration_tmp (
            holder_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            claim_text TEXT NOT NULL,
            source_event_id TEXT,
            distortion_level INTEGER NOT NULL DEFAULT 0,
            first_heard_week INTEGER NOT NULL DEFAULT 0,
            last_updated_week INTEGER NOT NULL DEFAULT 0,
            confidence REAL NOT NULL DEFAULT 0.5,
            PRIMARY KEY (holder_id, subject_id, topic),
            FOREIGN KEY (holder_id) REFERENCES agents(id),
            FOREIGN KEY (subject_id) REFERENCES events(id)
        );
        INSERT INTO beliefs__migration_tmp
        SELECT b.* FROM beliefs b
        WHERE EXISTS (SELECT 1 FROM events e WHERE e.id = b.subject_id);
        DROP TABLE beliefs;
        ALTER TABLE beliefs__migration_tmp RENAME TO beliefs;
        """
    )
    conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()


def connect_run_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


class Database:
    """轻量封装：run 级 SQLite。"""

    def __init__(self, db_path: Path) -> None:
        self.path = db_path
        self._conn = connect_run_db(db_path)

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    def close(self) -> None:
        self._conn.close()

    @contextmanager
    def transaction(self) -> Generator[sqlite3.Connection, None, None]:
        try:
            yield self._conn
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def run_meta(self) -> dict[str, Any] | None:
        row = self._conn.execute("SELECT * FROM runs LIMIT 1").fetchone()
        if not row:
            return None
        return dict(row)

    def json_dumps(self, obj: Any) -> str:
        return json.dumps(obj, ensure_ascii=False)

    def json_loads(self, s: str) -> Any:
        return json.loads(s) if s else None
