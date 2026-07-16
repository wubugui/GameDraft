"""过场编辑器 2026-07-14 审查修复回归（E 组 / T-过场）。

覆盖：
- P1-17 切换 kind / present 类型确认清空前压撤销快照（弹窗承诺「可用 Ctrl+Z 撤销」兑现）；
- P2-① 脏数据步骤（未知 kind / 非 dict 并行轨）展开不炸、to_dict/Apply 原样透传；
- P2-② Apply 成功后自动跑本过场校验，error 在状态区标红但不阻断；
- P2-③ 过场 id 改名守卫：空 id 拒绝、撞已有 id 需确认；
- P3   撤销/重做恢复顶层展开态；绑定表单 targetX/Y 数值保真（int 保 int）；
       parallel 子轨 contentChanged 统一汇入编辑器 _on_any_outline_changed。
"""
from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.timeline_editor import TimelineEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _make_model(td: str) -> ProjectModel:
    root = Path(td) / "p"
    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    return model


def _select_kind(sw, kind: str) -> None:
    """通过 combo 触发 _on_kind_changed（与用户操作同路径）。"""
    for i in range(sw._kind_combo.count()):
        if sw._kind_combo.itemData(i) == kind:
            sw._kind_combo.setCurrentIndex(i)
            return
    raise AssertionError(f"kind combo 无 {kind!r} 项")


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.model = _make_model(self._td.name)

    def tearDown(self) -> None:
        self._td.cleanup()


class TestTypeSwitchUndo(_Base):
    """P1-17：切错类型确认清空后，Ctrl+Z 必须还原参数。"""

    def test_kind_switch_then_undo_restores_params(self) -> None:
        step = {"kind": "present", "type": "showTitle", "text": "第一天", "duration": 2000}
        self.model.cutscenes[0]["steps"] = [deepcopy(step)]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)
        sw = ed._step_outlines[0]._step
        with patch.object(
            QMessageBox, "question",
            return_value=QMessageBox.StandardButton.Yes,
        ):
            _select_kind(sw, "action")
        self.assertEqual(ed._step_outlines[0].to_dict().get("kind"), "action")
        self.assertEqual(len(ed._undo_stack), 1, "确认清空前必须压撤销快照")
        ed.undo_last_structural()
        self.assertEqual(
            ed._step_outlines[0].to_dict(), step,
            "Ctrl+Z 后应还原切换前的完整参数（弹窗承诺的撤销）",
        )

    def test_present_type_switch_then_undo_restores_params(self) -> None:
        step = {"kind": "present", "type": "showTitle", "text": "火起", "duration": 1500}
        self.model.cutscenes[0]["steps"] = [deepcopy(step)]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)
        sw = ed._step_outlines[0]._step
        with patch.object(
            QMessageBox, "question",
            return_value=QMessageBox.StandardButton.Yes,
        ):
            sw._type_combo.set_committed_type("waitTime", emit=True)
        self.assertEqual(ed._step_outlines[0].to_dict().get("type"), "waitTime")
        self.assertEqual(len(ed._undo_stack), 1, "确认清空前必须压撤销快照")
        ed.undo_last_structural()
        self.assertEqual(ed._step_outlines[0].to_dict(), step)

    def test_cancel_switch_pushes_nothing(self) -> None:
        step = {"kind": "present", "type": "showTitle", "text": "别切", "duration": 800}
        self.model.cutscenes[0]["steps"] = [deepcopy(step)]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)
        sw = ed._step_outlines[0]._step
        with patch.object(
            QMessageBox, "question",
            return_value=QMessageBox.StandardButton.No,
        ):
            _select_kind(sw, "parallel")
        self.assertEqual(ed._step_outlines[0].to_dict(), step, "取消切换不得改数据")
        self.assertEqual(len(ed._undo_stack), 0, "取消切换不应压快照")


