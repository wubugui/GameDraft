"""台词配音控件（`voice` / `autoAdvance` 两个键的唯一录入面）的写盘契约。

这一个控件被五处台词面共用（过场字幕 / 过场对话框 / playScriptedDialogue 逐行 /
图对话每一拍 / 头顶气泡 action），它写歪一次就是全编辑器的数据面污染，故单独钉死：
最小形态不得凭空多键、字符串形态不得被升级成对象、未改动的数值不得漂表示。
"""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.shared.voice_spec_field import (
    ADVANCE_CLICK,
    ADVANCE_TIMER,
    ADVANCE_VOICE,
    VoiceSpecField,
)


class VoiceSpecFieldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def _rt(self, voice, advance):
        """打开→什么都不动→取写盘值。"""
        f = VoiceSpecField(None, model=None, voice_raw=voice, advance_raw=advance)
        self.addCleanup(f.deleteLater)
        out: dict = {}
        f.apply_to(out)
        return f, out

    def test_empty_form_writes_no_keys(self) -> None:
        """没配配音、点击推进 = 两个键都不写（最小形态打开→保存不得多键）。"""
        _f, out = self._rt(None, None)
        self.assertEqual(out, {})

    def test_string_voice_stays_string(self) -> None:
        _f, out = self._rt("voice_001", None)
        self.assertEqual(out, {"voice": "voice_001"})

    def test_object_voice_keeps_volume_and_hold(self) -> None:
        _f, out = self._rt({"id": "v", "volume": 0.75, "hold": True}, "voice")
        self.assertEqual(out, {"voice": {"id": "v", "volume": 0.75, "hold": True}, "autoAdvance": "voice"})

    def test_object_without_volume_stays_without_volume(self) -> None:
        """磁盘上没写 volume 的对象形态：打开保存不得注入 volume: 1.0。"""
        _f, out = self._rt({"id": "v", "hold": True}, None)
        self.assertEqual(out, {"voice": {"id": "v", "hold": True}})

    def test_int_millis_not_promoted_to_float(self) -> None:
        """未改动的毫秒数按原始表示回写（int 不漂成 float）。"""
        _f, out = self._rt(None, 3000)
        self.assertEqual(out, {"autoAdvance": 3000})
        self.assertIsInstance(out["autoAdvance"], int)

    def test_float_millis_preserved(self) -> None:
        _f, out = self._rt(None, 3000.0)
        self.assertIsInstance(out["autoAdvance"], float)

    def test_sfx_id_alias_is_normalized_to_id(self) -> None:
        """历史别名 sfxId 与 id 等价；写盘统一成 id（运行时两者都认）。"""
        _f, out = self._rt({"sfxId": "v"}, None)
        self.assertEqual(out, {"voice": {"id": "v"}})

    def test_modes_map_to_written_values(self) -> None:
        f, _out = self._rt("v", None)
        self.assertEqual(f.advance_mode(), ADVANCE_CLICK)
        self.assertIsNone(f.advance_value())

        f2, _o2 = self._rt("v", "voice")
        self.assertEqual(f2.advance_mode(), ADVANCE_VOICE)
        self.assertEqual(f2.advance_value(), "voice")

        f3, _o3 = self._rt("v", 1500)
        self.assertEqual(f3.advance_mode(), ADVANCE_TIMER)
        self.assertEqual(f3.advance_value(), 1500)

    def test_illegal_advance_degrades_to_click_without_writing_key(self) -> None:
        """非法推进值（运行时按等点击处理）不得被控件"洗"成一个合法值写回。"""
        _f, out = self._rt("v", "later")
        self.assertEqual(out, {"voice": "v"})

    def test_hold_checkbox_upgrades_string_to_object(self) -> None:
        f, _out = self._rt("voice_001", None)
        f._hold.setChecked(True)
        out: dict = {}
        f.apply_to(out)
        self.assertEqual(out, {"voice": {"id": "voice_001", "hold": True}})

    def test_clearing_voice_id_drops_the_key(self) -> None:
        f, _out = self._rt({"id": "v", "volume": 0.5}, None)
        f._id_widget.setText("")  # 无 model 时是保值的裸输入
        out: dict = {}
        f.apply_to(out)
        self.assertEqual(out, {})

    def test_has_content_drives_section_folding(self) -> None:
        f_empty, _ = self._rt(None, None)
        self.assertFalse(f_empty.has_content())
        f_voice, _ = self._rt("v", None)
        self.assertTrue(f_voice.has_content())
        f_adv, _ = self._rt(None, "voice")
        self.assertTrue(f_adv.has_content())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
