"""静态贴图实体（没有动画包的道具）：面板往返、校验器形状闸、两个画布的回落预览。

制作人要的是"完全不需要动画数据就能直接渲染 sprite、和 NPC 渲染功能完全一样的实体"。
落地手段是 `NpcDef.displayImage` + 无 `animFile` 时合成一份 1×1 单帧动画集，
所以这里钉的不是"新功能能用"，而是三件**最容易悄悄坏掉**的事：

1. **往返零丢失** —— 面板只出三个控件，而 `displayImage` 还可能带 `facing` /
   `spriteSort`。没有透传兜底的话，"打开这个 NPC 什么都不改再保存"就把它们删了，
   无告警、无 diff 解释（editor-roundtrip-contract 的已知坑原文）。
2. **兜底校验 ⊆ 运行时** —— 形状明显非法的报 error，合法最小形态不许拦。
3. **两个画布都得画** —— NAV_TARGET 当前仍是老画布，只做新画布 = 策划在主用的
   那个画布上看不见道具。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtGui import QColor, QImage
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import ScenePropertyPanel, SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate

_IMG_URL = "/resources/runtime/images/props/crate.png"
_IMG_W, _IMG_H = 40, 80


def _write_prop_image(root: Path) -> None:
    """在工程里放一张真图（20×40 之类的比例要能被"按图素比推另一维"用上）。"""
    p = root / "public" / "resources" / "runtime" / "images" / "props" / "crate.png"
    p.parent.mkdir(parents=True, exist_ok=True)
    img = QImage(_IMG_W, _IMG_H, QImage.Format.Format_ARGB32)
    img.fill(QColor(200, 160, 90))
    assert img.save(str(p), "PNG")


def _npc_with_display(**over) -> dict:
    npc: dict = {
        "id": "crate_01",
        "name": "木箱",
        "x": 120,
        "y": 240,
        "interactionRange": 40,
        "displayImage": {"image": _IMG_URL, "worldWidth": 60, "worldHeight": 120},
    }
    npc.update(over)
    return npc


def _scene(sid: str, npcs: list[dict]) -> dict:
    return {"id": sid, "name": sid, "hotspots": [], "zones": [],
            "spawnPoints": {}, "npcs": npcs}


def _dump(obj) -> str:
    """工程约定的落盘形状（ensure_ascii=False + 2 空格 + 不排序键）。"""
    return json.dumps(obj, ensure_ascii=False, indent=2)


class _QtCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path, npcs: list[dict] | None = None) -> ProjectModel:
        write_minimal_loadable_project(root)
        _write_prop_image(root)
        model = ProjectModel()
        model.load_project(root)
        if npcs is not None:
            model.scenes = {"sc_a": _scene("sc_a", npcs)}
        return model


class PanelRoundtripTests(_QtCase):
    """打开 → 什么都不改 → 保存，输出与磁盘字节等价。"""

    def _roundtrip(self, npc: dict) -> dict:
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            panel.load_npc_props(npc)
            panel._write_npc_widgets_to_dict(panel._staging_npc)
            return panel._staging_npc

    def test_open_and_save_is_byte_identical(self) -> None:
        npc = _npc_with_display()
        self.assertEqual(_dump(self._roundtrip(npc)), _dump(npc))

    def test_int_world_sizes_do_not_drift_to_float(self) -> None:
        """QDoubleSpinBox 一律 float：不按原始表示回写就是 60 → 60.0 炸全文 diff。"""
        out = self._roundtrip(_npc_with_display())["displayImage"]
        self.assertIsInstance(out["worldWidth"], int)
        self.assertIsInstance(out["worldHeight"], int)

    def test_float_world_sizes_stay_float(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {"image": _IMG_URL, "worldWidth": 60.5, "worldHeight": 121.0}
        self.assertEqual(_dump(self._roundtrip(npc)), _dump(npc))

    def test_facing_and_sprite_sort_survive_without_widgets(self) -> None:
        """面板没有这两个控件 —— 重建式序列化会把它们抹掉，必须原值透传。"""
        npc = _npc_with_display()
        npc["displayImage"] = {
            "image": _IMG_URL, "worldWidth": 60, "worldHeight": 120,
            "facing": "left", "spriteSort": "back",
        }
        self.assertEqual(_dump(self._roundtrip(npc)), _dump(npc))

    def test_npc_without_display_image_gets_no_key(self) -> None:
        """没填就不落键：不许"打开一次就多出一个空 displayImage"。"""
        npc = {"id": "n0", "name": "甲", "x": 0, "y": 0, "interactionRange": 50}
        self.assertNotIn("displayImage", self._roundtrip(npc))

    def test_clearing_the_image_drops_the_whole_key(self) -> None:
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            panel.load_npc_props(_npc_with_display())
            panel._npc_disp_row.set_path("")
            panel._write_npc_widgets_to_dict(panel._staging_npc)
            self.assertNotIn("displayImage", panel._staging_npc)

    def test_panel_loads_the_values_it_will_write_back(self) -> None:
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            panel.load_npc_props(_npc_with_display())
            self.assertEqual(panel._npc_disp_row.path().strip(), _IMG_URL)
            self.assertAlmostEqual(panel._npc_disp_ww.value(), 60.0, places=3)
            self.assertAlmostEqual(panel._npc_disp_hh.value(), 120.0, places=3)
            self.assertTrue(panel._npc_disp_fold.is_expanded())

    def test_auto_height_uses_the_image_aspect(self) -> None:
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            panel.load_npc_props(_npc_with_display())
            panel._npc_disp_ww.setValue(100.0)
            panel._on_npc_disp_auto_height_from_width()
            # 图素 40×80 ⇒ 高 = 宽 × 2
            self.assertAlmostEqual(panel._npc_disp_hh.value(), 200.0, places=3)

    def test_opening_an_npc_does_not_mark_it_dirty(self) -> None:
        """打开即脏是红线：load 期间三个控件的信号必须被挡住。"""
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            panel.load_npc_props(_npc_with_display())
            self.assertFalse(panel.is_pending_dirty())


class ValidatorShapeTests(_QtCase):
    def _issues(self, npc: dict) -> tuple[list[str], list[str]]:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p", [npc])
            issues = [i for i in validate(model)
                      if i.data_type == "scene" and "displayImage" in i.message
                      or (i.data_type == "scene" and "静态贴图" in i.message)]
            return ([i.message for i in issues if i.severity == "error"],
                    [i.message for i in issues if i.severity == "warning"])

    def test_minimal_legal_shape_is_not_blocked(self) -> None:
        errs, warns = self._issues(_npc_with_display())
        self.assertEqual(errs, [])
        self.assertEqual(warns, [])

    def test_empty_image_is_an_error(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {"image": "  ", "worldWidth": 60, "worldHeight": 120}
        errs, _ = self._issues(npc)
        self.assertTrue(any("image 不能为空" in m for m in errs), errs)

    def test_non_positive_world_size_is_an_error(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {"image": _IMG_URL, "worldWidth": 0, "worldHeight": -3}
        errs, _ = self._issues(npc)
        self.assertEqual(
            sum("须为正有限数" in m for m in errs), 2, errs)

    def test_non_numeric_world_size_is_an_error(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {"image": _IMG_URL, "worldWidth": "big", "worldHeight": 120}
        errs, _ = self._issues(npc)
        self.assertTrue(any("worldWidth 须为数值" in m for m in errs), errs)

    def test_display_image_must_be_an_object(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = _IMG_URL
        errs, _ = self._issues(npc)
        self.assertTrue(any("须为对象" in m for m in errs), errs)

    def test_anim_file_plus_display_image_only_warns(self) -> None:
        """两者都写是合法数据（运行时以动画包为准），只提示、不拦。"""
        npc = _npc_with_display(animFile="/resources/runtime/animation/x/anim.json")
        errs, warns = self._issues(npc)
        self.assertEqual(errs, [])
        self.assertTrue(any("以动画包为准" in m for m in warns), warns)

    def test_sprite_sort_in_display_image_warns_about_being_ignored(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {
            "image": _IMG_URL, "worldWidth": 60, "worldHeight": 120, "spriteSort": "back",
        }
        errs, warns = self._issues(npc)
        self.assertEqual(errs, [])
        self.assertTrue(any("运行时会被忽略" in m for m in warns), warns)


class LegacyCanvasPreviewTests(_QtCase):
    """老画布（NAV_TARGET 当前用的那个）：没有动画包也要出精灵。"""

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            try:
                ed._scene_npc_anim_timer.stop()
                ed._patrol_overlay_refresh_timer.stop()
                ed._canvas._gfx.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path, npcs: list[dict]) -> SceneEditor:
        ed = SceneEditor(self._model(root, npcs))
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        return ed

    def test_static_display_npc_gets_a_sprite_runtime(self) -> None:
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p", [_npc_with_display()])
            rt = ed._scene_npc_runtimes.get("crate_01")
            self.assertIsNotNone(rt, "没有动画包的道具在老画布上完全看不见")
            self.assertEqual((rt.world_w, rt.world_h), (60.0, 120.0))
            self.assertEqual(rt.facing_x, 1)
            self.assertFalse(rt.item.pixmap().isNull(), "精灵图元没有像素")

    def test_display_image_facing_left_mirrors_when_initial_facing_absent(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {
            "image": _IMG_URL, "worldWidth": 60, "worldHeight": 120, "facing": "left",
        }
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p", [npc])
            self.assertEqual(ed._scene_npc_runtimes["crate_01"].facing_x, -1)

    def test_initial_facing_wins_over_display_image_facing(self) -> None:
        npc = _npc_with_display(initialFacing="right")
        npc["displayImage"] = {
            "image": _IMG_URL, "worldWidth": 60, "worldHeight": 120, "facing": "left",
        }
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p", [npc])
            self.assertEqual(ed._scene_npc_runtimes["crate_01"].facing_x, 1)

    def test_only_world_width_infers_height_from_pixels(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {"image": _IMG_URL, "worldWidth": 100}
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p", [npc])
            rt = ed._scene_npc_runtimes["crate_01"]
            self.assertAlmostEqual(rt.world_h, 200.0, places=3)

    def test_missing_image_file_makes_no_sprite(self) -> None:
        npc = _npc_with_display()
        npc["displayImage"] = {
            "image": "/resources/runtime/images/props/nope.png",
            "worldWidth": 60, "worldHeight": 120,
        }
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p", [npc])
            self.assertIsNone(ed._scene_npc_runtimes.get("crate_01"))


class V2CanvasPreviewTests(_QtCase):
    """新画布：同一条回落（世界尺寸 + 当前帧 + 朝向）。"""

    def _bank(self, root: Path, npcs: list[dict]):
        from tools.editor.editors.scene_v2.page import SceneEditorV2
        page = SceneEditorV2(self._model(root, npcs))
        page.load_scene("sc_a")
        return page

    def test_world_size_and_frame_fall_back_to_display_image(self) -> None:
        with TemporaryDirectory() as td:
            page = self._bank(Path(td) / "p", [_npc_with_display()])
            try:
                npc = _npc_with_display()
                self.assertEqual(page._anim_bank.world_size(npc), (60.0, 120.0))
                pm = page._anim_bank.frame_pixmap(npc)
                self.assertIsNotNone(pm)
                self.assertEqual((pm.width(), pm.height()), (_IMG_W, _IMG_H))
                self.assertEqual(page._anim_bank.sprite_texture_url(npc), _IMG_URL)
                # 视图侧真的建出了内容图元（不是只有 bank 会算）
                from tools.editor.editors.scene_v2.changes import EntityRef
                self.assertIsNotNone(
                    page.view.item_for(EntityRef("npc", "crate_01"), "sprite"),
                    "新画布上没有动画包的道具没有精灵图元")
            finally:
                page.deleteLater()
                QApplication.processEvents()

    def test_anim_file_still_wins(self) -> None:
        with TemporaryDirectory() as td:
            npc = _npc_with_display(animFile="/resources/runtime/animation/x/anim.json")
            page = self._bank(Path(td) / "p", [npc])
            try:
                self.assertIsNone(page._anim_bank.world_size(npc))
                self.assertEqual(page._anim_bank.sprite_texture_url(npc), "")
            finally:
                page.deleteLater()
                QApplication.processEvents()


class SharedFacingRuleTests(unittest.TestCase):
    """两个画布共用同一份朝向规则 —— 不许各写一份。"""

    def test_rule_table(self) -> None:
        from tools.editor.shared.static_display_sprite import npc_content_facing_x
        di_left = {"image": _IMG_URL, "worldWidth": 1, "worldHeight": 1, "facing": "left"}
        self.assertEqual(npc_content_facing_x({"displayImage": di_left}), -1)
        self.assertEqual(
            npc_content_facing_x({"displayImage": di_left, "initialFacing": "right"}), 1)
        self.assertEqual(
            npc_content_facing_x({"displayImage": di_left, "animFile": "/a/anim.json"}), 1,
            "有动画包时 displayImage 整个不生效，朝向也不该被它拨走")
        self.assertEqual(npc_content_facing_x({"initialFacing": "left"}), -1)
        self.assertEqual(npc_content_facing_x({}), 1)


if __name__ == "__main__":
    unittest.main()