class TestDirtyDataPassthrough(_Base):
    """P2-①：未知 kind / 非 dict 并行轨展开不炸，to_dict / Apply 原样透传。"""

    BAD_KIND = {"kind": "showDialog", "text": "错拼 kind", "duration": 500}
    BAD_PARALLEL = {"kind": "parallel", "tracks": [
        "oops",
        {"kind": "present", "type": "waitTime", "duration": 300},
    ]}

    def test_expand_and_to_dict_passthrough(self) -> None:
        self.model.cutscenes[0]["steps"] = [
            deepcopy(self.BAD_KIND), deepcopy(self.BAD_PARALLEL),
        ]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)  # 旧实现在此抛 AttributeError
        self.assertEqual(ed._step_outlines[0].to_dict(), self.BAD_KIND)
        self.assertEqual(ed._step_outlines[1].to_dict(), self.BAD_PARALLEL)

    def test_apply_keeps_dirty_steps_intact(self) -> None:
        self.model.cutscenes[0]["steps"] = [
            deepcopy(self.BAD_KIND), deepcopy(self.BAD_PARALLEL),
        ]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)
        self.assertTrue(ed._apply(), "脏数据步不应让 Apply 静默失败")
        self.assertEqual(self.model.cutscenes[0]["steps"][0], self.BAD_KIND)
        self.assertEqual(self.model.cutscenes[0]["steps"][1], self.BAD_PARALLEL)

    def test_switch_away_from_unknown_kind_confirms_and_undoable(self) -> None:
        self.model.cutscenes[0]["steps"] = [deepcopy(self.BAD_KIND)]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)
        sw = ed._step_outlines[0]._step
        with patch.object(
            QMessageBox, "question",
            return_value=QMessageBox.StandardButton.Yes,
        ) as q:
            _select_kind(sw, "present")
        q.assert_called_once()  # 未知 kind 带内容也要确认，不能静默清空
        ed.undo_last_structural()
        self.assertEqual(ed._step_outlines[0].to_dict(), self.BAD_KIND)


class TestApplyGuards(_Base):
    """P2-③：Apply 时空 id 拒绝、撞已有 id 需确认。"""

    def test_empty_id_rejected(self) -> None:
        self.model.cutscenes.append({"id": "cut_b", "steps": []})
        ed = TimelineEditor(self.model)
        ed._on_select(1)
        ed._c_id.setText("   ")
        with patch.object(QMessageBox, "warning") as warn:
            self.assertFalse(ed._apply())
        warn.assert_called_once()
        self.assertEqual(self.model.cutscenes[1]["id"], "cut_b")

    def test_duplicate_id_needs_confirm(self) -> None:
        self.model.cutscenes.append({"id": "cut_b", "steps": []})
        ed = TimelineEditor(self.model)
        ed._on_select(1)
        ed._c_id.setText("cut_ok")  # 与 cutscenes[0] 撞
        with patch.object(
            QMessageBox, "question",
            return_value=QMessageBox.StandardButton.No,
        ):
            self.assertFalse(ed._apply())
        self.assertEqual(self.model.cutscenes[1]["id"], "cut_b")
        with patch.object(
            QMessageBox, "question",
            return_value=QMessageBox.StandardButton.Yes,
        ):
            self.assertTrue(ed._apply())
        self.assertEqual(self.model.cutscenes[1]["id"], "cut_ok")

    def test_unchanged_id_applies_without_prompt(self) -> None:
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        with patch.object(QMessageBox, "question") as q:
            self.assertTrue(ed._apply())
        q.assert_not_called()


class TestApplyAutoValidation(_Base):
    """P2-②：Apply 成功后自动校验，error 标红提示但不阻断。"""

    def test_apply_with_error_steps_marks_red_but_succeeds(self) -> None:
        # animLayer 缺 animFile → validator error
        self.model.cutscenes[0]["steps"] = [{"kind": "present", "type": "animLayer"}]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        self.assertTrue(ed._apply(), "校验 error 只提示，不阻断 Apply")
        self.assertIn("错误", ed._validate_summary.text())
        self.assertIn("e03131", ed._validate_summary.styleSheet())

    def test_apply_clean_steps_resets_style(self) -> None:
        self.model.cutscenes[0]["steps"] = [
            {"kind": "present", "type": "waitTime", "duration": 500},
        ]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        self.assertTrue(ed._apply())
        self.assertIn("无问题", ed._validate_summary.text())
        self.assertNotIn("e03131", ed._validate_summary.styleSheet())


