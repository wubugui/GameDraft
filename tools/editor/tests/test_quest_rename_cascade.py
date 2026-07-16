"""任务改名/删除的跨文件引用级联（审查 P1-14）。

改名时：quest_<旧id>_status flag 引用（条件树/动作 key）与 narrative_graphs
updateQuest.id 引用应跟随改写；删除时：这两类引用应被列入警告（不自动清理）。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.quest_editor import (
    QuestEditor,
    _count_flag_string_refs,
    _rewrite_flag_string_refs,
    _count_update_quest_refs,
    _rewrite_update_quest_refs,
)
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


_GROUPS = [{"id": "g_main", "name": "主线", "type": "main"}]

_QUESTS = [
    {"id": "q_a", "group": "g_main", "type": "main", "title": "甲",
     "preconditions": [], "completionConditions": [], "acceptActions": [],
     "rewards": [], "nextQuests": []},
    {"id": "q_b", "group": "g_main", "type": "main", "title": "乙",
     "preconditions": [{"flag": "quest_q_a_status"}],
     "completionConditions": [], "acceptActions": [], "rewards": [],
     "nextQuests": []},
]


class QuestRenameCascadeHelperTests(unittest.TestCase):
    def test_flag_string_ref_count_and_rewrite(self) -> None:
        obj = {
            "a": "quest_q_a_status",
            "b": {"flag": "quest_q_a_status", "op": "=="},
            "c": ["quest_q_a_status", "other"],
            "key_is_not_a_value": {"quest_q_a_status": True},  # 键名不计
        }
        self.assertEqual(_count_flag_string_refs(obj, "quest_q_a_status"), 3)
        n = _rewrite_flag_string_refs(obj, "quest_q_a_status", "quest_q_a2_status")
        self.assertEqual(n, 3)
        self.assertEqual(_count_flag_string_refs(obj, "quest_q_a_status"), 0)
        self.assertEqual(_count_flag_string_refs(obj, "quest_q_a2_status"), 3)
        # 键名未被改写
        self.assertIn("quest_q_a_status", obj["key_is_not_a_value"])

    def test_update_quest_ref_count_and_rewrite(self) -> None:
        obj = {
            "onEnterActions": [
                {"type": "updateQuest", "params": {"id": "q_a"}},
                {"action": "updateQuest", "id": "q_a"},  # 无 params 变体
                {"type": "updateQuest", "params": {"id": "other"}},
            ],
        }
        self.assertEqual(_count_update_quest_refs(obj, "q_a"), 2)
        n = _rewrite_update_quest_refs(obj, "q_a", "q_a2")
        self.assertEqual(n, 2)
        self.assertEqual(_count_update_quest_refs(obj, "q_a"), 0)
        self.assertEqual(_count_update_quest_refs(obj, "q_a2"), 2)


class QuestRenameCascadeEditorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path):
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        m.quests = copy.deepcopy(_QUESTS)
        m.quest_groups = copy.deepcopy(_GROUPS)
        m.narrative_graphs = {
            "schemaVersion": 2,
            "compositions": [
                {"id": "c0", "elements": [
                    {"graph": {"states": {"active": {"onEnterActions": [
                        {"type": "updateQuest", "params": {"id": "q_a"}},
                    ]}}}},
                ]},
            ],
        }
        ed = QuestEditor(m)
        return ed, m

    def test_rename_cascades_flag_and_update_quest(self) -> None:
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            ed._show_quest_props("q_a")
            ed._q_id.setText("q_a2")
            with mock.patch.object(
                QMessageBox, "question",
                return_value=QMessageBox.StandardButton.Ok,
            ):
                ok = ed._apply_quest()
            self.assertTrue(ok)
            # q_b 的前置 flag 已跟随改写
            qb = next(q for q in m.quests if q["id"] == "q_b")
            self.assertEqual(qb["preconditions"][0]["flag"], "quest_q_a2_status")
            # narrative updateQuest.id 已跟随改写
            act = (m.narrative_graphs["compositions"][0]["elements"][0]
                   ["graph"]["states"]["active"]["onEnterActions"][0])
            self.assertEqual(act["params"]["id"], "q_a2")
            # 相关脏桶已标记
            self.assertIn("quest", m._dirty)
            self.assertIn("narrative_graphs", m._dirty)

    def test_rename_cancel_aborts(self) -> None:
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            ed._show_quest_props("q_a")
            ed._q_id.setText("q_a2")
            with mock.patch.object(
                QMessageBox, "question",
                return_value=QMessageBox.StandardButton.Cancel,
            ):
                ok = ed._apply_quest()
            self.assertFalse(ok, "取消级联确认应中止改名")
            # id 未改、引用未动
            self.assertTrue(any(q["id"] == "q_a" for q in m.quests))
            qb = next(q for q in m.quests if q["id"] == "q_b")
            self.assertEqual(qb["preconditions"][0]["flag"], "quest_q_a_status")

    def test_delete_lists_refs_and_leaves_them(self) -> None:
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            report = ed._collect_quest_ref_report("q_a", exclude_quest_ids={"q_a"})
            lines = ed._format_quest_ref_lines(report)
            self.assertTrue(lines, "删除前应能列出跨文件引用清单")
            joined = "\n".join(lines)
            self.assertIn("quest_q_a_status", joined)
            self.assertIn("updateQuest", joined)
            # 删除本身不级联清理引用（悬垂，交给 validator/查引用）
            with mock.patch.object(
                QMessageBox, "warning",
                return_value=QMessageBox.StandardButton.Ok,
            ):
                ed._delete_quest("q_a")
            qb = next(q for q in m.quests if q["id"] == "q_b")
            self.assertEqual(qb["preconditions"][0]["flag"], "quest_q_a_status",
                             "删除不清理引用，flag 保留（悬垂）")

    def test_rename_no_refs_no_prompt(self) -> None:
        # 无任何跨文件引用时不应弹级联确认，直接改名成功。
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            # 去掉引用
            for q in m.quests:
                q["preconditions"] = []
            m.narrative_graphs = {"schemaVersion": 2, "compositions": []}
            ed._show_quest_props("q_a")
            ed._q_id.setText("q_a2")
            with mock.patch.object(QMessageBox, "question") as mq:
                ok = ed._apply_quest()
            self.assertTrue(ok)
            mq.assert_not_called()
            self.assertTrue(any(q["id"] == "q_a2" for q in m.quests))


if __name__ == "__main__":
    unittest.main()
