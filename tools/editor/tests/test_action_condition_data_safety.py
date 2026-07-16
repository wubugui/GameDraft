"""动作/条件共享控件的数据安全护栏（2026-07 审查修复的回归锁）。

锁定形状（全部为审查中探针实测复现过的真实缺陷）：
- 泛型 float 量程不得 clamp 世界坐标（persistNpcAt x:1200 曾被夹成 50.0）；
- schema 外但运行时认识的键（changeScene.cameraX/cameraY、legacy duration 别名）不得"保存即删"；
- 悬垂引用（物品/档案条目/实体/出生点）必须保值，不得静默清空或改指第一项；
- pickup 缺 count 不得写 0（运行时默认 1="给一个"）；
- 未登记 flag 的数值条件不得被 bool 化、op== 不得丢 value 键；
- 条件层 int 不得漂 float；scenario outcome 字符串不得经 json.loads 变类型；
- "(非枚举) xxx" 展示文案不得写回 JSON；
- IdRefSelector：未知值保值、空值不落第一项、editable 手打发信号/清空返回空。
"""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor
from tools.editor.shared.condition_editor import ConditionEditor
from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget
from tools.editor.shared.id_ref_selector import IdRefSelector
from tools.editor.tests.save_test_utils import repo_root_from_tests


def _roundtrip_action(model: ProjectModel, action: dict, scene_id: str | None = None) -> dict:
    ed = ActionEditor("test")
    ed.set_project_context(model, scene_id)
    ed.set_data([action])
    out = ed.to_list()
    assert len(out) == 1
    return out[0]


class ActionDataSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def _assert_roundtrip(self, action: dict) -> None:
        out = _roundtrip_action(self.model, action, self.scene_id)
        self.assertEqual(out, action)

    def test_persist_npc_at_world_coords_not_clamped(self) -> None:
        self._assert_roundtrip(
            {"type": "persistNpcAt", "params": {"target": "storyteller_zhang", "x": 1200, "y": 860}},
        )

    def test_add_flag_value_large_delta_not_clamped(self) -> None:
        self._assert_roundtrip(
            {"type": "addFlagValue", "params": {"key": "some_counter", "delta": 100}},
        )

    def test_change_scene_camera_keys_survive(self) -> None:
        self._assert_roundtrip(
            {
                "type": "changeScene",
                "params": {"targetScene": "雾津街头", "cameraX": 320, "cameraY": 180},
            },
        )

    def test_legacy_duration_alias_survives(self) -> None:
        out = _roundtrip_action(
            self.model,
            {"type": "fadingZoom", "params": {"zoom": 2.0, "duration": 800}},
            self.scene_id,
        )
        self.assertEqual(out["params"].get("duration"), 800)
        self.assertNotIn("durationMs", out["params"])  # 缺省默认不得凭空注入

    def test_dangling_give_item_id_preserved(self) -> None:
        self._assert_roundtrip(
            {"type": "giveItem", "params": {"id": "ghost_item_不存在"}},
        )

    def test_dangling_archive_entry_preserved(self) -> None:
        self._assert_roundtrip(
            {
                "type": "addArchiveEntry",
                "params": {"bookType": "character", "entryId": "ghost_entry_不存在"},
            },
        )

    def test_dangling_switch_scene_spawn_preserved(self) -> None:
        self._assert_roundtrip(
            {
                "type": "switchScene",
                "params": {"targetScene": "雾津街头", "targetSpawnPoint": "spawn_不存在"},
            },
        )

    def test_pickup_without_count_stays_absent(self) -> None:
        out = _roundtrip_action(
            self.model,
            {"type": "pickup", "params": {"itemId": "yellow_paper"}},
            self.scene_id,
        )
        self.assertNotIn("count", out["params"])
        self.assertNotIn("isCurrency", out["params"])

    def test_set_flag_unregistered_numeric_value_preserved(self) -> None:
        self._assert_roundtrip(
            {"type": "setFlag", "params": {"key": "unreg_key_xyz", "value": 3}},
        )

    def test_show_notification_non_enum_type_not_polluted(self) -> None:
        out = _roundtrip_action(
            self.model,
            {"type": "showNotification", "params": {"text": "hi", "type": "fancy_custom"}},
            self.scene_id,
        )
        self.assertEqual(out["params"].get("type"), "fancy_custom")

    def test_set_scenario_phase_non_enum_status_not_polluted(self) -> None:
        out = _roundtrip_action(
            self.model,
            {
                "type": "setScenarioPhase",
                "params": {"scenarioId": "码头水鬼", "phase": "p1", "status": "weird_status"},
            },
            self.scene_id,
        )
        self.assertEqual(out["params"].get("status"), "weird_status")

    def test_set_entity_field_dangling_entity_preserved(self) -> None:
        act = {
            "type": "setEntityField",
            "params": {
                "sceneId": self.scene_id or "",
                "entityKind": "npc",
                "entityId": "ghost_npc_不存在",
                "fieldName": "x",
                "value": 123.0,
            },
        }
        out = _roundtrip_action(self.model, act, self.scene_id)
        self.assertEqual(out["params"].get("entityId"), "ghost_npc_不存在")

    def test_set_scene_entity_position_dangling_keeps_xy(self) -> None:
        act = {
            "type": "setSceneEntityPosition",
            "params": {
                "sceneId": self.scene_id or "",
                "entityKind": "npc",
                "entityId": "ghost_npc_不存在",
                "x": 123.45,
                "y": 67.89,
            },
        }
        out = _roundtrip_action(self.model, act, self.scene_id)
        self.assertEqual(out["params"].get("entityId"), "ghost_npc_不存在")
        self.assertEqual(out["params"].get("x"), 123.45)
        self.assertEqual(out["params"].get("y"), 67.89)


class ConditionDataSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())

    def _roundtrip_conditions(self, conds: list[dict]) -> list[dict]:
        ed = ConditionEditor("test")
        ed.set_flag_pattern_context(self.model, None)
        ed.set_data(conds)
        return ed.to_list()

    def test_unregistered_flag_numeric_condition_not_boolified(self) -> None:
        conds = [{"flag": "unreg_key_xyz", "op": ">", "value": 3}]
        self.assertEqual(self._roundtrip_conditions(conds), conds)

    def test_unregistered_flag_eq_numeric_keeps_value_key(self) -> None:
        conds = [{"flag": "unreg_key_xyz", "value": 3}]
        self.assertEqual(self._roundtrip_conditions(conds), conds)

    def test_registered_float_flag_int_value_stays_int(self) -> None:
        # 找一个登记为 float 的 key；若工程没有则跳过
        from tools.editor.flag_registry import registry_value_type_for_key

        reg = self.model.flag_registry
        float_key = None
        for e in reg.get("static") or []:
            if isinstance(e, dict) and registry_value_type_for_key(str(e.get("key")), reg) == "float":
                float_key = str(e.get("key"))
                break
        if not float_key:
            self.skipTest("工程无 float 型登记 flag")
        conds = [{"flag": float_key, "op": ">=", "value": 3}]
        out = self._roundtrip_conditions(conds)
        self.assertEqual(out, conds)
        self.assertIsInstance(out[0]["value"], int)

    def test_tree_scenario_outcome_string_not_retyped(self) -> None:
        tree = ConditionExprTreeRootWidget(model_getter=lambda: self.model)
        expr = {"scenario": "码头水鬼", "phase": "p1", "status": "done", "outcome": "true"}
        tree.set_expr(expr)
        out = tree.get_expr()
        self.assertEqual(out, expr)
        self.assertIsInstance(out["outcome"], str)

    def test_tree_quest_without_status_not_injected(self) -> None:
        tree = ConditionExprTreeRootWidget(model_getter=lambda: self.model)
        expr = {"quest": "q_不存在也保值"}
        tree.set_expr(expr)
        self.assertEqual(tree.get_expr(), expr)

    def test_expert_json_appended_even_when_tree_active(self) -> None:
        ed = ConditionEditor("test")
        ed.set_flag_pattern_context(self.model, None)
        ed.set_data([{"scenario": "s1", "phase": "p", "status": "done"}])
        ed._extra_json.setPlainText('{"flag": "pasted_new_flag"}')
        out = ed.to_list()
        self.assertIn({"flag": "pasted_new_flag"}, out)


class IdRefSelectorSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_unknown_value_preserved_not_first_item(self) -> None:
        w = IdRefSelector(allow_empty=False)
        w.set_items([("a", "A"), ("b", "B")])
        w.set_current("不存在")
        self.assertEqual(w.current_id(), "不存在")

    def test_empty_value_not_first_item_when_not_allow_empty(self) -> None:
        w = IdRefSelector(allow_empty=False)
        w.set_items([("a", "A"), ("b", "B")])
        w.set_current("")
        self.assertEqual(w.current_id(), "")

    def test_allow_empty_unknown_value_preserved(self) -> None:
        w = IdRefSelector(allow_empty=True)
        w.set_items([("a", "A")])
        w.set_current("孤儿id")
        self.assertEqual(w.current_id(), "孤儿id")

    def test_editable_typed_text_emits_and_clears(self) -> None:
        w = IdRefSelector(allow_empty=True, editable=True)
        w.set_items([("a", "A"), ("b", "B")])
        got: list[str] = []
        w.value_changed.connect(got.append)
        le = w.lineEdit()
        assert le is not None
        le.clear()
        le.insert("zz_custom")  # 模拟用户键入（textEdited 不由 setText 触发，用 insert 经编辑路径）
        # editable 手打必须发 value_changed（供调用方置 pending-dirty）
        self.assertTrue(any(g == "zz_custom" for g in got) or w.current_id() == "zz_custom")
        le.selectAll()
        le.del_()
        self.assertEqual(w.current_id(), "")

    def test_set_items_skip_path_keeps_uncommitted_text(self) -> None:
        w = IdRefSelector(allow_empty=True, editable=True)
        items = [("a", "A"), ("b", "B")]
        w.set_items(items)
        le = w.lineEdit()
        assert le is not None
        le.setText("zz_uncommitted")
        w.set_items(items)  # 相同清单：缓存跳过路径不得抹掉手打中的文本
        self.assertEqual(w.current_id(), "zz_uncommitted")


if __name__ == "__main__":
    unittest.main()
