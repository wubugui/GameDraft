# -*- coding: utf-8 -*-
"""看原画修碰撞（art_review）：画面多边形 ↔ 网格多边形、可走集以外自动封死、工作台改过之后还认得出来。

跑：``sh scripts/py.sh -m pytest tools/terrain_workbench/tests/test_art_review.py -q``

全用合成几何（常数行走面 + 一个真实量级的俯角旋转），不读真工程的场景。
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.character_lighting_lab import terrain_compose as tc   # noqa: E402
from tools.terrain_workbench import art_review as ar              # noqa: E402

_N = [0]


def _geom(ww: float = 2000.0, wh: float = 1125.0) -> ar.SceneGeom:
    """俯角 45° 看一张斜面：行走面深度沿画面纵向线性变，正向映射单射（和真场景同一种形状）。"""
    _N[0] += 1
    t = math.radians(45)
    R = np.array([[1, 0, 0], [0, math.cos(t), -math.sin(t)], [0, math.sin(t), math.cos(t)]], np.float64)
    gh, gw = 90, 160
    dep = np.tile(np.linspace(8.0, 3.0, gh)[:, None], (1, gw))
    return ar.SceneGeom(sid=f"__synthetic_{_N[0]}", scene={}, ww=ww, wh=wh, R=R, ppu=100.0,
                        cx=ww / 2, cy=wh / 2, dep=dep, bake_dir=Path(f"/nonexistent/{_N[0]}"), art_path=Path("x"))


def _grid_for(g: ar.SceneGeom, n: int = 160) -> tc.GridMeta:
    X, Z = g.scene_to_xz(*np.meshgrid(np.linspace(0, g.ww, 60), np.linspace(0, g.wh, 60)))
    x0, x1, z0, z1 = X.min(), X.max(), Z.min(), Z.max()
    cell = max(x1 - x0, z1 - z0) / n
    return tc.GridMeta(x_min=float(x0), z_min=float(z0), cell_size=float(cell),
                       grid_width=int(math.ceil((x1 - x0) / cell)) + 1, grid_height=int(math.ceil((z1 - z0) / cell)) + 1)


def _blocked_by(g: ar.SceneGeom, grid: tc.GridMeta, regions: list[dict]) -> np.ndarray:
    """与合成器同一条规则：walk = 并集 − 阻挡（自动层当全可走）。"""
    X, Z = grid.centers()
    walk = np.zeros(X.shape, bool)
    block = np.zeros(X.shape, bool)
    for r in regions:
        m = tc.points_in_polygon(X, Z, r["points"])
        if r["kind"] == "walk":
            walk |= m
        else:
            block |= m
    return ~((np.ones(X.shape, bool) | walk) & ~block)


def _screen_blocked(g, grid, regions, pts):
    b = _blocked_by(g, grid, regions)
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    return ar.blocked_at(g, b, grid, xs, ys)


class TestProjection(unittest.TestCase):
    def test_inverse_round_trip(self):
        g = _geom()
        pts = [(300.0, 200.0), (1500.0, 260.0), (1700.0, 900.0), (250.0, 1000.0)]
        grid_pts = ar._to_grid(g, pts)
        back = np.array(ar._Inverse.of(g)(grid_pts))
        dense = np.array(ar._densify(pts, ar.DENSIFY_STEP))
        err = np.hypot(*(back - dense).T)
        self.assertLess(float(err.max()), 4.0)          # 反查误差 ≈ 采样步长

    def test_fingerprint_detects_workbench_edit(self):
        g = _geom()
        reg = ar._make_region(g, "r", "walk", [(100.0, 100.0), (900.0, 120.0), (800.0, 700.0)], "")
        self.assertEqual(ar.region_screen_pts(g, reg), [(100.0, 100.0), (900.0, 120.0), (800.0, 700.0)])
        # 人在工作台里拖了一个顶点：screen 那一圈过期了 → 按网格多边形反投回画面
        reg["points"][0] = [reg["points"][0][0] + 5.0, reg["points"][0][1]]
        pts = ar.region_screen_pts(g, reg)
        self.assertEqual(len(pts), len(reg["points"]))
        # 没有 screen 的（工作台里新画的）同样反投
        pts2 = ar.region_screen_pts(g, {"id": "w", "kind": "block", "points": reg["points"]})
        self.assertEqual(len(pts2), len(reg["points"]))


class TestOutside(unittest.TestCase):
    def test_single_walk_band(self):
        g = _geom()
        grid = _grid_for(g)
        band = [(0.0, 500.0), (2000.0, 400.0), (2000.0, 700.0), (0.0, 800.0)]
        regs = ar._with_outside(g, [ar._make_region(g, "路", "walk", band, "")])
        ids = [r["id"] for r in regs]
        self.assertIn(ar.OUTSIDE_ID, ids)
        inside = [(1000.0, 600.0), (200.0, 650.0), (1800.0, 550.0)]
        outside = [(1000.0, 100.0), (1000.0, 1050.0), (50.0, 50.0), (1950.0, 1100.0)]
        self.assertFalse(_screen_blocked(g, grid, regs, inside).any())
        self.assertTrue(_screen_blocked(g, grid, regs, outside).all())

    def test_two_disjoint_walks_both_open(self):
        g = _geom()
        grid = _grid_for(g)
        a = [(100.0, 100.0), (600.0, 100.0), (600.0, 500.0), (100.0, 500.0)]
        b = [(1200.0, 600.0), (1800.0, 600.0), (1800.0, 1000.0), (1200.0, 1000.0)]
        regs = ar._with_outside(g, [ar._make_region(g, "a", "walk", a, ""), ar._make_region(g, "b", "walk", b, "")])
        self.assertFalse(_screen_blocked(g, grid, regs, [(350.0, 300.0), (1500.0, 800.0)]).any())
        self.assertTrue(_screen_blocked(g, grid, regs, [(900.0, 550.0), (1500.0, 300.0), (350.0, 900.0)]).all())

    def test_ring_leaves_island_blocked(self):
        """四面是路的一个街区：被可走集围住的空洞另成一块简单多边形（人在工作台里也拖得动）。"""
        g = _geom()
        grid = _grid_for(g)
        outer = [(300.0, 200.0), (1700.0, 200.0), (1700.0, 950.0), (300.0, 950.0)]
        # 用四条路拼出一个环
        roads = [
            [(300.0, 200.0), (1700.0, 200.0), (1700.0, 350.0), (300.0, 350.0)],
            [(300.0, 800.0), (1700.0, 800.0), (1700.0, 950.0), (300.0, 950.0)],
            [(300.0, 200.0), (500.0, 200.0), (500.0, 950.0), (300.0, 950.0)],
            [(1500.0, 200.0), (1700.0, 200.0), (1700.0, 950.0), (1500.0, 950.0)],
        ]
        regs = ar._with_outside(g, [ar._make_region(g, f"r{i}", "walk", p, "") for i, p in enumerate(roads)])
        self.assertTrue(any(r["id"].startswith(ar.OUTSIDE_ID + "_岛") for r in regs))
        self.assertTrue(_screen_blocked(g, grid, regs, [(1000.0, 575.0)]).all())          # 街区中间
        self.assertFalse(_screen_blocked(g, grid, regs, [(1000.0, 275.0), (400.0, 575.0)]).any())
        self.assertTrue(_screen_blocked(g, grid, regs, [(100.0, 100.0), (1900.0, 1050.0)]).all())
        del outer

    def test_block_inside_walk_wins(self):
        g = _geom()
        grid = _grid_for(g)
        regs = ar._with_outside(g, [
            ar._make_region(g, "地", "walk", [(0.0, 0.0), (2000.0, 0.0), (2000.0, 1125.0), (0.0, 1125.0)], ""),
            ar._make_region(g, "屋", "block", [(800.0, 400.0), (1200.0, 400.0), (1200.0, 700.0), (800.0, 700.0)], ""),
        ])
        self.assertTrue(_screen_blocked(g, grid, regs, [(1000.0, 550.0)]).all())
        self.assertFalse(_screen_blocked(g, grid, regs, [(400.0, 550.0), (1600.0, 900.0)]).any())

    def test_regenerated_not_accumulated(self):
        g = _geom()
        walk = ar._make_region(g, "路", "walk", [(0.0, 500.0), (2000.0, 400.0), (2000.0, 700.0), (0.0, 800.0)], "")
        once = ar._with_outside(g, [walk])
        twice = ar._with_outside(g, once)
        self.assertEqual([r["id"] for r in once], [r["id"] for r in twice])
        self.assertEqual(sum(1 for r in twice if r["id"] == ar.OUTSIDE_ID), 1)
        self.assertEqual(tc.terrain_problems({"version": tc.TERRAIN_VERSION, "regions": twice, "heightOps": []}), [])

    def test_generated_recognized_without_flag(self):
        """人在工作台里存过一遍、screen 键丢了也认得出生成块（按 id）。"""
        self.assertTrue(ar._is_generated({"id": ar.OUTSIDE_ID}))
        self.assertTrue(ar._is_generated({"id": ar.OUTSIDE_ID + "_岛3"}))
        self.assertFalse(ar._is_generated({"id": "屋_茶馆"}))


class TestCheckFindings(unittest.TestCase):
    """check 新增的几项：孤岛、触发区走不到、实体自带碰撞一起挡、跳完切场景的落点不查。"""

    def _setup(self, scene: dict, walks: list, blocks: list = ()):
        g = _geom()
        g.scene = scene
        grid = _grid_for(g)
        regs = [ar._make_region(g, f"w{i}", "walk", p, "") for i, p in enumerate(walks)]
        regs += [ar._make_region(g, f"b{i}", "block", p, "") for i, p in enumerate(blocks)]
        regs = ar._with_outside(g, regs)
        return g, grid, _blocked_by(g, grid, regs)

    def test_island_and_unreachable_zone(self):
        scene = {"spawnPoint": {"x": 300, "y": 300},
                 "zones": [{"id": "z_好", "polygon": [{"x": 350, "y": 250}, {"x": 450, "y": 250}, {"x": 450, "y": 350}, {"x": 350, "y": 350}]},
                           {"id": "z_岛上", "polygon": [{"x": 1450, "y": 750}, {"x": 1550, "y": 750}, {"x": 1550, "y": 850}, {"x": 1450, "y": 850}]}]}
        a = [(100.0, 100.0), (700.0, 100.0), (700.0, 500.0), (100.0, 500.0)]
        b = [(1200.0, 600.0), (1800.0, 600.0), (1800.0, 1000.0), (1200.0, 1000.0)]
        g, grid, blocked = self._setup(scene, [a, b])
        lab, _w, keep, sx = ar.walk_components(g, blocked, grid, 5.0)
        islands = ar._islands(g, lab, keep, sx)
        self.assertEqual(len(islands), 1)
        self.assertIn("孤岛 (12", islands[0])
        zones = ar._zones_unreachable(g, keep[lab], sx)
        self.assertEqual(len(zones), 1)
        self.assertIn("z_岛上", zones[0])

    def test_in_scene_landing_seeds_reach(self):
        """场内跳跃的落点也是"进得去"的地方：跳过去的那块地不算孤岛。"""
        scene = {"spawnPoint": {"x": 300, "y": 300},
                 "hotspots": [{"id": "跳", "type": "act_spot", "x": 650, "y": 300,
                               "data": {"verbs": ["jump"], "align": {"x": 650, "y": 300}, "landing": {"x": 1500, "y": 800}}}]}
        a = [(100.0, 100.0), (700.0, 100.0), (700.0, 500.0), (100.0, 500.0)]
        b = [(1200.0, 600.0), (1800.0, 600.0), (1800.0, 1000.0), (1200.0, 1000.0)]
        g, grid, blocked = self._setup(scene, [a, b])
        lab, _w, keep, sx = ar.walk_components(g, blocked, grid, 5.0)
        self.assertEqual(ar._islands(g, lab, keep, sx), [])

    def test_scene_leaving_landing_not_a_standing_point(self):
        hs = {"id": "跳走", "type": "act_spot", "x": 10, "y": 10,
              "data": {"landing": {"x": 5, "y": 5}, "actions": [{"type": "switchScene", "params": {"targetScene": "x"}}]}}
        g = _geom()
        g.scene = {"hotspots": [hs]}
        kinds = {m[1]: m[0] for m in ar._marks(g)}
        self.assertEqual(kinds["跳走.landing"], "landing_x")
        hs["data"]["actions"] = []
        kinds = {m[1]: m[0] for m in ar._marks(g)}
        self.assertEqual(kinds["跳走.landing"], "landing")

    def test_entity_collision_polygon_blocks_reach(self):
        """热点自带碰撞（局部坐标）把一条窄路截断：路那头的交互物就够不着了。"""
        scene = {"spawnPoint": {"x": 200, "y": 560},
                 "hotspots": [{"id": "hs_挡路", "x": 1000, "y": 560, "collisionPolygonLocal": True,
                               "collisionPolygon": [{"x": -40, "y": -200}, {"x": 40, "y": -200}, {"x": 40, "y": 200}, {"x": -40, "y": 200}]}]}
        road = [(100.0, 500.0), (1900.0, 500.0), (1900.0, 620.0), (100.0, 620.0)]
        g, grid, blocked = self._setup(scene, [road])
        lab, _w, keep, sx = ar.walk_components(g, blocked, grid, 5.0)
        reach = keep[lab]
        i = int(560 * sx)
        self.assertTrue(reach[i, int(300 * sx)])
        self.assertFalse(reach[i, int(1600 * sx)])


class TestConnected(unittest.TestCase):
    def test_seal_door_detects_wall_leak(self):
        """院子:四面薄墙留一个门。堵上门还连通 = 墙漏缝;不连通 = 墙是好的。"""
        g = _geom()
        g.scene = {}
        grid = _grid_for(g)
        walls = [[(700.0, 300.0), (1300.0, 300.0), (1300.0, 330.0), (700.0, 330.0)],     # 北
                 [(700.0, 800.0), (950.0, 800.0), (950.0, 830.0), (700.0, 830.0)],        # 南左
                 [(1050.0, 800.0), (1300.0, 800.0), (1300.0, 830.0), (1050.0, 830.0)],    # 南右(中间 100 宽是门)
                 [(700.0, 300.0), (730.0, 300.0), (730.0, 830.0), (700.0, 830.0)],        # 西
                 [(1270.0, 300.0), (1300.0, 300.0), (1300.0, 830.0), (1270.0, 830.0)]]    # 东
        regs = [ar._make_region(g, "地", "walk", [(0.0, 0.0), (2000.0, 0.0), (2000.0, 1125.0), (0.0, 1125.0)], "")]
        regs += [ar._make_region(g, f"墙{i}", "block", w, "") for i, w in enumerate(walls)]
        blocked = _blocked_by(g, grid, ar._with_outside(g, regs))
        inside, outside = (1000.0, 550.0), (1000.0, 1000.0)
        self.assertTrue(ar.connected(g, blocked, grid, inside, outside))
        self.assertFalse(ar.connected(g, blocked, grid, inside, outside, [(940.0, 790.0, 1060.0, 840.0)]))
        # 点落在薄墙上:就近落到墙边的地(门的标记点常摆在门脸墙上)
        self.assertIsNotNone(ar.connected(g, blocked, grid, (1000.0, 315.0), outside))
        # 点落在大块阻挡深处(周围 SNAP 以内都不可走):回 None
        regs2 = regs + [ar._make_region(g, "大屋", "block", [(1400.0, 100.0), (1900.0, 100.0), (1900.0, 600.0), (1400.0, 600.0)], "")]
        blocked2 = _blocked_by(g, grid, ar._with_outside(g, regs2))
        self.assertIsNone(ar.connected(g, blocked2, grid, (1650.0, 350.0), outside))

    def test_flat_blocks_not_listed_as_missing_h(self):
        g = _geom()
        reg = ar._make_region(g, "死角", "block", [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], "", flat=True)
        self.assertTrue(reg["screen"]["flat"])
        tall = ar._make_region(g, "屋", "block", [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], "", h=100, flat=True)
        self.assertNotIn("flat", tall["screen"])          # 写了 h 就不是平块


class TestAuditWalkableLanding(unittest.TestCase):
    def test_switch_scene_jump_landing_exempt(self):
        """validate-data 的连通闸门与本工具同口径：跳完切场景的落点落阻挡不报，场内跳跃的照报。"""
        import json as _json
        import tempfile
        from unittest import mock
        from tools.character_lighting_lab import audit_walkable as aw

        # 左半边能走，右半边是墙；落点都在墙里
        geom = aw._Geom(lambda wx, wy: wx > 500, lambda wx, wy: (min(wx, 499.0), wy, 0.0), 1000.0, 600.0)

        def spot(actions):
            return {"id": "跳", "type": "act_spot", "x": 400, "y": 300,
                    "data": {"align": {"x": 400, "y": 300}, "landing": {"x": 800, "y": 300}, "actions": actions}}

        def issues(actions):
            scene = {"worldWidth": 1000, "worldHeight": 600, "depthConfig": {"M": {}},
                     "spawnPoint": {"x": 100, "y": 300}, "hotspots": [spot(actions)]}
            with tempfile.TemporaryDirectory() as d:
                pth = Path(d) / "s.json"
                pth.write_text(_json.dumps(scene), encoding="utf-8")
                with mock.patch.object(aw, "_scene_geometry", return_value=geom):
                    return [m for m in aw.reach_issues(pth) if "落点" in m]

        self.assertEqual(issues([{"type": "switchScene", "params": {"targetScene": "x"}}]), [])
        self.assertEqual(len(issues([])), 1)


class TestObjectVolumes(unittest.TestCase):
    """block 带物体高 h：占地往上扫 h 就是它在画面上挡人的轮廓（不读深度）。"""

    def test_silhouette_is_footprint_swept_up_by_h(self):
        from unittest import mock
        g = _geom()
        foot = [(800.0, 600.0), (1000.0, 600.0), (1000.0, 700.0), (800.0, 700.0)]
        reg = ar._make_region(g, "屋", "block", foot, "", h=150)
        self.assertEqual(reg["screen"]["h"], 150.0)
        walk = ar._make_region(g, "地", "walk", foot, "", h=150)
        self.assertNotIn("h", walk["screen"])                 # walk 不带物体高
        with mock.patch.object(tc, "load_terrain", return_value={"regions": [reg]}):
            vols = ar.object_volumes(g, 0.5, (1000, 563))
        self.assertEqual(len(vols), 1)
        _id, fp, sil, (x0, y0, x1, y1) = vols[0]

        def at(m, x, y):
            i, j = int(y * 0.5) - y0, int(x * 0.5) - x0
            return 0 <= i < m.shape[0] and 0 <= j < m.shape[1] and bool(m[i, j])

        self.assertTrue(at(fp, 900, 650))                      # 占地里
        self.assertFalse(at(fp, 900, 550))                     # 占地后沿之上：不是占地……
        self.assertTrue(at(sil, 900, 550))                     # ……但被它挡着（后面的地）
        self.assertTrue(at(sil, 900, 470))                     # 顶面（占地往上 h）以内
        self.assertFalse(at(sil, 900, 430))                    # 高过顶面：不挡

    def test_covered_walkway_hides_only_above_h0(self):
        """门楼底下的路:walk 带 h0 + h——能走,站在里面的人脚边不挡、头顶被门楣挡。"""
        from unittest import mock
        g = _geom()
        foot = [(800.0, 600.0), (1000.0, 600.0), (1000.0, 700.0), (800.0, 700.0)]
        reg = ar._make_region(g, "门洞", "walk", foot, "", h=200, h0=120)
        self.assertEqual((reg["screen"]["h"], reg["screen"]["h0"]), (200.0, 120.0))
        plain = ar._make_region(g, "路", "walk", foot, "", h=200)        # 没 h0 的 walk 不是有顶通道,不记 h
        self.assertNotIn("h", plain["screen"])
        with mock.patch.object(tc, "load_terrain", return_value={"regions": [reg]}):
            (_id, _fp, sil, (x0, y0, x1, y1)), = ar.object_volumes(g, 0.5, (1000, 563))

        def at(x, y):
            i, j = int(y * 0.5) - y0, int(x * 0.5) - x0
            return 0 <= i < sil.shape[0] and 0 <= j < sil.shape[1] and bool(sil[i, j])

        # 站在门洞里 (900,650) 的人:膝盖一带 y≈640 不挡,头 y≈560 被门楣挡
        self.assertFalse(at(900, 640))
        self.assertTrue(at(900, 560))
        self.assertFalse(at(900, 380))        # 高过门楼

    def test_footprint_below_picture_still_occludes(self):
        """前景墙的占地整个在画底以外,往上扫 h 仍会盖进画面。"""
        from unittest import mock
        g = _geom()
        foot = [(800.0, 1140.0), (1000.0, 1140.0), (1000.0, 1160.0), (800.0, 1160.0)]   # 画底 1125 以外
        reg = ar._make_region(g, "前墙", "block", foot, "", h=80)
        with mock.patch.object(tc, "load_terrain", return_value={"regions": [reg]}):
            vols = ar.object_volumes(g, 0.5, (1000, 563))
        self.assertEqual(len(vols), 1)
        _id, _fp, sil, (x0, y0, x1, y1) = vols[0]
        self.assertTrue(sil[int(1100 * 0.5) - y0, int(900 * 0.5) - x0])

    def test_block_without_h_does_not_occlude(self):
        from unittest import mock
        g = _geom()
        reg = ar._make_region(g, "扁", "block", [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], "")
        with mock.patch.object(tc, "load_terrain", return_value={"regions": [reg]}):
            self.assertEqual(ar.object_volumes(g, 1.0, (2000, 1125)), [])

    def test_draft_parses_h(self):
        import json as _json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            pth = Path(d) / "d.json"
            pth.write_text(_json.dumps({"桌": {"kind": "block", "pts": "0,0 10,0 10,10", "h": 45},
                                        "路": {"kind": "walk", "pts": "0,0 10,0 10,10"}}), encoding="utf-8")
            dd = ar._load_draft(str(pth))
        self.assertEqual(dd["桌"]["h"], 45.0)
        self.assertIsNone(dd["路"]["h"])


class TestFootprintFromOutline(unittest.TestCase):
    def test_box_outline_to_footprint(self):
        """立方体的画面轮廓 = 占地往上扫 h;反推:占地 = 轮廓 ∩ (轮廓下移 h),后面那片 = 轮廓 − 占地。"""
        # 占地 100×40(y 160..200),h=60 → 轮廓 y 100..200
        outline = [(0.0, 100.0), (100.0, 100.0), (100.0, 200.0), (0.0, 200.0)]
        fp, behind = ar.footprint_from_outline(outline, 60)
        ys = [p[1] for p in fp]
        self.assertAlmostEqual(min(ys), 160, delta=2)
        self.assertAlmostEqual(max(ys), 200, delta=2)
        by = [p[1] for p in behind]
        self.assertAlmostEqual(min(by), 100, delta=2)
        self.assertAlmostEqual(max(by), 160, delta=2)

    def test_h_taller_than_outline_gives_nothing(self):
        fp, _ = ar.footprint_from_outline([(0.0, 0.0), (50.0, 0.0), (50.0, 30.0), (0.0, 30.0)], 80)
        self.assertEqual(fp, [])


class TestMove(unittest.TestCase):
    def _run(self, scene: dict, what: str, xy: str, raw_override: str | None = None) -> dict:
        import json as _json
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            pth = Path(d) / "s.json"
            raw = raw_override if raw_override is not None else _json.dumps(scene, indent=2, ensure_ascii=False) + "\n"
            pth.write_text(raw, encoding="utf-8", newline="\n")
            with mock.patch.object(tc, "SCENES_JSON", Path(d)):
                ar.cmd_move("s", what, xy)
            return _json.loads(pth.read_text(encoding="utf-8"))

    def test_move_npc_hotspot_spawn_zone(self):
        scene = {"spawnPoint": {"x": 1, "y": 2}, "spawnPoints": {"a": {"x": 3, "y": 4}},
                 "npcs": [{"id": "n", "x": 10, "y": 10, "extra": "留着"}],
                 "hotspots": [{"id": "h", "x": 5, "y": 5, "data": {"align": {"x": 6, "y": 6}}}],
                 "zones": [{"id": "z", "polygon": [{"x": 0, "y": 0}, {"x": 20, "y": 0}, {"x": 20, "y": 10}, {"x": 0, "y": 10}]}]}
        out = self._run(scene, "npc:n", "100,200")
        self.assertEqual((out["npcs"][0]["x"], out["npcs"][0]["y"], out["npcs"][0]["extra"]), (100.0, 200.0, "留着"))
        self.assertEqual(self._run(scene, "spawn:spawnPoint", "7,8")["spawnPoint"], {"x": 7.0, "y": 8.0})
        self.assertEqual(self._run(scene, "spawn:a", "9,9")["spawnPoints"]["a"], {"x": 9.0, "y": 9.0})
        self.assertEqual(self._run(scene, "align:h", "1,1")["hotspots"][0]["data"]["align"], {"x": 1.0, "y": 1.0})
        z = self._run(scene, "zone:z", "110,105")["zones"][0]["polygon"]
        self.assertEqual([(q["x"], q["y"]) for q in z], [(100, 100), (120, 100), (120, 110), (100, 110)])

    def test_refuses_non_canonical_file(self):
        """文件不是标准格式时拒写：往返会改动无关字节。"""
        with self.assertRaises(SystemExit):
            self._run({}, "npc:n", "1,1", raw_override='{"npcs": [{"id": "n", "x": 1, "y": 1}]}')


class TestResolution(unittest.TestCase):
    def test_thin_diagonal_wall_is_thin(self):
        """斜着的一道细墙：外接框很大，真实厚度只有一两格。"""
        grid = tc.GridMeta(x_min=0.0, z_min=0.0, cell_size=1.0, grid_width=100, grid_height=100)
        wall = [[0.0, 0.0], [50.0, 50.0], [51.5, 48.5], [1.5, -1.5]]
        self.assertLess(ar.cells_thick(grid, wall), 2.5)
        block = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]]
        self.assertAlmostEqual(ar.cells_thick(grid, block), 20.0, places=3)

    def test_ratio_floor_by_size(self):
        self.assertIsNone(ar.ratio_floor(3.0))
        self.assertEqual(ar.ratio_floor(7.0), 0.8)
        self.assertEqual(ar.ratio_floor(20.0), 0.9)

    def test_cells_across_scales_with_size(self):
        g = _geom()
        grid = _grid_for(g)
        small = ar.cells_across(g, grid, [(1000.0, 500.0), (1030.0, 500.0), (1030.0, 530.0), (1000.0, 530.0)])
        big = ar.cells_across(g, grid, [(800.0, 300.0), (1300.0, 300.0), (1300.0, 800.0), (800.0, 800.0)])
        self.assertLess(small, ar.MIN_CELLS_FOR_RATIO)
        self.assertGreater(big, 10 * small)


if __name__ == "__main__":
    unittest.main()
