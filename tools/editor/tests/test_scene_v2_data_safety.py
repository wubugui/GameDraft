"""新画布**不许静默弄坏数据**的那批闸。

全功能回归（`artifact/Reviews/新画布-全功能回归缺口清单-2026-08-23.md`）里，
最贵的一类不是"少个功能"，而是**界面看着正常、数据在背后被改坏或丢掉**：
用户没有任何一次被告知的机会，往往要进游戏跑一遍才发现。

这一份逐条钉死那批闸。用例一律从**真实入口**进（真实控件、真实工具手势），
不直接改内部状态 —— 上一轮正是绕过真实入口才让一批坏掉的通路测成绿的。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.editors.scene_v2.tools_builtin import MoveTool, PolygonEditTool
from tools.editor.editors.scene_v2.tools_structure import duplicate_selected
from tools.editor.editors.scene_v2.tools_transform import TransformTool
from tools.editor.editors.scene_v2.view import SceneView
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_NO_MOD = Qt.KeyboardModifier.NoModifier
_LEFT = Qt.MouseButton.LeftButton
_SCENE = "安全街"


class _FakeModel:
    def __init__(self, scene: dict) -> None:
        self.scenes = {_SCENE: scene}

    def mark_dirty(self, domain: str, key: str) -> None:
        pass


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 900, "worldHeight": 700,
        # 三个控制点各带一份 env 关键帧：插点/删点后必须**各回各家**
        "lightEnvCurve": {"points": [
            {"x": 100, "y": 100, "env": {"tint": "#111111"}},
            {"x": 300, "y": 100, "env": {"tint": "#222222"}},
            {"x": 500, "y": 100, "env": {"tint": "#333333"}},
        ]},
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 200, "y": 400,
             "interactionRange": 50},
            # 带过场绑定：复制时必须剥离，否则副本在正常游戏里永不显示
            {"id": "h_cut", "type": "inspect", "x": 400, "y": 400,
             "cutsceneIds": ["cs_a"], "cutsceneOnly": True},
        ],
        "npcs": [
            {"id": "n1", "name": "甲", "x": 600, "y": 400,
             "patrol": {"route": [{"x": 600, "y": 400}, {"x": 700, "y": 400}]}},
        ],
        "zones": [],
        "spawnPoint": {"x": 50, "y": 650},
    }


class _CanvasBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.model = _FakeModel(_scene())
        self.doc = SceneDocument(self.model, _SCENE)
        self.view = SceneView(self.doc)
        self.view.resize(900, 700)
        self.view.renderer.set_view_scale(1.0)
        self.poly = self.view.tools.register(
            PolygonEditTool(self.doc, self.view.renderer, self.view))
        self.move = self.view.tools.register(
            MoveTool(self.doc, self.view.renderer, self.view))
        self.transform = self.view.tools.register(
            TransformTool(self.doc, self.view.renderer, self.view))

    def tearDown(self) -> None:
        self.view.deleteLater()
        self.doc.deleteLater()
        QApplication.processEvents()

    def ent(self, kind: str, eid: str) -> dict:
        return self.doc.model_entity(EntityRef(kind, eid))

    def tints(self) -> list:
        return [p.get("env", {}).get("tint")
                for p in self.doc.scene()["lightEnvCurve"]["points"]]


class LightCurveKeyframeTests(_CanvasBase):
    """光曲线的每个控制点都驮着一份 env 光照关键帧。"""

    def test_inserting_a_point_does_not_shift_later_keyframes(self) -> None:
        """在中间插一个点，**其后每一帧的 env 必须原地不动**。

        按输出位置重新配对 env 的话，插点会让后半段的打光集体前移一格、最后一帧
        被复制。画布上折线形状完全正确、面板关键帧表也不刷新，作者要进游戏走到
        那一段才可能察觉；而 v2 页又改不了关键帧，撞上之后连修都修不了。
        """
        self.doc.clear_selection()
        self.poly.mouse_double_clicked(QPointF(200, 100), _LEFT, _NO_MOD)
        got = self.tints()
        self.assertEqual(len(got), 4, f"没插进去：{got}")
        self.assertEqual(got[0], "#111111")
        self.assertEqual(got[2], "#222222", "插点把后面的关键帧整体错位了一格")
        self.assertEqual(got[3], "#333333", "最后一帧的光被顶掉了")

    def test_inserted_point_inherits_the_preceding_keyframe(self) -> None:
        self.doc.clear_selection()
        self.poly.mouse_double_clicked(QPointF(200, 100), _LEFT, _NO_MOD)
        self.assertEqual(self.tints()[1], "#111111",
                         "新插入的点该继承它**前面那个已有点**的光")

    def test_deleting_a_point_does_not_shift_later_keyframes(self) -> None:
        self.doc.clear_selection()
        self.poly.mouse_pressed(QPointF(300, 100), Qt.MouseButton.RightButton,
                                _NO_MOD)
        got = self.tints()
        self.assertEqual(len(got), 2, f"没删掉：{got}")
        self.assertEqual(got, ["#111111", "#333333"],
                         "删点把其余关键帧整体挪了位")

    def test_dragging_a_point_keeps_every_keyframe(self) -> None:
        self.doc.clear_selection()
        self.poly.mouse_pressed(QPointF(300, 100), _LEFT, _NO_MOD)
        self.poly.mouse_moved(QPointF(320, 160), _LEFT, _NO_MOD)
        self.poly.mouse_released(QPointF(320, 160), _LEFT, _NO_MOD)
        self.assertEqual(self.tints(), ["#111111", "#222222", "#333333"])


class TransformSafetyTests(_CanvasBase):
    """变换手柄不该在用户"什么都没做"的时候写数据。"""

    def _press_release_handle(self, ref: EntityRef) -> None:
        self.view.tools.select(self.transform)
        self.doc.set_selection([ref])
        pos = self.transform.handle_positions(ref)["rotate"]
        grabbed = self.transform.mouse_pressed(pos, _LEFT, _NO_MOD)
        # 没抓住手柄的话下面的断言就是**空过**（什么都没发生当然什么都没写）
        self.assertTrue(grabbed, "前置条件：这一按应当抓住了旋转手柄")
        self.transform.mouse_released(pos, _LEFT, _NO_MOD)

    def test_press_and_release_without_dragging_writes_nothing(self) -> None:
        """手柄上按一下不拖就松手：场景不该被标脏，也不该多一条撤销记录。

        无条件写的话，批量点检一遍场景就能污染一片实体，而 diff 里全是
        "我没改过的东西"。
        """
        ref = EntityRef("hotspot", "h1")
        before = copy.deepcopy(self.ent("hotspot", "h1"))
        self._press_release_handle(ref)
        self.assertEqual(self.ent("hotspot", "h1"), before)
        self.assertEqual(self.doc.undo_stack.count(), 0)

    def test_rotating_does_not_rewrite_the_untouched_scale(self) -> None:
        """只拖旋转手柄，不该顺手把没碰过的 scale 也写一遍。"""
        ref = EntityRef("hotspot", "h1")
        self.view.tools.select(self.transform)
        self.doc.set_selection([ref])
        pos = self.transform.handle_positions(ref)["rotate"]
        self.transform.mouse_pressed(pos, _LEFT, _NO_MOD)
        self.transform.mouse_moved(QPointF(200, 470), _LEFT, _NO_MOD)
        self.transform.mouse_released(QPointF(200, 470), _LEFT, _NO_MOD)
        ent = self.ent("hotspot", "h1")
        self.assertIsNotNone(ent.get("rotation"), "前置条件：这一拖应当写下 rotation")
        self.assertNotIn("scale", ent, "旋转顺手把 scale 也写进去了")

    def test_spawn_points_are_not_transformable(self) -> None:
        """出生点只有 x/y，运行时根本不读 scale/rotation —— 不许给它写。"""
        ref = EntityRef("spawn", "default")
        self.view.tools.select(self.transform)
        self.doc.set_selection([ref])
        self.assertEqual(self.transform.gizmo_positions(), {},
                         "出生点身上出现了变换手柄")
        self.assertFalse(
            self.transform.mouse_pressed(QPointF(50, 650), _LEFT, _NO_MOD))
        self.assertNotIn("scale", self.doc.scene()["spawnPoint"])


class NumericFidelityTests(_CanvasBase):
    """没动过的数值一个字节都不许变。"""

    def test_horizontal_drag_leaves_the_integer_y_untouched(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.doc.set_selection([ref])
        self.move.mouse_pressed(QPointF(200, 400), _LEFT, _NO_MOD)
        self.move.mouse_moved(QPointF(260, 400), _LEFT, _NO_MOD)
        self.move.mouse_released(QPointF(260, 400), _LEFT, _NO_MOD)
        ent = self.ent("hotspot", "h1")
        self.assertEqual(ent["x"], 260)
        self.assertIsInstance(ent["y"], int, "纯水平拖动把没动的 y 写成了浮点")
        self.assertEqual(ent["y"], 400)

    def test_integer_coordinates_stay_integers_after_a_drag(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.doc.set_selection([ref])
        self.move.mouse_pressed(QPointF(200, 400), _LEFT, _NO_MOD)
        self.move.mouse_moved(QPointF(210, 415), _LEFT, _NO_MOD)
        self.move.mouse_released(QPointF(210, 415), _LEFT, _NO_MOD)
        ent = self.ent("hotspot", "h1")
        self.assertIsInstance(ent["x"], int)
        self.assertIsInstance(ent["y"], int)


class DuplicateRulesTests(_CanvasBase):
    """复制规则与老画布共用同一份实现（`shared/entity_refactor`）。"""

    def test_duplicate_strips_cutscene_bindings(self) -> None:
        """副本必须剥离过场绑定。

        不剥离的话副本挂着 `cutsceneOnly` 却无人驱动 —— 画布上看得见、
        正常游戏里**永远不出现**，排查时完全没有线索。
        """
        self.doc.set_selection([EntityRef("hotspot", "h_cut")])
        self.assertTrue(duplicate_selected(self.doc))
        clones = [h for h in self.doc.scene()["hotspots"] if h["id"] != "h_cut"
                  and h["id"] != "h1"]
        self.assertEqual(len(clones), 1, "没复制出来")
        self.assertNotIn("cutsceneIds", clones[0])
        self.assertNotIn("cutsceneOnly", clones[0])

    def test_duplicate_offsets_the_patrol_route(self) -> None:
        """副本的巡逻路线要跟着偏移，否则它一进游戏就往原实体那条路上跑。"""
        self.doc.set_selection([EntityRef("npc", "n1")])
        self.assertTrue(duplicate_selected(self.doc))
        clone = [n for n in self.doc.scene()["npcs"] if n["id"] != "n1"][0]
        self.assertNotEqual(clone["patrol"]["route"][0],
                            {"x": 600, "y": 400},
                            "副本的巡逻路线仍钉在原实体那条路上")

    def test_new_id_avoids_the_shared_npc_hotspot_namespace(self) -> None:
        """npc 与 hotspot 共用 id 命名空间，取号要一起查两张表。"""
        self.doc.scene()["npcs"].append(
            {"id": "h1_2", "name": "占位", "x": 1, "y": 1})
        self.doc.set_selection([EntityRef("hotspot", "h1")])
        self.assertTrue(duplicate_selected(self.doc))
        ids = {h["id"] for h in self.doc.scene()["hotspots"]}
        self.assertNotIn("h1_2", ids, "副本撞上了 NPC 那张表里的同名 id")


class _PageBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_SCENE] = _scene()
        self.page = SceneEditorV2(self.model)
        self.page.load_scene(_SCENE)

    def tearDown(self) -> None:
        self.page.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def scene(self) -> dict:
        return self.model.scenes[_SCENE]


class ScenePanelReachesTheModelTests(_PageBase):
    """场景级属性面板的编辑必须真的落库 —— 这是缺口清单里最贵的一条。"""

    def test_empty_selection_lands_on_the_scene_page(self) -> None:
        self.page.document.clear_selection()
        loaded = self.page._bridge._loaded
        self.assertIsNotNone(loaded, "什么都没选时面板没有落点")
        self.assertEqual(loaded.kind, "scene")

    def test_scene_field_edit_reaches_the_model_and_is_undoable(self) -> None:
        """改场景级字段要进模型、进撤销栈。

        不进的话：存盘后 JSON 一个字节没变，而且因为模型压根没被标脏，
        关窗/切工程/Save All 都不会提示 —— 零提示的静默全损。
        """
        self.page.document.clear_selection()
        self.page._props._staging_scene["walkSpeed"] = 123
        self.assertTrue(self.page._bridge.commit_panel_edits())
        self.assertEqual(self.scene().get("walkSpeed"), 123)
        self.assertEqual(self.page.document.undo_stack.count(), 1)
        self.page.editor_undo()
        self.assertIsNone(self.scene().get("walkSpeed"))

    def test_scene_commit_never_overwrites_the_entity_roster(self) -> None:
        """名册归命令层。场景面板提交时不许把 hotspots/npcs/zones 一起写回去 ——
        那就是"两层真相"原地复活：画布上刚拖好的实体会被静默抹回旧位置。"""
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page._props._hs_x.setValue(555.0)
        self.page._bridge.commit_panel_edits()
        self.page.document.clear_selection()
        self.page._props._staging_scene["walkSpeed"] = 77
        self.page._bridge.commit_panel_edits()
        self.assertEqual(self.scene()["hotspots"][0]["x"], 555.0,
                         "场景面板提交把名册整份盖回去了")

    def test_multi_selection_does_not_leave_a_stale_entity_form(self) -> None:
        """多选时面板不许停在最后那个单实体表单上（用户会在上面白打字）。"""
        self.page.document.set_selection(
            [EntityRef("hotspot", "h1"), EntityRef("hotspot", "h_cut")])
        self.assertIsNone(self.page._bridge._loaded)
        self.assertFalse(self.page._bridge.commit_panel_edits())


class EntityIdGateTests(_PageBase):
    """id 撞名 / 空 id 是一次手滑就能造成、要等 validate-data 才发现的数据损坏。"""

    def _select_and_set_id(self, text: str) -> None:
        self.page.document.set_selection([EntityRef("hotspot", "h1")])
        self.page._props._hs_id.setText(text)
        self.page._bridge.commit_panel_edits()

    def test_duplicate_id_is_refused(self) -> None:
        """撞上**共用命名空间**（npc/hotspot）里的 id 也要拒。"""
        self._select_and_set_id("n1")
        self.assertEqual([h["id"] for h in self.scene()["hotspots"]],
                         ["h1", "h_cut"], "写出了两个同 id 的实体")

    def test_empty_id_is_refused(self) -> None:
        self._select_and_set_id("")
        self.assertEqual(self.scene()["hotspots"][0]["id"], "h1")

    def test_refused_id_is_reverted_in_the_widget(self) -> None:
        """拒绝之后控件要拨回原值，否则界面继续显示那个坏值。"""
        self._select_and_set_id("n1")
        self.assertEqual(self.page._props._hs_id.text(), "h1")

    def test_a_legal_rename_still_works_and_keeps_the_selection(self) -> None:
        """加闸不等于改不了名：合法改名要成功，且**选择跟着走**。

        选择不跟走的话，画布上那个实体当场从选中态消失、树里点旧 id 选不中任何
        东西 —— 用户以为实体被改没了。
        """
        self._select_and_set_id("h_renamed")
        self.assertEqual(self.scene()["hotspots"][0]["id"], "h_renamed")
        self.assertEqual(self.page.document.selection,
                         (EntityRef("hotspot", "h_renamed"),))


if __name__ == "__main__":
    unittest.main()
