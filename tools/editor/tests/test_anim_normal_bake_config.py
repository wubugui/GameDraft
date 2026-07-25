"""AnimEditor 的 per-animation 法线烘焙配置(normalBake)往返 + bake 工具解析。

钉死：
- 无 normalBake 的动画：不编辑地保存 → 不无中生有加键（往返保真，见 fidelity 测试同理）。
- 有 normalBake 的动画：load 反映到控件，不编辑保存 → 逐键逐值保留。
- 改「烘焙开关 / 分辨率」控件 → 写入 anim.json 的 normalBake。
- bake 工具 resolve_bake_config 按 normalBake + CLI 覆盖正确解析。
"""
from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.anim_editor import AnimEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import repo_root_from_tests
from tools.animation_pipeline.bake_normal_atlas import resolve_bake_config


class NormalBakeConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)
        cls._repo = repo_root_from_tests()

    def _model_with(self, anim_json: dict) -> tuple[ProjectModel, str]:
        td = TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        d = root / "public/resources/runtime/animation/test_bundle_anim"
        d.mkdir(parents=True, exist_ok=True)
        (d / "anim.json").write_text(json.dumps(anim_json, ensure_ascii=False, indent=2) + "\n")
        model = ProjectModel()
        model.project_path = root
        model.reload_animations_from_disk()
        return model, "test_bundle_anim"

    _BASE = {"spritesheet": "atlas.png", "cols": 4, "rows": 1,
             "states": {"idle": {"frames": [0, 1, 2, 3], "frameRate": 8, "loop": True}},
             "worldWidth": 100}

    def test_absent_stays_absent(self) -> None:
        model, bid = self._model_with(dict(self._BASE))
        ed = AnimEditor(model)
        ed._on_select(bid)
        self.assertTrue(ed._a_bake_enable.isChecked())      # 缺省显示=启用
        self.assertEqual(ed._a_bake_downscale.value(), 4)   # 缺省=1/4
        out, err = ed._build_saved_anim_dict()
        self.assertIsNone(err)
        self.assertNotIn("normalBake", out, "无编辑不应无中生有加 normalBake")

    def test_present_roundtrips(self) -> None:
        base = dict(self._BASE)
        base["normalBake"] = {"enabled": False, "downscale": 8}
        model, bid = self._model_with(base)
        ed = AnimEditor(model)
        ed._on_select(bid)
        self.assertFalse(ed._a_bake_enable.isChecked())
        self.assertEqual(ed._a_bake_downscale.value(), 8)
        out, err = ed._build_saved_anim_dict()
        self.assertIsNone(err)
        self.assertEqual(out["normalBake"], {"enabled": False, "downscale": 8})

    def test_edit_writes_field(self) -> None:
        model, bid = self._model_with(dict(self._BASE))
        ed = AnimEditor(model)
        ed._on_select(bid)
        ed._a_bake_enable.setChecked(False)      # 关掉烘焙
        out, err = ed._build_saved_anim_dict()
        self.assertIsNone(err)
        self.assertEqual(out["normalBake"], {"enabled": False, "downscale": 4})

    def test_edit_downscale_writes_field(self) -> None:
        model, bid = self._model_with(dict(self._BASE))
        ed = AnimEditor(model)
        ed._on_select(bid)
        ed._a_bake_downscale.setValue(8)
        out, err = ed._build_saved_anim_dict()
        self.assertIsNone(err)
        self.assertEqual(out["normalBake"], {"enabled": True, "downscale": 8})

    def test_bake_tool_resolve(self) -> None:
        self.assertEqual(resolve_bake_config({}, None), (True, 4))
        self.assertEqual(resolve_bake_config({"normalBake": {"enabled": False}}, None), (False, 4))
        self.assertEqual(resolve_bake_config({"normalBake": {"downscale": 8}}, None), (True, 8))
        self.assertEqual(resolve_bake_config({"normalBake": {"downscale": 8}}, 2), (True, 2))  # CLI 覆盖


if __name__ == "__main__":
    unittest.main()
