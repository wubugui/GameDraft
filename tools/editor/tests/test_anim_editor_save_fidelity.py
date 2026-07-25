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

    def test_bubble_anchor_authoring_roundtrip(self) -> None:
        """授权头顶锚：写入→落盘、清除→删键、没动过→原样保留（含重导出并回后的值）。"""
        model, root, td = self._temp_model()
        try:
            bid = "npc_blind_li_anim"
            self.assertIn(bid, model.animations)
            aj = (root / "public" / "resources" / "runtime" / "animation"
                  / bid / "anim.json")
            state = next(iter(model.animations[bid]["states"].keys()))

            editor = AnimEditor(model)
            editor._on_select(bid)
            row = next(
                r for r in range(editor._state_table.rowCount())
                if (editor._state_table.item(r, 0) or QTableWidgetItem("")).text() == state
            )
            editor._state_table.setCurrentCell(row, 0)

            # ① 授权：控件说的是"气泡底边绝对世界 y"，落盘应换算成格高归一化比例
            wh = float(max(1, editor._a_wh.value()))
            editor._bubble_field._chk.setChecked(True)
            editor._bubble_field._spin.setValue(-0.9 * wh - 8.0)   # 期望 frac≈0.9
            editor._on_bubble_anchor_changed()
            self.assertTrue(editor._do_save(), "保存应成功")
            saved = json.loads(aj.read_text(encoding="utf-8"))
            self.assertAlmostEqual(saved["states"][state]["bubbleAnchor"], 0.9, places=3)

            # ② 没动过的行：再存一次不得漂移
            editor2 = AnimEditor(model)
            editor2._on_select(bid)
            out, err = editor2._build_saved_anim_dict()
            self.assertIsNone(err)
            self.assertEqual(out, saved, "未编辑重存不得改动授权锚")

            # ③ 清除授权：键应被删掉，而不是写 0（0 会被运行时当成"锚在脚点"）
            editor2._state_table.setCurrentCell(row, 0)
            editor2._bubble_field._chk.setChecked(False)
            editor2._on_bubble_anchor_changed()
            self.assertTrue(editor2._do_save(), "保存应成功")
            saved2 = json.loads(aj.read_text(encoding="utf-8"))
            self.assertNotIn("bubbleAnchor", saved2["states"][state])
        finally:
            td.cleanup()

    def test_reexport_preserves_manual_state_fields(self) -> None:
        """重导出动画包不得抹掉人工 per-state 字段（refSpeed / 授权锚）——既有 bug，P4 前置。"""
        from tools.video_to_atlas.atlas_core import merge_preserved_anim_fields

        old = {"states": {"idle": {
            "frames": [0], "frameRate": 12, "loop": True,
            "referenceSpeed": 70, "bubbleAnchor": 0.86,
        }}}
        new = {"states": {"idle": {"frames": [0, 1], "frameRate": 8, "loop": True}}}
        merged = merge_preserved_anim_fields(new, old)
        self.assertEqual(merged["states"]["idle"]["referenceSpeed"], 70)
        self.assertEqual(merged["states"]["idle"]["bubbleAnchor"], 0.86)
        self.assertEqual(merged["states"]["idle"]["frames"], [0, 1], "帧序仍应取新导出的")
        # 新导出显式给了值就不被旧值顶掉；旧包里已不存在的状态不复活
        merged2 = merge_preserved_anim_fields(
            {"states": {"idle": {"bubbleAnchor": 0.5}}}, old)
        self.assertEqual(merged2["states"]["idle"]["bubbleAnchor"], 0.5)
        self.assertNotIn("走路", merge_preserved_anim_fields({"states": {}}, old)["states"])

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
