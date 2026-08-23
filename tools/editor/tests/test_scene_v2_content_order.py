"""新画布的内容层前后次序必须与运行时一致。

与老画布那份（`test_scene_canvas_content_order.py`）问的是同一个问题，
但这里还多锁一条**结构性**的：内容与装饰分属不同区间，装饰恒在内容之上。
老画布把两者混在一张写死的层表里，才会出现"NPC 永远被热点贴图压住"。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.items import Z_CONTENT_HI, Z_CONTENT_LO, Z_DECOR_BASE
from tools.editor.editors.scene_v2.sorting import assign_content_z
from tools.editor.editors.scene_v2.view import SceneView


class _FakeModel:
    def __init__(self, scene: dict) -> None:
        self.scenes = {"街": scene}
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, domain: str, key: str) -> None:
        self.dirty.append((domain, key))


def _hotspot(hid: str, y: float, sprite_sort: str | None = None) -> dict:
    di = {"image": "/x.png", "worldWidth": 100, "worldHeight": 80}
    if sprite_sort:
        di["spriteSort"] = sprite_sort
    return {"id": hid, "type": "inspect", "x": 200, "y": y, "displayImage": di}


def _scene() -> dict:
    return {
        "id": "街", "name": "街", "worldWidth": 800, "worldHeight": 600,
        "hotspots": [_hotspot("hs_近", 400), _hotspot("hs_远", 100)],
        "npcs": [], "zones": [],
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _build(self, scene: dict | None = None, *, loaded: bool = True):
        self.model = _FakeModel(scene or _scene())
        self.doc = SceneDocument(self.model, "街")
        self.view = SceneView(self.doc)
        if loaded:
            pix = QPixmap(4, 4)
            pix.fill()
            self.view.set_texture_provider(lambda _url: pix)
        else:
            self.view.set_texture_provider(lambda _url: None)
        self._cache = assign_content_z(self.doc, self.view)
        return self.view

    def tearDown(self) -> None:
        for obj in (getattr(self, "view", None), getattr(self, "doc", None)):
            if obj is not None:
                obj.deleteLater()
        QApplication.processEvents()

    def z(self, hid: str) -> float:
        return self.view.item_for(EntityRef("hotspot", hid), "display").zValue()


class ContentOrderTests(_Base):
    def test_nearer_entity_draws_in_front(self) -> None:
        self._build()
        self.assertGreater(self.z("hs_近"), self.z("hs_远"))

    def test_sprite_sort_front_lifts_above_everything(self) -> None:
        sc = _scene()
        sc["hotspots"][1] = _hotspot("hs_远", 100, sprite_sort="front")
        self._build(sc)
        self.assertGreater(self.z("hs_远"), self.z("hs_近"))

    def test_sprite_sort_back_sinks_below_everything(self) -> None:
        sc = _scene()
        sc["hotspots"][0] = _hotspot("hs_近", 400, sprite_sort="back")
        self._build(sc)
        self.assertLess(self.z("hs_近"), self.z("hs_远"))

    def test_band_needs_the_texture_to_have_loaded(self) -> None:
        """贴图读不出来时**没有档位** —— 与运行时 `displaySprite !== null` 同口径。

        不同口径的话，缺件的热点会排到一个运行时不存在的层。
        """
        sc = _scene()
        sc["hotspots"][1] = _hotspot("hs_远", 100, sprite_sort="front")
        self._build(sc, loaded=False)
        self.assertLess(self.z("hs_远"), self.z("hs_近"),
                        "缺件热点不该拿到 front 档位")

    def test_content_stays_inside_its_band(self) -> None:
        self._build()
        for hid in ("hs_近", "hs_远"):
            self.assertGreaterEqual(self.z(hid), Z_CONTENT_LO)
            self.assertLess(self.z(hid), Z_CONTENT_HI)

    def test_decor_sits_above_all_content(self) -> None:
        """把手恒在贴图之上 —— 否则拖不动、点不着。"""
        self._build()
        handle = self.view.item_for(EntityRef("hotspot", "hs_近"), "handle")
        self.assertGreaterEqual(handle.zValue(), Z_DECOR_BASE)
        self.assertGreater(handle.zValue(), self.z("hs_近"))

    def test_resort_is_dirty_checked(self) -> None:
        self._build()
        again = assign_content_z(self.doc, self.view, cache=self._cache)
        self.assertEqual(again, self._cache)

    def test_moving_an_entity_reorders(self) -> None:
        self._build()
        self.assertLess(self.z("hs_远"), self.z("hs_近"))
        self.doc.model_entity(EntityRef("hotspot", "hs_远"))["y"] = 590
        self.view._sync_entity(EntityRef("hotspot", "hs_远"))
        assign_content_z(self.doc, self.view)
        self.assertGreater(self.z("hs_远"), self.z("hs_近"))

    def test_entity_without_display_image_has_no_content_item(self) -> None:
        sc = _scene()
        sc["hotspots"].append({"id": "hs_裸", "type": "inspect", "x": 0, "y": 0})
        self._build(sc)
        self.assertIsNone(
            self.view.item_for(EntityRef("hotspot", "hs_裸"), "display"))


class SpriteVisibilityGateTests(_Base):
    """精灵的显隐闸门 —— 动画重画不许把隐藏结论冲掉。"""

    def test_refresh_frame_respects_the_gate(self) -> None:
        from tools.editor.editors.scene_v2.content_items import SpritePreviewItem
        item = SpritePreviewItem(EntityRef("npc", "n1"))
        item.setVisible(False)
        pix = QPixmap(2, 2)
        pix.fill()
        item.refresh_frame(pix)
        self.assertFalse(item.isVisible(),
                         "动画重画把隐藏结论冲掉了 —— 老画布那个 8ms 自愈又回来了")

    def test_gate_reopens(self) -> None:
        from tools.editor.editors.scene_v2.content_items import SpritePreviewItem
        item = SpritePreviewItem(EntityRef("npc", "n1"))
        item.setVisible(False)
        item.setVisible(True)
        item.refresh_frame(None)
        self.assertTrue(item.isVisible())


if __name__ == "__main__":
    unittest.main()
