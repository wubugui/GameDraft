from __future__ import annotations

import json
import unittest
from pathlib import Path

from tools.planner_gui import planner_gui as gui


class PlannerGuiCommandParsingTest(unittest.TestCase):
    def test_content_command_detects_pipeline_subcommand(self) -> None:
        cmd = [gui.PY, "-m", "tools.content_pipeline", "simulate", "case.json"]
        self.assertEqual("simulate", gui.content_command(cmd))

    def test_content_command_detects_pipeline_subcommand_after_python_options(self) -> None:
        cmd = [gui.PY, "-u", "-m", "tools.content_pipeline", "simulate", "case.json"]
        self.assertEqual("simulate", gui.content_command(cmd))

    def test_content_command_detects_all_summarized_commands(self) -> None:
        for command in ("simulate", "diagnostics-json", "runtime-compatibility", "explain"):
            with self.subTest(command=command):
                self.assertEqual(command, gui.content_command([gui.PY, "-m", "tools.content_pipeline", command]))

    def test_content_command_ignores_other_python_modules(self) -> None:
        self.assertEqual("", gui.content_command([gui.PY, "-m", "unittest", "tools.content_pipeline.tests.test_cli"]))

    def test_content_command_ignores_npm_commands(self) -> None:
        self.assertEqual("", gui.content_command(["npm.cmd", "--prefix", "tools/vscode-game-authoring", "run", "compile"]))

    def test_gui_command_list_contains_one_shot_acceptance_commands(self) -> None:
        commands = set(gui.ADVANCED_COMMANDS)
        self.assertIn("project:test", commands)
        self.assertIn("project:build", commands)
        self.assertIn("narrative-editor:build", commands)
        self.assertIn("vscode-extension:compile", commands)

    def test_gui_command_list_excludes_long_running_watch(self) -> None:
        self.assertNotIn("content:watch", set(gui.ADVANCED_COMMANDS))

    def test_gui_command_list_excludes_commands_with_dedicated_tabs(self) -> None:
        commands = set(gui.ADVANCED_COMMANDS)
        self.assertNotIn("content:build", commands)
        self.assertNotIn("content:validate", commands)
        self.assertNotIn("content:diagnostics-json", commands)
        self.assertNotIn("content:index", commands)


class PlannerGuiSummaryTest(unittest.TestCase):
    def test_simulation_summary_hides_raw_json(self) -> None:
        payload = {
            "ok": True,
            "input": {"simulate": {"graphId": "滚铁环小孩", "entry": "root", "choices": {"after_evt_choice": "snatch"}}},
            "blocked": [],
            "route": [
                {"nodeId": "root", "type": "ownerState"},
                {"nodeId": "after_evt_choice", "type": "choice"},
            ],
            "diff": {
                "quests": [{"id": "q", "before": "Inactive", "after": "Active"}],
                "inventory": [{"id": "iron_hoop", "after": 1}],
            },
            "events": [{"type": "action"}, {"type": "signal"}],
            "conditions": [{"runtimeRef": "quest:q.preconditions", "result": False}],
            "diagnostics": [{"severity": "warning"}],
        }
        summary = gui.summarize_content_output("simulate", json.dumps(payload, ensure_ascii=False))
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertIn("模拟结果：成功", summary)
        self.assertIn("路线：root(ownerState) -> after_evt_choice(choice)", summary)
        self.assertIn("quests.q: Inactive -> Active", summary)
        self.assertNotIn('"initialState"', summary)
        self.assertNotIn('"events"', summary)

    def test_diagnostics_summary_hides_raw_json(self) -> None:
        payload = {"diagnostics": [{"severity": "warning", "code": "flag.no_writer", "message": "flag has readers", "source": {"file": "a.yaml", "line": 3}}]}
        summary = gui.summarize_content_output("diagnostics-json", json.dumps(payload, ensure_ascii=False))
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertIn("诊断结果：0 error，1 warning", summary)
        self.assertIn("warning flag.no_writer a.yaml:3", summary)
        self.assertNotIn('"diagnostics"', summary)

    def test_runtime_summary_hides_raw_json(self) -> None:
        payload = {"ok": True, "issues": []}
        summary = gui.summarize_content_output("runtime-compatibility", json.dumps(payload, ensure_ascii=False))
        self.assertEqual("Runtime 兼容性：通过，0 issue\n详情：artifact/content_pipeline/runtime_compatibility.json\n", summary)

    def test_explain_summary_hides_raw_json(self) -> None:
        payload = {"ok": True, "conditions": [{"runtimeRef": "quest:q.preconditions", "result": False}]}
        summary = gui.summarize_content_output("explain", json.dumps(payload, ensure_ascii=False))
        self.assertIsNotNone(summary)
        assert summary is not None
        self.assertIn("条件解释：", summary)
        self.assertIn("未通过：quest:q.preconditions", summary)
        self.assertNotIn('"conditions"', summary)


