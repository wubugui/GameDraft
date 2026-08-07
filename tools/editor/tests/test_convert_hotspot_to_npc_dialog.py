"""「纯展示热点 → NPC」对话框的入口级流程探针。

norms 过程义务 3：护栏必须从最外层用户入口验——引擎层的单测在
``test_entity_refactor.py``，这里验的是**对话框这条路本身能不能走通**：
候选装得进选择器、强制闸在有失效引用时真的挡住 OK、确认后模型真的变了、
且 summary 被原样交回给调用方（场景编辑器据它弹提示 + 回选实体）。
"""
from __future__ import annotations

from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

from PySide6.QtWidgets import QApplication, QDialogButtonBox

from tools.editor.project_model import ProjectModel
from tools.editor.shared import entity_refactor as er
from tools.editor.shared.entity_refactor_dialog import ConvertHotspotToNpcDialog
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

BUNDLE = "占位测试_anim"
ANIM = f"/resources/runtime/animation/{BUNDLE}/anim.json"


def _display_hotspot(hid: str, **overrides) -> dict:
    row = {
        "id": hid,
        "type": "inspect",
        "x": 300,
        "y": 400,
        "interactionRange": 50,
        "data": {},
        "displayImage": {
            "image": "/resources/runtime/images/illustrations/搬运工.png",
            "worldWidth": 100.0,
            "worldHeight": 179.2,
            "facing": "left",
            "spriteSort": "front",
        },
    }
    row.update(overrides)
    return row


class ConvertHotspotToNpcDialogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> tuple[ProjectModel, str]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        sid = next(iter(model.scenes))
        scene = model.scenes[sid]
        scene["npcs"] = []
        scene["hotspots"] = [_display_hotspot("hs_搬运工")]
        # 动画包目录面由 ProjectModel.animations 提供（磁盘扫描结果），测试直接注入。
        model.animations[BUNDLE] = {
            "spritesheet": "atlas.png",
            "cols": 1,
            "rows": 1,
            "worldHeight": 150,
            "cellWidth": 84,
            "cellHeight": 210,
            "states": {"idle": {"frames": [0], "frameRate": 8, "loop": True}},
        }
        return model, sid

    def test_dialog_offers_bundles_and_converts_on_accept(self) -> None:
        with TemporaryDirectory() as td:
            model, sid = self._model(Path(td) / "p")
            dlg = ConvertHotspotToNpcDialog(model, sid, "hotspot", "hs_搬运工")
            try:
                self.assertIn(
                    ANIM, [rid for rid, _name in model.anim_asset_path_choices()],
                    "新建的动画包必须出现在 animFile 候选面里",
                )
                dlg._anim.set_current(ANIM)
                self.assertEqual(dlg._anim.current_id(), ANIM)
                dlg._name.setText("搬运工")
                dlg._render_raw.setChecked(True)
                # 没有热点专用动作引用时强制闸不出现、OK 可点
                self.assertFalse(dlg._force.isVisible())
                self.assertTrue(
                    dlg._buttons.button(QDialogButtonBox.StandardButton.Ok).isEnabled())
                dlg._on_accept()
            finally:
                dlg.deleteLater()

            self.assertIsNotNone(dlg.result_summary)
            self.assertEqual(dlg.result_summary["op"], "convertHotspotToNpc")
            scene = model.scenes[sid]
            self.assertEqual(scene["hotspots"], [])
            npc = scene["npcs"][0]
            self.assertEqual(npc["id"], "hs_搬运工")
            self.assertEqual(npc["name"], "搬运工")
            self.assertEqual(npc["animFile"], ANIM)
            self.assertEqual(npc["interactionRange"], 0)
            self.assertEqual(npc["initialFacing"], "left")
            self.assertEqual(npc["spriteSort"], "front")
            self.assertIs(npc["renderRaw"], True)
            # 撤销必须能把热点原样放回去（journal 已由对话框登记）
            self.assertEqual(er.journal_size(model), 1)
            self.assertTrue(er.undo_last(model)["ok"])
            self.assertEqual([h["id"] for h in model.scenes[sid]["hotspots"]], ["hs_搬运工"])
            self.assertEqual(model.scenes[sid]["npcs"], [])

    def test_force_gate_blocks_ok_until_checked(self) -> None:
        with TemporaryDirectory() as td:
            model, sid = self._model(Path(td) / "p")
            # 一处热点专用动作指向它：转 NPC 后必然失效
            model.quests = [{
                "id": "q_test",
                "onComplete": [{
                    "type": "persistHotspotEnabled",
                    "params": {"sceneId": sid, "hotspotId": "hs_搬运工", "enabled": False},
                }],
            }]
            dlg = ConvertHotspotToNpcDialog(model, sid, "hotspot", "hs_搬运工")
            try:
                ok = dlg._buttons.button(QDialogButtonBox.StandardButton.Ok)
                self.assertFalse(ok.isEnabled(), "有失效引用时 OK 必须先被挡住")
                dlg._force.setChecked(True)
                self.assertTrue(ok.isEnabled())
                dlg._anim.set_current(ANIM)
                dlg._on_accept()
            finally:
                dlg.deleteLater()
            self.assertEqual(
                [h["action"] for h in dlg.result_summary["deadHotspotActionRefs"]],
                ["persistHotspotEnabled"],
            )

    def test_interactive_hotspot_is_refused_without_closing_the_dialog(self) -> None:
        with TemporaryDirectory() as td:
            model, sid = self._model(Path(td) / "p")
            model.scenes[sid]["hotspots"] = [
                _display_hotspot("hs_可看", data={"text": "看一眼"})]
            dlg = ConvertHotspotToNpcDialog(model, sid, "hotspot", "hs_可看")
            try:
                dlg._anim.set_current(ANIM)
                from unittest.mock import patch

                with patch("PySide6.QtWidgets.QMessageBox.warning") as warn:
                    dlg._on_accept()
                self.assertTrue(warn.called, "引擎拒绝必须弹警告")
            finally:
                dlg.deleteLater()
            self.assertIsNone(dlg.result_summary, "拒绝路径不得产出 summary")
            self.assertEqual(len(model.scenes[sid]["hotspots"]), 1)
            self.assertEqual(model.scenes[sid]["npcs"], [])


if __name__ == "__main__":
    unittest.main()
