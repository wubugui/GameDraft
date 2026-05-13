from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import Issue, _walk_action_defs
from tools.editor.shared.ref_validator import walk_action_defs_embedded_refs


class TestActionNestedValidation(unittest.TestCase):
    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    def test_run_actions_and_choose_action_recurse_into_child_actions(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            issues: list[Issue] = []
            _walk_action_defs(model, issues, [{
                "type": "runActions",
                "params": {
                    "actions": [{
                        "type": "chooseAction",
                        "params": {
                            "prompt": "选一个",
                            "options": [{
                                "text": "坏分支",
                                "actions": [{"type": "__missing_action__", "params": {}}],
                            }],
                        },
                    }],
                },
            }], "scene", "h_nested", "sc_a")
            messages = [i.message for i in issues]

            self.assertTrue(any("__missing_action__" in msg for msg in messages))
            self.assertFalse(any("runActions" in msg and "未在 action_editor" in msg for msg in messages))
            self.assertFalse(any("chooseAction" in msg and "未在 action_editor" in msg for msg in messages))

    def test_choose_action_embedded_refs_validate_prompt_and_option_text(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            bad = "[tag:npc:definitely_missing_npc_xxxxx]"
            errs: list[str] = []
            walk_action_defs_embedded_refs(
                [{
                    "type": "chooseAction",
                    "params": {
                        "prompt": bad,
                        "options": [{
                            "text": " ok ",
                            "actions": [],
                        }],
                    },
                }],
                "t",
                model,
                errs,
            )
            self.assertTrue(any("[0].prompt" in e and "invalid [tag:npc]" in e for e in errs), errs)
            errs2: list[str] = []
            walk_action_defs_embedded_refs(
                [{
                    "type": "chooseAction",
                    "params": {
                        "prompt": "",
                        "options": [{
                            "text": bad,
                            "actions": [],
                        }],
                    },
                }],
                "t",
                model,
                errs2,
            )
            self.assertTrue(any("options[0].text" in e and "invalid [tag:npc]" in e for e in errs2), errs2)


if __name__ == "__main__":
    unittest.main()
