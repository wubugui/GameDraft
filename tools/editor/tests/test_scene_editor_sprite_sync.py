"""场景编辑器精灵-图元位置同步安全网（用户报告的"精灵闪烁/不跟随"bug）。

根因：8ms 动画定时器 _tick_scene_npc_anims 读"已提交模型"的 x/y，而拖拽/数值框
编辑写的是"staging 深拷贝"。两者每 8ms 互相打架，精灵被拍回旧位 → 闪烁、滞后图元。

修复要求：定时器（以及 draw 路径）对"正在编辑的那个 NPC"必须读与编辑同一处的
坐标（优先 staging），保证拖拽中精灵稳定跟随图元、不回弹。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from PySide6.QtWidgets import QGraphicsPixmapItem

from tools.editor.editors.scene_editor import SceneCanvas, SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import (
    repo_root_from_tests,
    write_minimal_loadable_project,
)


class _CapturingRuntime:
    """最小桩：记录 tick / draw_at 收到的坐标，替身真实动画 runtime。"""

    def __init__(self) -> None:
        self.last_xy: tuple[float, float] | None = None
        self.last_transform: tuple[float, float] | None = None
        self.last_playback: tuple[float, bool, int | None, int | None] | None = None

    def tick(self, dt: float, x: float, y: float) -> None:
        self.last_xy = (x, y)

    def draw_at(self, x: float, y: float) -> None:
        self.last_xy = (x, y)

    def set_instance_transform(self, scale: float, rot_deg: float) -> None:
        self.last_transform = (scale, rot_deg)

    def set_playback(
        self, speed: float, reverse: bool,
        hold: int | None, start: int | None,
    ) -> None:
        self.last_playback = (speed, reverse, hold, start)


def _scene(sid: str) -> dict:
    return {
        "id": sid, "name": sid, "hotspots": [], "zones": [], "spawnPoints": {},
        "npcs": [
            {"id": "npc1", "name": "甲", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "npc2", "name": "乙", "x": 200, "y": 200, "interactionRange": 50},
        ],
    }


class SceneEditorSpriteSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

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

    def _editor(self, root: Path) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene("sc_a")}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        return ed, model

    def _model_npc(self, model, nid):
        return next(n for n in model.scenes["sc_a"]["npcs"] if n["id"] == nid)

    def test_anim_tick_follows_staging_during_live_drag(self) -> None:
        """拖拽中（坐标只在 staging）：定时器必须把精灵画到 staging 新位，不读旧模型。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            # 实时拖拽：写 staging，不写模型
            ed._on_item_position_live("npc", "npc1", 333.0, 444.0)
            self.assertEqual((self._model_npc(model, "npc1")["x"],
                              self._model_npc(model, "npc1")["y"]),
                             (100, 100), "实时拖拽不应直接改模型（应走 staging）")

            cap = _CapturingRuntime()
            ed._scene_npc_runtimes = {"npc1": cap}
            ed._patrol_preview_ids = set()
            ed._scene_npc_anim_elapsed.start()
            ed._tick_scene_npc_anims()

            self.assertEqual(
                cap.last_xy, (333.0, 444.0),
                "动画定时器必须读拖拽写入的 staging 坐标，否则精灵每 8ms 被拍回旧位（闪烁）",
            )

    def test_spinbox_xy_moves_draggable_handle(self) -> None:
        """反向脱节：数值框改 x/y 必须同步移动可拖图元（不只移精灵/碰撞）。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._props._npc_x.setValue(350.0)
            ed._props._npc_y.setValue(360.0)
            handle = ed._canvas._entity_items.get("npc:npc1")
            self.assertIsNotNone(handle)
            self.assertEqual((handle.pos().x(), handle.pos().y()), (350.0, 360.0),
                             "改数值框后可拖图元必须跟随到新坐标")

    def test_anim_tick_other_npc_still_reads_model(self) -> None:
        """非编辑中的其它 NPC：仍读模型坐标（staging 只覆盖当前编辑实体）。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._on_item_position_live("npc", "npc1", 333.0, 444.0)

            cap2 = _CapturingRuntime()
            ed._scene_npc_runtimes = {"npc2": cap2}
            ed._patrol_preview_ids = set()
            ed._scene_npc_anim_elapsed.start()
            ed._tick_scene_npc_anims()

            self.assertEqual(cap2.last_xy, (200.0, 200.0),
                             "未编辑的 NPC 应读模型坐标，不受 staging 影响")


class HotspotDisplayImageFlickerTests(unittest.TestCase):
    """拖热区时 displayImage 贴图须原地平移，不再每帧 remove+重建+磁盘重载（perf-reload 闪烁）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)
        cls.repo = repo_root_from_tests()
        if not (cls.repo / "public" / "assets" / "data").is_dir():
            raise unittest.SkipTest("真实工程数据不存在，跳过 displayImage 原地刷新测试")

    def _find_hotspot_with_display(self, model):
        for sc in model.scenes.values():
            for hs in sc.get("hotspots", []):
                di = hs.get("displayImage")
                if isinstance(di, dict) and di.get("image") and di.get("worldWidth"):
                    return hs
        return None

    def test_drag_reuses_pixmap_item_in_place(self) -> None:
        model = ProjectModel()
        model.load_project(self.repo)
        hs = self._find_hotspot_with_display(model)
        if hs is None:
            self.skipTest("无带 displayImage 的热区样本")
        canvas = SceneCanvas()
        canvas.set_project_model(model)
        canvas.setup_world(2000, 1500)
        canvas.add_hotspot(hs)
        key = f"hotspot_display:{hs['id']}"
        it1 = canvas._entity_items.get(key)
        self.assertIsInstance(it1, QGraphicsPixmapItem, "样本图应能加载为 pixmap")
        moved = dict(hs)
        moved["x"] = float(hs.get("x", 0)) + 50
        moved["y"] = float(hs.get("y", 0)) + 30
        canvas.refresh_hotspot_visuals(moved)
        it2 = canvas._entity_items.get(key)
        self.assertIs(it1, it2, "拖拽中应复用同一 pixmap 图元（原地平移），不得每帧重建")

    def test_editing_display_size_rebuilds_item(self) -> None:
        """改 displayImage 尺寸/图片/朝向必须重建（不能因缓存复用而看不到改动）。"""
        import copy
        model = ProjectModel()
        model.load_project(self.repo)
        hs = self._find_hotspot_with_display(model)
        if hs is None:
            self.skipTest("无带 displayImage 的热区样本")
        canvas = SceneCanvas()
        canvas.set_project_model(model)
        canvas.setup_world(2000, 1500)
        canvas.add_hotspot(hs)
        key = f"hotspot_display:{hs['id']}"
        it1 = canvas._entity_items.get(key)
        edited = copy.deepcopy(hs)
        edited["displayImage"]["worldWidth"] = float(edited["displayImage"]["worldWidth"]) + 40
        canvas.refresh_hotspot_visuals(edited)
        it2 = canvas._entity_items.get(key)
        self.assertIsNot(it1, it2, "改 displayImage 尺寸后必须重建图元，否则改动不可见")


if __name__ == "__main__":
    unittest.main()
