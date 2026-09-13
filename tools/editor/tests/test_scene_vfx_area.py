"""场景页「粒子区域」（`vfx[].area` + `confine`）：从用户入口进的流程护栏。

口径（editor-tools norms 过程义务 3）：画布手势一律发**真实鼠标事件**进视口，面板操作点**真按钮**，
断言落在**模型**上，再验撤销。区域图元刻意不是实体（不进点选 / 批量操作），框内不吃鼠标——
这两条都有专门的用例，谁把它们"顺手改整齐"了会红。
"""
from __future__ import annotations

import copy
import json
import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPoint, QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor, _VfxAreaPolygon
from tools.editor.project_model import ProjectModel
from tools.editor.shared import vfx_confine
from tools.editor.tests.qt_teardown import quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

REPO = Path(__file__).resolve().parents[3]
_SID = "粒子区域测试"
_AREA = [[300.0, 200.0], [900.0, 200.0], [900.0, 600.0], [300.0, 600.0]]


def _scene(vfx: list) -> dict:
    return {
        "id": _SID, "name": _SID, "worldWidth": 1200, "worldHeight": 800,
        "spawnPoint": {"x": 10, "y": 10},
        "npcs": [{"id": "n1", "name": "路人", "x": 600, "y": 400, "interactionRange": 40}],
        "hotspots": [], "zones": [],
        "vfx": vfx,
    }


def _pump(n: int = 4) -> None:
    for _ in range(n):
        QApplication.processEvents()


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            quiesce_scene_editor(ed)
            ed.deleteLater()
        self._editors.clear()
        _pump()

    def _editor(self, root: Path, vfx: list) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {_SID: _scene(vfx)}
        ed = SceneEditor(model)
        self._editors.append(ed)
        ed._refresh_scene_list()
        ed._load_scene(_SID)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        ed.resize(1400, 900)
        ed.show()
        _pump()
        ed._canvas.fit_all()
        _pump()
        ed._canvas._auto_fit_after_layout = False
        _pump()
        return ed, model

    @staticmethod
    def _row(model: ProjectModel, iid: str) -> dict:
        for r in model.scenes[_SID].get("vfx") or []:
            if r.get("id") == iid:
                return r
        raise AssertionError(f"模型里没有 vfx 实例 {iid}")

    def _vp(self, ed: SceneEditor, x: float, y: float) -> QPoint:
        return ed._canvas.mapFromScene(QPointF(x, y))

    def _drag(self, ed: SceneEditor, a: tuple[float, float], b: tuple[float, float],
              mods=Qt.KeyboardModifier.NoModifier) -> None:
        from PySide6.QtTest import QTest

        vp = ed._canvas.viewport()
        p0, p1 = self._vp(ed, *a), self._vp(ed, *b)
        QTest.mousePress(vp, Qt.MouseButton.LeftButton, mods, p0)
        QTest.mouseMove(vp, (p0 + p1) / 2)
        QTest.mouseMove(vp, p1)
        QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, mods, p1)
        _pump()

    def _click(self, ed: SceneEditor, x: float, y: float) -> None:
        from PySide6.QtTest import QTest

        vp = ed._canvas.viewport()
        p = self._vp(ed, x, y)
        QTest.mousePress(vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, p)
        QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, p)
        _pump()


