"""挂件预览解析的跨语言 parity 锁（norms 第 8 条）+ 画挂件的遮挡语义。

``tools/editor/shared/prop_preview.py`` 镜像运行时两处：
- ``src/data/propPresets.ts`` 的状态名解析与贴图 / 摆放合并 —— 用例与
  ``src/data/propPresets.test.ts`` 「状态：挂哪个状态、这个状态长什么样」一节**逐条相同**；
- ``src/data/resolveAnimationSet.ts::resolveAnimationWorldSize`` —— 黄金值与
  ``src/data/resolveAnimationSet.test.ts`` **逐条相同**。
改用例必须同步改两边。

另钉 ``prop_tryon_canvas.paint_prop`` 在挂点标注画布里的遮挡结果：身前压在身体上、
身后被身体挡住（2026-09-14：只画圆点时身后被挡住在编辑器里完全看不出来）。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtGui import QColor, QImage, QPixmap
from PySide6.QtWidgets import QApplication

from tools.editor.shared.prop_preview import (
    anim_world_size,
    frame_image_index,
    resolve_prop_preview,
    resolve_prop_state_name,
)
from tools.editor.shared.prop_tryon_canvas import PropTryOnCanvas
from tools.editor.shared.socket_canvas import PropPreviewSpec, SocketCanvas

RAW = {
    "torch": {
        "image": "/base.png",
        "anchorX": 0.47,
        "anchorY": 0,
        "rotation": -90,
        "scale": 0.45,
        "defaultState": "out",
        "states": {
            "lit": {"label": "点着"},
            "out": {"image": "/out.png", "anchorY": 0.2, "scale": 0},
            "anim": {"images": ["/f0.png", "", "/f1.png"], "rotation": 0, "anchorX": 3},
        },
    },
    "no_default": {"image": "/a.png", "states": {"first": {}, "second": {}}},
    "bad_default": {"image": "/a.png", "defaultState": "ghost", "states": {"first": {}, "second": {}}},
}

GRID = {"cols": 9, "rows": 10}


def _placement(r) -> list[float]:
    return [r.anchor_x, r.anchor_y, r.rotation, r.scale]


class PropStateParityTests(unittest.TestCase):
    def test_initial_state_order(self) -> None:
        self.assertEqual(resolve_prop_state_name(RAW["torch"]), "out")
        self.assertEqual(resolve_prop_state_name(RAW["torch"], "anim"), "anim")
        self.assertEqual(resolve_prop_state_name(RAW["torch"], "nope"), "")
        self.assertEqual(resolve_prop_state_name(RAW["no_default"]), "first")
        self.assertEqual(resolve_prop_state_name(RAW["bad_default"]), "first")
        self.assertEqual(resolve_prop_state_name({"image": "/a.png"}), "")

    def test_state_images_replace_and_nonpositive_scale_ignored(self) -> None:
        r = resolve_prop_preview(RAW["torch"], "out")
        self.assertEqual(r.images, ["/out.png"])
        self.assertEqual(_placement(r), [0.47, 0.2, -90, 0.45])

    def test_zero_counts_anchor_clamped_empty_frames_dropped(self) -> None:
        r = resolve_prop_preview(RAW["torch"], "anim")
        self.assertEqual(r.images, ["/f0.png", "/f1.png"])
        self.assertEqual(_placement(r), [1, 0, 0, 0.45])

    def test_state_without_overrides_uses_base(self) -> None:
        r = resolve_prop_preview(RAW["torch"], "lit")
        self.assertEqual(r.images, ["/base.png"])
        self.assertEqual(_placement(r), [0.47, 0, -90, 0.45])

    def test_runtime_defaults_when_nothing_written(self) -> None:
        r = resolve_prop_preview({"image": "/a.png"})
        self.assertEqual(_placement(r), [0.5, 0.5, 0.0, 1.0])
        self.assertEqual(resolve_prop_preview(None).images, [])

    def test_frame_index_matches_sync_attachments(self) -> None:
        self.assertEqual(frame_image_index(1, 5), 0, "单张图不看帧号")
        self.assertEqual(frame_image_index(3, None), 0, "没标帧号取第一张")
        self.assertEqual(frame_image_index(3, 4), 1)
        self.assertEqual(frame_image_index(3, -1), 2, "负帧号与 ((f % n) + n) % n 同答案")


class AnimWorldSizeParityTests(unittest.TestCase):
    def test_both_written_kept_as_is(self) -> None:
        self.assertEqual(anim_world_size(
            {**GRID, "cellWidth": 219, "cellHeight": 204, "worldWidth": 148.214286, "worldHeight": 150},
            1971, 2040), (148.214286, 150))

    def test_width_only(self) -> None:
        self.assertEqual(anim_world_size({**GRID, "cellWidth": 219, "cellHeight": 204, "worldWidth": 148},
                                         1971, 2040), (148, 137.863014))

    def test_height_only(self) -> None:
        self.assertEqual(anim_world_size({**GRID, "cellWidth": 219, "cellHeight": 204, "worldHeight": 150},
                                         1971, 2040), (161.029412, 150))

    def test_neither_defaults_width_100(self) -> None:
        self.assertEqual(anim_world_size({**GRID, "cellWidth": 219, "cellHeight": 204}, 1971, 2040),
                         (100.0, 93.150685))

    def test_cell_from_atlas(self) -> None:
        self.assertEqual(anim_world_size({**GRID, "worldWidth": 50}, 900, 2000), (50, 100.0))

    def test_unknown_cell_size_is_none_not_guess(self) -> None:
        self.assertIsNone(anim_world_size({**GRID, "worldWidth": 50}, 0, 0))


def _solid(w: int, h: int, color: QColor) -> QPixmap:
    img = QImage(w, h, QImage.Format.Format_ARGB32_Premultiplied)
    img.fill(color)
    return QPixmap.fromImage(img)


class SocketCanvasOcclusionTests(unittest.TestCase):
    """从画布的数据入口喂进去、再读回渲染像素：身前看得见、身后被身体挡住。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _render(self, front: bool) -> QImage:
        canvas = SocketCanvas()
        # 身体：整格不透明的蓝；挂件：纯红，支点在图心，正好压在挂点上
        canvas.set_cell(_solid(100, 200, QColor(0, 0, 255)))
        canvas.set_marks({"hand": (0.5, 0.5, 0.0, front)}, "hand")
        canvas.set_prop_preview(PropPreviewSpec(
            pixmap=_solid(20, 20, QColor(255, 0, 0)),
            world_w=100.0, world_h=200.0,
            anchor_x=0.5, anchor_y=0.5, rotation=0.0, scale=1.0,
        ))
        # grab() 走真实 paintEvent；不自己开 QPainter（异常时没 end 的 painter 会在 GC 时 abort）
        img = canvas.grab().toImage()
        self._center = canvas._to_view(0.5, 0.5)
        canvas.deleteLater()
        return img

    def _sample(self, img: QImage, dx: float, dy: float) -> QColor:
        return img.pixelColor(int(self._center.x() + dx), int(self._center.y() + dy))

    def test_front_prop_drawn_over_body(self) -> None:
        img = self._render(front=True)
        # 避开挂点圆圈与名字：取挂件里偏下的一点（挂件边长 20 世界单位 ⇒ 画布上约 36 像素）
        c = self._sample(img, 0, 12)
        self.assertGreater(c.red(), 200, f"身前的挂件应当压在身体上，实际 {c.name()}")
        self.assertLess(c.blue(), 60)

    def test_behind_prop_hidden_by_body(self) -> None:
        img = self._render(front=False)
        c = self._sample(img, 0, 12)
        self.assertGreater(c.blue(), 200, f"身后的挂件应当被身体挡住，实际 {c.name()}")
        self.assertLess(c.red(), 60)


