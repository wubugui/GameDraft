# -*- coding: utf-8 -*-
"""场景前景图层 ``foregroundLayers``(见 agent_docs [[scene-foreground-layers]])的编辑器侧护栏。

本期没有作者面板(画蒙版 / 拖排序线是第二期),数据由人或 agent 直接写进场景 JSON。
所以编辑器这边最要紧的一条是**别丢**:打开 → 不动 → Apply,这个键原样回来(最小形态 / 填满形态两条都零漂移);
本来没有这个键的场景,浏览一趟也不许被塞一个空数组进去。

校验器规则(``check_scene_foreground_layers``,含接地 ``base``:接地点 / 接地折线)的判据:运行时对坏形状 / 解析不了的层一律**跳过该层**、
树照样画在人后面、没有任何红字——所以形状错记 error,"拆层没烘 / 点不在任何一株上"记 warning;
线上 跑马梁 那一层必须零问题。
"""
from __future__ import annotations

import copy
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor.editors.scene_editor import SceneEditor  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402
from tools.editor.validator import FOREGROUND_SWAY_SNAP_PX, check_scene_foreground_layers  # noqa: E402

_MINIMAL = [{"id": "fg_a", "source": {"kind": "swayPlant", "at": [1238, 564]}}]
_FULL = [
    {"id": "fg_a", "label": "崖边歪脖子树", "source": {"kind": "swayPlant", "at": [1238, 564]},
     "base": {"y": 577, "x": 1227.2}, "unknownLayerField": {"keep": True}},
    {"id": "fg_b", "label": "栏杆", "source": {"kind": "swayPlant", "at": [10.5, 20]},
     "base": {"line": [[800, 500], [1200, 700]]}},
]


def _scene(layers: list | None) -> dict:
    sc: dict = {
        "id": "sc_a", "name": "场景甲", "hotspots": [], "npcs": [], "zones": [], "spawnPoints": {},
        "unknownSceneField": {"keep": True},
    }
    if layers is not None:
        sc["foregroundLayers"] = copy.deepcopy(layers)
    return sc