class DrawRegionTests(_Base):
    def _assert_rect(self, pts: list, x0: float, y0: float, x1: float, y1: float) -> None:
        self.assertEqual(len(pts), 4)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        # 鼠标位置经视图变换换算，允许一两个世界单位的像素取整误差
        self.assertAlmostEqual(min(xs), x0, delta=3.0)
        self.assertAlmostEqual(max(xs), x1, delta=3.0)
        self.assertAlmostEqual(min(ys), y0, delta=3.0)
        self.assertAlmostEqual(max(ys), y1, delta=3.0)

    def test_拉发射区域_写_area_不碰限定(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", [{"id": "纸钱", "effect": "paper_money",
                                                      "anchor": {"x": 600, "y": 400}}])
            props = ed._props
            self.assertEqual(props.current_vfx_id(), "纸钱")
            props._sc_vfx_area_draw.click()
            self.assertEqual(ed._canvas._vfx_area_draw_mode, "emit", "按下按钮后画布要进拉框模式")
            self._drag(ed, (200.0, 150.0), (700.0, 500.0))

            row = self._row(model, "纸钱")
            self.assertIn("area", row, "拉完框模型里没有 area")
            self._assert_rect(row["area"], 200.0, 150.0, 700.0, 500.0)
            self.assertNotIn("confine", row, "拉发射区域不许顺手开限定：两块区域分开配")
            self.assertEqual(ed._canvas._vfx_area_draw_mode, "", "拉完要退出拉框模式")
            self.assertFalse(props._sc_vfx_area_draw.isChecked(), "按钮要弹起")
            self.assertTrue(model.is_dirty)
            it = ed._canvas.vfx_area_item("纸钱", "emit")
            self.assertIsInstance(it, _VfxAreaPolygon)
            self.assertTrue(it.is_current())
            self.assertIsNone(ed._canvas.vfx_area_item("纸钱", "range"))

            self.assertTrue(ed._undo.stack.canUndo())
            ed._undo.stack.undo()
            _pump()
            self.assertNotIn("area", self._row(model, "纸钱"), "撤销要把区域整个退掉")
            self.assertIsNone(ed._canvas.vfx_area_item("纸钱"), "撤销后画布上的区域也要没了")

    def test_拉范围区域_写_confine_area_并打开限定_发射区域不动(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", [{"id": "纸钱", "effect": "paper_money",
                                                      "anchor": {"x": 600, "y": 400},
                                                      "area": copy.deepcopy(_AREA)}])
            props = ed._props
            props._sc_vfx_range_draw.click()
            self.assertEqual(ed._canvas._vfx_area_draw_mode, "range")
            self._drag(ed, (100.0, 100.0), (1100.0, 700.0))
            row = self._row(model, "纸钱")
            self.assertEqual(row["area"], _AREA, "拉范围区域不许动发射区域")
            self.assertEqual(list(row["confine"].keys()), ["area"], "只多一个 confine.area，缺省值不落键")
            self._assert_rect(row["confine"]["area"], 100.0, 100.0, 1100.0, 700.0)
            self.assertTrue(props._sc_vfx_confine.isChecked(), "拉了范围区域就是限定打开")
            rng = ed._canvas.vfx_area_item("纸钱", "range")
            emit = ed._canvas.vfx_area_item("纸钱", "emit")
            self.assertIsNotNone(rng)
            self.assertIsNotNone(emit)
            self.assertTrue(rng._confined, "边带画在范围区域上")
            self.assertFalse(emit._confined, "有了范围区域，发射区域上不再画边带")
            ed._undo.stack.undo()
            _pump()
            self.assertNotIn("confine", self._row(model, "纸钱"))
            self.assertIsNone(ed._canvas.vfx_area_item("纸钱", "range"))

    def test_两个拉框按钮互斥(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", [{"id": "纸钱", "effect": "paper_money",
                                                       "anchor": {"x": 600, "y": 400}}])
            props = ed._props
            props._sc_vfx_area_draw.click()
            props._sc_vfx_range_draw.click()
            self.assertFalse(props._sc_vfx_area_draw.isChecked())
            self.assertEqual(ed._canvas._vfx_area_draw_mode, "range")
            props._sc_vfx_range_draw.click()
            self.assertEqual(ed._canvas._vfx_area_draw_mode, "")

    def test_手一抖点一下不算拉框(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", [{"id": "纸钱", "effect": "paper_money",
                                                      "anchor": {"x": 600, "y": 400}}])
            before = copy.deepcopy(model.scenes[_SID])
            ed._props._sc_vfx_area_draw.click()
            self._click(ed, 500.0, 300.0)
            self.assertEqual(model.scenes[_SID], before)
            self.assertFalse(model.is_dirty)
            self.assertEqual(ed._canvas._vfx_area_draw_mode, "emit", "没拉成就还在模式里，接着拉")

    def test_Esc_取消拉框(self) -> None:
        from PySide6.QtGui import QKeyEvent

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", [{"id": "纸钱", "effect": "paper_money",
                                                      "anchor": {"x": 600, "y": 400}}])
            ed._props._sc_vfx_area_draw.click()
            ed._canvas.keyPressEvent(QKeyEvent(QKeyEvent.Type.KeyPress, Qt.Key.Key_Escape,
                                               Qt.KeyboardModifier.NoModifier))
            _pump()
            self.assertEqual(ed._canvas._vfx_area_draw_mode, "")
            self.assertFalse(ed._props._sc_vfx_area_draw.isChecked())
            self.assertFalse(model.is_dirty)


