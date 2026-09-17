"""挂件预览解析的跨语言 parity 锁（norms 第 8 条）+ 画挂件的遮挡语义。

``tools/editor/shared/prop_preview.py`` 镜像运行时两处：
- ``src/data/propPresets.ts`` 的状态名解析与贴图 / 摆放合并 —— 用例与
  ``src/data/propPresets.test.ts`` 「状态：挂哪个状态、这个状态长什么样」一节**逐条相同**；
- ``src/data/resolveAnimationSet.ts::resolveAnimationWorldSize`` —— 黄金值与
  ``src/data/resolveAnimationSet.test.ts`` **逐条相同**；
- 燃烧物 + 程序化火焰数据契约（2026-09-15）的清洗与合并 —— ``FIRE_RAW`` 与 TS
  ``propPresets.test.ts`` 用同一组黄金用例；起火点局部坐标的黄金值按契约公式手算。
改用例必须同步改两边。

另钉 ``prop_tryon_canvas.paint_prop`` 在挂点标注画布里的遮挡结果：身前压在身体上、
身后被身体挡住（2026-09-14：只画圆点时身后被挡住在编辑器里完全看不出来）。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtCore import QPointF
from PySide6.QtGui import QColor, QImage, QPixmap, QTransform
from PySide6.QtWidgets import QApplication

from tools.editor.shared.animation_sockets import socket_pose_to_local
from tools.editor.shared.prop_preview import (
    FlameDef,
    ParticleMount,
    anim_world_size,
    fire_point_from_offset,
    fire_point_local,
    fire_point_offset,
    frame_image_index,
    parse_particles,
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


#: 燃烧物 + 程序化火焰数据契约的黄金用例（TS `propPresets.test.ts` 用**同一组**，改一边必改两边）。
FIRE_RAW = {
    "t": {
        "image": "/a.png", "anchorX": 0.5, "anchorY": 0.9,
        "firePoint": [0.5, 0.05],
        "flame": {"image": "/f.png", "cols": 12, "frames": 64, "height": 30},
        "states": {
            "lit": {"burn": 1},
            "ember": {"burn": 0.15, "firePoint": [0.4, 0.1]},
            "out": {"burn": 0, "onEnterActions": [{"type": "playSfx", "params": {"id": "x"}}]},
        },
    },
    "bad": {"image": "/b.png", "firePoint": [2, -1], "burn": 1.5, "flame": {"image": "", "height": 10}},
    "noh": {"image": "/c.png", "flame": {"image": "/f.png", "cols": 0, "fps": -3, "height": 0}},
    "defaults": {"image": "/d.png", "flame": {"image": "/f.png", "cols": 4, "height": 12}},
}

_T_FLAME = FlameDef(image="/f.png", cols=12, frames=64, fps=24, height=30)


class FlameContractParityTests(unittest.TestCase):
    """契约黄金表逐行：firePoint / burn / flame / onEnterActions。"""

    def _row(self, pid: str, state: str = ""):
        r = resolve_prop_preview(FIRE_RAW[pid], state)
        return r.fire_point, r.burn, r.flame, r.on_enter_actions

    def test_t_without_state(self) -> None:
        self.assertEqual(self._row("t"), ((0.5, 0.05), 1, _T_FLAME, []))

    def test_t_lit(self) -> None:
        self.assertEqual(self._row("t", "lit"), ((0.5, 0.05), 1, _T_FLAME, []))

    def test_t_ember_overrides_fire_point_and_burn(self) -> None:
        self.assertEqual(self._row("t", "ember"), ((0.4, 0.1), 0.15, _T_FLAME, []))

    def test_t_out_burn_zero_and_on_enter_actions(self) -> None:
        fp, burn, flame, acts = self._row("t", "out")
        self.assertEqual((fp, burn, flame), ((0.5, 0.05), 0, _T_FLAME))
        self.assertEqual(acts, [{"type": "playSfx", "params": {"id": "x"}}])

    def test_bad_clamps_and_empty_image_voids_flame(self) -> None:
        self.assertEqual(self._row("bad"), ((1, 0), 1, None, []))

    def test_zero_height_voids_flame(self) -> None:
        self.assertEqual(self._row("noh"), (None, 1, None, []))

    def test_flame_defaults(self) -> None:
        fp, burn, flame, acts = self._row("defaults")
        self.assertEqual((fp, burn, acts), (None, 1, []))
        self.assertEqual(flame, FlameDef(image="/f.png", cols=4, frames=4, fps=24, height=12))

    def test_wind_shelter_golden(self) -> None:
        """挡风比例：状态 → 基础块 → 0；夹到 0..1；非数当没写（TS 同一组用例）。"""
        p = {"windShelter": 0.1, "states": {"guard": {"windShelter": 1.8}, "open": {},
                                            "junk": {"windShelter": "x"}}}
        q = {"image": "/q.png"}
        self.assertEqual(resolve_prop_preview(p, "guard").wind_shelter, 1)
        self.assertEqual(resolve_prop_preview(p, "open").wind_shelter, 0.1)
        self.assertEqual(resolve_prop_preview(p, "junk").wind_shelter, 0.1)
        self.assertEqual(resolve_prop_preview(q).wind_shelter, 0)
        # 契约黄金表里的 t：没写 windShelter ⇒ 各状态都是 0
        for st in ("", "lit", "ember", "out"):
            self.assertEqual(resolve_prop_preview(FIRE_RAW["t"], st).wind_shelter, 0)
        # 强转口径与 burn 一致：null → 0（不是"没写"），"0.5" → 0.5
        self.assertEqual(resolve_prop_preview({"windShelter": 0.7, "states": {"s": {"windShelter": None}}},
                                              "s").wind_shelter, 0)
        self.assertEqual(resolve_prop_preview({"windShelter": "0.5"}).wind_shelter, 0.5)

    def test_numbers_follow_js_number_coercion(self) -> None:
        """TS 的 `finiteOrUndefined` 是 `Number(v)`：null→0、true→1、"0.5"→0.5、[]→0；没写（undefined）→NaN。
        镜像只认数的话，`burn: null` 预览按满火画、游戏里却是灭的。"""
        base = {"image": "/a.png"}
        cases = (
            ({"burn": None}, "burn", 0.0),
            ({"burn": True}, "burn", 1.0),
            ({"burn": " 0.25 "}, "burn", 0.25),
            ({"burn": ""}, "burn", 0.0),
            ({"burn": []}, "burn", 0.0),
            ({"burn": [0.4]}, "burn", 0.4),
            ({"burn": "0x1"}, "burn", 1.0),
            ({"burn": "半"}, "burn", 1.0),          # NaN ⇒ 当没写 ⇒ 1
            ({"burn": [1, 2]}, "burn", 1.0),
            ({"burn": {"v": 0}}, "burn", 1.0),
            ({"firePoint": ["0.3", None]}, "fire_point", (0.3, 0.0)),
            ({"firePoint": [True, "1e-1"]}, "fire_point", (1.0, 0.1)),
            ({"firePoint": ["左", 0.1]}, "fire_point", None),
        )
        for patch, attr, want in cases:
            with self.subTest(patch=patch):
                got = getattr(resolve_prop_preview({**base, **patch}), attr)
                if isinstance(want, tuple):
                    self.assertEqual(len(got), 2)
                    for g, w in zip(got, want):
                        self.assertAlmostEqual(g, w)
                elif want is None:
                    self.assertIsNone(got)
                else:
                    self.assertAlmostEqual(got, want)
        f = resolve_prop_preview({**base, "flame": {"image": " /f.png ", "height": "12", "cols": "4.9",
                                                    "frames": None, "fps": "0"}}).flame
        self.assertEqual(f, FlameDef(image="/f.png", cols=4, frames=4, fps=24, height=12))

    def test_on_enter_actions_mirror_parse_action_list(self) -> None:
        """`parseActionList`：只留 type 是非空串的对象，params 不是对象换成 {}。"""
        r = resolve_prop_preview({"states": {"s": {"onEnterActions": [
            {"type": " playSfx ", "params": {"id": "x"}},
            {"type": "", "params": {}}, {"params": {}}, "坏", None,
            {"type": "stopBgm", "params": [1]}, {"type": "stopBgm"},
        ]}}}, "s")
        self.assertEqual(r.on_enter_actions, [
            {"type": "playSfx", "params": {"id": "x"}},
            {"type": "stopBgm", "params": {}},
            {"type": "stopBgm", "params": {}},
        ])

    def test_particle_mounts_golden(self) -> None:
        """契约 v3 粒子挂载黄金表（TS `propPresets.test.ts` 同一组）：坏条目丢掉、point 清洗同 firePoint、
        状态写了键整体替换（空数组 = 没有粒子）、没写键沿用基础块。"""
        m = {
            "image": "/m.png", "firePoint": [0.5, 0.1],
            "particles": [{"effect": "flame", "point": [0.5, 0.05]}, {"effect": "smoke"}, {"effect": ""},
                          "junk", {"effect": "sparks", "point": [3, -1]}],
            "states": {"out": {"particles": []}, "ember": {"particles": [{"effect": "coals"}]}, "lit": {}},
        }
        base = [ParticleMount("flame", (0.5, 0.05)), ParticleMount("smoke", None), ParticleMount("sparks", (1, 0))]
        self.assertEqual(resolve_prop_preview(m).particles, base)
        self.assertEqual(resolve_prop_preview(m, "lit").particles, base)
        self.assertEqual(resolve_prop_preview(m, "ember").particles, [ParticleMount("coals", None)])
        self.assertEqual(resolve_prop_preview(m, "out").particles, [])
        # 黄金表里的 t / bad / noh / defaults 都没写 particles ⇒ 空
        for pid in ("t", "bad", "noh", "defaults"):
            self.assertEqual(resolve_prop_preview(FIRE_RAW[pid]).particles, [])

    def test_particle_mount_edge_shapes(self) -> None:
        self.assertEqual(parse_particles("flame"), [])
        self.assertEqual(parse_particles([{"effect": "  fx  ", "point": ["0.2", None]},
                                          {"effect": 3}, {"point": [0, 0]}, None]),
                         [ParticleMount("fx", (0.2, 0.0))])
        self.assertEqual(parse_particles([{"effect": "fx", "point": [0.5]}]), [ParticleMount("fx", None)])
        # 旧 `vfx` 字段运行时不读：写了也不会变成粒子挂载
        self.assertEqual(resolve_prop_preview({"vfx": ["a"], "states": {"s": {"vfx": ["b"]}}}, "s").particles, [])

    def test_cell_size_follows_three_fires_sheet(self) -> None:
        """三把火图 588×612、cols 12、frames 64 → 格 49×102（契约原话）。"""
        self.assertEqual(_T_FLAME.cell_size(588, 612), (49.0, 102.0))
        self.assertEqual(_T_FLAME.cell_size(0, 612), (0.0, 0.0))

    def test_lantern_without_fire_fields_is_unchanged(self) -> None:
        """灯笼不写 firePoint / flame / burn ⇒ 与今天完全一样（从挂点本身出、满燃、没有火苗）。"""
        r = resolve_prop_preview({"image": "/l.png", "anchorX": 0.47, "anchorY": 0}, "")
        self.assertEqual((r.fire_point, r.burn, r.flame, r.on_enter_actions), (None, 1, None, []))
        self.assertEqual(fire_point_offset(
            r.fire_point, anchor_x=r.anchor_x, anchor_y=r.anchor_y, frame_w=64, frame_h=128,
            angle_deg=33, facing=-1, scale=0.45), (0.0, 0.0))


class FirePointLocalTests(unittest.TestCase):
    """起火点在容器局部坐标里的位置：黄金值由契约公式手算（不是拿被测函数跑出来的）。"""

    LANTERN = {"image": "/l.png", "anchorX": 0.47, "anchorY": 0.0, "rotation": -90, "scale": 0.45,
               "firePoint": [0.5, 1.0]}

    def _pose(self, **kw):
        return socket_pose_to_local(
            {"x": 0.7, "y": 0.55, "angle": 20}, world_width=150, world_height=150, **kw)

    def test_golden_facing_left_mirrors_with_host(self) -> None:
        p = fire_point_local(self._pose(facing=-1), resolve_prop_preview(self.LANTERN), 64, 128)
        self.assertAlmostEqual(p[0], -84.421800361, places=6)
        self.assertAlmostEqual(p[1], -48.611534169, places=6)

    def test_golden_mirror_with_host_false(self) -> None:
        p = fire_point_local(self._pose(facing=-1), resolve_prop_preview(self.LANTERN), 64, 128,
                             mirror_with_host=False)
        self.assertAlmostEqual(p[0], -83.830789553, places=6)
        self.assertAlmostEqual(p[1], -46.987745320, places=6)

    def test_golden_state_override_with_depth_scale(self) -> None:
        pose = socket_pose_to_local({"x": 0.6, "y": 0.4, "angle": 30},
                                    world_width=100, world_height=200, depth_scale=0.8, facing=1)
        p = fire_point_local(pose, resolve_prop_preview(FIRE_RAW["t"], "ember"), 40, 100)
        self.assertAlmostEqual(p[0], 37.228718708, places=6)
        self.assertAlmostEqual(p[1], -153.025625842, places=6)

    def test_matches_paint_prop_transform_order(self) -> None:
        """与 `paint_prop` 同一套变换：translate → rotate((标注角+自转)·facing) → scale(s·facing, s)。"""
        prev = resolve_prop_preview(self.LANTERN)
        for facing in (1, -1):
            sign = -1 if facing < 0 else 1
            t = QTransform()
            t.rotate((20 + prev.rotation) * sign)
            t.scale(prev.scale * sign, prev.scale)
            w, h = 64.0, 128.0
            want = t.map(QPointF((prev.fire_point[0] - prev.anchor_x) * w,
                                 (prev.fire_point[1] - prev.anchor_y) * h))
            got = fire_point_offset(
                prev.fire_point, anchor_x=prev.anchor_x, anchor_y=prev.anchor_y,
                frame_w=w, frame_h=h, angle_deg=(20 + prev.rotation) * sign,
                facing=facing, scale=prev.scale)
            with self.subTest(facing=facing):
                self.assertAlmostEqual(got[0], want.x(), places=9)
                self.assertAlmostEqual(got[1], want.y(), places=9)

    def test_inverse_round_trips(self) -> None:
        kw = dict(anchor_x=0.47, anchor_y=0.1, frame_w=64, frame_h=128, angle_deg=70, scale=0.45)
        for facing in (1, -1):
            dx, dy = fire_point_offset((0.31, 0.83), facing=facing, **kw)
            u, v = fire_point_from_offset(dx, dy, facing=facing, **kw)
            with self.subTest(facing=facing):
                self.assertAlmostEqual(u, 0.31, places=9)
                self.assertAlmostEqual(v, 0.83, places=9)
        self.assertIsNone(fire_point_from_offset(1, 1, facing=1, **{**kw, "scale": 0}))
        far = fire_point_from_offset(9999, 9999, facing=1, **kw)
        self.assertTrue(all(0.0 <= c <= 1.0 for c in far), "点到贴图外要夹回 0..1")


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
