"""动作/条件共享控件的数据安全护栏（2026-07 审查修复的回归锁）。

锁定形状（全部为审查中探针实测复现过的真实缺陷）：
- 泛型 float 量程不得 clamp 世界坐标（persistNpcAt x:1200 曾被夹成 50.0）；
- schema 外但运行时认识的键（changeScene.cameraX/cameraY、legacy duration 别名）不得"保存即删"；
- 悬垂引用（物品/档案条目/实体/出生点）必须保值，不得静默清空或改指第一项；
- pickup 缺 count 不得写 0（运行时默认 1="给一个"）；
- 未登记 flag 的数值条件不得被 bool 化、op== 不得丢 value 键；
- 条件层 int 不得漂 float；scenario outcome 字符串不得经 json.loads 变类型；
- "(非枚举) xxx" 展示文案不得写回 JSON；
- 可选枚举串（showNotification.type）缺省不得凭空长出空串键；
- 「最小形态打开→不改→保存」不得凭空长键（2026-09-12 全量扫描收口的 8 个 action：
  setEntityShadow / playVfx / emitVfxField 是行为级，pickup / runActionsIf / randomBranch /
  debugAlertActionParams / setSceneEntityPosition 是格式级）；
- 位置引用 `at`（dict 形态）不得被泛型裸输入框存成 Python repr 字符串；
- IdRefSelector：未知值保值、空值不落第一项、editable 手打发信号/清空返回空。
"""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QDialog

