"""音频编辑器 2026-08-10 迭代的护栏。

覆盖三件事：
1. **往返保真**——新增 volume 列后，「打开→不动→保存」必须与磁盘等价（含 int 不漂 float、
   未知键透传、键序不变）；
2. **弹窗选择器取代长下拉**——选择走 AudioPickerDialog，取消不改值、悬垂值保值、
   搜索/键盘从最外层入口能走通；
3. **共享层**——wav 头解析时长、未登记文件扫描、引用计数区分「键」与「值」。
"""
from __future__ import annotations

import copy
import os
import struct
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEvent, Qt
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import QApplication, QDialog, QMessageBox

from tools.editor.project_model import ProjectModel
from tools.editor.shared import audio_library as lib
from tools.editor.shared.audio_picker_dialog import AudioPickerDialog
from tools.editor.shared.audio_preview_selector import AudioIdPreviewSelector
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_AUDIO_REL = ("public", "resources", "runtime", "audio")


def _write_wav(path: Path, seconds: float, *, rate: int = 8000) -> None:
    """写一个真 wav（单声道 8bit），供时长解析与「文件存在」判定用。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(rate * seconds)
    data = b"\x80" * frames
    header = (
        b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate, 1, 8)
        + b"data" + struct.pack("<I", len(data))
    )
    path.write_bytes(header + data)


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _project(self, td: str) -> tuple[ProjectModel, Path]:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        audio_dir = root.joinpath(*_AUDIO_REL)
        _write_wav(audio_dir / "a.wav", 1.5)
        _write_wav(audio_dir / "b.wav", 0.25)
        _write_wav(audio_dir / "orphan_on_disk.wav", 0.5)
        model = ProjectModel()
        model.load_project(root)
        return model, root


class AudioConfigRoundTripTests(_Base):
    """新增的 volume 列不得破坏「打开→不动→保存」的等价性。"""

    _CONFIG = {
        "bgm": {
            "bgm_int_vol": {"src": "/resources/runtime/audio/a.wav", "volume": 1},
            "bgm_float_vol": {"src": "/resources/runtime/audio/b.wav", "volume": 0.35},
            "bgm_no_vol": {"src": "/resources/runtime/audio/a.wav"},
            "bgm_unknown_key": {
                "src": "/resources/runtime/audio/b.wav",
                "volume": 0.5,
                "未来字段": {"x": 1},
            },
            "bgm_missing_file": {"src": "/resources/runtime/audio/gone.wav"},
        },
        "ambient": {},
        "sfx": {},
        "systemSfx": {"uiHover": ""},
    }

    def test_open_then_flush_is_identical(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            model.audio_config = copy.deepcopy(self._CONFIG)
            before = copy.deepcopy(model.audio_config)
            ed = AudioEditor(model)
            self.assertFalse(ed._is_dirty(), "打开不动不得判脏")
            ed.flush_to_model()
            self.assertEqual(model.audio_config, before, "零编辑往返必须等价")
            self.assertEqual(
                list(model.audio_config["bgm"].keys()), list(before["bgm"].keys()),
                "键序须保持",
            )
            self.assertIsInstance(
                model.audio_config["bgm"]["bgm_int_vol"]["volume"], int,
                "整数 volume 不得漂成 float",
            )
            self.assertEqual(
                model.audio_config["bgm"]["bgm_unknown_key"]["未来字段"], {"x": 1},
                "本页不管的未知键必须原样透传",
            )

    def test_volume_edit_writes_and_clear_removes_key(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor, _COL_VOLUME
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            model.audio_config = copy.deepcopy(self._CONFIG)
            ed = AudioEditor(model)
            bgm = ed._sub_tabs[0]
            bgm._table.item(2, _COL_VOLUME).setText("0.4")   # bgm_no_vol: 本来没有
            bgm._table.item(0, _COL_VOLUME).setText("")      # bgm_int_vol: 清成默认
            ed.flush_to_model()
            self.assertEqual(model.audio_config["bgm"]["bgm_no_vol"]["volume"], 0.4)
            self.assertNotIn(
                "volume", model.audio_config["bgm"]["bgm_int_vol"],
                "清空 volume 应删键而不是写 0",
            )

    def test_illegal_volume_reverts_to_last_good(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor, _COL_VOLUME
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            model.audio_config = copy.deepcopy(self._CONFIG)
            ed = AudioEditor(model)
            bgm = ed._sub_tabs[0]
            item = bgm._table.item(1, _COL_VOLUME)      # bgm_float_vol = 0.35
            item.setText("响一点")
            self.assertEqual(item.text(), "0.35", "非法输入必须退回原值而不是清零")
            item.setText("7")
            self.assertEqual(item.text(), "0.35", "超出 0～1 同样退回")
            ed.flush_to_model()
            self.assertEqual(model.audio_config["bgm"]["bgm_float_vol"]["volume"], 0.35)

    def test_missing_file_row_is_marked(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor, _COL_STATUS
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            model.audio_config = copy.deepcopy(self._CONFIG)
            ed = AudioEditor(model)
            bgm = ed._sub_tabs[0]
            self.assertEqual(bgm._table.item(4, _COL_STATUS).text(), "缺文件")
            self.assertEqual(bgm._table.item(0, _COL_STATUS).text(), "✓")

    def test_delete_referenced_entry_asks_first(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor
        with TemporaryDirectory() as td:
            model, root = self._project(td)
            model.audio_config = copy.deepcopy(self._CONFIG)
            # 让 bgm_int_vol 在内容 JSON 里真被引用一次
            scene = root / "public" / "assets" / "scenes" / "ref_scene.json"
            scene.write_text('{"id": "ref_scene", "bgm": "bgm_int_vol"}', encoding="utf-8")
            ed = AudioEditor(model)
            try:
                ed.refresh_reference_counts()
                bgm = ed._sub_tabs[0]
                bgm._table.setCurrentCell(0, 0)
                rows_before = bgm._table.rowCount()
                with patch.object(
                    QMessageBox, "question",
                    return_value=QMessageBox.StandardButton.No,
                ) as ask:
                    bgm._delete()
                self.assertTrue(ask.called, "删除被引用的音频前必须先问")
                self.assertEqual(bgm._table.rowCount(), rows_before, "答 No 不得删行")
            finally:
                # 选中一行会让 AudioTransportBar 把该 .wav 设成 QMediaPlayer 的 source，
                # 而 source 一直挂着就一直占着文件句柄。Windows 上那是独占的：
                # 不先松手，退出 TemporaryDirectory 时 rmtree 必挂
                # 「WinError 32 另一个程序正在使用此文件」——测试断言其实早就过了，
                # 红的是清理。autouse 的控件回收 fixture 在 with 块**之后**才跑，指望不上。
                for sub in ed._sub_tabs:
                    tp = getattr(sub, "_transport", None)
                    if tp is not None:
                        tp.play_file(None)


def _pick_exec(target: str):
    """把弹窗的模态 exec 换成「选中 target 并确定」，用来驱动选择器的真实提交路径。"""
    def _exec(self: AudioPickerDialog):
        for i in range(self._tree.topLevelItemCount()):
            item = self._tree.topLevelItem(i)
            if item.text(0) == target:
                self._tree.setCurrentItem(item)
                break
        self._accept_current()
        return QDialog.DialogCode.Accepted
    return _exec


class AudioSelectorPopupTests(_Base):
    """选择音频从「127 项长下拉」改为弹窗后的行为契约。"""

    def _selector(self, model: ProjectModel) -> AudioIdPreviewSelector:
        sel = AudioIdPreviewSelector(model, "sfx", allow_empty=True, editable=True)
        sel.set_items([(a, a) for a in model.all_audio_ids("sfx")])
        return sel

    def _model_with_sfx(self, td: str) -> ProjectModel:
        model, _root = self._project(td)
        model.audio_config["sfx"] = {
            "sfx_a": {"src": "/resources/runtime/audio/a.wav"},
            "sfx_b": {"src": "/resources/runtime/audio/b.wav"},
        }
        return model

    def test_no_giant_combo_anymore(self) -> None:
        from PySide6.QtWidgets import QComboBox
        with TemporaryDirectory() as td:
            sel = self._selector(self._model_with_sfx(td))
            self.assertEqual(
                sel.findChildren(QComboBox), [],
                "音频选择器不得再内嵌下拉（大候选集一律弹窗，见 dropdown-vs-popup 决策）",
            )

    def test_click_button_opens_picker_and_commits(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model_with_sfx(td)
            sel = self._selector(model)
            sel.set_current("sfx_a")
            seen: list[str] = []
            sel.value_changed.connect(seen.append)
            with patch.object(AudioPickerDialog, "exec", _pick_exec("sfx_b")):
                sel._button.click()          # 最外层用户入口：点那颗按钮
            self.assertEqual(sel.current_id(), "sfx_b")
            self.assertEqual(seen, ["sfx_b"], "只在真的换了值时发一次信号")

    def test_cancel_keeps_value_and_is_silent(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model_with_sfx(td)
            sel = self._selector(model)
            sel.set_current("sfx_a")
            seen: list[str] = []
            sel.value_changed.connect(seen.append)
            with patch.object(
                AudioPickerDialog, "exec",
                lambda self: QDialog.DialogCode.Rejected,
            ):
                sel._button.click()
            self.assertEqual(sel.current_id(), "sfx_a")
            self.assertEqual(seen, [], "取消不得发 value_changed（否则工程被标脏）")

    def test_dangling_value_is_preserved_and_labelled(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model_with_sfx(td)
            sel = self._selector(model)
            sel.set_current("sfx_not_registered")
            self.assertEqual(sel.current_id(), "sfx_not_registered", "悬垂值必须保值")
            self.assertIn("未登记", sel._button.text())

    def test_picker_lists_dangling_current_on_top(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model_with_sfx(td)
            dlg = AudioPickerDialog(
                model, "sfx", [("sfx_a", "sfx_a")], current="sfx_ghost",
            )
            self.assertEqual(dlg._tree.topLevelItem(0).text(0), "sfx_ghost")
            self.assertEqual(
                dlg._tree.currentItem().text(0), "sfx_ghost",
                "打开时应停在当前值上，否则用户会以为「没选」",
            )
            dlg._accept_current()
            self.assertEqual(dlg.selected_value(), "sfx_ghost", "不改选就不改值")

    def test_picker_filter_hides_non_matching(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model_with_sfx(td)
            dlg = AudioPickerDialog(
                model, "sfx", [("sfx_a", "sfx_a"), ("sfx_b", "sfx_b")], current="sfx_a",
            )
            dlg._filter.setText("sfx_b")
            visible = [
                dlg._tree.topLevelItem(i).text(0)
                for i in range(dlg._tree.topLevelItemCount())
                if not dlg._tree.topLevelItem(i).isHidden()
            ]
            self.assertEqual(visible, ["sfx_b"])

    def test_down_arrow_in_filter_walks_the_list(self) -> None:
        """搜索框里按 ↓ 直接进列表——不这样的话「搜完还要拿鼠标点一下」。"""
        with TemporaryDirectory() as td:
            model = self._model_with_sfx(td)
            dlg = AudioPickerDialog(
                model, "sfx", [("sfx_a", "sfx_a"), ("sfx_b", "sfx_b")], current="",
            )
            dlg.show()  # 焦点只在真实显示的窗口里才会转移（离屏也一样要 show）
            QApplication.processEvents()
            dlg._filter.setFocus()
            event = QKeyEvent(
                QEvent.Type.KeyPress, Qt.Key.Key_Down, Qt.KeyboardModifier.NoModifier,
            )
            QApplication.sendEvent(dlg._filter, event)
            self.assertIsNotNone(dlg._tree.currentItem(), "↓ 后应已经站在某一行上")
            self.assertTrue(dlg._tree.hasFocus(), "焦点应交给列表，后续 ↑↓ 才是换行")
            dlg.close()

    def test_picker_duration_column_filled(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model_with_sfx(td)
            cache = lib.AudioMetaCache()
            path = model.paths.runtime_audio_dir / "a.wav"
            self.assertIsNotNone(lib.probe_duration(path))
            dlg = AudioPickerDialog(
                model, "sfx", [("sfx_a", "sfx_a")], current="sfx_a", cache=cache,
            )
            cache.duration(path)  # 排队；后台探测出结果后 UI 自刷
            self.assertEqual(dlg._tree.headerItem().text(1), "时长")


class AudioLibraryTests(_Base):
    def test_wav_duration_from_header(self) -> None:
        with TemporaryDirectory() as td:
            path = Path(td) / "x.wav"
            _write_wav(path, 2.0, rate=8000)
            self.assertAlmostEqual(lib.probe_duration(path) or 0.0, 2.0, places=3)

    def test_format_duration(self) -> None:
        self.assertEqual(lib.format_duration(None), "—")
        self.assertEqual(lib.format_duration(1.234), "1.23s")
        self.assertEqual(lib.format_duration(65.0), "1:05.0")

    def test_scan_unregistered_files(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            model.audio_config = {
                "bgm": {"bgm_a": {"src": "/resources/runtime/audio/a.wav"}},
                "ambient": {},
                "sfx": {"sfx_b": {"src": "/resources/runtime/audio/b.wav"}},
            }
            names = {p.name for p in lib.scan_unregistered_files(model)}
            self.assertEqual(names, {"orphan_on_disk.wav"})

    def test_reference_counts_ignore_keys(self) -> None:
        with TemporaryDirectory() as td:
            model, root = self._project(td)
            scene = root / "public" / "assets" / "scenes" / "s.json"
            scene.write_text(
                '{"sfx_as_key": 1, "bgm": "sfx_as_value", "list": ["sfx_as_value"]}',
                encoding="utf-8",
            )
            counts = lib.build_reference_counts(model)
            self.assertEqual(counts.get("sfx_as_value"), 2)
            self.assertIsNone(
                counts.get("sfx_as_key"), "作为键出现不算引用（否则登记表自己就把自己数进去）",
            )

    def test_reference_counts_include_ts_constants(self) -> None:
        """代码里写死的音频 id（如 fly_buzz）不能被报成 0 引用——那是最危险的假零。"""
        with TemporaryDirectory() as td:
            model, root = self._project(td)
            ts = root / "src" / "systems" / "objectExamine" / "types.ts"
            ts.parent.mkdir(parents=True, exist_ok=True)
            ts.write_text(
                "export const OBJECT_EXAMINE_FLY_BUZZ_AMBIENT_ID = 'amb_fly_buzz';\n",
                encoding="utf-8",
            )
            counts = lib.build_reference_counts(model)
            self.assertEqual(counts.get("amb_fly_buzz"), 1)

    def test_meta_cache_survives_host_destruction(self) -> None:
        """后台探测线程在宿主被销毁后 emit → 曾抛 RuntimeError（全套测试里真的报过）。

        真机上的对应场景是「面板还在探时长就切工程/关窗」：轻则刷屏报错，
        重则在别的调用栈上炸。断路靠一个不持有 self 的共享标志。
        """
        import shiboken6
        from PySide6.QtWidgets import QWidget
        host = QWidget()
        cache = lib.AudioMetaCache(host)
        self.assertTrue(cache._alive[0])
        shiboken6.delete(host)          # 真销毁 C++ 对象（deleteLater 在 loopLevel 0 收不掉）
        self.assertFalse(cache._alive[0], "宿主销毁后共享标志必须翻转")
        cache._emit_updated()           # 后台线程走的正是这条路：不得抛
        self.assertTrue(cache._stopped, "发现宿主没了就该让线程收摊")

    def test_suggest_audio_id_keeps_chinese_filename(self) -> None:
        """建议 id = 文件名原样。

        旧版把非 ASCII 全抹成 `_` 再 strip，`茶馆开场_瞎子李_1.wav` 建议出来是 `1`
        ——这个项目的 id 全是中文，那套 ASCII 白名单等于把文件名信息全丢了。
        """
        for stem, want in (
            ("茶馆开场_瞎子李_1", "茶馆开场_瞎子李_1"),
            ("说书9", "说书9"),
            ("说书-李天狗大战旱魃_说书人_01", "说书-李天狗大战旱魃_说书人_01"),
            ("sfx_stone_press", "sfx_stone_press"),
            ("door slam", "door_slam"),          # 空格换掉：中间空格在表里看不见
        ):
            self.assertEqual(lib.suggest_audio_id(Path(f"/x/{stem}.wav"), []), want)

    def test_suggest_audio_id_dedupes_with_parent_dir_then_number(self) -> None:
        self.assertEqual(
            lib.suggest_audio_id(Path("/x/说书重庆话/1.wav"), ["1"]), "说书重庆话_1",
        )
        self.assertEqual(
            lib.suggest_audio_id(Path("/x/说书重庆话/1.wav"), ["1", "说书重庆话_1"]), "1_2",
        )

    def test_audio_id_problem_rejects_only_what_breaks(self) -> None:
        for ok in ("茶馆开场_瞎子李_1", "sfx_door", "说书-景别复位", "1"):
            self.assertIsNone(lib.audio_id_problem(ok), ok)
        for bad in ("", "   ", " 前导空白", "尾随空白 ", "带 空格", "带/斜杠", '带"引号', "带\\反斜杠"):
            self.assertIsNotNone(lib.audio_id_problem(bad), repr(bad))


class AudioIdGuardTests(_Base):
    """三个建 id 的入口(新增 / 重命名 / 扫描登记)都得挡住不合法 id。

    在这之前一处都没挡：`1`、`带 空格`、空串照收，validate-data 也一声不吭。
    """

    def _tab(self, model: ProjectModel, channel: str = "voice"):
        from tools.editor.editors.audio_editor import AudioEditor
        ed = AudioEditor(model)
        self.addCleanup(ed.deleteLater)
        return ed.channel_tab(channel)

    def test_scan_dialog_suggests_filename_and_blocks_bad_hand_edit(self) -> None:
        from tools.editor.editors.audio_editor import _UnregisteredFilesDialog
        with TemporaryDirectory() as td:
            model, root = self._project(td)
            audio_dir = root.joinpath(*_AUDIO_REL, "说书重庆话")
            _write_wav(audio_dir / "茶馆开场_瞎子李_1.wav", 0.2)
            _write_wav(audio_dir / "说书9.wav", 0.2)
            # sfx 里先占掉「说书9」：跨频道同名是 validate-data 的 warning，
            # 建议 id 要主动绕开（拿父目录兜），不能现建现犯
            model.audio_config = {
                "bgm": {}, "ambient": {},
                "sfx": {"说书9": {"src": "/resources/runtime/audio/b.wav"}},
                "voice": {},
            }
            files = [p for p in lib.scan_unregistered_files(model) if p.stem in
                     ("茶馆开场_瞎子李_1", "说书9")]
            self.assertEqual(len(files), 2)
            dlg = _UnregisteredFilesDialog(model, "voice", sorted(files), set())
            self.addCleanup(dlg.deleteLater)
            suggested = {dlg._table.item(r, 0).text() for r in range(dlg._table.rowCount())}
            self.assertEqual(
                suggested, {"茶馆开场_瞎子李_1", "说书重庆话_说书9"},
                "建议 id 必须是文件名原样（抹掉中文只剩 '1'/'9' 是旧版的祸）；"
                "撞上别的频道时拿父目录兜，而不是 '说书9_2'",
            )
            for r in range(dlg._table.rowCount()):
                dlg._table.item(r, 0).setCheckState(Qt.CheckState.Checked)
            # 手改成非法值：不能放行，也不能静默丢
            bad_row = next(r for r in range(dlg._table.rowCount())
                           if dlg._table.item(r, 0).text() == "茶馆开场_瞎子李_1")
            dlg._table.item(bad_row, 0).setText('坏"id')
            kept = dlg.chosen()
            self.assertEqual([aid for aid, _src in kept], ["说书重庆话_说书9"])
            self.assertEqual([aid for aid, _why in dlg.rejected()], ['坏"id'])

    def test_add_and_rename_reject_bad_id(self) -> None:
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            model.audio_config = {
                "bgm": {}, "ambient": {}, "sfx": {},
                "voice": {"说书1": {"src": "/resources/runtime/audio/a.wav"}},
            }
            tab = self._tab(model)
            before = tab._table.rowCount()
            warned: list[str] = []
            # 护栏若失效，_add 会往下走到 _browse_row 弹真的文件对话框 → 测试挂死而非变红。
            # 打桩成"用户取消"，让回归干净地失败在断言上。
            with patch.object(QMessageBox, "warning",
                              side_effect=lambda *a, **k: warned.append(a[2])), \
                 patch("tools.editor.editors.audio_editor.QFileDialog.getOpenFileName",
                       return_value=("", "")), \
                 patch("tools.editor.editors.audio_editor.QInputDialog.getText",
                       return_value=("带 空格", True)):
                tab._add()
            self.assertEqual(tab._table.rowCount(), before, "非法 id 不得建行")
            self.assertTrue(warned and "不能含" in warned[0], warned)

            warned.clear()
            with patch.object(QMessageBox, "warning",
                              side_effect=lambda *a, **k: warned.append(a[2])), \
                 patch("tools.editor.editors.audio_editor.QInputDialog.getText",
                       return_value=('坏"id', True)):
                tab._rename_row(0)
            self.assertEqual(tab._table.item(0, 0).text(), "说书1", "非法新名不得落到表里")
            self.assertTrue(warned, "被挡下必须说明原因")

    def test_validator_reports_bad_and_cross_channel_ids(self) -> None:
        """validate-data 也得认同一条口径——只挡编辑器，改 JSON 绕过去就白挡了。"""
        from tools.editor.validator import validate
        with TemporaryDirectory() as td:
            model, _root = self._project(td)
            src = {"src": "/resources/runtime/audio/a.wav"}
            model.audio_config = {
                "bgm": {}, "ambient": {},
                "sfx": {"说书1": dict(src)},
                "voice": {
                    "说书1": dict(src),        # 跨频道重名 → warning
                    "带 空格": dict(src),      # → error
                    "": dict(src),             # → error
                    "正常_id": dict(src),      # 不该报
                },
                # systemSfx 是逻辑名→sfx id 的映射，键由代码定，不参与本校验
                "systemSfx": {"uiHover": "说书1"},
            }
            got = [(i.severity, i.item_id) for i in validate(model)
                   if i.data_type == "audio_config"]
            self.assertIn(("error", "voice.带 空格"), got)
            self.assertIn(("error", "voice."), got)
            self.assertIn(("warning", "说书1"), got)
            self.assertEqual(len(got), 3, f"不该多报也不该少报：{got}")


if __name__ == "__main__":
    unittest.main()
