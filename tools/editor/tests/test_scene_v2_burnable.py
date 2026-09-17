"""新画布上的可燃实例（A3.8 模板 + 实例）：开了可燃就画模板，不许画实体自己的图。

钉死：
1. 热点：展示图的图与宽高失效，画模板的图、按模板真实尺寸（widthCm × 0.88），朝向照用展示图 facing；
2. NPC：动画包 / 自己的展示图失效，精灵按模板合成 1×1 单帧（不播动画）；
3. 模板装不上：不画图（运行时也不画），锚点上一个红叉；
4. 着火点标记与运行时 `burnEntityPlacement` 同口径（`shared/burn_geometry`），跟缩放 / 旋转手势预览走，
   且**不进命中白名单**、不被框选；
5. 燃烧工作台存盘 → 主窗重读模板 → 切页刷新时画布按新模板重画。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF, QRectF
from PySide6.QtGui import QColor, QImage
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.project_model import ProjectModel
from tools.editor.shared import burn_geometry as bg
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_TPL_URL = "/resources/runtime/images/props/burn_probe.png"
_OWN_URL = "/resources/runtime/images/props/own_probe.png"
_TPL_PX = (30, 60)
_OWN_PX = (50, 50)


def _write_png(root: Path, url: str, size: tuple[int, int]) -> None:
    p = root / "public" / url.lstrip("/")
    p.parent.mkdir(parents=True, exist_ok=True)
    img = QImage(size[0], size[1], QImage.Format.Format_ARGB32)
    img.fill(QColor(160, 90, 40))
    assert img.save(str(p), "PNG")


def _template(**over) -> dict:
    doc = {
        "label": "探针纸堆", "image": _TPL_URL, "mode": "spread",
        "widthCm": 50, "heightCm": 100,
        "ignitionPoints": [{"id": "corner", "u": 0.2, "v": 0.9}, {"id": "top", "u": 0.5, "v": 0.1}],
    }
    doc.update(over)
    return doc


def _hotspot(**over) -> dict:
    hs = {
        "id": "pile", "type": "inspect", "x": 300, "y": 400, "interactionRange": 40,
        "scale": 1.5, "rotation": 20,
        "displayImage": {"image": _OWN_URL, "worldWidth": 200, "worldHeight": 20, "facing": "left"},
        "burnable": {"template": "probe"},
    }
    hs.update(over)
    return hs


def _npc(**over) -> dict:
    npc = {
        "id": "figure", "name": "纸人", "x": 500, "y": 450, "interactionRange": 40,
        "displayImage": {"image": _OWN_URL, "worldWidth": 80, "worldHeight": 80},
        "burnable": {"template": "probe"},
    }
    npc.update(over)
    return npc


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _page(self, root: Path, *, hotspots=(), npcs=(), templates=None):
        from tools.editor.editors.scene_v2.page import SceneEditorV2
        write_minimal_loadable_project(root)
        _write_png(root, _TPL_URL, _TPL_PX)
        _write_png(root, _OWN_URL, _OWN_PX)
        model = ProjectModel()
        model.load_project(root)
        model.burnables = {"probe": _template()} if templates is None else templates
        model.scenes = {"sc_a": {"id": "sc_a", "name": "sc_a", "worldWidth": 1000, "worldHeight": 800,
                                 "hotspots": [copy.deepcopy(h) for h in hotspots], "zones": [],
                                 "spawnPoints": {}, "npcs": [copy.deepcopy(n) for n in npcs]}}
        page = SceneEditorV2(model)
        page.load_scene("sc_a")
        self.addCleanup(lambda: (page.deleteLater(), QApplication.processEvents()))
        return model, page

    @staticmethod
    def _scene_points(item) -> dict[str, tuple[float, float]]:
        out = {}
        for pid, _style, pos in item.marker_positions():
            if pos is not None:
                out[pid] = (item.pos().x() + pos[0], item.pos().y() + pos[1])
        return out


class HotspotTakeoverTests(_Base):
    def test_display_uses_template_image_and_real_size(self) -> None:
        with TemporaryDirectory() as td:
            _model, page = self._page(Path(td) / "p", hotspots=[_hotspot()])
            ref = EntityRef("hotspot", "pile")
            disp = page.view.item_for(ref, "display")
            self.assertIsNotNone(disp)
            self.assertEqual(disp.world_size, (50 * 0.88, 100 * 0.88), "尺寸取模板真实尺寸，展示图宽高失效")
            self.assertEqual((disp._pix.width(), disp._pix.height()), _TPL_PX, "图取模板的，不是实体自己的")
            self.assertEqual(disp._facing, -1, "朝向照用展示图 facing（与运行时 burnableDisplayOf 同口径）")

    def test_ignition_markers_match_runtime_placement(self) -> None:
        with TemporaryDirectory() as td:
            _model, page = self._page(Path(td) / "p", hotspots=[_hotspot()])
            hs = _hotspot()
            item = page.view.item_for(EntityRef("hotspot", "pile"), "burn")
            self.assertIsNotNone(item)
            self.assertEqual([r[0] for r in item.rows], ["corner", "top"])
            self.assertIn("缺省", item.rows[0][3])
            frame = bg.entity_frame(hs, (50 * 0.88, 100 * 0.88), depth_scale=1.0, flip_x=True)
            got = self._scene_points(item)
            for pid, u, v in (("corner", 0.2, 0.9), ("top", 0.5, 0.1)):
                want = bg.uv_to_scene(frame, u, v)
                self.assertAlmostEqual(got[pid][0], want[0], places=4)
                self.assertAlmostEqual(got[pid][1], want[1], places=4)

    def test_markers_never_steal_picks_or_band_selection(self) -> None:
        with TemporaryDirectory() as td:
            _model, page = self._page(Path(td) / "p", hotspots=[_hotspot()])
            item = page.view.item_for(EntityRef("hotspot", "pile"), "burn")
            pos = self._scene_points(item)["corner"]
            self.assertFalse(item.pick_contains(QPointF(*pos), 50.0))
            self.assertFalse(QRectF(0, 0, 2000, 2000).intersects(item.pick_rect()))

    def test_transform_preview_moves_markers_with_the_image(self) -> None:
        with TemporaryDirectory() as td:
            _model, page = self._page(Path(td) / "p", hotspots=[_hotspot()])
            ref = EntityRef("hotspot", "pile")
            item = page.view.item_for(ref, "burn")
            before = self._scene_points(item)["top"]
            page.view.set_transform_preview((ref, 3.0, 20.0))
            during = self._scene_points(item)["top"]
            self.assertNotAlmostEqual(before[1], during[1], places=2, msg="缩放预览时着火点跟着图走")
            page.view.set_transform_preview(None)
            after = self._scene_points(item)["top"]
            self.assertAlmostEqual(before[0], after[0], places=4)
            self.assertAlmostEqual(before[1], after[1], places=4)

    def test_missing_template_draws_nothing_but_a_red_cross(self) -> None:
        with TemporaryDirectory() as td:
            _model, page = self._page(Path(td) / "p", hotspots=[_hotspot()], templates={})
            ref = EntityRef("hotspot", "pile")
            self.assertIsNone(page.view.item_for(ref, "display"), "模板装不上：运行时不画，画布也不画（更不许回落画自己的图）")
            item = page.view.item_for(ref, "burn")
            self.assertEqual([(s, p) for _pid, s, p in item.marker_positions()], [("warn", (0.0, 0.0))])
            self.assertIn("不存在", item.rows[0][3])

    def test_not_burnable_has_no_marker_item_and_keeps_own_image(self) -> None:
        with TemporaryDirectory() as td:
            hs = _hotspot()
            del hs["burnable"]
            _model, page = self._page(Path(td) / "p", hotspots=[hs])
            ref = EntityRef("hotspot", "pile")
            self.assertIsNone(page.view.item_for(ref, "burn"))
            disp = page.view.item_for(ref, "display")
            self.assertEqual(disp.world_size, (200.0, 20.0))

    def test_template_reload_redraws_on_page_refresh(self) -> None:
        with TemporaryDirectory() as td:
            model, page = self._page(Path(td) / "p", hotspots=[_hotspot()])
            ref = EntityRef("hotspot", "pile")
            model.burnables = {"probe": _template(widthCm=10, heightCm=20, ignitionPoints=[])}
            page.reload_refs_from_model()
            self.assertEqual(page.view.item_for(ref, "display").world_size, (10 * 0.88, 20 * 0.88))
            self.assertEqual([r[4] for r in page.view.item_for(ref, "burn").rows], ["whole"],
                             "模板去掉着火点后画整体点着的虚线圈")


class NpcTakeoverTests(_Base):
    def test_npc_sprite_is_template_single_frame(self) -> None:
        with TemporaryDirectory() as td:
            npc = _npc(animFile="/resources/runtime/animation/nope/anim.json", initialAnimState="walk")
            _model, page = self._page(Path(td) / "p", npcs=[npc])
            bank = page._anim_bank
            self.assertEqual(bank.world_size(npc), (50 * 0.88, 100 * 0.88), "动画包 / 展示图失效，尺寸取模板")
            pm = bank.frame_pixmap(npc)
            self.assertEqual((pm.width(), pm.height()), _TPL_PX)
            self.assertEqual(bank.sprite_texture_url(npc), _TPL_URL)
            sprite = page.view.item_for(EntityRef("npc", "figure"), "sprite")
            self.assertIsNotNone(sprite)
            self.assertIsNotNone(page.view.item_for(EntityRef("npc", "figure"), "burn"))

    def test_npc_facing_uses_display_facing_even_with_anim_file(self) -> None:
        with TemporaryDirectory() as td:
            npc = _npc(animFile="/resources/runtime/animation/nope/anim.json")
            npc["displayImage"]["facing"] = "left"
            _model, page = self._page(Path(td) / "p", npcs=[npc])
            self.assertEqual(page.view.item_for(EntityRef("npc", "figure"), "sprite")._facing, -1,
                             "运行时删了动画包，initialFacing 没开口时展示图 facing 生效")

    def test_npc_template_missing_has_no_sprite(self) -> None:
        with TemporaryDirectory() as td:
            _model, page = self._page(Path(td) / "p", npcs=[_npc()], templates={})
            self.assertIsNone(page._anim_bank.world_size(_npc()))
            self.assertIsNone(page.view.item_for(EntityRef("npc", "figure"), "sprite"))

    def test_npc_template_reload_rebuilds_bundle(self) -> None:
        with TemporaryDirectory() as td:
            model, page = self._page(Path(td) / "p", npcs=[_npc()])
            model.burnables = {"probe": _template(widthCm=20, heightCm=40)}
            page.reload_refs_from_model()
            self.assertEqual(page._anim_bank.world_size(_npc()), (20 * 0.88, 40 * 0.88))
            self.assertEqual(page.view.item_for(EntityRef("npc", "figure"), "sprite").world_size, (20 * 0.88, 40 * 0.88))


if __name__ == "__main__":
    unittest.main()
