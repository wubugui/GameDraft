"""repeatable（活计镜像）任务的校验防火墙（S2批2）。

规则：runArchetype 必填且须活计图、活计↔任务 1:1、禁条件/动作/后继字段、
非 repeatable 禁 runArchetype、quest 叶/updateQuest/nextQuests 不可指向 repeatable。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate


def _narr(update_quest_target: str | None = None) -> dict[str, Any]:
    solo_state_a: dict[str, Any] = {"id": "a"}
    if update_quest_target:
        solo_state_a["onEnterActions"] = [
            {"type": "updateQuest", "params": {"id": update_quest_target, "status": "completed"}},
        ]
    return {
        "schemaVersion": 2,
        "migrations": [],
        "compositions": [
            {
                "id": "comp_job",
                "mainGraph": {
                    "id": "flow_job", "ownerType": "flow", "ownerId": "job",
                    "run": {"repeatable": True, "resumable": True},
                    "initialState": "s0", "entryState": "s0", "exitStates": ["s1"],
                    "states": {"s0": {"id": "s0"}, "s1": {"id": "s1"}},
                    "transitions": [],
                },
                "elements": [],
            },
            {
                "id": "comp_solo",
                "mainGraph": {
                    "id": "flow_solo", "ownerType": "flow", "ownerId": "solo",
                    "initialState": "a",
                    "states": {"a": solo_state_a},
                    "transitions": [],
                },
                "elements": [],
            },
        ],
        "signals": [],
    }


def _repeatable(**over: Any) -> dict[str, Any]:
    q: dict[str, Any] = {
        "id": "job_quest", "group": "g", "type": "repeatable", "runArchetype": "flow_job",
        "title": "零活", "description": "",
        "preconditions": [], "completionConditions": [], "rewards": [], "nextQuests": [],
    }
    q.update(over)
    return q


def _side(**over: Any) -> dict[str, Any]:
    q: dict[str, Any] = {
        "id": "side_quest", "group": "g", "type": "side",
        "title": "普通", "description": "",
        "preconditions": [], "completionConditions": [], "rewards": [], "nextQuests": [],
    }
    q.update(over)
    return q


class TestRepeatableQuestValidation(unittest.TestCase):
    def _errors(self, quests: list[dict[str, Any]],
                narrative: dict[str, Any] | None = None) -> list[str]:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            dp = root / "public" / "assets" / "data"

            def dump(rel: str, obj: Any) -> None:
                (dp / rel).write_text(
                    json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

            dump("quests.json", quests)
            dump("questGroups.json", [{"id": "g", "name": "组", "type": "side"}])
            dump("narrative_graphs.json", narrative or _narr())
            model = ProjectModel()
            model.load_project(root)
            return [i.message for i in validate(model)
                    if i.severity == "error" and i.data_type in ("quest", "narrative")]

    def test_valid_repeatable_passes(self) -> None:
        self.assertEqual(self._errors([_repeatable(), _side()]), [])

    def test_missing_run_archetype(self) -> None:
        q = _repeatable()
        del q["runArchetype"]
        self.assertTrue(any("必须配 runArchetype" in m for m in self._errors([q])))

    def test_run_archetype_must_be_run_graph(self) -> None:
        msgs = self._errors([_repeatable(runArchetype="flow_solo")])
        self.assertTrue(any("不是活计图" in m for m in msgs))

    def test_one_to_one_binding(self) -> None:
        q2 = _repeatable(id="job_quest_2")
        msgs = self._errors([_repeatable(), q2])
        self.assertTrue(any("1:1" in m for m in msgs))

    def test_banned_fields_on_repeatable(self) -> None:
        msgs = self._errors([_repeatable(completionConditions=[{"flag": "x"}])])
        self.assertTrue(any("禁配" in m for m in msgs))

    def test_run_archetype_on_non_repeatable(self) -> None:
        msgs = self._errors([_side(runArchetype="flow_job")])
        self.assertTrue(any("仅 repeatable" in m for m in msgs))

    def test_bad_type_value(self) -> None:
        msgs = self._errors([_side(type="weekly")])
        self.assertTrue(any("main|side|repeatable" in m for m in msgs))

    def test_quest_leaf_must_not_target_repeatable(self) -> None:
        msgs = self._errors([
            _repeatable(),
            _side(preconditions=[{"quest": "job_quest", "status": "completed"}]),
        ])
        self.assertTrue(any("quest 条件不可指向" in m for m in msgs))

    def test_next_quests_must_not_target_repeatable(self) -> None:
        msgs = self._errors([
            _repeatable(),
            _side(nextQuests=[{"questId": "job_quest", "conditions": []}]),
        ])
        self.assertTrue(any("nextQuests 不可指向" in m for m in msgs))

    def test_update_quest_action_must_not_target_repeatable(self) -> None:
        msgs = self._errors([_repeatable(), _side()], narrative=_narr(update_quest_target="job_quest"))
        self.assertTrue(any("updateQuest 不可指向" in m for m in msgs))


if __name__ == "__main__":
    unittest.main()
