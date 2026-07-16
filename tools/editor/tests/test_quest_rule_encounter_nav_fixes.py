"""select_by_id bool 契约 + 规矩碎片 id 校验/删除级联 + 跳转补切页（审查 P2/P3）。"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.rule_editor import RuleEditor
from tools.editor.editors.encounter_editor import EncounterEditor
from tools.editor.editors.quest_editor import QuestEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class NavContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m

    # ---- rule editor -----------------------------------------------------
    def _rule_model(self, root: Path) -> ProjectModel:
        m = self._model(root)
        m.rules_data = {
            "rules": [
                {"id": "r_a", "name": "甲", "category": "ward",
                 "layers": {"xiang": {"text": "x", "verified": "unverified"}}},
                {"id": "r_b", "name": "乙", "category": "ward",
                 "layers": {"xiang": {"text": "y", "verified": "unverified"}}},
            ],
            "fragments": [
                {"id": "f_a1", "text": "片1", "ruleId": "r_a", "layer": "xiang"},
                {"id": "f_a2", "text": "片2", "ruleId": "r_a", "layer": "li"},
                {"id": "f_b1", "text": "片3", "ruleId": "r_b", "layer": "xiang"},
            ],
        }
        return m

    def test_rule_select_by_id_returns_bool_and_switches_tab(self) -> None:
        with TemporaryDirectory() as td:
            m = self._rule_model(Path(td) / "p")
            ed = RuleEditor(m)
            self.assertTrue(ed.select_by_id("r_b"))
            self.assertEqual(ed._tabs.currentIndex(), 0, "命中规矩应切到 Rules 页")
            self.assertFalse(ed.select_by_id("nope"))

    def test_rule_select_fragment_jumps_to_fragments_tab(self) -> None:
        with TemporaryDirectory() as td:
            m = self._rule_model(Path(td) / "p")
            ed = RuleEditor(m)
            self.assertTrue(ed.select_by_id("f_b1"))
            self.assertEqual(ed._tabs.currentIndex(), 1,
                             "命中碎片必须切到 Fragments 页（不再在被遮页静默选择）")
            row = ed._frag_list.currentRow()
            it = ed._frag_list.item(row)
            self.assertIsNotNone(it)
            # 全局索引应指向 f_b1（fragments[2]）
            self.assertEqual(it.data(0x0100), 2)  # Qt.UserRole

    def test_fragment_apply_rejects_empty_and_duplicate_id(self) -> None:
        with TemporaryDirectory() as td:
            m = self._rule_model(Path(td) / "p")
            ed = RuleEditor(m)
            ed.select_by_id("f_a1")  # 选中碎片 f_a1（切到 Fragments 页）
            # 空 id → 保留原值
            ed._f_id.setText("")
            ed._apply_frag()
            self.assertEqual(m.rules_data["fragments"][0]["id"], "f_a1",
                             "空 id 应保留原 id")
            # 重复 id → 警告并保留原值
            ed._f_id.setText("f_a2")
            with mock.patch.object(QMessageBox, "warning") as mw:
                ed._apply_frag()
            mw.assert_called_once()
            self.assertEqual(m.rules_data["fragments"][0]["id"], "f_a1",
                             "重复 id 应保留原 id")

    def test_delete_rule_cascades_fragments(self) -> None:
        with TemporaryDirectory() as td:
            m = self._rule_model(Path(td) / "p")
            ed = RuleEditor(m)
            ed.select_by_id("r_a")
            with mock.patch(
                "tools.editor.shared.confirm.confirm_delete", return_value=True,
            ):
                ed._del_rule()
            ids = [r["id"] for r in m.rules_data["rules"]]
            self.assertNotIn("r_a", ids)
            frag_ids = [f["id"] for f in m.rules_data["fragments"]]
            self.assertEqual(frag_ids, ["f_b1"],
                             "删除规矩应连带删除其碎片，不留孤儿")

    # ---- encounter editor ------------------------------------------------
    def test_encounter_select_by_id_returns_bool(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.encounters = [{"id": "e_a", "narrative": "", "options": []},
                            {"id": "e_b", "narrative": "", "options": []}]
            ed = EncounterEditor(m)
            self.assertTrue(ed.select_by_id("e_b"))
            self.assertFalse(ed.select_by_id("nope"))

    def test_encounter_select_by_id_clears_filter(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.encounters = [{"id": "e_a", "narrative": "", "options": []},
                            {"id": "e_b", "narrative": "", "options": []}]
            ed = EncounterEditor(m)
            ed._search.setText("zzz")  # 过滤到无匹配
            self.assertTrue(ed.select_by_id("e_a"),
                            "被过滤隐藏时仍应清过滤器并选中")
            self.assertEqual(ed._search.text(), "")

    # ---- quest editor ----------------------------------------------------
    def test_quest_select_by_id_bool_and_group_compat(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.quest_groups = [{"id": "g_main", "name": "主线", "type": "main"}]
            m.quests = [{"id": "q_a", "group": "g_main", "type": "main",
                         "title": "甲", "preconditions": [],
                         "completionConditions": [], "acceptActions": [],
                         "rewards": [], "nextQuests": []}]
            ed = QuestEditor(m)
            self.assertTrue(ed.select_by_id("q_a"), "任务 id 应命中")
            self.assertTrue(ed.select_by_id("g_main"), "分组 id 也应命中（group 兼容）")
            self.assertFalse(ed.select_by_id("nope"))


if __name__ == "__main__":
    unittest.main()
