"""界面冒烟:从导入到导出走一遍真实控件路径。

**护栏必须从最外层用户入口进**(编辑器规范·过程义务3):直接调 model 层全绿
不算证据——切片改名走的是表格 item 的信号、切点调整走的是波形区间的拖拽信号,
这两条路断了在 model 测试里一点反应都没有。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

REPO = Path(__file__).resolve().parents[3]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from unittest import mock                                       # noqa: E402

from PySide6.QtCore import Qt                                  # noqa: E402
from PySide6.QtWidgets import QApplication, QDialog, QMessageBox  # noqa: E402

from tools.voice_workbench import audio_io as aio               # noqa: E402
from tools.voice_workbench import ledger as ldg                 # noqa: E402
from tools.voice_workbench.dialogs import (                     # noqa: E402
    BatchParamsDialog, RenameDialog, TagDialog,
)
from tools.voice_workbench.project import Project, Slice, projects_dir  # noqa: E402
from tools.voice_workbench.ui import (                          # noqa: E402
    COL_NAME, COL_STATE, COL_TAGS, SCOPE_ALL, VoiceWorkbench,
)


class _SilencedBoxes:
    """把模态框打桩掉。

    **不打桩就是整跑挂死**:离屏环境下 QMessageBox.exec() 永不返回。
    本工具有两处模态——关窗的"要保存吗"和恢复自动存盘的"要恢复吗"——
    测试必然撞上(addCleanup(win.close) 就会撞)。踩过一次,10 分钟没反应。
    """

    def __init__(self, answer=QMessageBox.StandardButton.Discard):
        self._answer = answer
        self._patches = []

    def __enter__(self):
        for name, ret in (
            ("question", self._answer),
            ("warning", QMessageBox.StandardButton.Ok),
            ("information", QMessageBox.StandardButton.Ok),
        ):
            pt = mock.patch.object(QMessageBox, name, staticmethod(lambda *a, _r=ret, **k: _r))
            pt.start()
            self._patches.append(pt)
        return self

    def __exit__(self, *exc):
        for pt in self._patches:
            pt.stop()
        return False


def _raw_with_silence(path: Path) -> None:
    """三秒:说 1 秒 → 静 1 秒 → 说 1 秒。自动切分应切出两段。"""
    t = np.arange(48000 * 3) / 48000
    x = np.column_stack([0.05 * np.sin(2 * np.pi * 300 * t)] * 2)
    x[48000:96000] = 0.0
    aio.write(path, aio.Audio(x, 48000, 16))


class UiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        boxes = _SilencedBoxes()
        boxes.__enter__()
        self.addCleanup(boxes.__exit__, None, None, None)

    def test_import_split_edit_export_roundtrip(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            # **state_dir 必须给临时目录**：不给就落到工具目录，一跑测试就把
            # 真人的 ui_state.json（记着"上次开的哪个工程"）覆盖成空
            win = VoiceWorkbench(root, state_dir=root / "state")
            self.addCleanup(win.close)

            raw = root / "raw.wav"
            _raw_with_silence(raw)
            entry, is_new = win.lib.import_file(raw)
            self.assertTrue(is_new)
            win.refresh_sources()
            self.assertEqual(win.source_list.count(), 1)

            win.source_list.setCurrentRow(0)
            self._app.processEvents()
            self.assertIsNotNone(win._current_audio)

            win.split_thr.setValue(-35.0)
            win.split_gap.setValue(0.5)
            win.auto_split()
            self.assertEqual(len(win.project.slices), 2)
            self.assertEqual(win.table.rowCount(), 2)
            self.assertEqual(len(win._regions), 2, "每条切片都要有一个可拖的波形区间")

            # 表格改名 / 取消勾选:走真实 itemChanged 信号
            win.table.item(0, 1).setText("测试句1")
            self.assertEqual(win.project.slices[0].name, "测试句1")
            win.table.item(0, 0).setCheckState(Qt.CheckState.Unchecked)
            self.assertFalse(win.project.slices[0].enabled)
            win.table.item(0, 0).setCheckState(Qt.CheckState.Checked)

            # 拖波形区间改切点:走真实 sigRegionChangeFinished
            sid = win.project.slices[-1].id
            win._regions[sid].setRegion((1.2, 2.4))
            self._app.processEvents()
            moved = win.project.get(sid)
            self.assertAlmostEqual(moved.start, 1.2, places=2)
            self.assertAlmostEqual(moved.end, 2.4, places=2)

            out = root / "out"
            win.export_dir.setText(str(out))
            win.export_all()
            wavs = sorted(p.name for p in out.glob("*.wav"))
            self.assertEqual(len(wavs), 2, win.report.toPlainText())
            self.assertIn("测试句1.wav", wavs)
            self.assertIn("LUFS", win.report.toPlainText())

            path = root / "p.json"
            win.project.save(path)
            self.assertEqual(len(Project.load(path).slices), 2)

    def test_export_dir_defaults_outside_source_library(self) -> None:
        """产物与源库必须是两个地方:导出目录默认在 public 下,源库在 resources 下。
        写混了就等于"原始素材被当成成品发出去"或"成品被当成原件保管"。"""
        with TemporaryDirectory() as td:
            win = VoiceWorkbench(Path(td), state_dir=Path(td) / "state")
            self.addCleanup(win.close)
            self.assertIn("public/", win.project.settings.export_dir)
            self.assertNotIn("public", str(win.lib.root))
            self.assertIn("audio_sources", str(win.lib.root))


class ProductStateTests(unittest.TestCase):
    """产物状态这一层的界面契约:**状态是算出来的,不是勾出来的**。

    这几条锁的是用户当初抱怨的那些:分不清谁没导、谁过时;导完第一批,
    过一阵要导第二批得从头再勾一遍。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        boxes = _SilencedBoxes(QMessageBox.StandardButton.Ok)
        boxes.__enter__()
        self.addCleanup(boxes.__exit__, None, None, None)

    def _win(self, root: Path) -> VoiceWorkbench:
        """两条切片 + 一个导出目录,准备好开导。"""
        win = VoiceWorkbench(root, state_dir=root / "state")
        self.addCleanup(lambda: (win._mark_saved(), win.close()))
        raw = root / "raw.wav"
        _raw_with_silence(raw)
        win.lib.import_file(raw)
        win.refresh_sources()
        win.source_list.setCurrentRow(0)
        self._app.processEvents()
        win.split_thr.setValue(-35.0)
        win.auto_split()
        win.denoise_db.setValue(0.0)                  # 降噪慢，与本组测试无关
        win.export_dir.setText(str(root / "out"))
        win.rescan_status()
        return win

    def test_export_is_a_query_not_a_checkbox(self) -> None:
        """导第一批 → 按钮自己变成"没有要导的";加一条 → 自己变回"导出 1 条"。
        全程没有任何一个"这次导不导"的钩子要人去点。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            self.assertEqual(win.btn_export.text(), "导出 2 条")

            win.export_all()
            self.assertEqual(win.btn_export.text(), "没有要导的", win.report.toPlainText())
            self.assertEqual(len(list((root / "out").glob("*.wav"))), 2)

            win.project.add_slice(Slice(
                source=win.project.slices[0].source, start=0.1, end=0.6, name="后来加的",
            ))
            win._refresh_slices()
            self.assertEqual(win.btn_export.text(), "导出 1 条", "第二批不该要人重新打钩")

            win.export_all()
            self.assertEqual(len(list((root / "out").glob("*.wav"))), 3)

    def test_moving_a_cut_puts_it_back_in_the_queue(self) -> None:
        """改完切点,那一条必须自己回到"需要更新的"里,并且说得出为什么。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            self.assertEqual(win.btn_export.text(), "没有要导的")

            sid = win.project.slices[0].id
            win._regions[sid].setRegion((0.1, 0.9))   # 走真实的波形拖拽信号
            self._app.processEvents()
            self.assertEqual(win.btn_export.text(), "导出 1 条")
            self.assertEqual(win.status_of(win.project.get(sid)).state, ldg.STATE_STALE)
            self.assertIn("切点", win.status_of(win.project.get(sid)).reason)

    def test_state_column_tells_never_from_current(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            self.assertEqual(win.table.item(0, COL_STATE).text(), "未导出")
            win.export_all()
            self.assertEqual(win.table.item(0, COL_STATE).text(), "最新")

    def test_exporting_does_not_make_the_project_dirty(self) -> None:
        """**红线**:导出只写产物与记账,不该让工程变脏——
        "什么都没干关闭却弹保存"是编辑器规范里明写的红线。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.project_path = projects_dir(root / "state") / "p.json"
            win.save_project()
            self.assertFalse(win.is_dirty())
            win.export_all()
            self.assertFalse(win.is_dirty(), "导出之后工程不该变脏")
            self.assertTrue(win._ledger_path().is_file(), "记账要落在工程旁边")
            self.assertNotIn(
                "out_sha256", win.project_path.read_text(encoding="utf-8"),
                "记账不许混进工程 json（混了就会每次导出都翻脏）",
            )

    def test_claim_adopts_files_exported_before_the_ledger_existed(self) -> None:
        """迁移路径:先有产物、后有记账。认一次账就归位,且绝不碰音频。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            # 抹掉记账 = 回到"这套东西上线之前"的样子
            win.ledger = ldg.Ledger()
            win._refresh_slices()
            self.assertEqual(win.table.item(0, COL_STATE).text(), "来历不明")
            before = sorted(p.read_bytes() for p in (root / "out").glob("*.wav"))

            win.claim_existing()
            self.assertEqual(win.table.item(0, COL_STATE).text(), "最新")
            self.assertEqual(
                before, sorted(p.read_bytes() for p in (root / "out").glob("*.wav")),
                "认账只动记账，不许碰音频",
            )

    def test_foreign_files_are_never_overwritten_silently(self) -> None:
        """来历不明的同名文件:「需要更新的」不碰它;切到「全部」要先点头,
        点了取消就一个字节都不许动。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            win.ledger = ldg.Ledger()               # 抹账 = 变成"来历不明"
            win.rescan_status()
            self.assertEqual(win.btn_export.text(), "没有要导的", "「需要更新的」不该碰来历不明的")

            win.export_scope.setCurrentText(SCOPE_ALL)
            self.assertEqual(win.btn_export.text(), "导出 2 条")
            before = sorted(p.read_bytes() for p in (root / "out").glob("*.wav"))
            with _SilencedBoxes(QMessageBox.StandardButton.Cancel):
                win.export_all()
            self.assertEqual(
                before, sorted(p.read_bytes() for p in (root / "out").glob("*.wav")),
                "点了取消就不许覆盖别人的文件",
            )

    def test_filtering_does_not_rescan_the_disk(self) -> None:
        """筛选是敲键盘的事:每敲一个字都去扫一遍导出目录,几百条时手感就垮了。"""
        with TemporaryDirectory() as td:
            win = self._win(Path(td))
            calls = []
            with mock.patch.object(
                VoiceWorkbench, "_recompute_status",
                lambda self: calls.append(1),
            ):
                win.filter_text.setText("甲")
                win.filter_text.setText("甲乙")
                win.filter_state.setCurrentIndex(1)
            self.assertEqual(calls, [], "筛选不该触发磁盘重扫")

    def test_changing_the_export_dir_leaves_the_old_files_where_they_are(self) -> None:
        """换导出目录 = 新地方还没导过,老地方那批仍在(是孤儿,但要说得出它在哪)。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            self.assertEqual(len(list((root / "out").glob("*.wav"))), 2)

            win.export_dir.setText(str(root / "out2"))
            win.rescan_status()
            st = win.status_of(win.project.slices[0])
            self.assertEqual(st.state, ldg.STATE_NEVER)
            self.assertEqual(st.orphan, root / "out" / f"{win.project.slices[0].name}.wav")

            win.export_all()
            self.assertEqual(len(list((root / "out2").glob("*.wav"))), 2)
            self.assertEqual(len(list((root / "out").glob("*.wav"))), 2, "老目录里的不许被动")
            self.assertEqual(win.btn_export.text(), "没有要导的")

    def test_ledger_follows_save_as(self) -> None:
        """另存为要把记账一起带走,否则新工程一打开满屏"来历不明"。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            target = projects_dir(root / "state") / "另一个名字.json"
            with mock.patch(
                "tools.voice_workbench.ui.QFileDialog.getSaveFileName",
                staticmethod(lambda *a, **k: (str(target), "")),
            ):
                win.save_project_as()
            self.assertTrue(target.is_file())
            self.assertTrue(target.with_name("另一个名字.export.json").is_file())

            again = VoiceWorkbench(root, state_dir=root / "state")
            self.addCleanup(lambda: (again._mark_saved(), again.close()))
            with mock.patch(
                "tools.voice_workbench.ui.QFileDialog.getOpenFileName",
                staticmethod(lambda *a, **k: (str(target), "")),
            ):
                again.open_project()
            self.assertEqual(again.btn_export.text(), "没有要导的", "记账没跟过来就会全变来历不明")

    def test_cancel_button_actually_cancels(self) -> None:
        """原来那个取消按钮是画上去的:点了没人读。这里锁住它真的会停。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            with mock.patch(
                "tools.voice_workbench.ui.QProgressDialog.wasCanceled",
                staticmethod(lambda: True),
            ):
                win.export_all()
            self.assertEqual(len(list((root / "out").glob("*.wav"))), 0, "按了取消就一个都不该写")
            self.assertIn("取消", win.report.toPlainText())


class BatchOpsTests(unittest.TestCase):
    """多选 + 批量动作。批量操作最贵的一脚是"手滑一次全废",所以每条都要能看清再动。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        boxes = _SilencedBoxes(QMessageBox.StandardButton.Ok)
        boxes.__enter__()
        self.addCleanup(boxes.__exit__, None, None, None)

    def _win(self, root: Path) -> VoiceWorkbench:
        win = VoiceWorkbench(root, state_dir=root / "state")
        self.addCleanup(lambda: (win._mark_saved(), win.close()))
        raw = root / "raw.wav"
        _raw_with_silence(raw)
        win.lib.import_file(raw)
        win.refresh_sources()
        win.source_list.setCurrentRow(0)
        self._app.processEvents()
        win.split_thr.setValue(-35.0)
        win.auto_split()
        win.denoise_db.setValue(0.0)
        win.export_dir.setText(str(root / "out"))
        win.rescan_status()
        return win

    def test_multi_selection_is_possible_at_all(self) -> None:
        with TemporaryDirectory() as td:
            win = self._win(Path(td))
            win.table.selectAll()
            self.assertEqual(len(win._selected_slices()), 2, "这张表必须能多选")

    def test_batch_params_only_touches_what_was_ticked(self) -> None:
        """没勾「改」的项一律不动——批量面板打开就按确定不该改掉任何东西。"""
        with TemporaryDirectory() as td:
            win = self._win(Path(td))
            win.table.selectAll()

            def accept_nothing(self):
                return QDialog.DialogCode.Accepted

            before = [(s.gain_db, s.denoise, s.enabled) for s in win.project.slices]
            with mock.patch.object(BatchParamsDialog, "exec", accept_nothing):
                win.batch_params()
            self.assertEqual(
                before, [(s.gain_db, s.denoise, s.enabled) for s in win.project.slices]
            )

            def set_gain(self):
                self.gain.check.setChecked(True)
                self.gain.editor.setValue(-3.0)
                return QDialog.DialogCode.Accepted

            with mock.patch.object(BatchParamsDialog, "exec", set_gain):
                win.batch_params()
            self.assertEqual([s.gain_db for s in win.project.slices], [-3.0, -3.0])

    def test_tags_survive_the_table_and_filter_the_list(self) -> None:
        with TemporaryDirectory() as td:
            win = self._win(Path(td))
            win.table.item(0, COL_TAGS).setText("茶馆，第一幕")
            self._app.processEvents()
            self.assertEqual(win.project.slices[0].tags, ["茶馆", "第一幕"])

            win.filter_tag.setCurrentText("茶馆")
            self.assertEqual(win.table.rowCount(), 1, "按标签筛完应当只剩一条")
            win.filter_tag.setCurrentIndex(0)
            self.assertEqual(win.table.rowCount(), 2)

    def test_batch_tag_dialog_keeps_partial_state(self) -> None:
        """三态:半选＝保持原样。没有它,打开对话框按确定就会抹掉别人身上的标签。"""
        with TemporaryDirectory() as td:
            win = self._win(Path(td))
            win.table.item(0, COL_TAGS).setText("茶馆")
            self._app.processEvents()
            win.table.selectAll()
            with mock.patch.object(
                TagDialog, "exec", lambda self: QDialog.DialogCode.Accepted
            ):
                win.batch_tags()
            self.assertEqual(win.project.slices[0].tags, ["茶馆"], "半选不该抹掉已有标签")
            self.assertEqual(win.project.slices[1].tags, [], "半选也不该给没有的加上")

    def test_filter_text_narrows_the_table(self) -> None:
        with TemporaryDirectory() as td:
            win = self._win(Path(td))
            win.table.item(0, COL_NAME).setText("瞎子李_1")
            self._app.processEvents()
            win.filter_text.setText("瞎子")
            self.assertEqual(win.table.rowCount(), 1)
            win.filter_text.setText("")
            self.assertEqual(win.table.rowCount(), 2)

    def test_rename_carries_the_exported_file_along(self) -> None:
        """已导出的条目改名是**重构**:磁盘产物跟着改,状态仍是「最新」。

        不连带的话,旧文件留在盘上、仍被 audio_config 引用、内容却是旧的——
        游戏里继续放旧声音,没有任何地方报错。
        """
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            old_names = sorted(p.name for p in (root / "out").glob("*.wav"))
            self.assertEqual(len(old_names), 2)

            win.table.selectAll()

            def by_template(self):
                self.by_template.setChecked(True)
                self.template.setText("说书_{序}")
                self.width.setValue(2)
                return QDialog.DialogCode.Accepted

            with mock.patch.object(RenameDialog, "exec", by_template):
                win.batch_rename()

            self.assertEqual(
                sorted(p.name for p in (root / "out").glob("*.wav")),
                ["说书_01.wav", "说书_02.wav"],
            )
            self.assertEqual([s.name for s in win.project.slices], ["说书_01", "说书_02"])
            self.assertEqual(win.btn_export.text(), "没有要导的", "连带改名之后不该变回未导出")

    def test_rename_without_file_move_leaves_an_orphan_and_says_so(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()

            def no_file_move(self):
                self.by_replace.setChecked(True)
                self.find.setText("raw")
                self.repl.setText("改名")
                self.rename_files.setChecked(False)
                return QDialog.DialogCode.Accepted

            with mock.patch.object(RenameDialog, "exec", no_file_move):
                win.batch_rename()
            st = win.status_of(win.project.slices[0])
            self.assertEqual(st.state, ldg.STATE_NEVER)
            self.assertIsNotNone(st.orphan, "旧产物还在盘上，必须报出来")

    def test_rename_never_overwrites_an_existing_artifact(self) -> None:
        """目标文件已存在就放弃那一个并说清楚,**绝不覆盖**。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            occupied = root / "out" / "占位.wav"
            aio.write(occupied, aio.Audio(np.zeros((100, 1)), 48000, 16))
            before = occupied.read_bytes()

            win.table.clearSelection()
            win.table.selectRow(0)

            def to_occupied(self):
                self.by_template.setChecked(True)
                self.template.setText("占位")
                return QDialog.DialogCode.Accepted

            with mock.patch.object(RenameDialog, "exec", to_occupied):
                win.batch_rename()
            self.assertEqual(before, occupied.read_bytes(), "已有文件绝不许被改名覆盖掉")

    def test_delete_never_removes_exported_audio(self) -> None:
        """删切片只删工程里的条目。盘上的产物可能正被 audio_config 引用着,不许连带删。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win(root)
            win.export_all()
            win.table.selectAll()
            win.delete_selected()
            self.assertEqual(win.project.slices, [])
            self.assertEqual(len(list((root / "out").glob("*.wav"))), 2, "磁盘产物必须原样留着")


if __name__ == "__main__":
    unittest.main()


class PersistenceTests(unittest.TestCase):
    """切好的片段不能因为"忘了 Ctrl+S"就没了——四条路各锁一次。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        boxes = _SilencedBoxes()
        boxes.__enter__()
        self.addCleanup(boxes.__exit__, None, None, None)

    def _win_with_slices(self, root: Path) -> VoiceWorkbench:
        win = VoiceWorkbench(root, state_dir=root / "state")
        self.addCleanup(win.close)
        raw = root / "raw.wav"
        _raw_with_silence(raw)
        entry, _ = win.lib.import_file(raw)
        win.refresh_sources()
        win.source_list.setCurrentRow(0)
        self._app.processEvents()
        win.split_thr.setValue(-35.0)
        win.auto_split()
        return win

    def test_edits_make_the_project_dirty(self) -> None:
        """脏态按内容比对,不靠"每处改动记得登记"——漏一处就是静默丢数据。"""
        with TemporaryDirectory() as td:
            win = self._win_with_slices(Path(td))
            self.assertTrue(win.is_dirty(), "切完还没存，必须是脏的")
            p = Path(td) / "p.json"
            win.project_path = p
            win.save_project()
            self.assertFalse(win.is_dirty(), "存过之后不该还是脏的")
            win.table.item(0, 1).setText("改个名")
            self.assertTrue(win.is_dirty(), "改名之后必须重新变脏")

    def test_autosave_writes_without_touching_the_project_file(self) -> None:
        """自动存盘只写 .autosave/：替用户覆盖工程本体等于替他做决定。"""
        with TemporaryDirectory() as td:
            win = self._win_with_slices(Path(td))
            p = Path(td) / "p.json"
            win.project_path = p
            win.save_project()
            win.table.item(0, 1).setText("改过了")
            win._autosave()
            self.assertTrue(win._autosave_path().is_file())
            self.assertNotIn("改过了", p.read_text(encoding="utf-8"), "工程本体不该被自动存盘改写")
            self.assertIn("改过了", win._autosave_path().read_text(encoding="utf-8"))

    def test_last_project_is_reopened_next_launch(self) -> None:
        """下次启动接着上次干:不然每次开工具都要先想起来"上次那个工程叫啥"。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._win_with_slices(root)
            p = projects_dir(root / "state") / "s.json"
            win.project_path = p
            win.project.name = p.stem
            win.save_project()
            n = len(win.project.slices)
            win.close()

            again = VoiceWorkbench(root, state_dir=root / "state")
            self.addCleanup(again.close)
            self.assertTrue(again.load_last_project(), "应当能载回上次的工程")
            self.assertEqual(again.project_path, p)
            self.assertEqual(len(again.project.slices), n)
            self.assertFalse(again.is_dirty(), "刚载入不该是脏的（否则关窗白弹一次保存）")


class CloseGuardTests(unittest.TestCase):
    """关窗路径:切好的片段是人一刀一刀拖出来的,不许静默丢。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def _dirty_win(self, root: Path) -> VoiceWorkbench:
        win = VoiceWorkbench(root, state_dir=root / "state")
        raw = root / "raw.wav"
        _raw_with_silence(raw)
        win.lib.import_file(raw)
        win.refresh_sources()
        win.source_list.setCurrentRow(0)
        self._app.processEvents()
        win.split_thr.setValue(-35.0)
        win.auto_split()
        win.project_path = projects_dir(root / "state") / "p.json"
        return win

    def test_cancel_keeps_the_window_open(self) -> None:
        """选「取消」= 我还想继续干:窗口必须留着,数据必须还在。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._dirty_win(root)
            self.addCleanup(lambda: (win._mark_saved(), win.close()))
            n = len(win.project.slices)
            with _SilencedBoxes(QMessageBox.StandardButton.Cancel):
                closed = win.close()
            self.assertFalse(closed, "选取消不该关掉窗口")
            self.assertEqual(len(win.project.slices), n, "取消之后数据必须原封不动")

    def test_save_on_close_actually_writes(self) -> None:
        """选「保存」= 存下来再走:文件必须真的落盘,内容必须对得上。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._dirty_win(root)
            n = len(win.project.slices)
            with _SilencedBoxes(QMessageBox.StandardButton.Save):
                win.close()
            self.assertTrue(win.project_path.is_file(), "选了保存就必须真的写出文件")
            self.assertEqual(len(Project.load(win.project_path).slices), n)

    def test_clean_project_closes_without_asking(self) -> None:
        """没改过东西就别弹框——"什么都没干关闭却弹保存"是编辑器红线。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = self._dirty_win(root)
            win.save_project()
            asked = []
            with mock.patch.object(
                QMessageBox, "question",
                staticmethod(lambda *a, **k: asked.append(1) or QMessageBox.StandardButton.Discard),
            ):
                win.close()
            self.assertEqual(asked, [], "干净工程关窗不该问任何问题")


class WaveformViewTests(unittest.TestCase):
    """波形纵轴是"音量刻度",不是可缩放视图。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_y_axis_is_locked_to_full_scale(self) -> None:
        """纵轴必须锁死:不锁的话中键/滚轮会连纵轴一起缩,
        反复缩放后波形被压成一根直线,看起来像素材坏了（用户实际踩到过）。"""
        with TemporaryDirectory() as td:
            root = Path(td)
            win = VoiceWorkbench(root, state_dir=root / "state")
            self.addCleanup(win.close)
            vb = win.plot.getViewBox()
            self.assertFalse(vb.state["mouseEnabled"][1], "纵轴不许跟随鼠标缩放")

            raw = root / "raw.wav"
            _raw_with_silence(raw)
            win.lib.import_file(raw)
            win.refresh_sources()
            win.source_list.setCurrentRow(0)
            self._app.processEvents()

            before = vb.viewRange()[1]
            # 模拟反复中键缩放：直接按 pyqtgraph 的缩放入口打，纵轴应纹丝不动
            for _ in range(8):
                vb.scaleBy((1.6, 1.6))
                self._app.processEvents()
            after = vb.viewRange()[1]
            self.assertAlmostEqual(before[0], after[0], places=3, msg="纵轴被缩放了")
            self.assertAlmostEqual(before[1], after[1], places=3, msg="纵轴被缩放了")
            self.assertGreater(after[1] - after[0], 1.5, "纵轴应始终覆盖 ±1 满刻度")
