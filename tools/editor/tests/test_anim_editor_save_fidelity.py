"""AnimEditor 写回 anim.json 的格式保真与数据不丢失护栏。

主编辑器动画面板现在可直接编辑 states（帧序/帧率/循环/增删）与世界尺寸并写回
anim.json（图集不动）。这组测试钉死三件事：

1. 不做任何改动地"载入→构建保存字典"必须与原 anim.json 逐键逐值且**键序**一致，
   且落盘为工程规范格式（UTF-8 / 2 空格缩进 / 中文不转义 / 保留键序 / 末尾换行）。
2. 改一个字段（如某状态 frameRate）后保存，除该字段外**一切原样保留**——包括
   spritesheet/cols/rows/单格像素/atlasFrames，以及编辑器不认识的未知顶层键（测试往临时
   拷贝注入的 notes，覆盖"真实数据里暂时没有"的潜伏形状，见验证门卡合成 fixture 一节）。
3. 非法 frames（越界/空/非数字）会被拦下，绝不写出会让运行时错位的 anim.json。
"""
from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication, QTableWidgetItem

from tools.editor.editors.anim_editor import AnimEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import repo_root_from_tests


def _canonical(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, indent=2) + "\n"


def _real_bundles(repo: Path) -> list[Path]:
    root = repo / "public" / "resources" / "runtime" / "animation"
    return sorted(p for p in root.iterdir()
                  if p.is_dir() and (p / "anim.json").is_file())


class AnimEditorSaveFidelityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)
        cls._repo = repo_root_from_tests()

    def _temp_model(self) -> tuple[ProjectModel, Path, "TemporaryDirectory[str]"]:
        """把真实仓库里每个动画包的 anim.json 拷进临时工程，返回已载入的 model。"""
        td = TemporaryDirectory()
        root = Path(td.name)
        anim_root = root / "public" / "resources" / "runtime" / "animation"
        for src in _real_bundles(self._repo):
            dst = anim_root / src.name
            dst.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / "anim.json", dst / "anim.json")
        model = ProjectModel()
        model.project_path = root
        model.reload_animations_from_disk()
        return model, root, td

    def test_no_edit_save_is_canonical_and_lossless(self) -> None:
        model, _root, td = self._temp_model()
        try:
            editor = AnimEditor(model)
            self.assertTrue(model.animations, "未载入任何动画包")
            for bid in sorted(model.animations.keys()):
                editor._on_select(bid)
                out, err = editor._build_saved_anim_dict()
                self.assertIsNone(err, f"{bid}: 不应有校验错误，得到 {err}")
                self.assertIsNotNone(out)
                orig = model.animations[bid]
                # 逐键逐值一致（无数据丢失，未知键如 notes 保留）
                self.assertEqual(out, orig, f"{bid}: 重建后内容发生变化")
                # 键序一致 + 规范序列化（无格式漂移）
                self.assertEqual(
                    _canonical(out), _canonical(orig),
                    f"{bid}: 键序或序列化格式发生变化")
        finally:
            td.cleanup()

    def test_edit_framerate_roundtrip_preserves_everything_else(self) -> None:
        model, root, td = self._temp_model()
        try:
            # 真实仓库里的 anim.json 不一定带未知键（编辑器不认识的顶层键），本测试要钉死的是
            # "编辑保存不吞掉未识别的顶层键"这条契约，故往临时拷贝里注入一个 notes 未知键——
            # 用嵌套结构 + 中文 + 整数 + 列表，兼验深结构与 ensure_ascii=False 一并原样保真；
            # 从盘重载使内存与盘面一致，不依赖真实工程数据是否恰好带 notes（那会随内容漂移而失效）。
            bid = "player_taoist_anim_v1"
            self.assertIn(bid, model.animations)
            aj = (root / "public" / "resources" / "runtime" / "animation"
                  / bid / "anim.json")
            disk = json.loads(aj.read_text(encoding="utf-8"))
            disk["notes"] = {
                "author": "保真测试",
                "tags": ["未知键", "roundtrip"],
                "revision": 3,
            }
            aj.write_text(_canonical(disk), encoding="utf-8")
            model.reload_animations_from_disk()

            orig = json.loads(json.dumps(model.animations[bid]))  # 深拷贝快照
            self.assertIn("notes", orig)
            first_state = next(iter(orig["states"].keys()))
            old_rate = int(orig["states"][first_state]["frameRate"])
            new_rate = old_rate + 5

            editor = AnimEditor(model)
            editor._on_select(bid)
            # 找到该状态所在行，改 frameRate 单元格
            row = None
            for r in range(editor._state_table.rowCount()):
                it = editor._state_table.item(r, 0)
                if it and it.text() == first_state:
                    row = r
                    break
            self.assertIsNotNone(row)
            editor._state_table.setItem(row, 2, QTableWidgetItem(str(new_rate)))
            self.assertTrue(editor._dirty, "改动应标记为 dirty")
            self.assertTrue(editor._do_save(), "保存应成功")

            # 盘面校验（aj 即上面注入 notes 的同一份 anim.json）
            raw = aj.read_text(encoding="utf-8")
            self.assertTrue(raw.endswith("\n"), "应有末尾换行")
            saved = json.loads(raw)
            self.assertEqual(raw, _canonical(saved), "应为规范序列化格式")
            # 仅该状态 frameRate 改变，其余完全一致
            self.assertEqual(saved["states"][first_state]["frameRate"], new_rate)
            expected = json.loads(json.dumps(orig))
            expected["states"][first_state]["frameRate"] = new_rate
            self.assertEqual(saved, expected, "除目标字段外不应有任何变化")
            self.assertEqual(saved.get("notes"), orig.get("notes"), "notes 不应丢失")
            self.assertEqual(model.animations[bid], saved, "内存应与盘面一致")
        finally:
            td.cleanup()

    def test_out_of_range_frame_is_rejected(self) -> None:
        model, _root, td = self._temp_model()
        try:
            bid = "npc_blind_li_anim"
            self.assertIn(bid, model.animations)
            cols = int(model.animations[bid]["cols"])
            rows = int(model.animations[bid]["rows"])
            editor = AnimEditor(model)
            editor._on_select(bid)
            # 写入一个越界帧索引（>= cols*rows）
            editor._state_table.setItem(0, 1, QTableWidgetItem(str(cols * rows + 3)))
            out, err = editor._build_saved_anim_dict()
            self.assertIsNone(out)
            self.assertIsNotNone(err)
            self.assertIn("超出", err)
        finally:
            td.cleanup()


if __name__ == "__main__":
    unittest.main()
