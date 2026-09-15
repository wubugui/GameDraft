# -*- coding: utf-8 -*-
"""场景页的「地形 / 碰撞」块：**只读显示**（碰撞 / 可走区 / 行走面全在地形工作台里改，主编辑器只画）。

一个合成的小场景：4×3 的碰撞网格（中间一列阻挡）+ 平地的行走面 + 单位标定，红块必须落在画面**中间那一竖条**上，
且叠加图元不吃鼠标（点它下面的 NPC 照样选得中）。摘要要说得出网格与阻挡比例；作者层比资源新时要标"待导出"。
"""
from __future__ import annotations

import io
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PIL import Image  # noqa: E402
from PySide6.QtCore import QPointF, Qt  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.editors.scene_editor import SceneEditor, _TerrainOverlayItem  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import terrain_overlay  # noqa: E402
from tools.editor.tests.qt_teardown import quiesce_scene_editor  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

_SID = "地形显示测试"
W, H = 400, 200            # 原生像素 = 世界 wu（ppu 与 cx/cy 按半幅）


def _png(arr: np.ndarray, mode: str) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, mode).save(buf, format="PNG")
    return buf.getvalue()


def _scene() -> dict:
    # R = 单位阵：X = qx，Z = d；行走面深度 d 恒 = 0.5 ⇒ 每个画面点落在 Z=0.5 那一行格上，X 由画面横坐标决定
    return {
        "id": _SID, "name": _SID, "worldWidth": W, "worldHeight": H,
        "spawnPoint": {"x": 20, "y": 100},
        "npcs": [{"id": "n1", "name": "站在红块下的", "x": 200, "y": 100, "interactionRange": 30}],
        "hotspots": [], "zones": [],
        "backgrounds": [{"image": "background.png", "worldWidth": W, "worldHeight": H}],
        "depthConfig": {
            "depth_map": "raw_depth_rg.png", "collision_map": "collision.png",
            "M": {"R": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "ppu": 100.0, "cx": W / 2, "cy": H / 2},
            "depth_mapping": {}, "depth_tolerance": 0, "floor_offset": 0,
        },
    }


def _runtime(root: Path, *, sidecar: bool = True, terrain_newer: bool = False) -> Path:
    rt = root / "public" / "resources" / "runtime" / "scenes" / _SID
    (rt / "lighting" / "background").mkdir(parents=True)
    (rt / "background.png").write_bytes(_png(np.full((H, W, 3), 90, np.uint8), "RGB"))
    (rt / "raw_depth_rg.png").write_bytes(_png(np.zeros((H, W, 3), np.uint8), "RGB"))
    # 碰撞 4×3：格 0.. 覆盖 qx ∈ [-2, 2)（画面全宽 = 4 q）、Z ∈ [0, 3)；中间一列（gx=1,2 里的 gx=1）阻挡
    col = np.zeros((3, 4), np.uint8)
    col[:, 1] = 255
    (rt / "collision.png").write_bytes(_png(col, "L"))
    grid = {"x_min": -2.0, "z_min": 0.0, "cell_size": 1.0, "grid_width": 4, "grid_height": 3}
    if sidecar:
        (rt / "collision.json").write_text(json.dumps({"version": 1, "collision_map": "collision.png", **grid,
                                                        "composed": {"terrain_sha1": "old"}}), encoding="utf-8")
    # 行走面 d ≡ 0.5（RG16，min=0，max=1 ⇒ 32767/65535）
    g = np.zeros((72, 144, 3), np.uint8)
    g[..., 0] = 32767 >> 8
    g[..., 1] = 32767 & 0xFF
    (rt / "lighting" / "background" / "ground_d.png").write_bytes(_png(g, "RGB"))
    (rt / "lighting" / "background" / "lighting.json").write_text(json.dumps({
        "version": 2, "work": {"w": 144, "h": 72}, "cal": {"ppu": 36.0, "cx": 72.0, "cy": 36.0},
        "ground_d": {"min": 0.0, "max": 1.0}}), encoding="utf-8")
    if terrain_newer:
        (rt / "terrain").mkdir()
        (rt / "terrain" / "terrain.json").write_text(json.dumps({"version": 1, "grid": grid, "auto": None, "brush": None,
                                                                  "regions": [{"id": "r1", "kind": "block", "points": [[0, 0], [1, 0], [1, 1]]}],
                                                                  "height": None, "heightOps": [], "updated": "2026-09-14 12:00:00"}),
                                                      encoding="utf-8")
    return rt


