# -*- coding: utf-8 -*-
"""场景「环境音效 ambientSounds」选择器的行为护栏(2026-08-10 改造)。

旧写法:把整个 ambient 目录铺成勾选框列表 + 一个"其它 id 逗号分隔"输入框。
两个毛病——候选越多越难用(两个输入面还得让人猜该填哪个),以及保存时按目录
**字母序**回写,作者写的顺序被静默重排(当时数据恰好都已字母序,没爆出来)。
新写法:列表只装本场景用的 id、按编排顺序;增删走统一弹窗选择器 + 上移下移。

每条用例对应一个真实入口,不允许只在纯函数层验。
"""
from __future__ import annotations

import os
import sys
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from pathlib import Path  # noqa: E402
from tempfile import TemporaryDirectory  # noqa: E402
from unittest.mock import patch  # noqa: E402

from PySide6.QtWidgets import QApplication, QDialog  # noqa: E402

from tools.editor.editors.scene_editor import (  # noqa: E402
    SceneEditor, ScenePropertyPanel,
)
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.audio_picker_dialog import AudioPickerDialog  # noqa: E402
from tools.editor.tests.save_test_utils import (  # noqa: E402
    write_minimal_loadable_project,
)


def _scene(ambient: list[str] | None = None) -> dict:
    sc: dict = {"id": "sc_a", "name": "甲场景", "hotspots": [], "npcs": [], "zones": []}
    if ambient is not None:
        sc["ambientSounds"] = list(ambient)
    return sc


class SceneAmbientSelectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        for ed in self._editors:
            try:
                ed._scene_npc_anim_timer.stop()
                ed._patrol_overlay_refresh_timer.stop()
                ed._canvas._gfx.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def _editor(self, ambient: list[str] | None = None):
        write_minimal_loadable_project(self.root)
        model = ProjectModel()
        model.load_project(self.root)
        # 种一份 ambient 目录:候选过滤/重复拦截都要真候选才验得动
        model.audio_config.setdefault("ambient", {}).update({
            "阴风": {"src": "/resources/runtime/audio/BGS/wind.wav"},
            "amb_light_rain_loop": {"src": "/resources/runtime/audio/rain.wav"},
            "夜晚蛐蛐叫": {"src": "/resources/runtime/audio/BGS/night.wav"},
        })
        model.scenes = {"sc_a": _scene(ambient)}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        # 环境音控件挂在属性面板上,不在 SceneEditor 本体
        return ed._props

    # ---------------------------------------------------------------- 顺序

    def test_order_preserved_not_alphabetised(self):
        """核心:作者写的顺序必须原样回来。旧勾选框列表会按字母序重排。"""
        ids = ["阴风", "amb_light_rain_loop", "夜晚蛐蛐叫"]
        ed = self._editor(ids)
        self.assertEqual(ed._ambient_ids_from_widgets(), ids)

    def test_order_survives_full_roundtrip(self):
        """整条往返:载入 → 落回场景 dict,顺序不能变。"""
        ids = ["阴风", "amb_light_rain_loop"]
        ed = self._editor(ids)
        self.assertEqual(ed._ambient_ids_from_widgets(), ids)

    def test_move_changes_order(self):
        ed = self._editor(["a", "b", "c"])
        ed._sc_ambient_list.setCurrentRow(2)
        ed._move_ambient(-1)
        self.assertEqual(ed._ambient_ids_from_widgets(), ["a", "c", "b"])
        ed._move_ambient(1)
        self.assertEqual(ed._ambient_ids_from_widgets(), ["a", "b", "c"])

    def test_move_at_edges_is_noop(self):
        ed = self._editor(["a", "b"])
        ed._sc_ambient_list.setCurrentRow(0)
        ed._move_ambient(-1)
        ed._sc_ambient_list.setCurrentRow(1)
        ed._move_ambient(1)
        self.assertEqual(ed._ambient_ids_from_widgets(), ["a", "b"])

    # ---------------------------------------------------------------- 保值

    def test_unknown_ids_preserved(self):
        """目录里没有的 id 也要原样保住(共享控件保值契约),不能被吃掉。"""
        ids = ["完全不存在的环境音", "阴风"]
        ed = self._editor(ids)
        self.assertEqual(ed._ambient_ids_from_widgets(), ids)

    def test_empty_scene_has_empty_list(self):
        ed = self._editor(None)
        self.assertEqual(ed._ambient_ids_from_widgets(), [])

    # ---------------------------------------------------------------- 增删

    def test_remove(self):
        ed = self._editor(["a", "b", "c"])
        ed._sc_ambient_list.setCurrentRow(1)
        ed._remove_ambient()
        self.assertEqual(ed._ambient_ids_from_widgets(), ["a", "c"])

    def test_remove_with_no_selection_is_noop(self):
        ed = self._editor(["a"])
        ed._sc_ambient_list.setCurrentRow(-1)
        ed._remove_ambient()
        self.assertEqual(ed._ambient_ids_from_widgets(), ["a"])

    def test_add_via_picker_appends(self):
        ed = self._editor(["a"])

        def _exec(dlg):
            dlg._selected = "阴风"
            return QDialog.DialogCode.Accepted

        with patch.object(AudioPickerDialog, "exec", _exec):
            ed._add_ambient()
        self.assertEqual(ed._ambient_ids_from_widgets(), ["a", "阴风"])

    def test_add_cancelled_changes_nothing(self):
        """取消不改值——共享选择器的硬契约。"""
        ed = self._editor(["a"])

        def _exec(dlg):
            dlg._selected = "阴风"
            return QDialog.DialogCode.Rejected

        with patch.object(AudioPickerDialog, "exec", _exec):
            ed._add_ambient()
        self.assertEqual(ed._ambient_ids_from_widgets(), ["a"])

    def test_duplicate_not_added_twice(self):
        ed = self._editor(["阴风"])

        def _exec(dlg):
            dlg._selected = "阴风"
            return QDialog.DialogCode.Accepted

        with patch.object(AudioPickerDialog, "exec", _exec), \
                patch("tools.editor.editors.scene_editor.QMessageBox.information"):
            ed._add_ambient()
        self.assertEqual(ed._ambient_ids_from_widgets(), ["阴风"])

    def test_picker_excludes_already_used(self):
        """已经在列表里的不该再出现在候选里(省得在长列表里翻已选过的)。"""
        ed = self._editor(["阴风"])
        captured: dict = {}
        real_init = AudioPickerDialog.__init__

        def _spy_init(dlg, model, channel, rows, **kw):
            captured["rows"] = [r[0] if isinstance(r, tuple) else r for r in rows]
            real_init(dlg, model, channel, rows, **kw)

        with patch.object(AudioPickerDialog, "__init__", _spy_init), \
                patch.object(AudioPickerDialog, "exec",
                             lambda _d: QDialog.DialogCode.Rejected):
            ed._add_ambient()
        self.assertIn("rows", captured, "没有真的打开选择器")
        self.assertNotIn("阴风", captured["rows"], "已选的还出现在候选里")
        self.assertIn("amb_light_rain_loop", captured["rows"], "未选的应该在候选里")

    # ---------------------------------------------------------------- 脏态

    def test_load_does_not_mark_dirty(self):
        """载入不能置脏,否则一打开场景就显示"有未保存改动"。"""
        ed = self._editor(["a", "b"])
        calls = []
        with patch.object(ScenePropertyPanel, "_emit_props_changed",
                          lambda _s: calls.append(1)):
            ed._load_ambient_widgets(["c", "d"])
        self.assertEqual(calls, [])

    def test_edits_mark_dirty(self):
        """增删排序必须即时入脏(commit-on-leave 范式要求)。"""
        ed = self._editor(["a", "b"])
        calls = []
        with patch.object(ScenePropertyPanel, "_emit_props_changed",
                          lambda _s: calls.append(1)):
            ed._sc_ambient_list.setCurrentRow(0)
            ed._move_ambient(1)
            ed._remove_ambient()
        self.assertEqual(len(calls), 2)

    # ---------------------------------------------------------------- 按钮态

    def test_buttons_reflect_selection(self):
        ed = self._editor(["a", "b", "c"])
        ed._sc_ambient_list.setCurrentRow(-1)
        ed._sync_ambient_buttons()
        self.assertFalse(ed._amb_btn_del.isEnabled())
        self.assertFalse(ed._amb_btn_up.isEnabled())
        self.assertFalse(ed._amb_btn_down.isEnabled())

        ed._sc_ambient_list.setCurrentRow(0)
        self.assertTrue(ed._amb_btn_del.isEnabled())
        self.assertFalse(ed._amb_btn_up.isEnabled(), "首行不该能上移")
        self.assertTrue(ed._amb_btn_down.isEnabled())

        ed._sc_ambient_list.setCurrentRow(2)
        self.assertTrue(ed._amb_btn_up.isEnabled())
        self.assertFalse(ed._amb_btn_down.isEnabled(), "末行不该能下移")


if __name__ == "__main__":
    unittest.main()
