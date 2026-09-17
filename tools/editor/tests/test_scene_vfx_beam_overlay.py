"""场景页画布的光柱轮廓：**只读显示**（光柱在粒子工作台里摆、调，主编辑器只画起点与轮廓）。

- ``vfx_beam.beam3d_corners / beam2d_corners`` 与运行时 ``resolveBeam3dFrame / resolveBeam2dFrame`` 的 corners
  逐点一致（node 真跑 TS），平面近似空间与 ``createPlanarVfxSpace`` 同式——轮廓画的就是运行时那个凸包；
- 场景有深度时的 ``GeometryBeamSpace``：锚点解算回投到画面落回锚点本身（地面 / 壳两种）；
- 画布：带光柱的效果被布置了才画，起点 / 终点 / 轮廓与独立推算一致；图元不吃鼠标、压在轮廓下的 NPC 点得中；
  切时段外观跟着换；「刷新粒子数据」后轮廓按盘上新形状重画。
"""
from __future__ import annotations

import json
import math
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF, Qt

from tools.editor.editors.scene_editor import _EditableZonePolygon, _VfxBeamOutline
from tools.editor.shared import vfx_beam, vfx_placements
from tools.editor.tests.test_scene_vfx_overlay import _SID, _Base, _dump, _pump, _scene

REPO = Path(__file__).resolve().parents[3]
K = math.sqrt(2)

_SHAFT = {
    "id": "shaft", "emitters": [],
    "beams": [{
        "id": "window", "mode": "3d",
        "shape3d": {"from": [0, 300, 0], "to": [120, 0, 60], "section": {"kind": "rect", "width": 80, "height": 30}},
        "color": [1, 0.9, 0.7], "intensity": 1,
    }, {
        "id": "band", "mode": "2d", "shape2d": {"from": [0, 0], "to": [0, 200], "width": [40, 120]},
        "color": [1, 1, 1], "intensity": 0.5,
    }],
}
_ANCHOR = (600.0, 400.0)
#: 3D 光柱起点 / 终点的画面位置（平面近似：scene = (x, −z/k − y)），独立手算
_START = (600.0, 400.0 - 300.0)
_END = (720.0, 400.0 - 60.0 / K)
_MID = ((_START[0] + _END[0]) / 2, (_START[1] + _END[1]) / 2)


def _library(effect: str = "shaft") -> dict:
    lib = vfx_placements.empty_library()
    lib["scenes"][_SID] = {
        "base": [{"id": "天窗", "effect": effect, "anchor": {"x": _ANCHOR[0], "y": _ANCHOR[1]}}],
        "variants": {"夜": [{"id": "萤火", "effect": "fireflies", "anchor": {"x": 800, "y": 650, "h": 40}}]},
    }
    return lib


# --------------------------------------------------------------------------- #
# 几何：与运行时逐点一致
# --------------------------------------------------------------------------- #

def _shapes3d() -> list[dict]:
    out = [
        {"to": [120, 0, 60], "from": [0, 300, 0], "section": {"kind": "rect", "width": 80, "height": 30}},
        {"to": [0, -500, 0], "section": {"kind": "rect", "width": 40, "height": 90}, "spreadDeg": [20, 8], "rollDeg": 33},
        {"to": [-200, -100, 300], "from": [10, 20, 30], "section": {"kind": "rect", "width": 5, "height": 5}, "spreadDeg": [0, 60]},
    ]
    for sides in range(3, 9):
        out.append({"to": [90 * sides, -400, -30 * sides], "from": [0, 50, 0],
                    "section": {"kind": "polygon", "sides": sides, "radius": 25 + sides}, "spreadDeg": [15, 0],
                    "rollDeg": -12 * sides})
    return out


def _shapes2d() -> list[dict]:
    return [
        {"to": [0, 200], "width": [40, 120]},
        {"from": [-30, 10], "to": [180, -60], "width": [10, 0], "occludeByDepth": True},
    ]


