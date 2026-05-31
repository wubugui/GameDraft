from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.production_workbench.runtime_command import (
    clear_runtime_command_queue,
    enqueue_runtime_command,
    enqueue_runtime_commands,
    format_runtime_command_queue_report,
    load_runtime_command_queue,
    runtime_command_queue_path,
)


class ProductionWorkbenchRuntimeCommandTests(TestCase):
    def test_enqueue_runtime_command_writes_queue_file(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"

            report = enqueue_runtime_command(
                root,
                "captureSnapshot",
                reason="manual",
            )

            self.assertTrue(report.ok)
            self.assertEqual(len(report.commands), 1)
            self.assertEqual(report.commands[0]["type"], "captureSnapshot")
            self.assertEqual(report.commands[0]["reason"], "manual")
            self.assertTrue(runtime_command_queue_path(root).is_file())

    def test_enqueue_runtime_commands_appends_normalized_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            enqueue_runtime_command(root, "captureSnapshot", reason="first")

            report = enqueue_runtime_commands(
                root,
                [
                    {"type": "setFlag", "key": "ringboy_seen", "value": False},
                    {"type": "debugSetNarrativeState", "graphId": "ringboy_flow", "stateId": "intro"},
                ],
            )

            self.assertTrue(report.ok)
            self.assertEqual([x["type"] for x in report.commands], [
                "captureSnapshot",
                "setFlag",
                "debugSetNarrativeState",
            ])
            self.assertTrue(str(report.commands[1].get("id") or "").startswith("pw-"))
            self.assertEqual(report.commands[1]["source"], "production-workbench")

    def test_load_and_format_queue(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            path = runtime_command_queue_path(root)
            path.parent.mkdir(parents=True)
            path.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "updatedAt": "2026-05-31T12:00:00+08:00",
                        "commands": [{"id": "cmd", "type": "clearNarrativeTrace", "reason": "test"}],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            report = load_runtime_command_queue(root)
            text = format_runtime_command_queue_report(report)

            self.assertTrue(report.ok)
            self.assertIn("待执行: 1", text)
            self.assertIn("clearNarrativeTrace", text)

    def test_rejects_unsupported_command_type(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"

            with self.assertRaises(ValueError):
                enqueue_runtime_command(root, "deleteSave")

    def test_allows_player_acceptance_debug_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"

            report = enqueue_runtime_commands(
                root,
                [
                    {"type": "debugWait", "durationMs": 500},
                    {"type": "debugSetPlayerPosition", "x": 10, "y": 20},
                    {"type": "debugMovePlayerTo", "x": 30, "y": 40, "speed": 180},
                ],
            )

            self.assertTrue(report.ok)
            self.assertEqual([x["type"] for x in report.commands], [
                "debugWait",
                "debugSetPlayerPosition",
                "debugMovePlayerTo",
            ])

    def test_clear_runtime_command_queue_removes_file(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            enqueue_runtime_command(root, "captureSnapshot")

            self.assertTrue(clear_runtime_command_queue(root))
            self.assertFalse(runtime_command_queue_path(root).exists())
            self.assertFalse(clear_runtime_command_queue(root))


if __name__ == "__main__":
    import unittest

    unittest.main()
