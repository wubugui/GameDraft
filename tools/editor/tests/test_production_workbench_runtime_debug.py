from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.production_workbench.runtime_debug import (
    clear_runtime_debug_snapshot,
    format_runtime_debug_report,
    load_runtime_debug_snapshot,
    runtime_debug_snapshot_path,
)


class ProductionWorkbenchRuntimeDebugTests(TestCase):
    def test_missing_runtime_snapshot_is_reported_without_crashing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"

            report = load_runtime_debug_snapshot(root)
            text = format_runtime_debug_report(report)

            self.assertFalse(report.ok)
            self.assertIn("运行时 Debug 快照: 不可用", text)
            self.assertIn("npm run dev", text)

    def test_runtime_snapshot_report_extracts_trace_and_state(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            path = runtime_debug_snapshot_path(root)
            path.parent.mkdir(parents=True)
            payload = {
                "ok": True,
                "capturedAt": "2026-05-31T12:00:00+08:00",
                "source": "vite-runtime",
                "snapshot": {
                    "reason": "narrative:stateChanged",
                    "currentSceneId": "test_scene",
                    "gameState": "Dialogue",
                    "flags": {"ringboy_seen": True},
                    "questState": {"bridge_find_source": 1},
                    "scenarioState": {"line_a": {"lifecycle": "active"}},
                    "narrativeEval": {"summaryText": "route: root -> line"},
                    "narrativeState": {
                        "activeStates": {"ringboy_flow": "done"},
                        "recentTrace": [
                            {
                                "seq": 1,
                                "type": "signal.received",
                                "triggerKey": "ringboy.met",
                            },
                            {
                                "seq": 2,
                                "type": "transition.applied",
                                "graphId": "ringboy_flow",
                                "transitionId": "meet",
                                "from": "intro",
                                "to": "done",
                            },
                        ],
                        "recentIssues": [{"severity": "warning", "code": "demo", "message": "check me"}],
                        "recentTransitions": [
                            {
                                "graphId": "ringboy_flow",
                                "transitionId": "meet",
                                "from": "intro",
                                "to": "done",
                                "triggerKey": "ringboy.met",
                            }
                        ],
                    },
                    "runtimeCommands": {
                        "lastResults": [
                            {
                                "id": "cmd-1",
                                "type": "clearNarrativeTrace",
                                "ok": True,
                                "message": "narrative trace cleared",
                            }
                        ]
                    },
                },
            }
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            report = load_runtime_debug_snapshot(root)
            text = format_runtime_debug_report(report)

            self.assertTrue(report.ok)
            self.assertEqual(report.current_scene_id, "test_scene")
            self.assertEqual(report.active_states["ringboy_flow"], "done")
            self.assertIn("signal.received", text)
            self.assertIn("ringboy_flow: intro -> done", text)
            self.assertIn("clearNarrativeTrace", text)
            self.assertIn("route: root -> line", text)

    def test_clear_runtime_snapshot_removes_file(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            path = runtime_debug_snapshot_path(root)
            path.parent.mkdir(parents=True)
            path.write_text("{}", encoding="utf-8")

            self.assertTrue(clear_runtime_debug_snapshot(root))
            self.assertFalse(path.exists())
            self.assertFalse(clear_runtime_debug_snapshot(root))


if __name__ == "__main__":
    import unittest

    unittest.main()