class TerrainOverlayMathTests(unittest.TestCase):
    """纯数据面：与运行时同式的掩码。"""

    def test_红块落在中间那一竖条_且网格外不阻挡(self):
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            rt = _runtime(root)
            m = terrain_overlay.collision_mask(rt, _scene(), 128)
            self.assertIsNotNone(m)
            self.assertEqual(m.shape[1], 128)
            # 画面横坐标 u ∈ [0,1) → qx = (u·W − cx)/ppu ∈ [−2, 2)；阻挡格 gx=1 ⇔ qx ∈ [−1, 0) ⇔ u ∈ [0.25, 0.5)
            cols = m.any(axis=0)
            self.assertTrue(cols[int(128 * 0.30)] and cols[int(128 * 0.45)])
            self.assertFalse(cols[int(128 * 0.10)] or cols[int(128 * 0.60)] or cols[int(128 * 0.90)])
            self.assertTrue(m[:, int(128 * 0.30)].all(), "d 恒 0.5 ⇒ 整列都在同一行格上")
            s = terrain_overlay.terrain_summary(rt, _scene())
            self.assertEqual((s["grid"]["grid_width"], s["grid"]["grid_height"]), (4, 3))
            self.assertAlmostEqual(s["blockedPct"], 25.0)
            self.assertTrue(s["sidecar"] and s["sizeOk"])
            self.assertFalse(s["problems"])

    def test_没有产物就说缺什么_不抛(self):
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            rt = root / "public" / "resources" / "runtime" / "scenes" / _SID
            rt.mkdir(parents=True)
            self.assertIsNone(terrain_overlay.collision_mask(rt, _scene()))
            s = terrain_overlay.terrain_summary(rt, _scene())
            self.assertTrue(s["depth"] and s["grid"] is None)
            s2 = terrain_overlay.terrain_summary(rt, {"id": "x"})
            self.assertFalse(s2["depth"])
            self.assertTrue(any("depthConfig" in p for p in s2["problems"]))

    def test_作者层比资源新_标待导出(self):
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            rt = _runtime(root, terrain_newer=True)
            s = terrain_overlay.terrain_summary(rt, _scene())
            self.assertTrue(s["needsExport"])
            self.assertEqual(s["terrain"]["regions"], 1)


class TerrainOverlayEditorTests(unittest.TestCase):
    """真页面：块里的摘要、画布上的红块图元（纯显示、不吃鼠标）、开关。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _pump(self, n: int = 6) -> None:
        for _ in range(n):
            QApplication.processEvents()

    def test_块与红块(self):
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            (root / "public" / "assets" / "scenes" / f"{_SID}.json").write_text(
                json.dumps(_scene(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            _runtime(root, terrain_newer=True)
            model = ProjectModel()
            model.load_project(root)
            ed = SceneEditor(model)
            try:
                ed._refresh_scene_list()
                ed._load_scene(_SID)
                ed._undo.clear()
                ed.resize(1400, 900)
                ed.show()
                self._pump()
                ed._terrain_overlay_refresh_timer.timeout.emit()   # 合并到下一拍的那一下，直接敲
                self._pump()
                props = ed._props
                text = props._sc_terrain_summary.text()
                self.assertIn("4×3", text)
                self.assertIn("25.0%", text)
                self.assertIn("待导出", props._sc_terrain_fold._plain_title)
                it = ed._canvas.terrain_overlay_item()
                self.assertIsInstance(it, _TerrainOverlayItem)
                # 纯显示：不吃鼠标、空 shape、在实体把手之下
                self.assertEqual(it.acceptedMouseButtons(), Qt.MouseButton.NoButton)
                self.assertTrue(it.shape().isEmpty())
                self.assertTrue(it.zValue() < ed._canvas._entity_items["n1"].zValue() if "n1" in getattr(ed._canvas, "_entity_items", {}) else True)
                # 图元贴满世界矩形
                br = it.sceneBoundingRect()
                self.assertAlmostEqual(br.width(), W, delta=1.0)
                self.assertAlmostEqual(br.height(), H, delta=1.0)
                # 红块在中间那一竖条：读像素
                img = it.pixmap().toImage()
                px_on = img.pixelColor(int(img.width() * 0.30), int(img.height() * 0.5)).alpha()
                px_off = img.pixelColor(int(img.width() * 0.80), int(img.height() * 0.5)).alpha()
                self.assertGreater(px_on, 0)
                self.assertEqual(px_off, 0)
                # 关掉开关 = 撤掉图元；再开 = 回来
                props._sc_terrain_show.setChecked(False)
                ed._terrain_overlay_refresh_timer.timeout.emit()
                self._pump()
                self.assertIsNone(ed._canvas.terrain_overlay_item())
                props._sc_terrain_show.setChecked(True)
                ed._terrain_overlay_refresh_timer.timeout.emit()
                self._pump()
                self.assertIsNotNone(ed._canvas.terrain_overlay_item())
                self.assertFalse(model.is_dirty, "只读块不许把场景标脏")
                _ = QPointF(0, 0)
            finally:
                quiesce_scene_editor(ed)
                ed._vfx_area_overlay_refresh_timer.stop()
                ed._terrain_overlay_refresh_timer.stop()
                ed.deleteLater()
                self._pump()


if __name__ == "__main__":
    unittest.main()
