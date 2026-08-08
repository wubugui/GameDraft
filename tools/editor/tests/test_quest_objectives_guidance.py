"""任务目标 / 引导 / 提示档位（玩法文档 D7–D9）的编辑器与校验防火墙。

三条要守的线：

1. **零丢失往返**：填满形态原样回来；**最小形态打开→不改→保存不得凭空多键**
   （加可选参数最容易踩的一脚：把 offscreenArrow:false / announce:"" 写进全项目）。
2. **校验拦死指不到的引导**：场景/实体不存在 = 运行时箭头默默不出现，必须构建期 error。
3. **实体改名/迁场景时引导跟随**：引导目标是场景限定引用，重构引擎要机械改写它。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.entity_refactor import move_entity, rename_entity, scan_entity_usages
from tools.editor.shared.quest_guidance_editor import GuidanceEditor, ObjectivesEditor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate


def _app() -> QApplication:
    return QApplication.instance() or QApplication([])


_SCENE = {
    "id": "dock",
    "background": "",
    "npcs": [{"id": "laoxiang", "name": "老乡", "x": 100, "y": 200}],
    "hotspots": [{"id": "crate", "type": "inspect", "x": 10, "y": 20, "interactionRange": 40}],
    "zones": [{"id": "waterside", "polygon": [{"x": 0, "y": 0}, {"x": 10, "y": 10}]}],
}


def _write_project(root: Path, quests: list[dict[str, Any]]) -> ProjectModel:
    write_minimal_loadable_project(root)
    dp = root / "public" / "assets" / "data"
    sp = root / "public" / "assets" / "scenes"

    def dump(path: Path, obj: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    dump(dp / "quests.json", quests)
    dump(dp / "questGroups.json", [{"id": "g", "name": "组", "type": "side"}])
    dump(sp / "dock.json", _SCENE)
    model = ProjectModel()
    model.load_project(root)
    return model


def _quest(**over: Any) -> dict[str, Any]:
    q: dict[str, Any] = {
        "id": "q1", "group": "g", "type": "side", "title": "任务", "description": "",
        "preconditions": [], "completionConditions": [], "rewards": [], "nextQuests": [],
    }
    q.update(over)
    return q


FULL_GUIDANCE = [
    {"kind": "mapMarker", "sceneId": "dock", "label": "码头"},
    {
        "kind": "worldMarker", "sceneId": "dock", "entityKind": "npc", "entityId": "laoxiang",
        "label": "老乡", "offscreenArrow": False, "showDistance": True,
    },
    {"kind": "worldMarker", "sceneId": "dock", "x": 120, "y": 240},
    {"kind": "sceneHint", "sceneId": "dock", "text": "先找老乡"},
]


class GuidanceEditorRoundtripTests(unittest.TestCase):
    def setUp(self) -> None:
        _app()
        self._td = TemporaryDirectory()
        self.model = _write_project(Path(self._td.name) / "p", [_quest()])

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_full_shape_roundtrips(self) -> None:
        w = GuidanceEditor(self.model)
        w.set_data(FULL_GUIDANCE)
        self.assertEqual(w.to_list(), FULL_GUIDANCE)

    def test_minimal_shape_adds_no_keys(self) -> None:
        """最小形态：只有 kind+sceneId，保存后**一个键都不许多**。"""
        minimal = [{"kind": "worldMarker", "sceneId": "dock", "entityKind": "hotspot", "entityId": "crate"}]
        w = GuidanceEditor(self.model)
        w.set_data(minimal)
        self.assertEqual(w.to_list(), minimal)

    def test_integer_coords_do_not_drift_to_float(self) -> None:
        rows = [{"kind": "worldMarker", "sceneId": "dock", "x": 120, "y": 240}]
        w = GuidanceEditor(self.model)
        w.set_data(rows)
        out = w.to_list()
        self.assertIsInstance(out[0]["x"], int)
        self.assertIsInstance(out[0]["y"], int)

    def test_unknown_keys_pass_through(self) -> None:
        rows = [{"kind": "mapMarker", "sceneId": "dock", "未来字段": 7}]
        w = GuidanceEditor(self.model)
        w.set_data(rows)
        self.assertEqual(w.to_list()[0].get("未来字段"), 7)

    def test_fields_show_and_hide_by_kind(self) -> None:
        """三通道各自只露用得上的字段——露一堆填不了的框是最劝退的一种编辑器。"""
        w = GuidanceEditor(self.model)
        w.set_data([{"kind": "mapMarker", "sceneId": "dock"}])
        row = w._rows[0]
        # 用 isHidden()（"是否被显式隐藏"）而不是 isVisible()——后者还要求整条祖先链已显示，
        # 离屏测试里根窗口从没 show 过，恒为 False，断言不出任何东西。
        self.assertTrue(row.entity_id.isHidden())
        self.assertTrue(row.text.isHidden())
        self.assertFalse(row.label.isHidden())

        row.kind.setCurrentIndex(row.kind.findData("worldMarker"))
        self.assertFalse(row.entity_id.isHidden())
        self.assertFalse(row.xy_row.isHidden())
        self.assertFalse(row.offscreen.isHidden())
        self.assertTrue(row.text.isHidden())

        row.kind.setCurrentIndex(row.kind.findData("sceneHint"))
        self.assertFalse(row.text.isHidden())
        self.assertTrue(row.entity_id.isHidden())
        self.assertTrue(row.offscreen.isHidden())

    def test_entity_candidates_follow_scene_and_kind(self) -> None:
        w = GuidanceEditor(self.model)
        w.set_data([{"kind": "worldMarker", "sceneId": "dock", "entityKind": "npc", "entityId": "laoxiang"}])
        row = w._rows[0]
        self.assertEqual(row.entity_id.current_id(), "laoxiang")
        row.entity_kind.setCurrentText("hotspot")
        # 换了种类候选跟着换；原值不在新候选里时**保值展示**，不静默清空
        self.assertEqual(row.entity_id.current_id(), "laoxiang")

    def test_scene_and_entity_fields_are_not_bare_line_edits(self) -> None:
        """选择器铁律：引用字段必须是选择器（手打错 = 运行时静默不出引导）。"""
        from PySide6.QtWidgets import QLineEdit
        w = GuidanceEditor(self.model)
        w.set_data([{"kind": "worldMarker", "sceneId": "dock"}])
        row = w._rows[0]
        self.assertNotIsInstance(row.scene, QLineEdit)
        self.assertNotIsInstance(row.entity_id, QLineEdit)


class ObjectivesEditorTests(unittest.TestCase):
    def setUp(self) -> None:
        _app()
        self._td = TemporaryDirectory()
        self.model = _write_project(Path(self._td.name) / "p", [_quest()])

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_roundtrip_full_and_minimal(self) -> None:
        items = [
            {"id": "o1", "text": "去码头", "completeWhen": [{"flag": "at_dock"}],
             "guidance": [{"kind": "mapMarker", "sceneId": "dock"}], "optional": True},
            {"id": "o2", "text": "找老乡"},
        ]
        w = ObjectivesEditor(self.model)
        w.set_data(items)
        self.assertEqual(w.to_list(), items)

    def test_move_carries_conditions_and_guidance(self) -> None:
        items = [
            {"id": "o1", "text": "甲", "completeWhen": [{"flag": "f1"}]},
            {"id": "o2", "text": "乙", "guidance": [{"kind": "mapMarker", "sceneId": "dock"}]},
        ]
        w = ObjectivesEditor(self.model)
        w.set_data(items)
        w._move_row(w._rows[0], 1)
        out = w.to_list()
        self.assertEqual([o["id"] for o in out], ["o2", "o1"])
        self.assertEqual(out[0].get("guidance"), [{"kind": "mapMarker", "sceneId": "dock"}])
        self.assertEqual(out[1].get("completeWhen"), [{"flag": "f1"}])

    def test_move_keeps_expansion_state(self) -> None:
        """调顺序不该把正在编辑的那几条折叠回去（重建整列的副作用）。"""
        w = ObjectivesEditor(self.model)
        w.set_data([{"id": "o1", "text": "甲"}, {"id": "o2", "text": "乙"}])
        w._rows[0].section.set_expanded(True)
        w._rows[0].guidance_section.set_expanded(True)
        w._move_row(w._rows[0], 1)
        moved = next(r for r in w._rows if r.id_edit.text().strip() == "o1")
        self.assertTrue(moved.section.is_expanded())
        self.assertTrue(moved.guidance_section.is_expanded())

    def test_half_filled_row_without_id_is_dropped(self) -> None:
        w = ObjectivesEditor(self.model)
        w.set_data([{"id": "", "text": "还没起名"}])
        self.assertEqual(w.to_list(), [])


class QuestEditorFormRoundtripTests(unittest.TestCase):
    """整页表单：打开一个**没配**目标/引导/提示的任务，应用后不得多出这些键。"""

    def setUp(self) -> None:
        _app()
        self._td = TemporaryDirectory()
        self.root = Path(self._td.name) / "p"
        self.model = _write_project(self.root, [_quest()])

    def tearDown(self) -> None:
        self._td.cleanup()

    def _editor(self):
        from tools.editor.editors.quest_editor import QuestEditor
        return QuestEditor(self.model)

    def test_open_apply_adds_no_optional_keys(self) -> None:
        ed = self._editor()
        ed._show_quest_props("q1")
        self.assertFalse(ed._is_dirty(), "打开即脏 = 违反编辑器不变量")
        self.assertTrue(ed._apply_quest())
        q = next(q for q in self.model.quests if q["id"] == "q1")
        for key in ("objectives", "guidance", "announce", "autoFocus"):
            self.assertNotIn(key, q, f"未配置的 {key} 被凭空写出（往返漂移）")

    def test_explicit_default_values_do_not_make_it_dirty(self) -> None:
        """磁盘上显式写了默认值键（手写 JSON 完全合法）时，**打开不许判脏**。

        判脏一旦比写回口径严，「只是点开看一眼再切走」就会被 commit-on-leave 悄悄改写
        （整个工程标脏 + 那几个键被抹掉），用户什么都没编辑。
        """
        self.model.quests[0]["objectives"] = [
            {"id": "o1", "text": "甲", "optional": False, "completeWhen": [], "guidance": []},
        ]
        self.model.quests[0]["guidance"] = [
            {"kind": "worldMarker", "sceneId": "dock", "entityKind": "npc",
             "entityId": "laoxiang", "showDistance": False},
        ]
        ed = self._editor()
        ed._show_quest_props("q1")
        self.assertFalse(ed._is_dirty(), "显式写了默认值的任务被误判为脏")

    def test_editing_other_fields_does_not_strip_explicit_default_keys(self) -> None:
        """改标题不该顺手把 objectives 里显式写的默认值键抹掉（语义等价但是白噪音 diff）。"""
        self.model.quests[0]["objectives"] = [
            {"id": "o1", "text": "甲", "optional": False, "completeWhen": []},
        ]
        ed = self._editor()
        ed._show_quest_props("q1")
        ed._q_title.setText("改过的标题")
        self.assertTrue(ed._is_dirty())
        self.assertTrue(ed._apply_quest())
        q = next(q for q in self.model.quests if q["id"] == "q1")
        self.assertEqual(q["title"], "改过的标题")
        self.assertEqual(q["objectives"], [{"id": "o1", "text": "甲", "optional": False, "completeWhen": []}])

    def test_announce_and_autofocus_roundtrip(self) -> None:
        self.model.quests[0]["announce"] = "banner"
        self.model.quests[0]["autoFocus"] = False
        ed = self._editor()
        ed._show_quest_props("q1")
        self.assertFalse(ed._is_dirty())
        self.assertTrue(ed._apply_quest())
        q = next(q for q in self.model.quests if q["id"] == "q1")
        self.assertEqual(q["announce"], "banner")
        self.assertIs(q["autoFocus"], False)

    def test_objectives_and_guidance_roundtrip(self) -> None:
        self.model.quests[0]["objectives"] = [
            {"id": "o1", "text": "去码头", "guidance": [{"kind": "mapMarker", "sceneId": "dock"}]},
        ]
        self.model.quests[0]["guidance"] = [{"kind": "sceneHint", "sceneId": "dock", "text": "出门"}]
        ed = self._editor()
        ed._show_quest_props("q1")
        self.assertFalse(ed._is_dirty())
        self.assertTrue(ed._apply_quest())
        q = next(q for q in self.model.quests if q["id"] == "q1")
        self.assertEqual(q["objectives"][0]["id"], "o1")
        self.assertEqual(q["guidance"][0]["kind"], "sceneHint")


class GuidanceValidationTests(unittest.TestCase):
    def _errors(self, quests: list[dict[str, Any]]) -> list[str]:
        with TemporaryDirectory() as td:
            model = _write_project(Path(td) / "p", quests)
            return [i.message for i in validate(model)
                    if i.severity == "error" and i.data_type == "quest"]

    def test_valid_guidance_passes(self) -> None:
        self.assertEqual(self._errors([_quest(guidance=FULL_GUIDANCE)]), [])

    def test_unknown_scene_is_error(self) -> None:
        msgs = self._errors([_quest(guidance=[{"kind": "mapMarker", "sceneId": "没这个场景"}])])
        self.assertTrue(any("不存在" in m for m in msgs), msgs)

    def test_entity_not_in_scene_is_error(self) -> None:
        msgs = self._errors([_quest(guidance=[
            {"kind": "worldMarker", "sceneId": "dock", "entityKind": "npc", "entityId": "查无此人"},
        ])])
        self.assertTrue(any("不在场景" in m for m in msgs), msgs)

    def test_world_marker_needs_entity_or_point(self) -> None:
        msgs = self._errors([_quest(guidance=[{"kind": "worldMarker", "sceneId": "dock"}])])
        self.assertTrue(any("须指向实体" in m for m in msgs), msgs)

    def test_scene_hint_needs_text(self) -> None:
        msgs = self._errors([_quest(guidance=[{"kind": "sceneHint", "sceneId": "dock"}])])
        self.assertTrue(any("text 不可为空" in m for m in msgs), msgs)

    def test_bad_announce_value(self) -> None:
        msgs = self._errors([_quest(announce="很醒目")])
        self.assertTrue(any("announce" in m for m in msgs), msgs)

    def test_duplicate_objective_id(self) -> None:
        msgs = self._errors([_quest(objectives=[
            {"id": "o1", "text": "甲"}, {"id": "o1", "text": "乙"},
        ])])
        self.assertTrue(any("重复" in m for m in msgs), msgs)

    def test_objective_empty_text(self) -> None:
        msgs = self._errors([_quest(objectives=[{"id": "o1", "text": "  "}])])
        self.assertTrue(any("text 为空" in m for m in msgs), msgs)

    def test_set_focused_quest_unknown_target_is_error(self) -> None:
        q = _quest(rewards=[{"type": "setFocusedQuest", "params": {"id": "查无此任务"}}])
        with TemporaryDirectory() as td:
            model = _write_project(Path(td) / "p", [q])
            msgs = [i.message for i in validate(model) if i.severity == "error"]
        self.assertTrue(any("setFocusedQuest" in m for m in msgs), msgs)

    def test_set_focused_quest_empty_id_is_allowed(self) -> None:
        """空 id = 清空当前任务，是合法用法。"""
        q = _quest(rewards=[{"type": "setFocusedQuest", "params": {"id": ""}}])
        with TemporaryDirectory() as td:
            model = _write_project(Path(td) / "p", [q])
            msgs = [i.message for i in validate(model)
                    if i.severity == "error" and "setFocusedQuest" in i.message]
        self.assertEqual(msgs, [])


class GuidanceRefactorFollowTests(unittest.TestCase):
    """引导目标是场景限定引用：改名 / 迁场景必须机械跟随，否则运行时静默指空。"""

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.root = Path(self._td.name) / "p"
        quests = [_quest(objectives=[{
            "id": "o1", "text": "找老乡",
            "guidance": [{"kind": "worldMarker", "sceneId": "dock", "entityKind": "npc", "entityId": "laoxiang"}],
        }])]
        self.model = _write_project(self.root, quests)
        # 迁移目标场景
        (self.root / "public" / "assets" / "scenes" / "street.json").write_text(
            json.dumps({"id": "street", "background": "", "npcs": [], "hotspots": [], "zones": []},
                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.model = ProjectModel()
        self.model.load_project(self.root)

    def tearDown(self) -> None:
        self._td.cleanup()

    def _guidance(self) -> dict:
        return self.model.quests[0]["objectives"][0]["guidance"][0]

    def test_scan_reports_quest_guidance(self) -> None:
        report = scan_entity_usages(self.model, "dock", "npc", "laoxiang")
        # 必须给到任务粒度：重构弹窗要显示「是哪条任务的引导指着它」
        self.assertEqual(report["questGuidance"], [{"bucket": "quest", "itemId": "q1", "count": 1}])
        self.assertGreaterEqual(report["totalRefs"], 1)

    def test_refactor_dialog_shows_quest_guidance_row(self) -> None:
        """计数进了标题却不在树里露出来 = 用户无从判断删除风险。"""
        _app()
        from tools.editor.shared.entity_refactor_dialog import _usage_tree
        report = scan_entity_usages(self.model, "dock", "npc", "laoxiang")
        tree = _usage_tree(report)
        titles = [tree.topLevelItem(i).text(0) for i in range(tree.topLevelItemCount())]
        self.assertTrue(any("任务引导目标" in t for t in titles), titles)

    def test_rename_follows(self) -> None:
        rename_entity(self.model, "dock", "npc", "laoxiang", "laoxiang2")
        self.assertEqual(self._guidance()["entityId"], "laoxiang2")
        self.assertEqual(self._guidance()["sceneId"], "dock")

    def test_move_follows(self) -> None:
        move_entity(self.model, "dock", "npc", "laoxiang", "street")
        self.assertEqual(self._guidance()["sceneId"], "street")
        self.assertEqual(self._guidance()["entityId"], "laoxiang")


if __name__ == "__main__":
    unittest.main()
