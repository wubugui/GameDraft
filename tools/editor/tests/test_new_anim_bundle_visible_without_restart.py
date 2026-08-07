"""产线新发布的动画包，编辑器不重启就得看得见、选得中。

由来（2026-08-06）：静态占位包批量上线后，**已经开着的编辑器一个新包都看不到**——
动画面板的列表只在 `load_project` 那一刻建过，场景页的 `animFile` 选择器压根不在
`reload_refs_from_model` 的刷新名单里。策划的体感就是"产线说做好了，编辑器里没有"。

这里从**最外层用户入口**验：切页钩子 `reload_refs_from_model`（主窗按鸭子协议调它）
必须让新包同时出现在动画面板列表与场景 NPC 的 animFile 候选里；且**不许**冲掉
动画面板里没保存的编辑。
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

from PySide6.QtWidgets import QApplication

from tools.editor.editors.anim_editor import AnimEditor
from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

NEW_BUNDLE = "产线新出的包_anim"
NEW_MANIFEST = f"/resources/runtime/animation/{NEW_BUNDLE}/anim.json"


def _publish_bundle(model: ProjectModel, bundle_id: str) -> None:
    """模拟产线发布：直接往 animation 目录里放一个合法单帧包（编辑器全程不知情）。"""
    d = model.animation_bundles_path / bundle_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "anim.json").write_text(json.dumps({
        "spritesheet": "atlas.png",
        "cols": 1, "rows": 1,
        "states": {"idle": {"frames": [0], "frameRate": 8, "loop": True}},
        "worldHeight": 150,
        "cellWidth": 84, "cellHeight": 210,
        "atlasFrames": [{"width": 84, "height": 210, "contentWidth": 84, "contentHeight": 210}],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class NewBundleVisibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    def test_discover_only_adds_and_never_touches_loaded_bundles(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            model.animations["手上正在编辑的包"] = {"states": {"idle": {"frames": [0]}}, "编辑中": True}

            _publish_bundle(model, NEW_BUNDLE)
            added = model.discover_new_animation_bundles()

            self.assertEqual(added, [NEW_BUNDLE])
            # 只加不改：内存里已有的包（可能带着未保存编辑）一个字节都不许动
            self.assertEqual(model.animations["手上正在编辑的包"]["编辑中"], True)
            # 幂等：再调一次不重复加
            self.assertEqual(model.discover_new_animation_bundles(), [])

    def test_anim_panel_lists_the_new_bundle_on_page_activation(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            editor = AnimEditor(model)
            try:
                before = {editor._list.item(i).text() for i in range(editor._list.count())}
                self.assertNotIn(NEW_BUNDLE, before)

                _publish_bundle(model, NEW_BUNDLE)
                editor.reload_refs_from_model()      # 主窗切页时调的就是它

                after = {editor._list.item(i).text() for i in range(editor._list.count())}
                self.assertIn(NEW_BUNDLE, after, "新发布的动画包必须出现在动画面板列表里")
            finally:
                editor.deleteLater()

    def test_scene_npc_anim_picker_offers_the_new_bundle_on_page_activation(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            editor = SceneEditor(model)
            try:
                _publish_bundle(model, NEW_BUNDLE)
                editor.reload_refs_from_model()

                picker = editor._props._npc_anim
                # 「选得中」的判据是真去选一次再读回，不是比对显示文本
                # （IdRefSelector 的行文本是 "<id>  [<显示名>]"，拿它比会假红）
                picker.set_current(NEW_MANIFEST)
                self.assertEqual(
                    picker.current_id(), NEW_MANIFEST,
                    "新发布的动画包必须能在场景 NPC 的 animFile 选择器里选中",
                )
                self.assertNotIn(
                    "[缺失]", picker.currentText(),
                    "应当是真候选项，而不是保值展示的孤儿行",
                )
            finally:
                editor.deleteLater()


if __name__ == "__main__":
    unittest.main()