def test_corners_match_runtime_resolvers() -> None:
    import pytest

    from tools.vfx_workbench.bundle import node_exe

    node = node_exe()
    if not node:
        pytest.skip("Node unavailable")
    anchors3 = [[0, 0, 0], [612.5, 40, -910.25]]
    anchors2 = [[0, 0], [1024.5, 377.25]]
    job = {"s3": _shapes3d(), "s2": _shapes2d(), "a3": anchors3, "a2": anchors2}
    script = r"""
const fs = require('node:fs'), ts = require('typescript');
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(fs.readFileSync(p, 'utf8'), {
 compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true }
}).outputText, p);
const { resolveBeam3dFrame, resolveBeam2dFrame } = require('./src/systems/vfx/vfxBeam.ts');
const { createPlanarVfxSpace } = require('./src/systems/vfx/vfxSpace.ts');
const job = JSON.parse(fs.readFileSync(0, 'utf8'));
const sp = createPlanarVfxSpace();
const out = { c3: [], c2: [], planar: [] };
for (const a of job.a3) for (const s of job.s3) { const f = resolveBeam3dFrame(s, a); out.c3.push(f ? Array.from(f.corners) : null); }
for (const a of job.a2) for (const s of job.s2) { const f = resolveBeam2dFrame(s, { x: a[0], y: a[1] }); out.c2.push(f ? Array.from(f.corners) : null); }
for (const a of [{ x: 10, y: 20 }, { x: 900, y: 333, h: 45 }]) {
  const w = sp.anchorToWorld(a); const s = { x: 0, y: 0 }; sp.toScene([w[0] + 7, w[1] - 3, w[2] + 11], s);
  out.planar.push([Array.from(w), [s.x, s.y]]);
}
process.stdout.write(JSON.stringify(out));
"""
    r = subprocess.run([node, "-e", script], cwd=REPO, input=json.dumps(job), capture_output=True, text=True,
                       encoding="utf8", timeout=60)
    assert r.returncode == 0, r.stderr
    rt = json.loads(r.stdout)

    def close(a: list[float], b: list[float]) -> bool:
        return len(a) == len(b) and all(abs(x - y) <= 1e-3 * max(1.0, abs(y)) for x, y in zip(a, b, strict=True))

    i = 0
    for a in anchors3:
        for s in _shapes3d():
            want = rt["c3"][i]
            got = vfx_beam.beam3d_corners(s, a)
            assert want is not None and got is not None
            assert close([v for p in got for v in p], want), (s, a)
            i += 1
    i = 0
    for a in anchors2:
        for s in _shapes2d():
            got = vfx_beam.beam2d_corners(s, a)
            assert got is not None and close([v for p in got for v in p], rt["c2"][i]), (s, a)
            i += 1
    sp = vfx_beam.PlanarBeamSpace()
    for anchor, (w_rt, s_rt) in zip([{"x": 10, "y": 20}, {"x": 900, "y": 333, "h": 45}], rt["planar"], strict=True):
        w = sp.anchor_world(anchor)
        assert close(list(w), w_rt)
        assert close(list(sp.world_to_scene((w[0] + 7, w[1] - 3, w[2] + 11))), s_rt)


def test_degenerate_and_invalid_beams_are_not_drawn() -> None:
    sp = vfx_beam.PlanarBeamSpace()
    bad = {"id": "bad", "emitters": [], "beams": [
        {"id": "short", "mode": "3d", "shape3d": {"to": [0, 0, 0], "section": {"kind": "rect", "width": 1, "height": 1}},
         "color": [1, 1, 1], "intensity": 1},
        {"id": "nine", "mode": "3d", "shape3d": {"to": [0, -9, 0], "section": {"kind": "polygon", "sides": 9, "radius": 1}},
         "color": [1, 1, 1], "intensity": 1},
    ]}
    rows = [{"id": "x", "effect": "bad", "anchor": {"x": 0, "y": 0}}, {"id": "y", "effect": "shaft"},
            {"id": "z", "effect": "missing", "anchor": {"x": 0, "y": 0}}]
    assert vfx_beam.beam_overlay_rows(rows, {"bad": bad, "shaft": _SHAFT}, sp) == []


def test_geometry_space_anchor_projects_back_to_anchor() -> None:
    import pytest

    try:
        from tools.trajectory_workbench.geometry import SceneGeometry
        g = SceneGeometry("义庄")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"没有烘过深度的真场景：{exc}")
    if not g.has_depth:
        pytest.skip("义庄没有深度")
    sp = vfx_beam.GeometryBeamSpace(g)
    w, h = g.world_w, g.world_h
    for fx, fy in ((0.3, 0.7), (0.5, 0.55), (0.72, 0.8)):
        x, y = w * fx, h * fy
        for surface in ("ground", "shell"):
            p = sp.anchor_world({"x": x, "y": y, "surface": surface})
            sx, sy = sp.world_to_scene(p)
            assert abs(sx - x) < 2.0 and abs(sy - y) < 2.0, (surface, (x, y), (sx, sy))
        # 地面锚点抬 h：画面上正上方 h（正交视图下竖直 1 wu 投成画面 cosθ 左右，只要求往上、不横移）
        lo = sp.world_to_scene(sp.anchor_world({"x": x, "y": y}))
        hi = sp.world_to_scene(sp.anchor_world({"x": x, "y": y, "h": 100}))
        assert hi[1] < lo[1] - 20 and abs(hi[0] - lo[0]) < 2.0


# --------------------------------------------------------------------------- #
# 画布
# --------------------------------------------------------------------------- #

