"""新老画布的**内容层前后次序必须一致** —— 跨实现 parity。

两个画布并存期间最危险的不是各自出错，而是**各自都"对"但结果不同** ——
策划在一个页排好前后关系，切到另一个页看到的是别的顺序，而两边都不报错。

规则本体只有一份（`shared/entity_sort_math.py`），所以理论上不该分叉；
本文件是那条理论的实测护栏：同一份数据喂给两个画布，内容次序必须逐项相同。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.editors.scene_v2.sorting import content_sort_entries
from tools.editor.project_model import ProjectModel
from tools.editor.tests.qt_teardown import quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "对照街"


def _hotspot(hid: str, y: float, png: str, sort: str | None = None) -> dict:
    di = {"image": png, "worldWidth": 100, "worldHeight": 80}
    if sort:
        di["spriteSort"] = sort
    return {"id": hid, "type": "inspect", "x": 200, "y": y,
            "interactionRange": 50, "displayImage": di}


class ContentOrderParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(self.root)
        png = self.root / "disp.png"
        pm = QPixmap(4, 4)
        pm.fill()
        pm.save(str(png), "PNG")
        self.png = str(png)
        self.model = ProjectModel()
        self.model.load_project(self.root)
        self.model.scenes[_SCENE] = {
            "id": _SCENE, "name": _SCENE, "worldWidth": 800, "worldHeight": 600,
            "spawnPoint": {"x": 10, "y": 10},
            "hotspots": [
                _hotspot("hs_near", 500, self.png),
                _hotspot("hs_far", 100, self.png),
                _hotspot("hs_front", 300, self.png, sort="front"),
                _hotspot("hs_back", 400, self.png, sort="back"),
            ],
            "npcs": [], "zones": [],
        }
        self._editors: list = []

    def tearDown(self) -> None:
        for ed in self._editors:
            if isinstance(ed, SceneEditor):
                quiesce_scene_editor(ed)
            ed.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def _v1_order(self) -> list[str]:
        ed = SceneEditor(self.model)
        self._editors.append(ed)
        ed._load_scene(_SCENE)
        ed._canvas._auto_fit_after_layout = False
        ed._resort_canvas_content_z()
        entries = sorted(ed._content_sort_entries(), key=lambda e: (e[0], e[1]))
        return [ref for _z, _tie, _item, ref in entries]

    def _v2_order(self) -> list[str]:
        page = SceneEditorV2(self.model)
        self._editors.append(page)
        page.load_scene(_SCENE)
        entries = sorted(content_sort_entries(page.document, page.view),
                         key=lambda e: (e[0], e[1]))
        return [ref for _z, _tie, _item, ref in entries]

    def test_both_canvases_agree_on_content_order(self) -> None:
        v1 = self._v1_order()
        v2 = self._v2_order()
        self.assertTrue(v1, "前置条件：老画布应当有内容项")
        self.assertEqual(v1, v2,
                         "新老画布对同一份数据算出了不同的前后次序 —— "
                         "策划在一个页排好，切到另一个页会看到别的顺序")

    def test_bands_are_honoured_by_both(self) -> None:
        order = self._v2_order()
        self.assertEqual(order[0], "hotspot:hs_back", "back 档没有沉到最底")
        self.assertEqual(order[-1], "hotspot:hs_front", "front 档没有浮到最顶")

    def test_within_band_it_is_foot_y(self) -> None:
        order = self._v2_order()
        self.assertLess(order.index("hotspot:hs_far"), order.index("hotspot:hs_near"),
                        "同档内应当按脚底 y 排")


if __name__ == "__main__":
    unittest.main()