class EditRegionOnCanvasTests(_Base):
    def _two(self) -> list:
        return [
            {"id": "纸钱", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
             "area": copy.deepcopy(_AREA), "confine": {"feather": 80}},
            {"id": "落叶", "effect": "paper_money", "anchor": {"x": 100, "y": 700},
             "area": [[40.0, 650.0], [240.0, 650.0], [240.0, 780.0], [40.0, 780.0]]},
        ]

    def test_拖当前实例区域的顶点_写进模型_一次手势一条撤销(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._two())
            self.assertEqual(ed._props.current_vfx_id(), "纸钱")
            self._drag(ed, (300.0, 200.0), (360.0, 250.0))
            area = self._row(model, "纸钱")["area"]
            self.assertAlmostEqual(area[0][0], 360.0, delta=3.0)
            self.assertAlmostEqual(area[0][1], 250.0, delta=3.0)
            self.assertEqual(area[1:], _AREA[1:], "只动被拖的那个顶点")
            self.assertEqual(self._row(model, "纸钱")["confine"], {"feather": 80}, "confine 不许被顺手改")
            self.assertEqual(ed._props.current_vfx_id(), "纸钱", "拖完选中不许跳回别的实例")
            it = ed._canvas.vfx_area_item("纸钱")
            self.assertAlmostEqual(it.area_points()[0][0], 360.0, delta=3.0)

            ed._undo.stack.undo()
            _pump()
            self.assertEqual(self._row(model, "纸钱")["area"], _AREA)
            self.assertEqual(ed._canvas.vfx_area_item("纸钱").area_points(), _AREA, "画布跟着撤回")

    def test_发射区域与范围区域各拖各的(self) -> None:
        R = [[100.0, 100.0], [1100.0, 100.0], [1100.0, 750.0], [100.0, 750.0]]
        vfx = [{"id": "纸钱", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
                "area": copy.deepcopy(_AREA), "confine": {"area": copy.deepcopy(R), "feather": 80}}]
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", vfx)
            self._drag(ed, (1100.0, 750.0), (1150.0, 780.0))        # 范围区域右下角
            row = self._row(model, "纸钱")
            self.assertAlmostEqual(row["confine"]["area"][2][0], 1150.0, delta=3.0)
            self.assertEqual(row["area"], _AREA, "拖范围区域不许动发射区域")
            self.assertEqual(row["confine"]["feather"], 80)
            self._drag(ed, (300.0, 600.0), (250.0, 650.0))          # 发射区域左下角
            row = self._row(model, "纸钱")
            self.assertAlmostEqual(row["area"][3][0], 250.0, delta=3.0)
            self.assertAlmostEqual(row["confine"]["area"][2][0], 1150.0, delta=3.0, msg="拖发射区域不许动范围区域")

    def test_框内点击与拖动不被区域吃掉_区域不许被整体挪走(self) -> None:
        """跑马梁那圈几乎盖满整张图：框内可点 = 画布上点哪都先点到它。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._two())
            before = copy.deepcopy(model.scenes[_SID])
            self._drag(ed, (500.0, 300.0), (560.0, 340.0))       # 框内空白处拖
            self.assertEqual(model.scenes[_SID]["vfx"], before["vfx"], "框内拖动把区域挪走了")
            # 边线附近（打得中区域、但不在顶点上）按住拖：也不许整体挪
            self._drag(ed, (600.0, 206.0), (660.0, 260.0))
            self.assertEqual(model.scenes[_SID]["vfx"], before["vfx"], "按住边线附近一拖，整个区域被挪走了")
            # 框内的 NPC 照样点得到
            self._click(ed, 600.0, 400.0)
            self.assertIs(ed._props._stack.currentWidget(), ed._props._npc_panel,
                          "区域盖着的 NPC 点不中了")

    def test_区域不是实体_不进点选与批量操作集合(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", self._two())
            it = ed._canvas.vfx_area_item("纸钱")
            self.assertFalse(hasattr(it, "entity_kind"))
            self.assertFalse(bool(it.flags() & it.GraphicsItemFlag.ItemIsSelectable))
            it.setSelected(True)
            self.assertEqual(ed._canvas_selected_entity_refs(), [])
            self.assertNotIn(it, ed._canvas._entity_stack_at(QPointF(300.0, 200.0)))

    def test_非当前实例的区域改不动_点它的边线切到那条实例(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._two())
            before = copy.deepcopy(self._row(model, "落叶"))
            self._drag(ed, (40.0, 650.0), (90.0, 690.0))
            self.assertEqual(self._row(model, "落叶"), before, "非当前实例的区域被拖动了")
            self._click(ed, 140.0, 780.0)                          # 下边线中点
            self.assertEqual(ed._props.current_vfx_id(), "落叶")
            self.assertTrue(ed._canvas.vfx_area_item("落叶").is_current())
            self.assertFalse(ed._canvas.vfx_area_item("纸钱").is_current())

    def test_在别的属性页时拖区域顶点_先回场景页再落到那条实例上(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._two())
            self._click(ed, 600.0, 400.0)                           # 先选中 NPC
            self.assertIs(ed._props._stack.currentWidget(), ed._props._npc_panel)
            self._drag(ed, (900.0, 600.0), (950.0, 640.0))
            area = self._row(model, "纸钱")["area"]
            self.assertAlmostEqual(area[2][0], 950.0, delta=3.0)
            self.assertIs(ed._props._stack.currentWidget(), ed._props._scene_panel)


class PanelFieldTests(_Base):
    def test_打开不改再提交_零漂移(self) -> None:
        vfx = [{"id": "纸钱", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
                "area": copy.deepcopy(_AREA), "confine": {"feather": 120, "ceiling": 400},
                "未知键": {"留着": 1}}]
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", vfx)
            before = json.dumps(model.scenes[_SID], ensure_ascii=False, indent=2)
            props = ed._props
            props._flush_scene_widgets_into(props._staging_scene)
            props.commit_scene_staging_to_source()
            # 比文本不比 dict：dict 相等不管键序，而磁盘上键序变了就是一份 diff
            self.assertEqual(json.dumps(model.scenes[_SID], ensure_ascii=False, indent=2), before)
            # 再拖一次顶点后回写：键序照样不许变（新值落在原来的位置上）
            props.apply_vfx_area("纸钱", [[1, 2], [3, 4], [5, 6]])
            props._flush_scene_widgets_into(props._staging_scene)
            props.commit_scene_staging_to_source()
            self.assertEqual(list(self._row(model, "纸钱").keys()),
                             ["id", "effect", "anchor", "area", "confine", "未知键"])

    def test_限定勾选_边带_限高_删除区域(self) -> None:
        vfx = [{"id": "纸钱", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
                "area": copy.deepcopy(_AREA)}]
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", vfx)
            props = ed._props

            def commit() -> None:
                ed._undo_flush_pending_as_command()
                _pump()

            self.assertFalse(props._sc_vfx_confine.isChecked())
            self.assertTrue(props._sc_vfx_confine.isEnabled(), "有区域时限定要能勾")
            self.assertFalse(props._sc_vfx_feather.isEnabled())
            props._sc_vfx_confine.click()
            commit()
            self.assertEqual(self._row(model, "纸钱")["confine"], {}, "缺省边带宽不落键")
            props._sc_vfx_feather.setValue(200)
            props._sc_vfx_ceiling.setValue(350)
            commit()
            self.assertEqual(self._row(model, "纸钱")["confine"], {"feather": 200, "ceiling": 350})
            self.assertEqual(ed._canvas.vfx_area_item("纸钱")._feather, 200.0, "画布边带跟着变")
            props._sc_vfx_ceiling.setValue(0)
            commit()
            self.assertEqual(self._row(model, "纸钱")["confine"], {"feather": 200}, "限高 0 = 删键")
            props._sc_vfx_confine.click()
            commit()
            self.assertNotIn("confine", self._row(model, "纸钱"))
            props._sc_vfx_confine.click()
            commit()
            props._sc_vfx_area_clear.click()
            commit()
            row = self._row(model, "纸钱")
            self.assertNotIn("area", row)
            self.assertNotIn("confine", row, "删区域要连限定一起删（没有区域的限定运行时整条忽略）")
            self.assertIsNone(ed._canvas.vfx_area_item("纸钱"))
            self.assertFalse(props._sc_vfx_confine.isEnabled(), "没有区域时限定不能勾")

    def test_去掉限定勾不丢拉好的范围区域_再勾上原样回来(self) -> None:
        R = [[100.0, 100.0], [1100.0, 100.0], [1100.0, 750.0], [100.0, 750.0]]
        vfx = [{"id": "纸钱", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
                "area": copy.deepcopy(_AREA), "confine": {"area": copy.deepcopy(R), "feather": 150}}]
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", vfx)
            props = ed._props
            props._sc_vfx_confine.click()
            ed._undo_flush_pending_as_command()
            _pump()
            self.assertNotIn("confine", self._row(model, "纸钱"))
            self.assertIsNone(ed._canvas.vfx_area_item("纸钱", "range"))
            # 切走再切回来（控件被重装成缺省值）也不许把收着的边带宽冲掉
            ed._props.load_scene_props(model.scenes[_SID])
            self.assertEqual(props._sc_vfx_feather.value(), 120)
            self.assertTrue(props._sc_vfx_confine.isEnabled())
            props._sc_vfx_confine.click()
            ed._undo_flush_pending_as_command()
            _pump()
            self.assertEqual(self._row(model, "纸钱")["confine"], {"area": R, "feather": 150})
            self.assertEqual(props._sc_vfx_feather.value(), 150, "恢复出来的边带宽要回填到控件")
            self.assertIsNotNone(ed._canvas.vfx_area_item("纸钱", "range"))

    def test_删范围区域退回用发射区域_再删发射区域才连限定一起去掉(self) -> None:
        R = [[100.0, 100.0], [1100.0, 100.0], [1100.0, 750.0], [100.0, 750.0]]
        vfx = [{"id": "纸钱", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
                "area": copy.deepcopy(_AREA), "confine": {"area": copy.deepcopy(R), "feather": 150}}]
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", vfx)
            props = ed._props
            props._sc_vfx_range_clear.click()
            ed._undo_flush_pending_as_command()
            _pump()
            row = self._row(model, "纸钱")
            self.assertEqual(row["confine"], {"feather": 150}, "删范围区域 = 退回用发射区域，限定照开")
            self.assertTrue(ed._canvas.vfx_area_item("纸钱", "emit")._confined, "边带挪回发射区域上")
            props._sc_vfx_area_clear.click()
            ed._undo_flush_pending_as_command()
            _pump()
            row = self._row(model, "纸钱")
            self.assertNotIn("area", row)
            self.assertNotIn("confine", row, "一块区域都没了，限定无从谈起")

    def test_同一场景重装时保住选中的实例(self) -> None:
        vfx = [{"id": "a", "effect": "paper_money", "anchor": {"x": 1, "y": 1}},
               {"id": "b", "effect": "paper_money", "anchor": {"x": 2, "y": 2}}]
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", vfx)
            ed._props.select_vfx_row_by_id("b")
            ed._props.load_scene_props(model.scenes[_SID])
            self.assertEqual(ed._props.current_vfx_id(), "b")


# --------------------------------------------------------------------------- #
# 校验器 + 与 TS 的对账
# --------------------------------------------------------------------------- #

class ValidatorTests(unittest.TestCase):
    def _issues(self, row: dict, effects: dict | None = None) -> list:
        from tools.editor import validator

        class FakeModel:
            vfx_effects = effects or {}

        issues: list = []
        area = row.get("area") if isinstance(row.get("area"), list) else None
        validator._check_vfx_confine(FakeModel(), issues, "s", str(row.get("id")), row, area)  # type: ignore[arg-type]
        return issues

    PAPER = {"paper_money": {"id": "paper_money", "emitters": [
        {"id": "paper", "appearance": {"image": "x", "sizeWu": 16}, "spawn": {"max": 1},
         "plate": {"size": [16, 16], "terminalSpeed": 90}}]}}

    def test_合法形态零告警(self) -> None:
        for conf in ({}, {"feather": 0}, {"feather": 150, "ceiling": 400}):
            row = {"id": "v", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
                   "area": _AREA, "confine": conf}
            self.assertEqual(self._issues(row, self.PAPER), [], conf)
        self.assertEqual(self._issues({"id": "v", "area": _AREA}), [], "没配 confine 什么都不查")

    def test_坏数据必报(self) -> None:
        def sev(row: dict, effects: dict | None = None) -> list[str]:
            return [i.severity for i in self._issues(row, effects)]

        base = {"id": "v", "effect": "paper_money", "anchor": {"x": 600, "y": 400}, "area": _AREA}
        # 范围区域单独配：只有 confine.area、没有发射区域也合法
        only_range = {k: v for k, v in base.items() if k != "area"}
        self.assertEqual(sev({**only_range, "confine": {"area": _AREA}}), [])
        self.assertIn("error", sev({**base, "confine": {"area": [[0, 0], [1, 1]]}}), "范围区域形状坏")
        far = [[5000, 5000], [5100, 5000], [5100, 5100], [5000, 5100]]
        self.assertEqual(sev({**base, "anchor": {"x": 5050, "y": 5050}, "confine": {"area": far}}),
                         ["warning"], "发射区域与范围区域不相交")
        self.assertEqual(sev({**base, "confine": "yes"}), ["error"])
        self.assertIn("error", sev({**base, "confine": {"feather": -1}}))
        self.assertIn("error", sev({**base, "confine": {"feather": "宽"}}))
        self.assertIn("error", sev({**base, "confine": {"ceiling": 0}}))
        no_area = {k: v for k, v in base.items() if k != "area"}
        self.assertEqual(sev({**no_area, "confine": {}}), ["error"], "没有区域的限定运行时整条忽略")
        bow = [[0, 0], [100, 100], [100, 0], [0, 100]]
        self.assertEqual(sev({**base, "area": bow, "confine": {}}), ["warning"], "自相交")
        smoke = {"smoke": {"id": "smoke", "emitters": [
            {"id": "puff", "appearance": {"image": "x", "sizeWu": 8}, "spawn": {"max": 1, "rate": 1}}]}}
        outside = {**base, "effect": "smoke", "anchor": {"x": 50, "y": 50}, "confine": {}}
        self.assertEqual(sev(outside, smoke), ["warning"], "锚点在框外、普通粒子一出生就淡出")
        bats = {"bats": {"id": "bats", "emitters": [
            {"id": "b", "appearance": {"image": "x", "sizeWu": 8}, "spawn": {"max": 1}, "behavior": {}}]}}
        self.assertEqual(sev({**base, "effect": "bats", "confine": {}}, bats), ["warning"], "群体不吃限定")

    def test_自相交判据(self) -> None:
        self.assertFalse(vfx_confine.polygon_self_intersects(_AREA))
        self.assertTrue(vfx_confine.polygon_self_intersects([[0, 0], [100, 100], [100, 0], [0, 100]]))
        self.assertFalse(vfx_confine.polygon_self_intersects(
            [[0, 0], [300, 0], [300, 300], [200, 300], [200, 100], [100, 100], [100, 300], [0, 300]]))

    def test_缺省边带宽与运行时同一个数(self) -> None:
        ts = (REPO / "src/systems/vfx/vfxConfine.ts").read_text(encoding="utf-8")
        m = re.search(r"export const CONFINE_FEATHER_DEFAULT = (\d+(?:\.\d+)?);", ts)
        self.assertIsNotNone(m, "TS 那边的常量改名了：对账失效")
        self.assertEqual(float(m.group(1)), vfx_confine.CONFINE_FEATHER_DEFAULT)

    def test_点在多边形里与运行时同一条式子(self) -> None:
        ts = (REPO / "src/systems/vfx/vfxConfine.ts").read_text(encoding="utf-8")
        self.assertIn("x < ((xj - xi) * (y - yi)) / (yj - yi) + xi", ts, "运行时奇偶规则的式子变了：对账失效")
        self.assertTrue(vfx_confine.point_in_polygon(_AREA, 600, 400))
        self.assertFalse(vfx_confine.point_in_polygon(_AREA, 100, 400))

    def test_仓库里的真场景零新增告警(self) -> None:
        """跑马梁那条实例（有 area、没 confine）不许因为这一块多出任何 issue。"""
        doc = json.loads((REPO / "public/assets/scenes/跑马梁.json").read_text(encoding="utf-8"))
        for row in doc.get("vfx") or []:
            area = row.get("area") if isinstance(row.get("area"), list) else None
            self.assertEqual(self._issues(row), [], row.get("id"))


if __name__ == "__main__":
    unittest.main()