class BeamOverlayCanvasTests(_Base):
    def _beam_project(self, td: str) -> Path:
        sc = _scene(_SID)
        sc["npcs"] = [{"id": "n1", "name": "路人", "x": round(_MID[0]), "y": round(_MID[1]), "interactionRange": 40}]
        root = self._project(td, {_SID: sc}, _library())
        (root / "public" / "assets" / "data" / "vfx").mkdir(parents=True, exist_ok=True)
        (root / "public" / "assets" / "data" / "vfx" / "shaft.json").write_bytes(_dump(_SHAFT))
        return root

    @staticmethod
    def _beams(ed) -> dict[str, _VfxBeamOutline]:
        return {it.beam_id: it for it in ed._canvas.vfx_overlay_items() if isinstance(it, _VfxBeamOutline)}

    def test_画出起点终点与运行时同一个凸包(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(self._beam_project(td))
            beams = self._beams(ed)
            self.assertEqual(set(beams), {"window", "band"})
            win = beams["window"]
            self.assertEqual(win.instance_id, "天窗")
            self.assertAlmostEqual(win.start_point()[0], _START[0], places=3)
            self.assertAlmostEqual(win.start_point()[1], _START[1], places=3)
            self.assertAlmostEqual(win.end_point()[0], _END[0], places=3)
            self.assertAlmostEqual(win.end_point()[1], _END[1], places=3)
            sp = vfx_beam.PlanarBeamSpace()
            corners = vfx_beam.beam3d_corners(_SHAFT["beams"][0]["shape3d"], sp.anchor_world({"x": _ANCHOR[0], "y": _ANCHOR[1]}))
            want = vfx_beam.convex_hull([sp.world_to_scene(c) for c in corners])
            self.assertEqual(win.outline_points(), [[round(x, 1), round(y, 1)] for x, y in want])
            self.assertGreaterEqual(len(want), 4)
            band = beams["band"]
            self.assertEqual(band.outline_points(), [[580.0, 400.0], [620.0, 400.0], [660.0, 600.0], [540.0, 600.0]])
            self.assertIn("2D", band.childItems()[0].text())
            self.assertIn("光柱 window · 天窗", win.childItems()[0].text())
            self.assertFalse(model.is_dirty)

    def test_不吃鼠标_压在轮廓下的NPC点得中(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(self._beam_project(td))
            beams = list(self._beams(ed).values())
            self.assertEqual(len(beams), 2)
            items = [*beams, *(c for it in beams for c in it.childItems())]
            for it in items:
                with self.subTest(item=type(it).__name__):
                    self.assertEqual(it.acceptedMouseButtons(), Qt.MouseButton.NoButton)
                    self.assertFalse(bool(it.flags() & it.GraphicsItemFlag.ItemIsSelectable))
                    self.assertFalse(bool(it.flags() & it.GraphicsItemFlag.ItemIsMovable))
                    self.assertFalse(it.acceptHoverEvents())
                    self.assertFalse(hasattr(it, "entity_kind"))
                    self.assertNotIsInstance(it, _EditableZonePolygon)
                    self.assertTrue(it.shape().isEmpty())
            scene_before = self._scene_text(model)
            self._drag(ed, _START, (_START[0] + 50, _START[1] + 40))
            self.assertEqual(ed._canvas._gfx.selectedItems(), [])
            self.assertEqual(self._scene_text(model), scene_before)
            self.assertFalse(model.is_dirty)
            self._click(ed, round(_MID[0]), round(_MID[1]))
            self.assertEqual(ed._canvas_selected_entity_refs(), [("npc", "n1")], "光柱轮廓下的 NPC 点不中了")
            self.assertEqual(self._scene_text(model), scene_before)

    def test_切时段外观跟着换_刷新后按盘上新形状重画(self) -> None:
        with TemporaryDirectory() as td:
            root = self._beam_project(td)
            ed, _model = self._editor(root)
            props = ed._props
            combo = props._sc_vfx_phase
            night = next(i for i in range(combo.count()) if combo.itemData(i) == "夜")
            combo.setCurrentIndex(night)
            _pump()
            self.assertEqual(self._beams(ed), {}, "夜那份没摆带光柱的效果，轮廓应当清掉")
            base = next(i for i in range(combo.count()) if combo.itemData(i) == "")
            combo.setCurrentIndex(base)
            _pump()
            self.assertEqual(set(self._beams(ed)), {"window", "band"})

            doc = json.loads(json.dumps(_SHAFT))
            doc["beams"][0]["shape3d"]["from"] = [0, 500, 0]
            del doc["beams"][1]
            (root / "public" / "assets" / "data" / "vfx" / "shaft.json").write_bytes(_dump(doc))
            self._click_button(props._sc_vfx_refresh)
            _pump()
            beams = self._beams(ed)
            self.assertEqual(set(beams), {"window"})
            self.assertAlmostEqual(beams["window"].start_point()[1], _ANCHOR[1] - 500, places=3)
            # 没深度的临时工程：走平面近似（不去装仓库里的真几何）
            self.assertIsInstance(props._vfx_beam_space, vfx_beam.PlanarBeamSpace)
            self.assertIsInstance(QPointF(*beams["window"].start_point()), QPointF)