from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor, FilterableTypeCombo
from tools.editor.shared.condition_editor import ConditionEditor
from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget
from tools.editor.shared.id_ref_selector import IdRefSelector
from tools.editor.shared.reference_picker import ReferencePickerField
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

    def test_start_dialogue_explicit_owner_type_requires_owner_id(self) -> None:
        from tools.editor.validator import _append_action_param_ref_issues

        issues = []
        _append_action_param_ref_issues(
            self.model,
            issues,
            {
                "type": "startDialogueGraph",
                "params": {"graphId": "missing", "ownerType": "sceneGroup"},
            },
            "scene",
            self.scene_id or "test",
            self.scene_id,
        )
        self.assertTrue(any(
            issue.severity == "error" and "必须同时填写 ownerId" in issue.message
            for issue in issues
        ))

    def test_run_actions_if_full_form_roundtrip(self) -> None:
        """填满形态：条件树 + 两条子动作列表都要原样存回。"""
        self._assert_roundtrip({
            "type": "runActionsIf",
            "params": {
                "condition": {"timePhase": "夜"},
                "actions": [
                    {"type": "setThreeFiresVisible", "params": {"visible": True, "style": "fade"}},
                ],
                "elseActions": [
                    {"type": "setThreeFiresVisible", "params": {"visible": False, "style": "instant"}},
                ],
            },
        })

    def test_run_actions_if_minimal_form_does_not_grow_else_key(self) -> None:
        """最小形态：没写 elseActions 的，打开→什么都不改→保存不得凭空多出该键。"""
        self._assert_roundtrip({
            "type": "runActionsIf",
            "params": {
                "condition": {"all": [{"timePhase": "夜"}, {"flag": "three_fires_visible", "op": "==", "value": False}]},
                "actions": [{"type": "setThreeFiresVisible", "params": {"visible": True, "style": "flare"}}],
            },
        })

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

    def test_show_notification_minimal_form_does_not_grow_type_key(self) -> None:
        """最小形态（只写 text）：打开→什么都不改→保存不得凭空多出 type:""。

        type 在 actionParamManifest 里是 optional，泛型 str 控件的中性值是空串；
        不登记 omit 表的话全项目 showNotification 条目会被批量注入这个空键。
        """
        self._assert_roundtrip({"type": "showNotification", "params": {"text": "提示"}})

    def test_show_notification_explicit_type_survives(self) -> None:
        """显式写过的档（含显式空串）一律保留——omit 只针对"原本就没这个键"。"""
        for tv in ("", "info", "warning"):
            with self.subTest(type=tv):
                self._assert_roundtrip(
                    {"type": "showNotification", "params": {"text": "提示", "type": tv}},
                )

    def test_show_notification_non_enum_type_not_polluted(self) -> None:
        out = _roundtrip_action(
            self.model,
            {"type": "showNotification", "params": {"text": "hi", "type": "fancy_custom"}},
            self.scene_id,
        )
        self.assertEqual(out["params"].get("type"), "fancy_custom")

    # ---- 最小形态不得凭空长键（2026-09-12 全量扫描的 8 个漏网 action）----
    # 判据统一：只填 actionParamManifest.ts 的 required/nonEmpty，可选参数一律不写，
    # 打开→什么都不改→保存必须逐字节回原样。复扫脚本见
    # tools/editor/tests/scan_action_minimal_roundtrip.py。

    def test_set_entity_shadow_minimal_form_does_not_grow_virtual_params(self) -> None:
        """虚拟灯五个量的运行时默认全是非 0（135/50/0.6/0.35/0）——凭空写 0 是行为级：
        darkness:0 影子直接不可见、azimuth/elevation 归 0 方向错。"""
        for source in ("virtual", "light:lamp_1", "none"):
            with self.subTest(source=source):
                self._assert_roundtrip(
                    {"type": "setEntityShadow", "params": {"target": "player", "source": source}},
                )

    def test_set_entity_shadow_explicit_values_survive(self) -> None:
        """显式写过的一律保留——含"显式 0"（绑真实灯时运行时按 `p.darkness !== undefined`
        判断要不要覆盖，把显式 0 剔掉会让"覆盖成全黑"变成"沿用灯的 0.6"）。"""
        self._assert_roundtrip({
            "type": "setEntityShadow",
            "params": {
                "target": "player", "source": "virtual",
                "azimuthDeg": 135, "elevationDeg": 50,
                "darkness": 0.6, "softness": 0.35, "length": 40,
            },
        })
        self._assert_roundtrip({
            "type": "setEntityShadow",
            "params": {"target": "player", "source": "light:lamp_1", "darkness": 0, "softness": 0},
        })

    def test_play_vfx_minimal_form_does_not_grow_optional_params(self) -> None:
        """seed 凭空写 0 = 随机种子被钉死；countScale 凭空写 0 = **粒子一颗都不出**；
        at 凭空写 "" = parsePositionRef 解析不出 → 整个动作静默跳过。"""
        for params in (
            {"instanceId": "fog_1"},
            {"effect": "dust", "x": 120, "y": 340},
            {"effect": "dust", "at": {"kind": "entity", "id": "player"}},
            {"effect": "dust", "at": "player"},
        ):
            with self.subTest(params=params):
                self._assert_roundtrip({"type": "playVfx", "params": params})

    def test_play_vfx_explicit_values_survive(self) -> None:
        """显式写过的值一律保留，含显式 seed:0 / countScale:0（作者真要钉种子/关粒子）。"""
        self._assert_roundtrip({
            "type": "playVfx",
            "params": {
                "effect": "dust", "at": "player", "h": 12.5,
                "surface": "shell", "seed": 0, "countScale": 0,
            },
        })
        self._assert_roundtrip({
            "type": "playVfx",
            "params": {"effect": "dust", "x": 0, "y": 0, "surface": "ground", "seed": 7, "countScale": 1.5},
        })

    def test_emit_vfx_field_minimal_form_does_not_grow_optional_params(self) -> None:
        """strength 运行时缺省 1（`numOr(p.strength, 1)`）——凭空写 0 = 刺激场强度归零；
        at:"" 同 playVfx，会让整个 emit 静默跳过。"""
        for params in (
            {"tag": "item:bug", "radius": 900},
            {"tag": "gust", "radius": 600, "x": 12, "y": 34},
            {"tag": "gust", "radius": 600, "at": {"kind": "entity", "id": "player"}},
        ):
            with self.subTest(params=params):
                self._assert_roundtrip({"type": "emitVfxField", "params": params})

    def test_emit_vfx_field_explicit_values_survive(self) -> None:
        """显式值保留（含显式 strength:0 与等于运行时缺省的 kind:"fear"）；
        direction 三元组不在 _PARAM_SCHEMAS 里，走「未登记参数原值透传」不得被保存即删。"""
        self._assert_roundtrip({
            "type": "emitVfxField",
            "params": {
                "kind": "wind", "tag": "gust", "radius": 600, "strength": 900,
                "duration": 1.2, "at": {"kind": "entity", "id": "player"},
                "direction": [1, 0, 0],
            },
        })
        self._assert_roundtrip({
            "type": "emitVfxField",
            "params": {"kind": "fear", "tag": "item:bug", "radius": 900, "strength": 0, "h": 30},
        })

    def test_pickup_minimal_form_does_not_grow_item_id(self) -> None:
        """铜钱档（isCurrency + itemName + count）本就不填 itemId，运行时也不读它。"""
        self._assert_roundtrip(
            {"type": "pickup", "params": {"itemName": "铜钱", "count": 5, "isCurrency": True}},
        )

    def test_pickup_explicit_values_survive(self) -> None:
        self._assert_roundtrip({"type": "pickup", "params": {"itemId": "yellow_paper", "count": 2}})
        self._assert_roundtrip({"type": "pickup", "params": {"itemId": "", "itemName": "铜钱"}})

    def test_run_actions_if_minimal_form_does_not_grow_actions_key(self) -> None:
        """只写 condition 的（等价 runActions 的空壳 / 只用 elseActions 的）不得长出 actions:[]。"""
        self._assert_roundtrip({"type": "runActionsIf", "params": {"condition": {"timePhase": "夜"}}})
        self._assert_roundtrip({
            "type": "runActionsIf",
            "params": {
                "condition": {"timePhase": "夜"},
                "elseActions": [{"type": "showNotification", "params": {"text": "白天"}}],
            },
        })

    def test_run_actions_if_explicit_empty_actions_survive(self) -> None:
        """盘上原本写着空列表的，原样留着不动（omit 只针对"原本就没这个键"）。"""
        self._assert_roundtrip({
            "type": "runActionsIf",
            "params": {"condition": {"timePhase": "夜"}, "actions": [], "elseActions": []},
        })

    def test_random_branch_minimal_form_does_not_grow_optional_params(self) -> None:
        """probability 缺键 = 运行时 0.5；两条分支列表缺键同义于空列表。"""
        self._assert_roundtrip({"type": "randomBranch", "params": {}})
        self._assert_roundtrip({
            "type": "randomBranch",
            "params": {"aboveActions": [{"type": "showNotification", "params": {"text": "上"}}]},
        })

    def test_random_branch_explicit_values_survive(self) -> None:
        self._assert_roundtrip({
            "type": "randomBranch",
            "params": {"probability": 0.5, "aboveActions": [], "belowActions": []},
        })
        self._assert_roundtrip({
            "type": "randomBranch",
            "params": {
                "probability": 0.25,
                "aboveActions": [{"type": "showNotification", "params": {"text": "上"}}],
                "belowActions": [{"type": "showNotification", "params": {"text": "下"}}],
            },
        })

    def test_debug_alert_action_params_minimal_form_does_not_grow_title(self) -> None:
        self._assert_roundtrip({"type": "debugAlertActionParams", "params": {}})

    def test_debug_alert_action_params_explicit_title_survives(self) -> None:
        for tv in ("", "看参数"):
            with self.subTest(title=tv):
                self._assert_roundtrip({"type": "debugAlertActionParams", "params": {"title": tv}})

    def test_set_scene_entity_position_minimal_form_does_not_grow_entity_kind(self) -> None:
        """entityKind 在 manifest 里是 optional，缺键 = 运行时 'npc'；专用表单恒写它。"""
        self._assert_roundtrip({
            "type": "setSceneEntityPosition",
            "params": {"sceneId": self.scene_id or "", "entityId": "ghost_npc_不存在", "x": 12, "y": 34},
        })

    def test_set_scene_entity_position_explicit_entity_kind_survives(self) -> None:
        for kind in ("npc", "hotspot"):
            with self.subTest(entityKind=kind):
                self._assert_roundtrip({
                    "type": "setSceneEntityPosition",
                    "params": {
                        "sceneId": self.scene_id or "", "entityKind": kind,
                        "entityId": "ghost_不存在", "x": 12, "y": 34,
                    },
                })

    def test_vfx_dict_position_ref_not_stringified(self) -> None:
        """泛型面的 `at` 是裸 QLineEdit（装的是 str(原值)）：dict 形态必须按磁盘原值回写，
        否则会存成 Python repr 字符串（"{'kind': 'entity', 'id': 'player'}"），运行时
        parsePositionRef 拿它当实体 id 解析不出来 → 动作静默跳过（崖墓那阵风的真实死法）。"""
        for act_type, base in (
            ("playVfx", {"effect": "dust"}),
            ("emitVfxField", {"tag": "gust", "radius": 600}),
        ):
            for ref in (
                {"kind": "entity", "id": "player"},
                {"kind": "point", "x": 120.5, "y": 340},
                {"kind": "slot", "trajectoryId": "coin_drop_demo", "slotId": "s1"},
            ):
                with self.subTest(action=act_type, at=ref):
                    out = _roundtrip_action(
                        self.model, {"type": act_type, "params": {**base, "at": ref}}, self.scene_id,
                    )
                    self.assertEqual(out["params"].get("at"), ref)

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

    def test_scene_group_actions_use_current_scene_selector_and_keep_orphan(self) -> None:
        sid = "__action_group_selector_scene__"
        self.model.scenes[sid] = {
            "id": sid,
            "entityGroups": [{"id": "crowd", "label": "围观人群"}],
            "npcs": [{"id": "legacy_actor", "group": "legacy_group"}],
        }
        try:
            editor = ActionEditor("test")
            editor.set_project_context(self.model, sid)
            action = {
                "type": "setGroupEnabled",
                "params": {"group": "missing_old_group", "enabled": False},
            }
            editor.set_data([action])
            row = editor._rows[0]
            group = row._param_widgets["group"]
            self.assertIsInstance(group, IdRefSelector)
            self.assertFalse(group.isEditable(), "group 不应继续纯手打")
            self.assertIn("crowd", group._ids)
            self.assertIn("legacy_group", group._ids)
            self.assertEqual(editor.to_list(), [action], "悬垂旧 group 必须原样往返")
            editor.deleteLater()
        finally:
            self.model.scenes.pop(sid, None)

    def test_emit_signal_source_uses_linked_pickers_and_preserves_future_values(self) -> None:
        action = {
            "type": "emitNarrativeSignal",
            "params": {
                "signal": "some_future_signal",
                "sourceType": "future_source_kind",
                "sourceId": "future_source_id",
            },
        }
        editor = ActionEditor("test")
        editor.set_project_context(self.model, self.scene_id)
        editor.set_data([action])
        row = editor._rows[0]
        self.assertIsInstance(row._param_widgets["sourceType"], FilterableTypeCombo)
        self.assertIsInstance(row._param_widgets["sourceId"], ReferencePickerField)
        self.assertEqual(editor.to_list(), [action])
        editor.deleteLater()

    def test_emit_signal_open_source_namespace_has_define_flow(self) -> None:
        editor = ActionEditor("test")
        editor.set_project_context(self.model, self.scene_id)
        editor.set_data([{
            "type": "emitNarrativeSignal",
            "params": {"signal": "future_signal", "sourceType": "action"},
        }])
        source = editor._rows[0]._param_widgets["sourceId"]
        self.assertIsInstance(source, ReferencePickerField)
        self.assertTrue(source._allow_custom)
        self.assertFalse(source._define.isHidden())
        editor.deleteLater()


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

    def test_long_readonly_catalog_uses_independent_search_picker(self) -> None:
        w = IdRefSelector(allow_empty=True, editable=False)
        w.set_items([(f"id_{i}", f"Name {i}") for i in range(20)])
        w.set_current("id_3")
        self.assertTrue(w._uses_search_picker())

        class _AcceptedPicker:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def exec(self):
                return QDialog.DialogCode.Accepted

            def selected_value(self) -> str:
                return "id_17"

        got: list[str] = []
        w.value_changed.connect(got.append)
        with patch(
            "tools.editor.shared.reference_picker.ReferencePickerDialog",
            _AcceptedPicker,
        ):
            w._open_search_picker()
        self.assertEqual(w.current_id(), "id_17")
        self.assertEqual(got, ["id_17"])

    def test_search_picker_cancel_keeps_orphan_value(self) -> None:
        w = IdRefSelector(allow_empty=True, editable=False)
        w.set_items([(f"id_{i}", f"Name {i}") for i in range(20)])
        w.set_current("dangling_old")

        class _CancelledPicker:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def exec(self):
                return QDialog.DialogCode.Rejected

            def selected_value(self) -> str:
                raise AssertionError("cancelled picker must not read a selection")

        with patch(
            "tools.editor.shared.reference_picker.ReferencePickerDialog",
            _CancelledPicker,
        ):
            w._open_search_picker()
        self.assertEqual(w.current_id(), "dangling_old")

    def test_contextless_group_action_can_choose_project_group_but_writes_bare_id(self) -> None:
        model = ProjectModel()
        model.scenes = {
            "scene_a": {
                "entityGroups": [{"id": "guards", "label": "守卫"}],
                "npcs": [], "hotspots": [], "zones": [],
            },
            "scene_b": {
                "entityGroups": [{"id": "guards"}, {"id": "crowd"}],
                "npcs": [], "hotspots": [], "zones": [],
            },
        }
        ed = ActionEditor("test")
        ed.set_project_context(model, None)
        ed.set_data([{"type": "setGroupEnabled", "params": {"group": "guards", "enabled": True}}])
        row = ed._rows[0]
        selector = row._param_widgets["group"]
        self.assertIsInstance(selector, IdRefSelector)
        self.assertIn("guards", selector._ids)
        self.assertIn("crowd", selector._ids)
        self.assertEqual(ed.to_list()[0]["params"]["group"], "guards")
        ed.deleteLater()

    def test_long_select_only_type_catalog_uses_search_dialog(self) -> None:
        combo = FilterableTypeCombo(
            [(f"Scene {i}", f"scene_{i}") for i in range(30)],
            select_only=True,
        )
        combo.set_committed_type("scene_2")

        class _AcceptedPicker:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            def exec(self):
                return QDialog.DialogCode.Accepted

            def selected_value(self) -> str:
                return "scene_27"

        with patch(
            "tools.editor.shared.action_editor.ReferencePickerDialog",
            _AcceptedPicker,
        ):
            combo.showPopup()
        self.assertEqual(combo.committed_type(), "scene_27")


if __name__ == "__main__":
    unittest.main()