class PlannerGuiReferenceViewTest(unittest.TestCase):
    def test_reference_rows_summarizes_flag_read_write(self) -> None:
        index = {
            "flags": {
                "flag.a": {
                    "declaredAt": [{"file": "authoring/tables/flags.csv", "line": 2, "column": 1, "valueType": "bool"}],
                    "readers": [{"file": "a.yaml", "line": 3, "column": 5}],
                    "writers": [{"file": "b.yaml", "line": 4, "column": 7}],
                },
            },
        }
        rows = gui.reference_rows("Flag Read/Write", index, {})
        self.assertEqual(1, len(rows))
        self.assertEqual("flag.a", rows[0][1])
        self.assertIn("read 1 / write 1", rows[0][2])
        self.assertIn("a.yaml:3:5", rows[0][3])

    def test_reference_rows_summarizes_runtime_trace(self) -> None:
        simulation = {
            "events": [
                {
                    "type": "action",
                    "phase": "run",
                    "label": "setFlag",
                    "source": {"file": "dlg.yaml", "line": 8, "column": 9},
                },
            ],
        }
        rows = gui.reference_rows("Runtime Trace Timeline", {}, simulation)
        self.assertEqual(1, len(rows))
        self.assertIn("action:run setFlag", rows[0][1])
        self.assertIn("dlg.yaml:8:9", rows[0][2])


class PlannerGuiTemplateTest(unittest.TestCase):
    def test_template_text_dialogue(self) -> None:
        text = gui.template_text("dialogue", "dlg_test", "测试对话", template_key="choice")
        self.assertIn('id: "dlg_test"', text)
        self.assertIn("kind: dialogueGraph", text)
        self.assertIn('title: "测试对话"', text)
        self.assertIn("entry: start", text)
        self.assertIn("type: choice", text)
        self.assertIn("type: end", text)

    def test_template_text_narrative_owner(self) -> None:
        text = gui.template_text("narrative", "flow_test", "测试流程", "flow:dock", "signal")
        self.assertIn('id: "flow_test"', text)
        self.assertIn('title: "测试流程"', text)
        self.assertIn('type: "flow"', text)
        self.assertIn('id: "dock"', text)
        self.assertIn("signal: TODO.signal", text)

    def test_template_text_quest(self) -> None:
        text = gui.template_text("quest", "quest_test", "测试任务", template_key="chain")
        self.assertIn('id: "quest_test"', text)
        self.assertIn('title: "测试任务"', text)
        self.assertIn("preconditions: []", text)
        self.assertIn("questId: TODO.next_quest", text)

    def test_safe_filename_replaces_invalid_windows_chars(self) -> None:
        self.assertEqual("a_b_c_d_e_f_g_h_i", gui.safe_filename('a<b>c:d"e/f\\g|h?i'))

    def test_generated_id_from_name_is_based_on_display_name(self) -> None:
        self.assertTrue(gui.generated_id_from_name("滚铁环小孩", "dialogue").startswith("dialogue_"))
        self.assertNotEqual("滚铁环小孩", gui.generated_id_from_name("滚铁环小孩", "dialogue"))
        self.assertEqual("hello_world", gui.generated_id_from_name("hello world"))

    def test_is_relative_to_rejects_sibling_folder(self) -> None:
        base = Path("D:/GameDraft/authoring/dialogues")
        sibling = Path("D:/GameDraft/authoring/narrative/test.yaml")
        self.assertFalse(gui.is_relative_to(sibling, base))

    def test_log_path_uses_safe_title_slug(self) -> None:
        path = gui.log_path_for_title("content simulate / case", "20260530-120000")
        self.assertEqual(gui.LOG_DIR / "planner-gui-20260530-120000-content_simulate_case.log", path)


if __name__ == "__main__":
    unittest.main()
