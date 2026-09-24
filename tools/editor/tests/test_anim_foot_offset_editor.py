"""脚底偏移（`states[*].footOffset`）在编辑器侧的三处：镜像运行时的气泡算式、画布把帧画挪到脚点、
动画面板那一列的往返与「按图测」。

镜像的算式与 `SpriteEntity.getContentBoxLocal` / `getAuthoredBubbleAnchorLocalY` 对账
（缺省锚点、无跳跃抬升）：画面按偏移下挪，内容底边取 pad 与偏移的大者。
"""
from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPixmap
from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.anim_editor import AnimEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.anim_atlas_preview import (
    HEAD_GAP,
    auto_bubble_anchor_y,
    content_box_local,
    lower_frame_to_foot,
    state_foot_offset,
)
from tools.editor.tests.save_test_utils import repo_root_from_tests

CW, CH, WW, WH = 32, 48, 100.0, 150.0


def _anim(off: float | None = 0.125, bubble: float | None = None) -> dict:
    st: dict = {"frames": [0], "frameRate": 8, "loop": True}
    if off is not None:
        st["footOffset"] = off
    if bubble is not None:
        st["bubbleAnchor"] = bubble
    return {
        "cols": 1, "rows": 1, "cellWidth": CW, "cellHeight": CH,
        "atlasFrames": [{"width": CW, "height": CH, "contentWidth": 20, "contentHeight": 44}],
        "states": {"idle": st},
    }


class FootOffsetMirrorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_state_foot_offset_clamps_like_runtime(self) -> None:
        self.assertEqual(state_foot_offset(_anim(0.125), "idle"), 0.125)
        self.assertEqual(state_foot_offset(_anim(None), "idle"), 0.0)
        self.assertEqual(state_foot_offset(_anim(-1), "idle"), 0.0)
        self.assertEqual(state_foot_offset(_anim(0.9), "idle"), 0.5)

    def test_content_box_bottom_gap_mirrors_runtime(self) -> None:
        # pad = (48-44)/2 = 2 px < 偏移 6 px ⇒ 内容底边就在脚点上
        w, h, gap = content_box_local(_anim(), 0, WW, WH, foot_offset=0.125)
        self.assertAlmostEqual(h, 44 * WH / CH)
        self.assertAlmostEqual(gap, 0.0)
        # 没偏移：原口径（pad）
        self.assertAlmostEqual(content_box_local(_anim(None), 0, WW, WH)[2], 2 * WH / CH)

    def test_authored_bubble_follows_lowered_art(self) -> None:
        y = auto_bubble_anchor_y(_anim(0.125, bubble=0.95), 0, WW, WH, state="idle")
        self.assertAlmostEqual(y, -(0.95 - 0.125) * WH - HEAD_GAP)

    def test_lower_frame_moves_pixels_down(self) -> None:
        pm = QPixmap(CW, CH)
        pm.fill(Qt.GlobalColor.transparent)
        img = pm.toImage()
        img.setPixelColor(5, 40, QColor(255, 0, 0, 255))
        low = lower_frame_to_foot(QPixmap.fromImage(img), 0.125).toImage()
        self.assertEqual(low.size(), img.size())
        self.assertEqual(low.pixelColor(5, 46).alpha(), 255)
        self.assertEqual(low.pixelColor(5, 40).alpha(), 0)
        self.assertIs(lower_frame_to_foot(pm, 0.0), pm)


class AnimPanelFootColumnTests(unittest.TestCase):
    BUNDLE = "npc_popo_anim"

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)
        cls._repo = repo_root_from_tests()

    def setUp(self) -> None:
        self.td = TemporaryDirectory()
        root = Path(self.td.name)
        src = self._repo / "public" / "resources" / "runtime" / "animation" / self.BUNDLE
        dst = root / "public" / "resources" / "runtime" / "animation" / self.BUNDLE
        dst.mkdir(parents=True)
        for name in ("anim.json", "atlas.png"):
            shutil.copy2(src / name, dst / name)
        self.model = ProjectModel()
        self.model.project_path = root
        self.model.reload_animations_from_disk()
        self.editor = AnimEditor(self.model)
        self.editor._on_select(self.BUNDLE)
        self.orig = json.loads((dst / "anim.json").read_text(encoding="utf-8"))

    def tearDown(self) -> None:
        self.td.cleanup()

    def _row(self, state: str) -> int:
        t = self.editor._state_table
        return next(r for r in range(t.rowCount()) if t.item(r, 0).text() == state)

    def test_column_shows_percent_of_disk_value(self) -> None:
        v = self.orig["states"]["idle"].get("footOffset")
        self.assertIsNotNone(v, "测试前提：数据里已按图测写过 footOffset")
        self.assertEqual(self.editor._state_table.item(self._row("idle"), 5).text(), f"{v * 100:.2f}")

    def test_edit_and_clear_roundtrip(self) -> None:
        t = self.editor._state_table
        t.item(self._row("idle"), 5).setText("5")
        t.item(self._row("run"), 5).setText("")
        out, err = self.editor._build_saved_anim_dict()
        self.assertIsNone(err)
        self.assertEqual(out["states"]["idle"]["footOffset"], 0.05)
        self.assertNotIn("footOffset", out["states"]["run"])
        # 没动的行原值原位
        self.assertEqual(out["states"]["walk"], self.orig["states"]["walk"])
        t.item(self._row("idle"), 5).setText("80")
        out, err = self.editor._build_saved_anim_dict()
        self.assertIsNone(out)
        self.assertIn("0~50", err)

    def test_measure_button_restores_measured_values(self) -> None:
        t = self.editor._state_table
        t.item(self._row("idle"), 5).setText("")
        orig_info = QMessageBox.information
        QMessageBox.information = staticmethod(lambda *a, **k: None)
        try:
            self.editor._measure_foot_offsets()
        finally:
            QMessageBox.information = orig_info
        out, err = self.editor._build_saved_anim_dict()
        self.assertIsNone(err)
        for name, sd in self.orig["states"].items():
            self.assertEqual(out["states"][name].get("footOffset"), sd.get("footOffset"), name)


if __name__ == "__main__":
    unittest.main()