class TestUndoRestoresExpandedState(_Base):
    """P3：撤销/重做快照记录并恢复顶层展开态。"""

    def test_undo_restores_expanded_rows(self) -> None:
        self.model.cutscenes[0]["steps"] = [
            {"kind": "present", "type": "waitTime", "duration": 500},
            {"kind": "present", "type": "waitTime", "duration": 800},
        ]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._step_outlines[0].set_collapsed(False)
        ed._add_step("present")  # 压快照：2 步、第 0 步展开
        ed._set_all_step_collapsed(True)
        ed.undo_last_structural()
        self.assertEqual(len(ed._step_outlines), 2)
        self.assertFalse(ed._step_outlines[0]._collapsed, "撤销应恢复编辑现场的展开态")
        self.assertTrue(ed._step_outlines[1]._collapsed)

    def test_redo_restores_state_too(self) -> None:
        self.model.cutscenes[0]["steps"] = [
            {"kind": "present", "type": "waitTime", "duration": 500},
        ]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._add_step("present")
        ed._step_outlines[1].set_collapsed(False)
        ed.undo_last_structural()   # 回到 1 步
        self.assertEqual(len(ed._step_outlines), 1)
        ed.redo_last_structural()   # 重做回 2 步，且撤销时的展开态被恢复
        self.assertEqual(len(ed._step_outlines), 2)
        self.assertFalse(ed._step_outlines[1]._collapsed)


class TestBindingNumericFidelity(_Base):
    """P3：绑定表单 targetX/Y 数值保真（int 保 int、未改动的 float 保 float）。"""

    def test_new_integral_values_written_as_int(self) -> None:
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._pos_chk.setChecked(True)
        ed._target_x.setValue(100.0)
        ed._target_y.setValue(250.5)
        self.assertTrue(ed._apply())
        cs = self.model.cutscenes[0]
        self.assertEqual(cs["targetX"], 100)
        self.assertIs(type(cs["targetX"]), int, "100 不得漂成 100.0")
        self.assertEqual(cs["targetY"], 250.5)

    def test_unchanged_values_keep_original_repr(self) -> None:
        cs = self.model.cutscenes[0]
        cs["targetX"] = 100.0  # 磁盘上本就是 float
        cs["targetY"] = 7      # 磁盘上本就是 int
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        self.assertTrue(ed._apply())
        self.assertIs(type(cs["targetX"]), float, "未改动的 100.0 应保持 float")
        self.assertIs(type(cs["targetY"]), int, "未改动的 7 应保持 int")


class TestParallelChildSignalWiring(_Base):
    """P3：parallel 子轨 contentChanged 统一汇入 _on_any_outline_changed。"""

    def test_child_edit_triggers_overlay_refresh_debounce(self) -> None:
        self.model.cutscenes[0]["steps"] = [{"kind": "parallel", "tracks": [
            {"kind": "present", "type": "waitTime", "duration": 500},
        ]}]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)
        child_sw = ed._step_outlines[0]._step._child_outlines[0]._step
        ed._overlay_id_selectors_debounce.stop()
        ed._index_refresh_debounce.stop()
        child_sw._emit_dirty()
        self.assertTrue(
            ed._overlay_id_selectors_debounce.isActive(),
            "并行子轨内容变化应触发 overlay id 候选池去抖刷新（与顶层步一致）",
        )

    def test_added_track_wired_the_same_way(self) -> None:
        self.model.cutscenes[0]["steps"] = [{"kind": "parallel", "tracks": []}]
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        ed._set_all_step_collapsed(False)
        par_sw = ed._step_outlines[0]._step
        par_sw._add_parallel_track()
        new_ol = par_sw._child_outlines[-1]
        ed._overlay_id_selectors_debounce.stop()
        ed._index_refresh_debounce.stop()
        new_ol.contentChanged.emit()
        self.assertTrue(ed._overlay_id_selectors_debounce.isActive())


if __name__ == "__main__":
    unittest.main()
