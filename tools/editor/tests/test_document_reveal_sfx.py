"""文档揭示的「揭示音效」配置：往返保真 + 空值不写键 + 未登记 id 保值 + 校验器口径。

运行时契约见 `src/systems/DocumentRevealManager.ts`：`revealSfx` 是 `audio_config.sfx` 的
id，与叠化同起（等过 `animation.delayMs`）；`revealSfxVolume` 是可选的音量覆盖。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from unittest.mock import patch

from PySide6.QtWidgets import QApplication, QDialog

from tools.editor.editors.narrative_data_editors import DocumentRevealsEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.audio_picker_dialog import AudioPickerDialog
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import Issue, validate


def _pick_exec(target: str):
    """把弹窗的模态 exec 换成「选中 target 并确定」，驱动选择器的真实提交路径。
    ``target=""`` 走「清空」分支（同弹窗底部的清空按钮）。"""
    def _exec(self: AudioPickerDialog) -> QDialog.DialogCode:
        if not target:
            self._clear_and_accept()
            return QDialog.DialogCode.Accepted
        for i in range(self._tree.topLevelItemCount()):
            item = self._tree.topLevelItem(i)
            if item.text(0) == target:
                self._tree.setCurrentItem(item)
                break
        self._accept_current()
        return QDialog.DialogCode.Accepted
    return _exec


def _reveal(**extra: object) -> dict:
    d = {
        "id": "doc_notice",
        "blurredImagePath": "/assets/blur.png",
        "clearImagePath": "/assets/clear.png",
        "revealCondition": {"all": []},
        "animation": {"durationMs": 2000, "delayMs": 0},
    }
    d.update(extra)
    return d


class DocumentRevealSfxEditorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path, reveals: list[dict]) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.audio_config = {
            "sfx": {
                "paper_reveal": {"src": "/resources/runtime/audio/sfx/paper.wav"},
                "ink_wash": {"src": "/resources/runtime/audio/sfx/ink.wav"},
            },
        }
        model.document_reveals = reveals
        return model

    def test_roundtrip_keeps_sfx_fields_untouched(self) -> None:
        """打开→只改无关字段→保存：音效 id 与 int 音量原样保留（不漂成 float）。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = self._model(root, [_reveal(revealSfx="paper_reveal", revealSfxVolume=1)])
            ed = DocumentRevealsEditor(model)

            self.assertEqual(ed._dr_sfx.current_id(), "paper_reveal")
            self.assertTrue(ed._dr_sfx_vol_chk.isChecked())
            self.assertTrue(ed._dr_sfx_vol.isEnabled())

            ed._dr_x.setValue(51)
            ed.flush_to_model()
            saved = model.document_reveals[0]
            self.assertEqual(saved["revealSfx"], "paper_reveal")
            self.assertEqual(saved["revealSfxVolume"], 1)
            self.assertIsInstance(saved["revealSfxVolume"], int)
            self.assertEqual(saved["xPercent"], 51)

    def test_high_precision_and_out_of_range_volume_survive_untouched_roundtrip(self) -> None:
        """两位小数控件不得截掉 0.333，也不得把越界值钳成上限——没动就原样写回。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = self._model(root, [
                _reveal(revealSfx="paper_reveal", revealSfxVolume=0.333),
                _reveal(id="doc_loud", revealSfx="ink_wash", revealSfxVolume=42),
            ])
            ed = DocumentRevealsEditor(model)
            ed.flush_to_model()
            self.assertEqual(model.document_reveals[0]["revealSfxVolume"], 0.333)
            self.assertEqual(model.document_reveals[1]["revealSfxVolume"], 42)

    def test_unregistered_sfx_id_is_preserved_not_cleared(self) -> None:
        """音效 id 不在 audio_config.sfx 里（改名/未登记）时保值展示、保值写回。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = self._model(root, [_reveal(revealSfx="legacy_unregistered")])
            ed = DocumentRevealsEditor(model)

            self.assertEqual(ed._dr_sfx.current_id(), "legacy_unregistered")
            self.assertIn("legacy_unregistered", ed._dr_sfx.item_ids())
            ed._dr_x.setValue(49)
            ed.flush_to_model()
            self.assertEqual(model.document_reveals[0]["revealSfx"], "legacy_unregistered")

    def test_empty_selection_writes_no_keys(self) -> None:
        """没选音效的条目不得写出 revealSfx / revealSfxVolume 空键。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = self._model(root, [_reveal()])
            ed = DocumentRevealsEditor(model)

            self.assertEqual(ed._dr_sfx.current_id(), "")
            self.assertFalse(ed._dr_sfx_vol_chk.isChecked())
            self.assertFalse(ed._dr_sfx_vol.isEnabled())
            ed.flush_to_model()
            self.assertNotIn("revealSfx", model.document_reveals[0])
            self.assertNotIn("revealSfxVolume", model.document_reveals[0])

    def test_user_picks_sfx_and_custom_volume(self) -> None:
        """选音效 + 勾自定义音量：两个键都写出；取消勾选后音量键被删除。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = self._model(root, [_reveal()])
            ed = DocumentRevealsEditor(model)

            with patch.object(AudioPickerDialog, "exec", _pick_exec("ink_wash")):
                ed._dr_sfx._button.click()  # 最外层用户入口：点音效按钮开弹窗选中
            ed._dr_sfx_vol_chk.setChecked(True)
            ed._dr_sfx_vol.setValue(0.35)
            ed.flush_to_model()
            self.assertEqual(model.document_reveals[0]["revealSfx"], "ink_wash")
            self.assertAlmostEqual(model.document_reveals[0]["revealSfxVolume"], 0.35)

            ed._dr_sfx_vol_chk.setChecked(False)
            ed.flush_to_model()
            self.assertEqual(model.document_reveals[0]["revealSfx"], "ink_wash")
            self.assertNotIn("revealSfxVolume", model.document_reveals[0])

    def test_volume_key_dropped_when_sfx_cleared(self) -> None:
        """音效被清空时，孤儿音量键一并清掉（音量无处生效）。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = self._model(root, [_reveal(revealSfx="ink_wash", revealSfxVolume=0.5)])
            ed = DocumentRevealsEditor(model)

            with patch.object(AudioPickerDialog, "exec", _pick_exec("")):
                ed._dr_sfx._button.click()  # 弹窗里按「清空」
            ed.flush_to_model()
            self.assertNotIn("revealSfx", model.document_reveals[0])
            self.assertNotIn("revealSfxVolume", model.document_reveals[0])

    def test_save_all_writes_sfx_to_disk(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = self._model(root, [_reveal()])
            ed = DocumentRevealsEditor(model)
            with patch.object(AudioPickerDialog, "exec", _pick_exec("paper_reveal")):
                ed._dr_sfx._button.click()
            ed.flush_to_model()
            model.mark_dirty("document_reveals")
            model.save_all()
            saved = json.loads(
                (root / "public/assets/data/document_reveals.json").read_text(encoding="utf-8"),
            )
            self.assertEqual(saved[0]["revealSfx"], "paper_reveal")


class DocumentRevealSfxValidatorTests(unittest.TestCase):
    def _issues(self, reveals: list[dict]) -> list[Issue]:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.audio_config = {"sfx": {"paper_reveal": {"src": "/a.wav"}}}
            model.document_reveals = reveals
            return [i for i in validate(model) if i.data_type == "document_reveal"]

    def test_registered_sfx_is_clean(self) -> None:
        self.assertEqual(self._issues([_reveal(revealSfx="paper_reveal")]), [])
        self.assertEqual(
            self._issues([_reveal(revealSfx="paper_reveal", revealSfxVolume=0.5)]), [])

    def test_unregistered_sfx_warns(self) -> None:
        issues = self._issues([_reveal(revealSfx="ghost_sfx")])
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].severity, "warning")
        self.assertIn("ghost_sfx", issues[0].message)

    def test_non_numeric_volume_is_error(self) -> None:
        issues = self._issues([_reveal(revealSfx="paper_reveal", revealSfxVolume="loud")])
        self.assertEqual([i.severity for i in issues], ["error"])

    def test_orphan_and_out_of_range_volume_warn(self) -> None:
        orphan = self._issues([_reveal(revealSfxVolume=0.5)])
        self.assertEqual([i.severity for i in orphan], ["warning"])
        self.assertIn("revealSfx", orphan[0].message)

        # >1 是**合法**的（“这一处要比素材原音更响”，与别处的本处音量同口径），
        # 最终只是被运行时钳到满幅——不能因为作者想调响就报一条。
        self.assertEqual(
            self._issues([_reveal(revealSfx="paper_reveal", revealSfxVolume=1.5)]), [],
        )
        loud = self._issues([_reveal(revealSfx="paper_reveal", revealSfxVolume=40)])
        self.assertEqual([i.severity for i in loud], ["warning"])
        self.assertIn("大得离谱", loud[0].message)

        bad = self._issues([_reveal(revealSfx="paper_reveal", revealSfxVolume=-1)])
        self.assertEqual([i.severity for i in bad], ["error"])


if __name__ == "__main__":
    unittest.main()
