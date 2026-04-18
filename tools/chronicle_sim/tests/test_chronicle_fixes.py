from __future__ import annotations

import asyncio
import json
import sqlite3
import unittest
from pathlib import Path

from tools.chronicle_sim.core.llm.stub_adapter import StubLLMAdapter
from tools.chronicle_sim.core.simulation.persistence import events_for_week_json
from tools.chronicle_sim.core.storage.db import init_schema
from tools.chronicle_sim.core.storage.probe_world_index import _compute_index_sig
from tools.chronicle_sim.core.storage.snapshot import dump_table
from tools.chronicle_sim.core.storage.sql_identifiers import require_chronicle_table, validate_column_identifiers
from tools.chronicle_sim.core.storage.sql_like import escape_like_pattern


class TestSqlIdentifiers(unittest.TestCase):
    def test_require_table_ok(self) -> None:
        self.assertEqual(require_chronicle_table("events"), "events")

    def test_require_table_rejects(self) -> None:
        with self.assertRaises(ValueError):
            require_chronicle_table("events;--")

    def test_validate_columns(self) -> None:
        validate_column_identifiers(["id", "week_number"])
        with self.assertRaises(ValueError):
            validate_column_identifiers(["bad;col"])


class TestSnapshotDumpGuard(unittest.TestCase):
    def test_dump_rejects_unknown(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_schema(conn)
        with self.assertRaises(ValueError):
            dump_table(conn, "not_a_table")


class TestProbeIndexSig(unittest.TestCase):
    def test_sig_changes_when_event_inserted(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_schema(conn)
        before = _compute_index_sig(conn)
        conn.execute(
            "INSERT INTO event_types (id, category) VALUES (?, ?)",
            ("t_probe", "misc"),
        )
        conn.execute(
            """
            INSERT INTO events (
                id, week_number, location_id, type_id, truth_json,
                director_draft_json, witness_accounts_json, rumor_versions_json,
                tags_json, supernatural_level
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "ev_probe",
                1,
                None,
                "t_probe",
                "{}",
                "{}",
                "[]",
                "[]",
                "[]",
                "none",
            ),
        )
        after = _compute_index_sig(conn)
        self.assertNotEqual(before, after)


class TestOrchestratorIncludesTierB(unittest.TestCase):
    def test_sql_literal(self) -> None:
        root = Path(__file__).resolve().parents[1]
        text = (root / "core" / "simulation" / "orchestrator.py").read_text(encoding="utf-8")
        self.assertIn("('S','A','B')", text)


class TestStubRumorRewrite(unittest.TestCase):
    def test_stub_returns_distorted_line(self) -> None:
        async def _run() -> str:
            ad = StubLLMAdapter()
            r = await ad.chat(
                [{"role": "user", "content": "【传闻改写任务】传播跳数=2\n原句：码头打架了。"}]
            )
            return r.text

        text = asyncio.run(_run())
        self.assertTrue(len(text) > 3)


class TestSqlLikeEscape(unittest.TestCase):
    def test_escape_percent_underscore(self) -> None:
        self.assertEqual(escape_like_pattern("a%b_c"), "a\\%b\\_c")


class TestEventsForWeekJson(unittest.TestCase):
    def test_truncation_meta_present(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        init_schema(conn)
        conn.execute(
            "INSERT INTO event_types (id, category) VALUES (?, ?)",
            ("t_ev", "misc"),
        )
        conn.execute(
            """
            INSERT INTO events (
                id, week_number, location_id, type_id, truth_json,
                director_draft_json, witness_accounts_json, rumor_versions_json,
                tags_json, supernatural_level
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "ev1",
                2,
                None,
                "t_ev",
                "{}",
                "{}",
                "[]",
                "[]",
                "[]",
                "none",
            ),
        )
        raw = events_for_week_json(conn, 2)
        data = json.loads(raw)
        self.assertEqual(len(data["events"]), 1)
        self.assertIn("included_rows", data["_truncation"])


class TestStubGmBranch(unittest.TestCase):
    def test_records_branch(self) -> None:
        async def _run() -> str:
            ad = StubLLMAdapter()
            r = await ad.chat([{"role": "user", "content": "请输出 JSON 数组 records"}])
            return r.text

        text = asyncio.run(_run())
        payload = json.loads(text)
        self.assertIn("records", payload)
        self.assertTrue(len(payload["records"]) >= 1)
