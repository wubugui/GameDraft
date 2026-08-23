""""画布不许撒谎" —— 预览与运行时口径一致的那批。

全功能回归里第二贵的一类：**画面看着好好的，跟游戏里不是一回事**。它比崩溃更坏，
因为没有任何报错，策划照着画布摆好的构图进游戏才发现是散的，而且无从归因。

这一份钉死三条：透视系数、NPC 精灵是"一帧"而不是"整张图集"、内容层次序在
重建与手势中都得对。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.items import Z_CONTENT_LO
from tools.editor.editors.scene_v2.sorting import assign_content_z
from tools.editor.editors.scene_v2.tools_builtin import MoveTool
from tools.editor.editors.scene_v2.view import SceneView
from tools.editor.shared.anim_frame_cursor import AnimFrameCursor

_NO_MOD = Qt.KeyboardModifier.NoModifier
_LEFT = Qt.MouseButton.LeftButton
_SCENE = "透视街"


class _FakeModel:
    def __init__(self, scene: dict) -> None:
        self.scenes = {_SCENE: scene}

    def mark_dirty(self, domain: str, key: str) -> None:
        pass


def _scene() -> dict:
    """近端 y=600 缩放 1.0、远端 y=100 缩放 0.5 的竖直透视轴。"""
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 900, "worldHeight": 700,
        "perspectiveScale": {
            "near": {"x": 450, "y": 600, "scale": 1.0},
            "far": {"x": 450, "y": 100, "scale": 0.5},
        },
        "hotspots": [
            {"id": "h_near", "type": "inspect", "x": 450, "y": 600,
             "interactionRange": 100, "perspectiveScaleEnabled": True,
             "displayImage": {"image": "a.png", "worldWidth": 100,
                              "worldHeight": 200}},
            {"id": "h_far", "type": "inspect", "x": 450, "y": 100,
             "interactionRange": 100, "perspectiveScaleEnabled": True,
             "displayImage": {"image": "a.png", "worldWidth": 100,
                              "worldHeight": 200}},
        ],
        "npcs": [],
        "zones": [],
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.model = _FakeModel(_scene())
        self.doc = SceneDocument(self.model, _SCENE)
        self.view = SceneView(self.doc)
        self.view.resize(900, 700)
        self.view.renderer.set_view_scale(1.0)
        self.view.set_texture_provider(lambda _u: QPixmap(8, 8))
        self.move = self.view.tools.register(
            MoveTool(self.doc, self.view.renderer, self.view))

    def tearDown(self) -> None:
        self.view.deleteLater()
        self.doc.deleteLater()
        QApplication.processEvents()


class PerspectiveFactorTests(_Base):
    """透视场景里"多大"的东西全都要乘透视系数。"""

    def test_factor_shrinks_with_distance(self) -> None:
        near = self.doc.entity(EntityRef("hotspot", "h_near"))
        far = self.doc.entity(EntityRef("hotspot", "h_far"))
        self.assertAlmostEqual(
            self.view.perspective_factor(near, "hotspot"), 1.0, places=3)
        self.assertAlmostEqual(
            self.view.perspective_factor(far, "hotspot"), 0.5, places=3)

    def test_display_image_is_scaled_by_the_factor(self) -> None:
        """远处的贴图必须画得更小 —— 不乘的话画布最多骗 2.2 倍。"""
        near = self.view.item_for(EntityRef("hotspot", "h_near"), "display")
        far = self.view.item_for(EntityRef("hotspot", "h_far"), "display")
        self.assertIsNotNone(near)
        self.assertIsNotNone(far)
        self.assertGreater(near.boundingRect().height(),
                           far.boundingRect().height() * 1.5,
                           "远近两张同尺寸贴图画得一样大 —— 漏乘了透视系数")

    def test_interaction_ring_is_scaled_by_the_factor(self) -> None:
        """交互半径圈同理：策划照着它调"走到多近能交互"。"""
        near = self.view.item_for(EntityRef("hotspot", "h_near"), "handle")
        far = self.view.item_for(EntityRef("hotspot", "h_far"), "handle")
        self.assertGreater(near.boundingRect().height(),
                           far.boundingRect().height(),
                           "远近两个同 interactionRange 的圈画得一样大")

    def test_interaction_range_defaults_to_fifty_not_zero(self) -> None:
        """缺省是 50（与运行时一致）。写 0 的话圈直接不画，等于对玩法参数撒谎。"""
        self.doc.scene()["hotspots"][0].pop("interactionRange", None)
        self.view.rebuild_all()
        item = self.view.item_for(EntityRef("hotspot", "h_near"), "handle")
        self.assertGreater(item.boundingRect().height(), 20.0,
                           "缺省 interactionRange 被当成 0，圈没画出来")

    def test_sort_key_uses_the_factor(self) -> None:
        """排序的脚底 quad 尺寸也要乘 —— 否则"谁挡谁"与运行时算的不是一回事。"""
        scene = self.doc.scene()
        for hs in scene["hotspots"]:
            hs["rotation"] = 30.0
        self.view.rebuild_all()
        from tools.editor.editors.scene_v2.sorting import content_sort_entries

        with_pf = content_sort_entries(self.doc, self.view)
        scene.pop("perspectiveScale", None)
        without_pf = content_sort_entries(self.doc, self.view)
        self.assertNotEqual([round(e[0], 4) for e in with_pf],
                            [round(e[0], 4) for e in without_pf],
                            "开不开透视算出同样的排序键 —— 排序漏乘了系数")


class ContentZTests(_Base):
    """内容层 z 在重建之后必须重新派，手势中也要跟着走。"""

    def test_drag_preview_feeds_the_sort_key(self) -> None:
        """拖动中脚底 y 已经在画面上变了，排序键必须跟着变。

        不跟的话"把这个人挪到树后面"这类调层动作在拖动全程看到的层级是错的，
        只能靠松手那一跳试错，实体密集的场景里一次调层要来回好几遍。
        """
        from tools.editor.editors.scene_v2.sorting import content_sort_entries

        ref = EntityRef("hotspot", "h_far")
        base = [round(e[0], 4) for e in content_sort_entries(self.doc, self.view)]
        self.doc.set_selection([ref])
        self.view.tools.select(self.move)
        self.move.mouse_pressed(QPointF(450, 100), _LEFT, _NO_MOD)
        self.move.mouse_moved(QPointF(450, 650), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        moved = [round(e[0], 4) for e in content_sort_entries(self.doc, self.view)]
        self.assertNotEqual(base, moved, "拖动中排序键没跟着预览走")

    def test_stale_cache_does_not_leave_new_items_at_zero(self) -> None:
        """换了一批全新图元之后，**不能**因为排序键没变就一个 z 都不派。

        缓存键刻意不含图元身份（id 会被回收复用），所以重建视图时必须由宿主
        作废缓存。不作废的话切页/跳转/编排回来一次，全场内容图元停在默认 z=0：
        该被挡住的贴图跑到前面来，而数据其实没变。
        """
        key = assign_content_z(self.doc, self.view)
        self.view.rebuild_all()
        zs_before = [self.view.item_for(EntityRef("hotspot", i), "display").zValue()
                     for i in ("h_near", "h_far")]
        self.assertEqual(zs_before, [0.0, 0.0], "前置条件：新图元的 z 是 0")
        again = assign_content_z(self.doc, self.view, cache=key)
        self.assertEqual(again, key,
                         "前置条件：这一趟的排序键与重建前相同（正是踩坑的形态）")
        zs_stale = [self.view.item_for(EntityRef("hotspot", i), "display").zValue()
                    for i in ("h_near", "h_far")]
        self.assertEqual(zs_stale, [0.0, 0.0],
                         "前置条件：带旧缓存时确实会早退（所以宿主必须作废它）")
        # 宿主的正确做法：作废缓存再派
        assign_content_z(self.doc, self.view, cache=None)
        zs_fixed = [self.view.item_for(EntityRef("hotspot", i), "display").zValue()
                    for i in ("h_near", "h_far")]
        self.assertNotEqual(zs_fixed, [0.0, 0.0])
        self.assertTrue(all(z < Z_CONTENT_LO + 100 for z in zs_fixed))


class AnimFrameCursorTests(unittest.TestCase):
    """帧游标是两个画布共用的那一份，语义与运行时对齐过。"""

    def test_loops_back_to_the_start(self) -> None:
        c = AnimFrameCursor([0, 1, 2], frame_rate=10, loop=True)
        for _ in range(3):
            c.advance(0.1)
        self.assertEqual(c.frame_idx, 0)

    def test_non_looping_stops_at_the_end(self) -> None:
        c = AnimFrameCursor([0, 1, 2], frame_rate=10, loop=False)
        for _ in range(10):
            c.advance(0.1)
        self.assertEqual(c.frame_idx, 2)

    def test_hold_frame_pins_the_cursor(self) -> None:
        c = AnimFrameCursor([0, 1, 2, 3], frame_rate=10, loop=True)
        c.set_playback(1.0, False, 2, None)
        for _ in range(10):
            c.advance(0.1)
        self.assertEqual(c.frame_idx, 2, "定格帧被推走了")

    def test_start_frame_only_moves_on_the_edge(self) -> None:
        """每拍都拨游标的话动画会永远停在起点 —— 只认变化边沿。"""
        c = AnimFrameCursor([0, 1, 2, 3], frame_rate=10, loop=True)
        c.set_playback(1.0, False, None, 1)
        self.assertEqual(c.frame_idx, 1)
        c.advance(0.1)
        c.set_playback(1.0, False, None, 1)      # 同样的参数再拉一次
        self.assertEqual(c.frame_idx, 2, "重复拉取把游标拨回了起播帧")

    def test_reverse_walks_backwards(self) -> None:
        c = AnimFrameCursor([0, 1, 2], frame_rate=10, loop=True)
        c.set_playback(1.0, True, None, None)
        self.assertEqual(c.frame_idx, 2)
        c.advance(0.1)
        self.assertEqual(c.frame_idx, 1)

    def test_atlas_index_maps_through_the_frame_table(self) -> None:
        """`frames` 是"第几帧 → 图集第几格"的映射，不是恒等。"""
        c = AnimFrameCursor([5, 7, 9], frame_rate=10, loop=True)
        self.assertEqual(c.atlas_index, 5)
        c.advance(0.1)
        self.assertEqual(c.atlas_index, 7)


if __name__ == "__main__":
    unittest.main()
