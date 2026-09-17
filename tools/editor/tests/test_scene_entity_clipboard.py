"""场景实体剪贴板（Ctrl+C / Ctrl+V，可跨场景）。

两层：
- 引擎规则（`shared/entity_refactor` 剪贴板一节）：取号、落位、跨场景引用口径、报告；
- 两个画布的**真实入口**：画布 / 实体树上发真实按键、右键菜单项真的接到那个函数。
  此前两个画布都只有 Ctrl+D（本场景创建副本），Ctrl+C / Ctrl+V 一个调用点都没有——
  制作人按下去毫无反应。
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtCore import QPointF, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QMenu, QMessageBox

from tools.editor.shared import entity_refactor as er

_CTRL = Qt.KeyboardModifier.ControlModifier


class _Model:
    def __init__(self, scenes: dict) -> None:
        self.scenes = scenes
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, domain: str, key: str = "") -> None:
        self.dirty.append((domain, key))


def _scenes() -> dict:
    return {
        "街": {
            "id": "街", "worldWidth": 1000, "worldHeight": 800,
            "entityGroups": [{"id": "夜摊", "phases": ["night"]}],
            "npcs": [
                {"id": "老王", "name": "老王", "x": 100.25, "y": 200, "group": "夜摊",
                 "cutsceneIds": ["cut_a"], "cutsceneOnly": True,
                 "patrol": {"route": [{"x": 100, "y": 200}, {"x": 150, "y": 200}]}},
            ],
            "hotspots": [
                {"id": "摊子", "type": "inspect", "x": 300, "y": 400, "data": {
                    "actions": [
                        {"type": "showEmote", "params": {"target": "老王"}},
                        {"type": "showEmote", "params": {"target": "路人甲"}},
                        {"type": "showEmote", "params": {"target": "player"}},
                        {"type": "moveEntityTo", "params": {
                            "target": "老王", "at": {"kind": "entity", "id": "摊子"}}},
                        {"type": "emitNarrativeSignal", "params": {
                            "signal": "s", "sourceId": "街:摊子"}},
                    ]}},
            ],
            "zones": [
                {"id": "z", "polygon": [{"x": 10, "y": 10}, {"x": 60, "y": 10},
                                        {"x": 60, "y": 60}]},
            ],
            "spawnPoints": {"门口": {"x": 5, "y": 6}},
        },
        "河边": {
            "id": "河边", "worldWidth": 400, "worldHeight": 300,
            "npcs": [{"id": "船夫", "x": 50, "y": 50}],
            "hotspots": [], "zones": [], "spawnPoints": {},
        },
    }


class ClipEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.model = _Model(_scenes())

    def clip(self, refs, sid="街"):
        # 走一遍文本往返：剪贴板里真正存的是文本
        text = er.entity_clip_to_text(er.build_entity_clip(self.model, sid, refs))
        parsed = er.parse_entity_clip(text)
        self.assertIsNotNone(parsed)
        return parsed

    def row(self, sid, list_key, eid):
        return next(r for r in self.model.scenes[sid][list_key] if r["id"] == eid)

    def test_copy_does_not_touch_the_model(self) -> None:
        before = copy.deepcopy(self.model.scenes)
        self.clip([("npc", "老王"), ("hotspot", "摊子")])
        self.assertEqual(self.model.scenes, before)
        self.assertEqual(self.model.dirty, [])

    def test_copy_rejects_default_spawn_and_unknowns(self) -> None:
        with self.assertRaises(er.EntityRefactorError):
            er.build_entity_clip(self.model, "街", [("spawn", "default"), ("group", "夜摊")])

    def test_foreign_text_is_not_a_clip(self) -> None:
        self.assertIsNone(er.parse_entity_clip("hello"))
        self.assertIsNone(er.parse_entity_clip(json.dumps([{"type": "showEmote"}])))
        self.assertIsNone(er.parse_entity_clip(
            json.dumps({er.ENTITY_CLIP_MARK: 99, "entities": []})))

    def test_same_scene_paste_gets_copy_id_and_steps_off_the_original(self) -> None:
        summary = er.paste_entity_clip(self.model, "街", self.clip([("npc", "老王")]))
        self.assertEqual([e["newId"] for e in summary["entries"]], ["老王_copy"])
        new = self.row("街", "npcs", "老王_copy")
        self.assertEqual((new["x"], new["y"]), (124.2, 224))
        self.assertEqual(new["patrol"]["route"][0], {"x": 124, "y": 224})
        self.assertNotIn("cutsceneIds", new)
        self.assertNotIn("cutsceneOnly", new)
        self.assertEqual(new["group"], "夜摊", "同场景分组有定义，应保留")
        self.assertIn(("scene", "街"), self.model.dirty)

    def test_pasting_twice_cascades_instead_of_stacking(self) -> None:
        clip = self.clip([("npc", "老王")])
        er.paste_entity_clip(self.model, "街", clip)
        er.paste_entity_clip(self.model, "街", clip)
        xs = sorted(r["x"] for r in self.model.scenes["街"]["npcs"])
        self.assertEqual(xs, [100.25, 124.2, 148.2])

    def test_same_scene_keeps_references_pointing_at_the_originals(self) -> None:
        er.paste_entity_clip(self.model, "街", self.clip([("npc", "老王"), ("hotspot", "摊子")]))
        acts = self.row("街", "hotspots", "摊子_copy")["data"]["actions"]
        self.assertEqual(acts[0]["params"]["target"], "老王")
        self.assertEqual(acts[4]["params"]["sourceId"], "街:摊子_copy")

    def test_cross_scene_in_place_keeps_exact_coordinates(self) -> None:
        clip = self.clip([("npc", "老王")])
        self.model.scenes["河边"]["worldWidth"] = 1000
        self.model.scenes["河边"]["worldHeight"] = 800
        summary = er.paste_entity_clip(self.model, "河边", clip)
        self.assertEqual(summary["placement"], "inPlace")
        new = self.model.scenes["河边"]["npcs"][-1]
        self.assertEqual((new["x"], new["y"]), (100.25, 200), "零位移不许截断小数")

    def test_cross_scene_npc_id_is_globally_unique(self) -> None:
        """owner 绑定按裸 id 全局解析：在别的场景用回「老王」= 副本静默继承叙事状态机。"""
        summary = er.paste_entity_clip(self.model, "河边", self.clip([("npc", "老王")]))
        self.assertEqual(summary["entries"][0]["newId"], "老王_copy")

    def test_cross_scene_zone_and_spawn_keep_their_ids(self) -> None:
        summary = er.paste_entity_clip(
            self.model, "河边", self.clip([("zone", "z"), ("spawn", "门口")]))
        self.assertEqual([e["newId"] for e in summary["entries"]], ["z", "门口"])
        self.assertEqual(self.model.scenes["河边"]["spawnPoints"]["门口"], {"x": 5, "y": 6})

    def test_id_that_exists_nowhere_is_kept(self) -> None:
        clip = self.clip([("npc", "老王")])
        self.model.scenes["街"]["npcs"] = []
        summary = er.paste_entity_clip(self.model, "河边", clip)
        self.assertEqual(summary["entries"][0]["newId"], "老王")

    def test_cross_scene_remaps_batch_refs_and_reports_the_rest(self) -> None:
        summary = er.paste_entity_clip(
            self.model, "河边", self.clip([("npc", "老王"), ("hotspot", "摊子")]))
        acts = next(r for r in self.model.scenes["河边"]["hotspots"]
                    if r["id"] == "摊子_copy")["data"]["actions"]
        self.assertEqual(acts[0]["params"]["target"], "老王_copy")
        self.assertEqual(acts[3]["params"]["target"], "老王_copy")
        self.assertEqual(acts[3]["params"]["at"]["id"], "摊子_copy")
        self.assertEqual(acts[1]["params"]["target"], "路人甲", "非本批引用不改")
        self.assertEqual(acts[4]["params"]["sourceId"], "河边:摊子_copy")
        self.assertEqual(
            [(d["action"], d["value"]) for d in summary["danglingRefs"]],
            [("showEmote", "路人甲")], "player 不是悬垂；路人甲在河边不存在")
        # 原件一个字节都不动
        self.assertEqual(self.model.scenes["街"], _scenes()["街"])

    def test_cross_scene_reports_dangling_burn_targets(self) -> None:
        """燃烧动作的 target（burn_target）与其它裸实体引用同一道闸：本批改名跟随，场景里没有的报悬垂。"""
        stall = next(r for r in self.model.scenes["街"]["hotspots"] if r["id"] == "摊子")
        stall["data"]["actions"].extend([
            {"type": "igniteBurnable", "params": {"target": "老王"}},
            {"type": "extinguishBurnable", "params": {"target": "纸堆不在河边"}},
            {"type": "resetBurnable", "params": {"target": "player", "socket": "right_hand"}},
        ])
        summary = er.paste_entity_clip(
            self.model, "河边", self.clip([("npc", "老王"), ("hotspot", "摊子")]))
        acts = next(r for r in self.model.scenes["河边"]["hotspots"]
                    if r["id"] == "摊子_copy")["data"]["actions"]
        self.assertEqual(acts[-3]["params"]["target"], "老王_copy")
        dangling = [(d["action"], d["value"]) for d in summary["danglingRefs"]]
        self.assertIn(("extinguishBurnable", "纸堆不在河边"), dangling)
        self.assertNotIn(("resetBurnable", "player"), dangling)

    def test_cross_scene_strips_a_group_the_target_does_not_define(self) -> None:
        summary = er.paste_entity_clip(self.model, "河边", self.clip([("npc", "老王")]))
        self.assertNotIn("group", self.model.scenes["河边"]["npcs"][-1])
        self.assertEqual(summary["strippedGroups"], [{"ref": "npc:老王_copy", "group": "夜摊"}])
        lines = er.describe_paste_report(summary)
        self.assertTrue(any("夜摊" in ln for ln in lines))
        self.assertTrue(any("cut_a" in ln for ln in lines))

    def test_out_of_world_paste_lands_in_the_middle(self) -> None:
        self.model.scenes["街"]["npcs"][0]["x"] = 900
        summary = er.paste_entity_clip(self.model, "河边", self.clip([("npc", "老王")]))
        self.assertEqual(summary["placement"], "worldCenter")
        new = self.model.scenes["河边"]["npcs"][-1]
        self.assertEqual((new["x"], new["y"]), (200, 150))

    def test_anchor_centres_the_batch_on_the_click(self) -> None:
        clip = self.clip([("npc", "老王"), ("hotspot", "摊子")])
        er.paste_entity_clip(self.model, "河边", clip, anchor=(250, 150))
        xs = [r["x"] for r in (self.model.scenes["河边"]["npcs"][-1],
                               self.model.scenes["河边"]["hotspots"][-1])]
        ys = [r["y"] for r in (self.model.scenes["河边"]["npcs"][-1],
                               self.model.scenes["河边"]["hotspots"][-1])]
        self.assertAlmostEqual((min(xs) + max(xs)) / 2, 250, delta=0.1)
        self.assertAlmostEqual((min(ys) + max(ys)) / 2, 150, delta=0.1)

    def test_plan_does_not_write(self) -> None:
        before = copy.deepcopy(self.model.scenes)
        er.plan_entity_paste(self.model, "河边", self.clip([("npc", "老王")]))
        self.assertEqual(self.model.scenes, before)


# --------------------------------------------------------------------------- #
# 真实入口
# --------------------------------------------------------------------------- #

def _project(root: Path):
    from tools.editor.project_model import ProjectModel
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    sc = model.scenes["sc_a"]
    sc.update({"worldWidth": 1000, "worldHeight": 800})
    sc.setdefault("npcs", []).append(
        {"id": "n0", "name": "N0", "x": 100, "y": 100, "interactionRange": 50})
    sc.setdefault("hotspots", []).append(
        {"id": "h0", "type": "inspect", "label": "", "x": 200, "y": 200,
         "interactionRange": 50, "data": {"text": ""}})
    sc.setdefault("spawnPoints", {})["门口"] = {"x": 30, "y": 40}
    model.scenes["sc_b"] = {"id": "sc_b", "name": "B", "worldWidth": 1000,
                            "worldHeight": 800, "hotspots": [], "zones": [],
                            "spawnPoints": {}}
    return model


class _QtBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        QApplication.clipboard().clear()
        self._td = TemporaryDirectory()
        self.model = _project(Path(self._td.name) / "p")
        self._patches = [patch.object(QMessageBox, "information",
                                      return_value=QMessageBox.StandardButton.Ok),
                         patch.object(QMessageBox, "warning",
                                      return_value=QMessageBox.StandardButton.Ok)]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self.app.processEvents()
        self._td.cleanup()

    def show(self, widget) -> None:
        widget.resize(1400, 900)
        widget.show()
        widget.activateWindow()
        QTest.qWaitForWindowActive(widget, 2000)
        self.app.processEvents()

    def press(self, widget, key) -> None:
        widget.setFocus()
        self.app.processEvents()
        QTest.keyClick(widget, key, _CTRL)
        self.app.processEvents()

    def ids(self, sid, list_key):
        return [r["id"] for r in self.model.scenes[sid].get(list_key) or []]


class OldCanvasClipboardTests(_QtBase):
    def setUp(self) -> None:
        super().setUp()
        from tools.editor.editors.scene_editor import SceneEditor
        self.ed = SceneEditor(self.model)
        self.show(self.ed)
        self.ed._load_scene("sc_a")
        self.app.processEvents()

    def tearDown(self) -> None:
        canvas = self.ed._canvas
        canvas._auto_fit_after_layout = False
        canvas._fit_layout_token += 1
        self.app.processEvents()
        QTest.qWait(360)
        self.ed.close()
        self.ed.deleteLater()
        super().tearDown()

    def select(self, kind, eid) -> None:
        self.ed._canvas._entity_items[f"{kind}:{eid}"].setSelected(True)
        self.ed._on_item_selected(kind, eid)
        self.app.processEvents()

    def test_ctrl_c_on_canvas_then_ctrl_v_in_another_scene(self) -> None:
        self.select("npc", "n0")
        self.press(self.ed._canvas, Qt.Key.Key_C)
        clip = er.parse_entity_clip(QApplication.clipboard().text())
        self.assertIsNotNone(clip, "Ctrl+C 没把实体放进剪贴板")
        self.assertEqual([e["id"] for e in clip["entities"]], ["n0"])
        self.ed._load_scene("sc_b")
        self.app.processEvents()
        self.press(self.ed._canvas, Qt.Key.Key_V)
        self.assertEqual(self.ids("sc_b", "npcs"), ["n0_copy"])
        self.assertEqual(self.ids("sc_a", "npcs"), ["n0"], "源场景不许被动")
        self.assertIn("npc:n0_copy", self.ed._canvas._entity_items)

    def test_copy_carries_an_unapplied_panel_edit(self) -> None:
        self.select("npc", "n0")
        self.ed._props._npc_name.setText("巡夜人甲")
        self.app.processEvents()
        self.press(self.ed._canvas, Qt.Key.Key_C)
        clip = er.parse_entity_clip(QApplication.clipboard().text())
        self.assertEqual(clip["entities"][0]["def"]["name"], "巡夜人甲")

    def test_ctrl_v_on_the_entity_tree_and_undo(self) -> None:
        # 实体树住在左栏「实体」页签里；页签没切过去时树不可见，快捷键按 Qt 规则不生效
        self.ed._left_tabs.setCurrentIndex(1)
        self.app.processEvents()
        self.select("hotspot", "h0")
        self.press(self.ed._entity_tree, Qt.Key.Key_C)
        self.press(self.ed._entity_tree, Qt.Key.Key_V)
        self.assertEqual(self.ids("sc_a", "hotspots"), ["h0", "h0_copy"])
        self.ed.editor_undo()
        self.app.processEvents()
        self.assertEqual(self.ids("sc_a", "hotspots"), ["h0"])

    def test_ctrl_c_in_a_panel_text_field_copies_text_not_entities(self) -> None:
        self.select("npc", "n0")
        field = self.ed._props._npc_name
        field.setText("纯文本")
        field.selectAll()
        self.press(field, Qt.Key.Key_C)
        self.assertEqual(QApplication.clipboard().text(), "纯文本")

    def test_canvas_menu_copy_targets_the_entity_under_the_cursor(self) -> None:
        canvas = self.ed._canvas
        self.select("hotspot", "h0")
        item = canvas._entity_items["npc:n0"]
        menu = QMenu()
        canvas._add_clipboard_actions(menu, item.sceneBoundingRect().center(), 500.0, 400.0)
        labels = [a.text() for a in menu.actions()]
        self.assertTrue(labels[0].startswith("复制「n0」"), labels)
        menu.actions()[0].trigger()
        self.app.processEvents()
        clip = er.parse_entity_clip(QApplication.clipboard().text())
        self.assertEqual([e["id"] for e in clip["entities"]], ["n0"])
        menu = QMenu()
        canvas._add_clipboard_actions(menu, QPointF(900, 700), 500.0, 400.0)
        paste = menu.actions()[1]
        self.assertTrue(paste.isEnabled())
        paste.trigger()
        self.app.processEvents()
        new = self.model.scenes["sc_a"]["npcs"][-1]
        self.assertEqual((new["id"], new["x"], new["y"]), ("n0_copy", 500, 400))

    def test_tree_menu_has_copy_and_paste(self) -> None:
        menu = self.ed.build_entity_tree_context_menu([("npc", "n0")])
        keys = [a.data() for a in menu.actions()]
        self.assertIn("copy", keys)
        self.assertIn("paste", keys)
        self.select("npc", "n0")
        self.ed._run_tree_context_action("copy")
        self.ed._run_tree_context_action("paste")
        self.assertEqual(self.ids("sc_a", "npcs"), ["n0", "n0_copy"])


class NewCanvasClipboardTests(_QtBase):
    def setUp(self) -> None:
        super().setUp()
        from tools.editor.editors.scene_v2.page import SceneEditorV2
        self.page = SceneEditorV2(self.model)
        self.show(self.page)
        self.page.load_scene("sc_a")
        self.app.processEvents()

    def tearDown(self) -> None:
        self.page.close()
        self.page.deleteLater()
        super().tearDown()

    def refs(self, *pairs):
        from tools.editor.editors.scene_v2.changes import EntityRef
        return [EntityRef(k, i) for k, i in pairs]

    def test_ctrl_c_ctrl_v_across_scenes_is_one_undo_step(self) -> None:
        self.page._doc.set_selection(self.refs(("npc", "n0"), ("spawn", "门口")))
        self.press(self.page._view, Qt.Key.Key_C)
        self.page.load_scene("sc_b")
        self.app.processEvents()
        self.press(self.page._view, Qt.Key.Key_V)
        sc = self.model.scenes["sc_b"]
        self.assertEqual(self.ids("sc_b", "npcs"), ["n0_copy"])
        self.assertEqual(sc["spawnPoints"], {"门口": {"x": 30, "y": 40}})
        self.assertEqual(set(self.page._doc.selection),
                         set(self.refs(("npc", "n0_copy"), ("spawn", "门口"))))
        self.page._doc.undo_stack.undo()
        self.assertEqual(self.ids("sc_b", "npcs"), [])
        self.assertEqual(sc["spawnPoints"], {}, "撤销只撤了一半")

    def test_paste_works_from_any_tool(self) -> None:
        self.page._doc.set_selection(self.refs(("hotspot", "h0")))
        self.page.copy_selected()
        self.page._view.tools.select(self.page.transform_tool)
        self.press(self.page._view, Qt.Key.Key_V)
        self.assertEqual(self.ids("sc_a", "hotspots"), ["h0", "h0_copy"])

    def test_tree_shortcuts(self) -> None:
        self.page._doc.set_selection(self.refs(("npc", "n0")))
        self.press(self.page._tree, Qt.Key.Key_C)
        self.press(self.page._tree, Qt.Key.Key_V)
        self.assertEqual(self.ids("sc_a", "npcs"), ["n0", "n0_copy"])

    def test_old_canvas_clip_pastes_on_the_new_canvas(self) -> None:
        from tools.editor.shared.scene_entity_clipboard import write_entity_clip
        write_entity_clip(er.build_entity_clip(self.model, "sc_a", [("hotspot", "h0")]))
        self.page.load_scene("sc_b")
        self.app.processEvents()
        self.press(self.page._view, Qt.Key.Key_V)
        self.assertEqual(self.ids("sc_b", "hotspots"), ["h0_copy"])

    def test_canvas_menu_paste_lands_on_the_click(self) -> None:
        self.page._doc.set_selection(self.refs(("npc", "n0")))
        self.page.copy_selected()
        menu = QMenu()
        self.page._add_clipboard_actions(menu, QPointF(600, 500))
        paste = [a for a in menu.actions() if a.text().startswith("粘贴到这里")]
        self.assertEqual(len(paste), 1)
        paste[0].trigger()
        new = self.model.scenes["sc_a"]["npcs"][-1]
        self.assertEqual((new["id"], new["x"], new["y"]), ("n0_copy", 600, 500))


if __name__ == "__main__":
    unittest.main()
