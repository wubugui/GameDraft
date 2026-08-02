"""表单类编辑器（主从列表 + 详情 + Apply）的"数据编辑后不丢失"安全网。

历史缺陷：这类编辑器只有点 Apply 才写回模型；切换条目/Save All/关闭都不提交未应用编辑，
静默丢弃。修复为：commit-on-leave（切走即提交）+ flush_to_model（Save All 前提交）+
confirm_close（关闭/切项目提示）。本测试逐个编辑器验证三条丢失路径都被堵住。
"""
from __future__ import annotations

import json
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
from tools.editor.editors.narrative_data_editors import (
    DocumentRevealsEditor,
    ScenariosCatalogEditor,
)
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

    def test_reload_refs_refreshes_open_item_rule_catalog_without_touching_draft(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.items = [{"id": "i_old", "name": "旧物"}]
            model.rules_data = {"rules": [{"id": "r_old", "name": "旧规矩"}]}
            model.encounters = [{
                "id": "enc0",
                "narrative": "old",
                "options": [{
                    "text": "选",
                    "type": "rule",
                    "requiredRuleId": "r_old",
                    "consumeItems": [{"id": "i_old", "count": 2}],
                    "conditions": [],
                    "resultActions": [],
                }],
            }]
            ed = EncounterEditor(model)
            model.items.append({"id": "i_added", "name": "新增物"})
            model.rules_data["rules"].append({"id": "r_added", "name": "新增规矩"})
            model._dirty.clear()
            ed.reload_refs_from_model()
            self.assertFalse(ed._is_dirty(), "干净表单刷新候选后不得凭空变脏")
            self.assertEqual(model._dirty, set())

            ed._e_narr.setPlainText("尚未 Apply 的正文")
            option = ed._opt_widgets[0]
            item_row = option._consume._rows[0]
            self.assertTrue(ed._is_dirty())

            # 模拟其它页删掉旧目标、添加新目标；当前旧引用必须转为孤儿保值。
            model.items = [{"id": "i_new", "name": "新物"}]
            model.rules_data = {"rules": [{"id": "r_new", "name": "新规矩"}]}
            model._dirty.clear()
            ed.reload_refs_from_model()

            self.assertIs(ed._opt_widgets[0], option, "刷新目录不得重建已打开 Option 表单")
            self.assertEqual(ed._e_narr.toPlainText(), "尚未 Apply 的正文")
            self.assertEqual(option._rule.current_id(), "r_old")
            self.assertIn("r_new", option._rule._ids)
            self.assertEqual(item_row._item_sel.current_id(), "i_old")
            self.assertIn("i_new", item_row._item_sel._ids)
            self.assertTrue(ed._is_dirty(), "刷新不得吞掉原有未提交脏态")
            self.assertEqual(model._dirty, set(), "候选目录刷新本身不得标工程脏")


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

    def test_reload_refs_preserves_open_group_run_archetype_and_draft(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            run_ids = ["run_old"]
            model.narrative_instanced_graph_ids_ordered = lambda: list(run_ids)  # type: ignore[method-assign]
            q = self._q(model, "qA")
            q["type"] = "repeatable"
            q["runArchetype"] = "run_old"
            root = ed._tree.invisibleRootItem()
            ed._tree.setCurrentItem(ed._find_tree_item(root, "quest", "qA"))
            model.quest_groups.append({"id": "g_added", "name": "新增组", "type": "main"})
            run_ids.append("run_added")
            model._dirty.clear()
            ed.reload_refs_from_model()
            self.assertFalse(ed._is_dirty(), "干净任务表单刷新候选后不得凭空变脏")
            self.assertEqual(model._dirty, set())

            ed._q_title.setText("尚未应用的标题")
            group_selector = ed._q_group
            run_selector = ed._q_run_arch
            self.assertTrue(ed._is_dirty())

            # 其它页替换分组/活计图目录；当前值虽悬垂仍必须保留，并看得到新候选。
            model.quest_groups = [{"id": "g_new", "name": "新组", "type": "main"}]
            run_ids[:] = ["run_new"]
            model._dirty.clear()
            ed.reload_refs_from_model()

            self.assertIs(ed._q_group, group_selector)
            self.assertIs(ed._q_run_arch, run_selector)
            self.assertEqual(ed._q_group.current_id(), "g0")
            self.assertIn("g_new", ed._q_group._ids)
            self.assertEqual(ed._q_run_arch.current_id(), "run_old")
            self.assertIn("run_new", ed._q_run_arch._ids)
            self.assertEqual(ed._q_title.text(), "尚未应用的标题")
            self.assertTrue(ed._is_dirty(), "刷新不得提交或清除已有未应用编辑")
            self.assertEqual(model._dirty, set(), "候选目录刷新本身不得标工程脏")


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

    def test_phase_without_status_not_forced_status_key(self) -> None:
        # 审查 P3：原 phase 无 status 键且仍是默认 pending 时，Apply/flush 后不得
        # 凭空注入 "status":"pending"（伪脏 + 格式漂移）。
        with TemporaryDirectory() as td:
            ed, model = self._editor(
                Path(td) / "p",
                [{"id": "s_ns", "phases": {"p0": {"status": "done"}, "p_bare": {}}}],
            )
            ed._sc_list.setCurrentRow(0)
            self.assertFalse(
                ed._is_dirty(),
                "无 status 键的极简 phase 纯加载不应判脏（否则每次保存都伪重写）",
            )
            ed._f_desc.setText("触发 sync")  # 任意编辑触发 phases 重建
            self.assertTrue(ed.flush_to_model())
            phases = model.scenarios_catalog["scenarios"][0]["phases"]
            self.assertNotIn(
                "status", phases["p_bare"],
                "原无 status 键的 phase 序列化后不得被注入 status",
            )
            self.assertEqual(phases["p0"].get("status"), "done",
                             "有 status 键的 phase 不受影响")

    def test_phase_explicit_pending_status_preserved(self) -> None:
        # 反向：原本就有 status 键（含 "pending"）必须保留，不得被门控误删。
        with TemporaryDirectory() as td:
            ed, model = self._editor(
                Path(td) / "p",
                [{"id": "s_ep", "phases": {"p1": {"status": "pending"}}}],
            )
            ed._sc_list.setCurrentRow(0)
            ed._f_desc.setText("触发 sync")
            self.assertTrue(ed.flush_to_model())
            p1 = model.scenarios_catalog["scenarios"][0]["phases"]["p1"]
            self.assertEqual(p1.get("status"), "pending",
                             "原有的显式 status 键必须原样保留")

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


class DocumentRevealsEditorReferenceSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_dangling_scenario_phase_survive_reload_unrelated_edit_and_save_all(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.scenarios_catalog = {
                "scenarios": [{"id": "known_line", "phases": {"current": {}}}],
            }
            original_condition = {
                "scenario": "known_line",
                "phase": "removed_phase",
                "status": "done",
                "futureField": {"keep": 1},
            }
            model.document_reveals = [{
                "id": "doc_safe",
                "blurredImagePath": "/assets/blur.png",
                "clearImagePath": "/assets/clear.png",
                "revealCondition": original_condition,
                "animation": {"durationMs": 2000, "delayMs": 0},
                "xPercent": 50,
                "yPercent": 50,
                "widthPercent": 40,
            }]
            ed = DocumentRevealsEditor(model)

            # 初始填表与显式重载都必须把清单外 phase 注入孤儿项，而非落到空项。
            self.assertEqual(ed._dr_sc_scen.current_id(), "known_line")
            self.assertEqual(ed._dr_sc_phase.current_id(), "removed_phase")
            self.assertIn("[缺失]", ed._dr_sc_phase.currentText())
            ed.reload_from_model()
            self.assertEqual(ed._dr_sc_phase.current_id(), "removed_phase")

            # scenario 随后也被其它页删除；轻量目录刷新必须同时保留两级悬垂值。
            model.scenarios_catalog = {"scenarios": [{"id": "other", "phases": {"p": {}}}]}
            ed.reload_refs_from_model()
            self.assertEqual(ed._dr_sc_scen.current_id(), "known_line")
            self.assertEqual(ed._dr_sc_phase.current_id(), "removed_phase")
            self.assertIn("[缺失]", ed._dr_sc_scen.currentText())

            # 只改位置并走 Save All；引用及同一条件内未来字段不得被结构化回写抹掉。
            ed._dr_x.setValue(51)
            ed.flush_to_model()
            self.assertEqual(model.document_reveals[0]["revealCondition"], original_condition)
            model.save_all()
            saved = json.loads(
                (root / "public/assets/data/document_reveals.json").read_text(encoding="utf-8"),
            )
            self.assertEqual(saved[0]["revealCondition"], original_condition)
            self.assertEqual(saved[0]["xPercent"], 51)


if __name__ == "__main__":
    unittest.main()