class TryOnFacingTests(unittest.TestCase):
    """挂件预设页试挂预览：切到朝左时前后互换（标注按朝右标，与运行时同一条规则）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _center_color(self, *, authored_front: bool, facing: int) -> QColor:
        canvas = PropTryOnCanvas()
        canvas.resize(340, 400)
        canvas.set_host(_solid(100, 200, QColor(0, 0, 255)), 100.0, 200.0)
        canvas.set_pose((0.5, 0.5, 0.0, authored_front))
        canvas.set_prop(_solid(20, 20, QColor(255, 0, 0)))
        canvas.set_placement(0.5, 0.5, 0.0, 1.0)
        canvas.set_facing(facing)
        img = canvas.grab().toImage()
        k, o, cw, ch = canvas._fit()
        c = img.pixelColor(int(o.x() + 0.5 * cw * k), int(o.y() + 0.5 * ch * k + 12))
        canvas.deleteLater()
        return c

    def test_front_when_facing_right_goes_behind_when_facing_left(self) -> None:
        self.assertGreater(self._center_color(authored_front=True, facing=1).red(), 200)
        self.assertGreater(self._center_color(authored_front=True, facing=-1).blue(), 200)

    def test_behind_when_facing_right_comes_front_when_facing_left(self) -> None:
        self.assertGreater(self._center_color(authored_front=False, facing=1).blue(), 200)
        self.assertGreater(self._center_color(authored_front=False, facing=-1).red(), 200)


if __name__ == "__main__":
    unittest.main()
