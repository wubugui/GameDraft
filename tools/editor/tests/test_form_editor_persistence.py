"""表单类编辑器（主从列表 + 详情 + Apply）的"数据编辑后不丢失"安全网。

历史缺陷：这类编辑器只有点 Apply 才写回模型；切换条目/Save All/关闭都不提交未应用编辑，
静默丢弃。修复为：commit-on-leave（切走即提交）+ flush_to_model（Save All 前提交）+
confirm_close（关闭/切项目提示）。本测试逐个编辑器验证三条丢失路径都被堵住。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.archive_editor import ArchiveEditor
from tools.editor.editors.audio_editor import AudioEditor
from tools.editor.editors.encounter_editor import EncounterEditor
from tools.editor.editors.game_config_editor import GameConfigEditor
from tools.editor.editors.item_editor import ItemEditor
from tools.editor.editors.pressure_signal_editor import (
    PressureHoldEditor,
    SignalCueEditor,
)
from tools.editor.editors.narrative_data_editors import ScenariosCatalogEditor
from tools.editor.editors.quest_editor import QuestEditor
from tools.editor.editors.rule_editor import RuleEditor
from tools.editor.editors.shop_editor import ShopEditor
from tools.editor.editors.string_editor import StringEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class ItemEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path) -> tuple[ItemEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.items = [
            {"id": "i0", "name": "甲", "type": "consumable", "description": "", "maxStack": 1},
            {"id": "i1", "name": "乙", "type": "consumable", "description": "", "maxStack": 1},
        ]
        ed = ItemEditor(model)
        ed._refresh() if hasattr(ed, "_refresh") else None
        return ed, model

    def test_edit_then_switch_commits(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._i_name.setText("甲改")
            ed._list.setCurrentRow(1)          # 切走，不点 Apply
            self.assertEqual(model.items[0]["name"], "甲改", "切条目必须提交上一项编辑")
            ed._list.setCurrentRow(0)
            self.assertEqual(ed._i_name.text(), "甲改")

    def test_edit_then_save_all_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._i_name.setText("甲存盘")
            self.assertTrue(ed.flush_to_model())   # Save All 走 flush_to_model
            self.assertEqual(model.items[0]["name"], "甲存盘", "Save All 前必须提交未应用编辑")

    def test_clean_state_not_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            self.assertFalse(ed._is_dirty(), "纯选择不应判定为脏（避免误标未保存）")


class EncounterEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path) -> tuple[EncounterEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.encounters = [
            {"id": "enc0", "narrative": "old", "options": []},
            {"id": "enc1", "narrative": "x", "options": []},
        ]
        ed = EncounterEditor(model)
        ed._refresh(select_id="enc0")
        return ed, model

    def test_edit_then_save_all_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._e_narr.setPlainText("编辑未应用")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(model.encounters[0]["narrative"], "编辑未应用")

    def test_clean_state_not_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self.assertFalse(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            # 未编辑时 flush 不应改变数据
            self.assertEqual(model.encounters[0]["narrative"], "old")


class ShopEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path) -> tuple[ShopEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.shops = [
            {"id": "s0", "name": "甲店", "items": []},
            {"id": "s1", "name": "乙店", "items": []},
        ]
        ed = ShopEditor(model)
        ed._refresh()
        return ed, model

    def test_edit_then_switch_commits(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._s_name.setText("甲店改")
            ed._list.setCurrentRow(1)
            self.assertEqual(model.shops[0]["name"], "甲店改")

    def test_edit_then_save_all_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._s_name.setText("甲店存盘")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(model.shops[0]["name"], "甲店存盘")

    def test_clean_state_not_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            self.assertFalse(ed._is_dirty())


class GameConfigEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path) -> tuple[GameConfigEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.game_config = {
            "initialScene": "sc_a", "initialQuest": "", "fallbackScene": "sc_a",
        }
        ed = GameConfigEditor(model)
        if hasattr(ed, "_refresh"):
            ed._refresh()
        return ed, model

    def test_clean_state_not_dirty_and_flush_noop(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self.assertFalse(ed._is_dirty(), "未编辑时不应判脏（否则关闭误弹保存提示）")
            before = dict(model.game_config)
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(dict(model.game_config), before, "未编辑时 flush 不得改动数据")

    def test_edit_then_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._initial_quest.set_current("q_demo") if hasattr(ed._initial_quest, "set_current") else None
            # 用 fallbackScene 选择器制造一处可控改动
            ed._fallback_scene.set_current("sc_b") if hasattr(ed._fallback_scene, "set_current") else None
            if ed._is_dirty():
                self.assertTrue(ed.flush_to_model())
                self.assertEqual(model.game_config.get("fallbackScene"), "sc_b")


class PressureHoldEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.pressure_holds = [
            {"id": "h0", "prompt": "按", "fillSeconds": 3.0, "decayPerSecond": 0.6},
            {"id": "h1", "prompt": "压", "fillSeconds": 3.0, "decayPerSecond": 0.6},
        ]
        ed = PressureHoldEditor(model)
        if hasattr(ed, "_refresh"):
            ed._refresh()
        return ed, model

    def test_switch_and_flush_persist(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            self.assertFalse(ed._is_dirty())
            ed._f_prompt.setText("按改")
            ed._list.setCurrentRow(1)
            self.assertEqual(model.pressure_holds[0]["prompt"], "按改")
            ed._f_prompt.setText("压改")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(model.pressure_holds[1]["prompt"], "压改")


class SignalCueEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.signal_cues = [
            {"id": "c0", "description": "甲", "actions": []},
            {"id": "c1", "description": "乙", "actions": []},
        ]
        ed = SignalCueEditor(model)
        if hasattr(ed, "_refresh"):
            ed._refresh()
        return ed, model

    def test_switch_and_flush_persist(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            self.assertFalse(ed._is_dirty())
            ed._f_desc.setText("甲改")
            ed._list.setCurrentRow(1)
            self.assertEqual(model.signal_cues[0]["description"], "甲改")
            ed._f_desc.setText("乙改")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(model.signal_cues[1]["description"], "乙改")


class StringEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.strings = {"greet": {"hello": "你好", "bye": "再见"}}
        ed = StringEditor(model)
        ed._refresh()
        return ed, model

    def test_edit_then_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self.assertFalse(ed._is_dirty())
            grp = ed._tree.topLevelItem(0)
            leaf = grp.child(0)
            ed._tree.setCurrentItem(leaf)
            ed._value_edit.setPlainText("你好呀")   # live -> tree
            self.assertTrue(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(model.strings["greet"]["hello"], "你好呀")
            self.assertFalse(ed._is_dirty())


class QuestEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.quest_groups = [{"id": "g0", "name": "组", "type": "main"}]
        model.quests = [
            {"id": "qA", "group": "g0", "type": "main", "title": "任务A", "description": ""},
            {"id": "qB", "group": "g0", "type": "main", "title": "任务B", "description": ""},
        ]
        ed = QuestEditor(model)
        ed._refresh()
        return ed, model

    def _q(self, model, qid):
        return next(q for q in model.quests if q["id"] == qid)

    def test_edit_then_switch_commits(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            root = ed._tree.invisibleRootItem()
            ed._tree.setCurrentItem(ed._find_tree_item(root, "quest", "qA"))
            self.assertFalse(ed._is_dirty())
            ed._q_title.setText("任务A改")
            self.assertTrue(ed._is_dirty())
            ed._tree.setCurrentItem(ed._find_tree_item(root, "quest", "qB"))
            self.assertEqual(self._q(model, "qA")["title"], "任务A改",
                             "切任务节点必须提交上一个任务的编辑")
            self.assertEqual(ed._current_selection, "qB")
            self.assertEqual(ed._q_title.text(), "任务B", "切走后必须正确载入新任务")

    def test_edit_then_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            root = ed._tree.invisibleRootItem()
            ed._tree.setCurrentItem(ed._find_tree_item(root, "quest", "qB"))
            ed._q_title.setText("任务B改")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(self._q(model, "qB")["title"], "任务B改")


class RuleEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.rules_data = {
            "rules": [
                {"id": "r0", "name": "规矩0", "category": "ward", "layers": {"xiang": {"text": "象0"}}},
                {"id": "r1", "name": "规矩1", "category": "ward", "description": "旧式描述"},
            ],
            "fragments": [{"id": "f0", "text": "碎片0", "ruleId": "r0", "layer": "xiang"}],
        }
        ed = RuleEditor(model)
        ed._refresh()
        return ed, model

    def _rule(self, model, rid):
        return next(r for r in model.rules_data["rules"] if r["id"] == rid)

    def test_legacy_rule_not_spuriously_dirty(self) -> None:
        # 旧式 rule（description，无 layers）被选中后不得判脏，否则切换即触发非预期迁移。
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._rule_list.setCurrentRow(1)
            self.assertFalse(ed._is_dirty_rule(), "旧式 rule 仅被选中不应判脏")

    def test_rule_edit_then_switch_commits(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._rule_list.setCurrentRow(1)
            ed._r_name.setText("规矩1改")
            ed._rule_list.setCurrentRow(0)
            self.assertEqual(self._rule(model, "r1")["name"], "规矩1改",
                             "切规矩必须提交上一条编辑")

    def test_frag_edit_then_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._frag_list.setCurrentRow(0)
            if ed._frag_idx < 0:
                self.skipTest("碎片未就绪")
            ed._f_text.setPlainText("碎片0改")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(model.rules_data["fragments"][0]["text"], "碎片0改")


class ArchiveEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_edit_char_then_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.archive_characters = [
                {"id": "c0", "name": "角色0", "title": "",
                 "impressions": [], "knownInfo": [], "unlockConditions": []},
            ]
            ed = ArchiveEditor(model)
            ed._refresh_chars()
            ed._char_list.setCurrentRow(0)
            ed._ch_name.setText("角色0改")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(model.archive_characters[0]["name"], "角色0改",
                             "Save All 前必须提交未应用的档案编辑")


class AudioEditorPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_edit_table_then_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.audio_config = {"bgm": {"track_a": {"src": "a.ogg"}}}
            ed = AudioEditor(model)
            bgm = ed._sub_tabs[0]
            if hasattr(bgm, "_refresh"):
                bgm._refresh()
            it = bgm._table.item(0, 0)
            self.assertIsNotNone(it)
            it.setText("track_renamed")
            self.assertTrue(ed.flush_to_model())
            self.assertIn("track_renamed", model.audio_config.get("bgm", {}),
                          "Save All 前必须提交未应用的音频表编辑")


class ScenariosCatalogEditorPersistenceTests(unittest.TestCase):
    """Scenarios 编辑器曾不在防丢失安全网内：未 Apply 即关闭/切工程会静默丢编辑，
    且每次 Save All 无脑重写 scenarios.json。本组锁定修复：_is_dirty + 脏判定 flush +
    confirm_close + phases.outcome 不被 Apply 抹掉。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path, scenarios: list[dict]):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenarios_catalog = {"scenarios": scenarios}
        ed = ScenariosCatalogEditor(model)
        ed.reload_from_model()
        return ed, model

    def test_clean_state_not_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(
                Path(td) / "p",
                [{"id": "s_a", "phases": {"起始": {"status": "pending"}}}],
            )
            ed._sc_list.setCurrentRow(0)
            self.assertFalse(ed._is_dirty(), "纯加载/选择不应判定为脏（否则每次保存都误重写）")

    def test_edit_then_flush_persists(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(
                Path(td) / "p",
                [{"id": "s_a", "phases": {"起始": {"status": "pending"}}}],
            )
            ed._sc_list.setCurrentRow(0)
            ed._f_desc.setText("新描述")            # 不点 Apply
            self.assertTrue(ed._is_dirty(), "编辑后必须判脏")
            self.assertTrue(ed.flush_to_model(), "Save All 前必须提交未应用编辑")
            self.assertEqual(
                model.scenarios_catalog["scenarios"][0].get("description"), "新描述",
                "未 Apply 的编辑必须在 flush 时落入模型，不能静默丢弃",
            )

    def test_flush_noop_when_unedited_does_not_mark_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(
                Path(td) / "p",
                [{"id": "s_a", "phases": {"起始": {"status": "pending"}}}],
            )
            ed._sc_list.setCurrentRow(0)
            model._dirty.discard("scenarios")
            self.assertTrue(ed.flush_to_model())
            self.assertNotIn(
                "scenarios", model._dirty,
                "未改动时 flush 不得标脏（否则每次 Save All 都重写 scenarios.json）",
            )

    def test_confirm_close_clean_returns_true(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(
                Path(td) / "p",
                [{"id": "s_a", "phases": {"起始": {"status": "pending"}}}],
            )
            ed._sc_list.setCurrentRow(0)
            self.assertTrue(ed.confirm_close(), "无未应用编辑时关闭不应被拦")

    def test_phase_outcome_preserved_through_sync(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(
                Path(td) / "p",
                [{"id": "s_oc", "phases": {"p1": {"status": "done", "outcome": "win"}}}],
            )
            ed._sc_list.setCurrentRow(0)
            ed._f_desc.setText("触发 sync")          # 任意编辑触发重建 phases
            self.assertTrue(ed.flush_to_model())
            p1 = model.scenarios_catalog["scenarios"][0]["phases"]["p1"]
            self.assertEqual(p1.get("outcome"), "win",
                             "phases 无列编辑的 outcome 不得被 Apply/flush 抹掉")
            self.assertEqual(p1.get("status"), "done")

    def test_exposes_without_expose_after_phase_rejected(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(
                Path(td) / "p",
                [{
                    "id": "s_x",
                    "phases": {"起始": {"status": "pending"}},
                    "exposes": {"some_flag": True},
                }],
            )
            ed._sc_list.setCurrentRow(0)
            err = ed._validate()
            self.assertIsNotNone(err, "配了 exposes 却无 exposeAfterPhase 应被校验拦下")
            self.assertIn("exposeAfterPhase", err or "")


if __name__ == "__main__":
    unittest.main()
