from __future__ import annotations

import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from tools.editor.tests.test_production_workbench_story_units import _write_story_unit_project
from tools.production_workbench.daily_check import _daily_toolchain_commands, run_daily_check


class ProductionWorkbenchDailyCheckTests(TestCase):
    def test_daily_check_reports_dialogue_graph_structure_errors(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            graph_path = root / "public" / "assets" / "dialogues" / "graphs" / "ringboy.json"
            graph = json.loads(graph_path.read_text(encoding="utf-8"))
            graph["nodes"]["line"]["next"] = "missing_node"
            graph_path.write_text(json.dumps(graph, ensure_ascii=False), encoding="utf-8")

            report = run_daily_check(root)

            self.assertFalse(report.ok)
            self.assertTrue(any(
                issue.area == "dialogue-graph" and "missing_node" in issue.message
                for issue in report.issues
            ))

    def test_daily_check_reports_asset_spec_warnings(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            bad_image = root / "public" / "resources" / "runtime" / "images" / "props" / "broken.png"
            bad_image.parent.mkdir(parents=True)
            bad_image.write_bytes(b"not an image")

            report = run_daily_check(root)

            self.assertTrue(any(
                issue.area == "asset-spec" and "broken.png" in issue.message
                for issue in report.issues
            ))

    def test_toolchain_commands_include_runtime_save_smoke(self) -> None:
        with patch("tools.production_workbench.daily_check.shutil.which", return_value="npm"):
            commands = _daily_toolchain_commands(Path.cwd())
        ts_commands = [argv for _label, argv, _timeout in commands if "npm" in Path(argv[0]).name.lower()]
        self.assertTrue(any("src/core/SaveManager.test.ts" in argv for argv in ts_commands))

    def test_toolchain_commands_show_workbench_smoke_as_own_gate(self) -> None:
        commands = _daily_toolchain_commands(Path.cwd())
        labels = [label for label, _argv, _timeout in commands]
        workbench = next(argv for label, argv, _timeout in commands if label == "生产工作台 smoke")

        self.assertIn("生产工作台 smoke", labels)
        self.assertIn("tools.editor.tests.test_production_workbench_story_unit_gui", workbench)
        self.assertNotIn(
            "tools.editor.tests.test_production_workbench_story_unit_gui",
            next(argv for label, argv, _timeout in commands if label == "Python 编辑器/Narrative smoke"),
        )

    def test_failed_toolchain_command_writes_full_log(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            failed = subprocess.CompletedProcess(
                ["fake-test"],
                2,
                stdout="stdout line 1\nstdout line 2",
                stderr="stderr line 1\nstderr line 2",
            )

            with patch(
                "tools.production_workbench.daily_check._daily_toolchain_commands",
                return_value=[("Fake Toolchain", ["fake-test"], 1)],
            ), patch(
                "tools.production_workbench.daily_check._run_command",
                return_value=failed,
            ):
                report = run_daily_check(root, run_toolchain_checks=True)

            self.assertFalse(report.ok)
            issue = next(x for x in report.issues if x.area == "toolchain")
            self.assertIn("完整日志:", issue.message)
            log_path = Path(issue.message.rsplit("完整日志:", 1)[1].strip())
            self.assertTrue(log_path.is_file())
            text = log_path.read_text(encoding="utf-8")
            self.assertIn("Fake Toolchain", text)
            self.assertIn("stderr line 1", text)
            self.assertIn("stdout line 2", text)


if __name__ == "__main__":
    import unittest

    unittest.main()