class SceneForegroundLayersRoundTripTests(unittest.TestCase):
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

    def _open(self, root: Path, layers: list | None) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene(layers)}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        ed._undo.clear()
        return ed, model

    def test_minimal_form_round_trips(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._open(Path(td) / "p", _MINIMAL)
            before = copy.deepcopy(model.scenes["sc_a"])
            ed._apply_props()
            self.assertEqual(model.scenes["sc_a"], before, "打开-不动-Apply 必须原样回来")
            self.assertEqual(json.dumps(model.scenes["sc_a"]["foregroundLayers"], ensure_ascii=False),
                             json.dumps(_MINIMAL, ensure_ascii=False), "键序 / 数值表示也不许漂(int 不变 float)")

    def test_full_form_round_trips(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._open(Path(td) / "p", _FULL)
            before = copy.deepcopy(model.scenes["sc_a"])
            ed._apply_props()
            self.assertEqual(model.scenes["sc_a"], before)
            self.assertEqual(json.dumps(model.scenes["sc_a"]["foregroundLayers"], ensure_ascii=False),
                             json.dumps(_FULL, ensure_ascii=False))

    def test_absence_stays_absent(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._open(Path(td) / "p", None)
            ed._apply_props()
            self.assertNotIn("foregroundLayers", model.scenes["sc_a"])

    def test_save_all_writes_the_key_back(self) -> None:
        """统一保存出口整份写场景 dict:前景层随场景落盘,字节与规范化格式一致。"""
        with TemporaryDirectory() as td:
            ed, model = self._open(Path(td) / "p", _FULL)
            ed._apply_props()
            model.mark_dirty("scene", "sc_a")
            model.save_all()
            on_disk = json.loads((model.scenes_path / "sc_a.json").read_text(encoding="utf-8"))
            self.assertEqual(on_disk["foregroundLayers"], _FULL)


def _write_ids_png(path: Path, w: int, h: int, boxes: list[tuple[int, int, int, int, int]]) -> None:
    from PIL import Image
    im = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    px = im.load()
    for x0, y0, x1, y1, oid in boxes:
        for y in range(y0, y1):
            for x in range(x0, x1):
                px[x, y] = (oid & 255, oid >> 8, 1, 255)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


class ForegroundLayerValidatorTests(unittest.TestCase):
    def _scene(self, layers: object, **extra) -> dict:
        sc = {"id": "s", "backgrounds": [{"image": "bg.png"}], "wind": {"direction": [-1, 0, 0], "speed": 400}}
        sc.update(extra)
        sc["foregroundLayers"] = layers
        return sc

    def test_absent_is_silent(self) -> None:
        self.assertEqual(check_scene_foreground_layers("s", {"id": "s"}), [])

    def test_shape_errors(self) -> None:
        issues = check_scene_foreground_layers("s", self._scene([
            "x", {"source": {}}, {"id": "a", "source": {"kind": "mask"}},
            {"id": "b", "source": {"kind": "swayPlant", "at": [1]}},
            {"id": "c", "source": {"kind": "swayPlant", "at": [1, 2]}, "base": {"y": "no"}},
            {"id": "c", "source": {"kind": "swayPlant", "at": [3, 4]}},
            {"id": "d", "source": {"kind": "swayPlant", "at": [3, 4]}, "base": {"line": [[1, 2]]}},
            {"id": "e", "source": {"kind": "swayPlant", "at": [3, 4]}, "base": {"line": [[1, 2], [1, 5]]}},
            {"id": "f", "source": {"kind": "swayPlant", "at": [3, 4]}, "base": {"line": [[1, 2], [9, 5]]}},
        ]))
        errs = [i.message for i in issues if i.severity == "error"]
        self.assertEqual(len(errs), 8, errs)
        self.assertFalse(any("「f」" in m for m in errs), "合法的接地折线不该报")
        self.assertTrue(any("id 重复" in m for m in errs))
        self.assertTrue(any("不认识" in m for m in errs))
        self.assertEqual([i.severity for i in check_scene_foreground_layers("s", self._scene({}))], ["error"],
                         "不是数组:整份一条 error")

    def test_no_wind_warns(self) -> None:
        sc = self._scene([{"id": "a", "source": {"kind": "swayPlant", "at": [1, 2]}}])
        del sc["wind"]
        issues = check_scene_foreground_layers("s", sc)
        self.assertEqual([i.severity for i in issues], ["warning"])
        self.assertIn("wind", issues[0].message)

    def test_bake_checks(self) -> None:
        with TemporaryDirectory() as td:
            rt = Path(td) / "s"
            layers = [{"id": "on", "source": {"kind": "swayPlant", "at": [60, 30]}},
                      {"id": "snap", "source": {"kind": "swayPlant", "at": [100 + FOREGROUND_SWAY_SNAP_PX - 4, 30]}},
                      {"id": "far", "source": {"kind": "swayPlant", "at": [180, 90]}}]
            sc = self._scene(layers, timeVariants={"夜": {"backgrounds": [{"image": "bg_night.png"}]}})
            # 主背景有拆层,夜里没有
            (rt / "lighting" / "bg").mkdir(parents=True)
            (rt / "lighting" / "bg" / "sway.json").write_text('{"version": 3, "ids": "sway_ids.png"}', encoding="utf-8")
            _write_ids_png(rt / "lighting" / "bg" / "sway_ids.png", 200, 100, [(40, 10, 100, 60, 1)])
            msgs = [(i.severity, i.message) for i in check_scene_foreground_layers("s", sc, rt)]
            self.assertTrue(all(s == "warning" for s, _ in msgs), msgs)
            self.assertEqual(sum("「far」" in m for _, m in msgs), 1, msgs)
            self.assertFalse(any("「on」" in m or "「snap」" in m for _, m in msgs), msgs)
            self.assertEqual(sum("时段「夜」没有草木拆层" in m for _, m in msgs), 1, msgs)

    def test_live_paomaliang_is_clean(self) -> None:
        sj = _ROOT / "public" / "assets" / "scenes" / "跑马梁.json"
        sc = json.loads(sj.read_text(encoding="utf-8"))
        self.assertTrue(sc.get("foregroundLayers"), "跑马梁 应配着崖边那棵树的前景层(本期第一例)")
        rt = _ROOT / "public" / "resources" / "runtime" / "scenes" / "跑马梁"
        self.assertEqual(check_scene_foreground_layers("跑马梁", sc, rt), [])


if __name__ == "__main__":
    unittest.main()
