"""构建页的两个引用字段（dev 起始场景 / 叙事锚点）：候选来自模型、切页重拉、悬垂值保值。

此前 `_dev_scene` 是裸 QComboBox、只在构造时填一次，页又没有 `reload_refs_from_model`，
本会话新建的场景要重启编辑器才选得到；`_dev_warp` 干脆是裸 QLineEdit 手打锚点名。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.build_config_editor import BuildConfigEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class BuildConfigRefsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        (root / "public" / "assets" / "data" / "dev_narrative_warps.json").write_text(
            json.dumps({"warps": [{"id": "听书", "label": "1 · 听书", "scene": "sc_a"}]},
                       ensure_ascii=False),
            encoding="utf-8",
        )
        self.model = ProjectModel()
        self.model.load_project(root)
        self.editor = BuildConfigEditor(self.model)

    def tearDown(self) -> None:
        self.editor.deleteLater()
        self._app.processEvents()
        self._tmp.cleanup()

    @staticmethod
    def _rows(sel) -> str:
        return " | ".join(sel.itemText(i) for i in range(sel.count()))

    def test_scene_candidates_follow_the_model_after_reload(self) -> None:
        self.assertNotIn("梦_新场景", self._rows(self.editor._dev_scene))
        self.model.scenes["梦_新场景"] = {"id": "梦_新场景", "hotspots": [], "npcs": [], "zones": []}
        self.editor._dev_scene.set_current("sc_a")
        self.editor.reload_refs_from_model()
        self.assertIn("梦_新场景", self._rows(self.editor._dev_scene))
        self.assertEqual(self.editor._dev_scene.current_id(), "sc_a", "重拉候选不许冲掉当前值")

    def test_warp_candidates_come_from_the_warps_table(self) -> None:
        self.assertIn("听书", self._rows(self.editor._dev_warp))
        self.model.dev_narrative_warps.append({"id": "背尸", "label": "2 · 背尸", "scene": "sc_b"})
        self.editor.reload_refs_from_model()
        self.assertIn("背尸", self._rows(self.editor._dev_warp))

    def test_dangling_values_are_kept_not_cleared(self) -> None:
        self.editor._dev_scene.set_current("已删场景")
        self.editor._dev_warp.set_current("已删锚点")
        self.editor.reload_refs_from_model()
        self.assertEqual(self.editor._dev_scene.current_id(), "已删场景")
        self.assertEqual(self.editor._dev_warp.current_id(), "已删锚点")

    def test_compose_reads_the_selectors(self) -> None:
        self.editor._dev_mode.setCurrentIndex(self.editor._dev_mode.findData("warp"))
        self.editor._dev_warp.set_current("听书")
        dev_q, _ = self.editor._compose()
        self.assertEqual(dev_q, "mode=dev&narrativeWarp=听书")
        self.editor._dev_mode.setCurrentIndex(self.editor._dev_mode.findData("scene"))
        self.editor._dev_scene.set_current("sc_b")
        dev_q, _ = self.editor._compose()
        self.assertEqual(dev_q, "mode=dev&devScene=sc_b")
