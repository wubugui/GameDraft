"""切页时的跨编辑器同步：①离开页先提交 staging，②进入页真刷新引用候选。

历史缺陷（"给场景实体配置的任何东西都要重启编辑器才在别处看得到"）有两层根因：

1. **改动没进模型**：场景编辑器属性面板是 staging + 「应用」模式，commit-on-leave 只在
   编辑器**内部**切实体/切场景时触发；切到别的编辑器页不提交，模型里根本没有这次配置。
2. **候选是构造期快照**：``ActionRow`` 的 ``IdRefSelector`` 候选在 ``_rebuild_params()``
   时一次性 ``set_items``，而 ``set_project_context`` 在 model/scene 未变时短路——别处新增的
   实体/物品/flag 不重建行就看不见。且约 12 个编辑页压根没有顶层 ``reload_refs_from_model``
   钩子（鸭子协议缺钩子静默跳过），只能靠主窗的子控件兜底扫描。

本探针从最外层入口（``_on_stack_page_changed``）进，断言两层都被堵住。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QDialog, QVBoxLayout, QWidget

from tools.editor import main_window
from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import (
    ActionEditor,
    bump_reference_refresh_epoch,
    outermost_action_editors,
)
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class _HostPage(QWidget):
    """模拟"没有顶层 reload_refs_from_model 钩子"的老编辑页（过场/档案/物品…那一类）。"""

    def __init__(self, editor: ActionEditor) -> None:
        super().__init__()
        layout = QVBoxLayout(self)
        layout.addWidget(editor)


class TestActionEditorCandidateRefresh(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    @staticmethod
    def _npc_candidate_ids(editor: ActionEditor) -> list[str]:
        """当前行里 showEmote 目标选择器的候选 id（构造期快照 vs 重建后的真值）。"""
        row = editor._rows[0]
        widget = row._param_widgets.get("target")
        ids = getattr(widget, "_ids", None)
        if ids is None:  # 弹窗式选择器：懒查 provider，本探针只针对下拉快照
            return []
        return [str(i) for i in ids]

    def test_reload_refs_rebuilds_stale_dropdown_candidates(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            sid = next(iter(model.scenes.keys()))
            model.scenes[sid].setdefault("npcs", []).append(
                {"id": "n0", "name": "N0", "x": 1, "y": 1, "interactionRange": 50})
            editor = ActionEditor("Actions")
            try:
                editor.set_project_context(model, sid)
                editor.set_data([{"type": "showEmote", "params": {"target": "n0", "emote": "!"}}])
                self.assertIn("n0", self._npc_candidate_ids(editor))

                # 别处（场景编辑器）新增了一个 NPC：不重建的话候选里看不到
                model.scenes[sid]["npcs"].append(
                    {"id": "n1", "name": "N1", "x": 2, "y": 2, "interactionRange": 50})
                editor.set_project_context(model, sid)   # 上下文没变 → 短路，候选仍陈旧
                self.assertNotIn("n1", self._npc_candidate_ids(editor))

                bump_reference_refresh_epoch()
                editor.reload_refs_from_model()
                self.assertIn("n1", self._npc_candidate_ids(editor))
            finally:
                editor.deleteLater()
                self._qt_app.processEvents()

    def test_reload_refs_preserves_action_payload_verbatim(self) -> None:
        """重建行不得改动数据：内容逐字不变，数值表示不漂移（往返保真契约）。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            sid = next(iter(model.scenes.keys()))
            model.scenes[sid].setdefault("npcs", []).append(
                {"id": "n0", "name": "N0", "x": 1, "y": 1, "interactionRange": 50})
            actions = [
                {"type": "showEmote", "params": {"target": "n0", "emote": "!"}},
                {"type": "setFlag", "params": {"key": "已听书", "value": True}},
                {"type": "giveItem", "params": {"itemId": "i_missing", "count": 3}},
            ]
            editor = ActionEditor("Actions")
            try:
                editor.set_project_context(model, sid)
                editor.set_data(actions)
                before = editor.to_list()
                bump_reference_refresh_epoch()
                editor.reload_refs_from_model()
                self.assertEqual(editor.to_list(), before)
                # 幂等：再刷一轮仍逐字不变
                bump_reference_refresh_epoch()
                editor.reload_refs_from_model()
                self.assertEqual(editor.to_list(), before)
            finally:
                editor.deleteLater()
                self._qt_app.processEvents()

    def test_reload_refs_is_deduped_within_one_epoch(self) -> None:
        """同一轮刷新里顶层钩子与主窗兜底扫描会打到同一个编辑器：只准重建一次。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            editor = ActionEditor("Actions")
            try:
                editor.set_project_context(model, None)
                editor.set_data([{"type": "setFlag", "params": {"key": "k", "value": True}}])
                bump_reference_refresh_epoch()
                editor.reload_refs_from_model()
                row_after_first = editor._rows[0]
                editor.reload_refs_from_model()
                self.assertIs(editor._rows[0], row_after_first, "同一代号内不得重复重建")
                bump_reference_refresh_epoch()
                editor.reload_refs_from_model()
                self.assertIsNot(editor._rows[0], row_after_first, "新一轮必须真刷新")
            finally:
                editor.deleteLater()
                self._qt_app.processEvents()

    def test_outermost_action_editors_skips_nested_children(self) -> None:
        """兜底扫描只能碰最外层：重建外层会销毁嵌套子编辑器，再调方法就是 RuntimeError。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            editor = ActionEditor("Actions")
            page = _HostPage(editor)
            try:
                editor.set_project_context(model, None)
                # addDelayedEvent 会建出嵌套 ActionEditor
                editor.set_data([{"type": "addDelayedEvent", "params": {"delay": 1, "actions": [
                    {"type": "setFlag", "params": {"key": "k", "value": True}},
                ]}}])
                nested = [e for e in page.findChildren(ActionEditor) if e is not editor]
                self.assertTrue(nested, "样本必须真的含嵌套 ActionEditor，否则本断言是空的")
                self.assertEqual(outermost_action_editors(page), [editor])
            finally:
                page.deleteLater()
                self._qt_app.processEvents()

    def test_sweep_skips_when_model_untouched_but_not_after_an_edit(self) -> None:
        """来回切页不该反复重建（重建不便宜）；但模型一改，下次切页必须真刷新。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            sid = next(iter(model.scenes.keys()))
            model.scenes[sid].setdefault("npcs", []).append(
                {"id": "n0", "name": "N0", "x": 1, "y": 1, "interactionRange": 50})
            editor = ActionEditor("Actions")
            page = _HostPage(editor)
            owner = SimpleNamespace(
                _status=SimpleNamespace(showMessage=lambda *_a: None),
                _model_revision=0,
                _page_refresh_revisions={},
            )
            try:
                editor.set_project_context(model, sid)
                editor.set_data([{"type": "showEmote", "params": {"target": "n0", "emote": "!"}}])

                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                row_after_first = editor._rows[0]

                bump_reference_refresh_epoch()   # 数据没动：整轮应当跳过
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                self.assertIs(editor._rows[0], row_after_first, "模型没变时不该重建")

                model.scenes[sid]["npcs"].append(
                    {"id": "n1", "name": "N1", "x": 2, "y": 2, "interactionRange": 50})
                owner._model_revision += 1        # mark_dirty → data_changed → 水位推进
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                self.assertIn("n1", self._npc_candidate_ids(editor), "模型改过就必须真刷新")
            finally:
                page.deleteLater()
                self._qt_app.processEvents()

    def test_focused_editor_is_deferred_and_not_marked_refreshed(self) -> None:
        """正在打字的动作编辑器不重建（不抢焦点/光标）；且**不能**因此被水位固化成永久陈旧。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            sid = next(iter(model.scenes.keys()))
            model.scenes[sid].setdefault("npcs", []).append(
                {"id": "n0", "name": "N0", "x": 1, "y": 1, "interactionRange": 50})
            editor = ActionEditor("Actions")
            page = _HostPage(editor)
            owner = SimpleNamespace(
                _status=SimpleNamespace(showMessage=lambda *_a: None),
                _model_revision=1,
                _page_refresh_revisions={},
            )
            page.show()
            try:
                editor.set_project_context(model, sid)
                editor.set_data([{"type": "showEmote", "params": {"target": "n0", "emote": "!"}}])
                row_before = editor._rows[0]
                target = editor._rows[0]._param_widgets.get("emote") or editor._rows[0]
                target.setFocus()
                self._qt_app.processEvents()
                if not editor.isAncestorOf(QApplication.focusWidget() or page):
                    self.skipTest("离屏平台拿不到键盘焦点，跳过该分支")

                model.scenes[sid]["npcs"].append(
                    {"id": "n1", "name": "N1", "x": 2, "y": 2, "interactionRange": 50})
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                self.assertIs(editor._rows[0], row_before, "有焦点时不该重建")
                self.assertNotIn(id(page), owner._page_refresh_revisions,
                                 "跳过的一轮不得记水位，否则永远刷不到了")

                target.clearFocus()
                self._qt_app.processEvents()
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                self.assertIn("n1", self._npc_candidate_ids(editor), "焦点离开后必须补上")
            finally:
                page.hide()
                page.deleteLater()
                self._qt_app.processEvents()

    def test_rebuild_preserves_row_fold_state(self) -> None:
        """展开/折叠是用户的阅读状态：内部重建不得把展开着的行全折回去。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            editor = ActionEditor("Actions")
            try:
                editor.set_project_context(model, None)
                editor.set_data([
                    {"type": "setFlag", "params": {"key": "a", "value": True}},
                    {"type": "setFlag", "params": {"key": "b", "value": True}},
                    {"type": "setFlag", "params": {"key": "c", "value": True}},
                ])
                # 多行默认折叠；用户手动展开中间那行
                editor._rows[1]._on_fold_clicked()
                before = [r.fold_state() for r in editor._rows]
                self.assertEqual(before, [True, False, True], "前提：只有第二行是展开的")

                bump_reference_refresh_epoch()
                editor.reload_refs_from_model()
                self.assertEqual([r.fold_state() for r in editor._rows], before)
            finally:
                editor.deleteLater()
                self._qt_app.processEvents()

    def test_never_rebuilds_while_a_modal_is_open(self) -> None:
        """有模态框开着时绝不重建——重建会 free 掉挂在行上的栈上 QMessageBox → 进程 abort。

        触发面不是理论：刷新入口里有不受模态阻塞的定时器（外置图对话编辑器退出轮询 700ms、
        窗口激活 singleShot），用户在 action 行上开着「切换类型」确认框、切走再关掉外置编辑器
        就会撞上。焦点守卫挡不住（应用一失活 focusWidget 就是 None）。
        """
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            sid = next(iter(model.scenes.keys()))
            model.scenes[sid].setdefault("npcs", []).append(
                {"id": "n0", "name": "N0", "x": 1, "y": 1, "interactionRange": 50})
            editor = ActionEditor("Actions")
            page = _HostPage(editor)
            owner = SimpleNamespace(
                _status=SimpleNamespace(showMessage=lambda *_a: None),
                _model_revision=1,
                _page_refresh_revisions={},
            )
            modal = QDialog(editor)          # parent=行所在编辑器，与真实弹窗同形
            modal.setModal(True)
            page.show()
            modal.show()
            self._qt_app.processEvents()
            try:
                editor.set_project_context(model, sid)
                editor.set_data([{"type": "showEmote", "params": {"target": "n0", "emote": "!"}}])
                row_before = editor._rows[0]
                if QApplication.activeModalWidget() is None:
                    self.skipTest("离屏平台没有活动模态窗口，跳过该分支")

                model.scenes[sid]["npcs"].append(
                    {"id": "n1", "name": "N1", "x": 2, "y": 2, "interactionRange": 50})
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                self.assertIs(editor._rows[0], row_before, "模态开着时不得重建")
                self.assertNotIn(id(page), owner._page_refresh_revisions,
                                 "让路的一轮不记水位")
                # 直接调 ActionEditor 的钩子也得拦住（编辑器自己的 reload 钩子会走这条）
                bump_reference_refresh_epoch()
                editor.reload_refs_from_model()
                self.assertIs(editor._rows[0], row_before, "重建闸必须在 ActionEditor 自身这层")

                modal.close()
                self._qt_app.processEvents()
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                self.assertIn("n1", self._npc_candidate_ids(editor), "弹窗关掉后必须补上")
            finally:
                modal.deleteLater()
                page.hide()
                page.deleteLater()
                self._qt_app.processEvents()

    def test_force_bypasses_the_revision_gate(self) -> None:
        """磁盘侧变化（外置图对话编辑器）不经 mark_dirty，force 必须绕过水位。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            editor = ActionEditor("Actions")
            page = _HostPage(editor)
            owner = SimpleNamespace(
                _status=SimpleNamespace(showMessage=lambda *_a: None),
                _model_revision=0,
                _page_refresh_revisions={},
            )
            try:
                editor.set_project_context(model, None)
                editor.set_data([{"type": "setFlag", "params": {"key": "k", "value": True}}])
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)
                first = editor._rows[0]
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page, force=True)
                self.assertIsNot(editor._rows[0], first)
            finally:
                page.deleteLater()
                self._qt_app.processEvents()

    def test_page_sweep_refreshes_editor_without_top_level_hook(self) -> None:
        """没有顶层钩子的页：主窗兜底扫描必须把它内嵌的 ActionEditor 也刷新掉。"""
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            sid = next(iter(model.scenes.keys()))
            model.scenes[sid].setdefault("npcs", []).append(
                {"id": "n0", "name": "N0", "x": 1, "y": 1, "interactionRange": 50})
            editor = ActionEditor("Actions")
            page = _HostPage(editor)
            try:
                editor.set_project_context(model, sid)
                editor.set_data([{"type": "showEmote", "params": {"target": "n0", "emote": "!"}}])
                self.assertFalse(hasattr(page, "reload_refs_from_model"))

                model.scenes[sid]["npcs"].append(
                    {"id": "n1", "name": "N1", "x": 2, "y": 2, "interactionRange": 50})
                owner = SimpleNamespace(_status=SimpleNamespace(showMessage=lambda *_a: None))
                bump_reference_refresh_epoch()
                main_window.MainWindow._refresh_page_reference_candidates(owner, page)

                self.assertIn("n1", self._npc_candidate_ids(editor))
            finally:
                page.deleteLater()
                self._qt_app.processEvents()


class TestLeavingPageCommitsStaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _scene_editor(self, root: Path) -> tuple[SceneEditor, ProjectModel, str]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        sid = next(iter(model.scenes.keys()))
        model.scenes[sid].setdefault("npcs", []).append(
            {"id": "n0", "name": "N0", "x": 100, "y": 100, "interactionRange": 50})
        editor = SceneEditor(model)
        editor._load_scene(sid)
        return editor, model, sid

    def _settle_and_close(self, editor: SceneEditor) -> None:
        canvas = getattr(editor, "_canvas", None)
        if canvas is not None:
            canvas._auto_fit_after_layout = False
            canvas._fit_layout_token += 1
        self._qt_app.processEvents()
        QTest.qWait(360)
        self._qt_app.processEvents()
        editor.close()
        editor.deleteLater()
        self._qt_app.processEvents()

    def test_scene_entity_edit_reaches_model_when_switching_pages(self) -> None:
        with TemporaryDirectory() as td:
            editor, model, sid = self._scene_editor(Path(td) / "p")
            other = QWidget()
            try:
                editor._canvas._entity_items["npc:n0"].setSelected(True)
                editor._on_item_selected("npc", "n0")
                self._qt_app.processEvents()
                editor._props._npc_name.setText("配好的名字")
                self._qt_app.processEvents()
                self.assertEqual(model.scenes[sid]["npcs"][0]["name"], "N0",
                                 "前提：未应用编辑此刻确实还没进模型")

                owner = SimpleNamespace(
                    _editor_instances=[editor, other],
                    _editor_labels=["场景", "别的页"],
                    _status=SimpleNamespace(showMessage=lambda *_a: None),
                )
                main_window.MainWindow._commit_leaving_page(owner, 0)

                self.assertEqual(model.scenes[sid]["npcs"][0]["name"], "配好的名字")
            finally:
                other.deleteLater()
                self._settle_and_close(editor)

    def test_page_switch_commit_is_undoable_like_every_other_leave_path(self) -> None:
        """切页提交必须记进场景撤销栈。

        编辑器内部所有离开路径（切实体/切场景/点空白/新增/拖拽前）都走
        `_undo_flush_pending_as_command` 记成独立命令。切页若裸提交，同一个"离开当前编辑"
        动作就有两套撤销语义，且这次写入不在栈顶命令的 after 快照里——一次 撤销+重做
        会把策划刚配好的东西静默还原掉。
        """
        with TemporaryDirectory() as td:
            editor, model, sid = self._scene_editor(Path(td) / "p")
            other = QWidget()
            owner = SimpleNamespace(
                _editor_instances=[editor, other],
                _editor_labels=["场景", "别的页"],
                _status=SimpleNamespace(showMessage=lambda *_a: None),
            )
            try:
                editor._canvas._entity_items["npc:n0"].setSelected(True)
                editor._on_item_selected("npc", "n0")
                self._qt_app.processEvents()
                editor._props._npc_name.setText("切页时配的名字")
                self._qt_app.processEvents()

                depth_before = editor._undo.stack.count()
                main_window.MainWindow._commit_leaving_page(owner, 0)
                self.assertEqual(model.scenes[sid]["npcs"][0]["name"], "切页时配的名字")
                self.assertGreater(editor._undo.stack.count(), depth_before,
                                   "切页提交必须入撤销栈")

                editor._undo.stack.undo()
                self._qt_app.processEvents()
                self.assertEqual(model.scenes[sid]["npcs"][0]["name"], "N0", "撤销要能退回去")
                editor._undo.stack.redo()
                self._qt_app.processEvents()
                self.assertEqual(model.scenes[sid]["npcs"][0]["name"], "切页时配的名字",
                                 "重做要能回来——不能被静默吃掉")
            finally:
                other.deleteLater()
                self._settle_and_close(editor)

    def test_leaving_page_without_the_hook_is_silently_skipped(self) -> None:
        plain = QWidget()
        owner = SimpleNamespace(
            _editor_instances=[plain],
            _editor_labels=["无钩子页"],
            _status=SimpleNamespace(showMessage=lambda *_a: None),
        )
        try:
            main_window.MainWindow._commit_leaving_page(owner, 0)  # 不得抛
            main_window.MainWindow._commit_leaving_page(owner, 99)  # 越界也不得抛
        finally:
            plain.deleteLater()

    def test_stale_locked_page_is_never_committed_on_leave(self) -> None:
        """被 Task 编译标记为陈旧的页：表单投影已不可信，切页绝不能把陈旧值写回模型。"""
        class Recorder(QWidget):
            def __init__(self) -> None:
                super().__init__()
                self.calls = 0

            def commit_pending_on_leave(self) -> bool:
                self.calls += 1
                return True

        page = Recorder()
        owner = SimpleNamespace(
            _editor_instances=[page],
            _editor_labels=["陈旧页"],
            _status=SimpleNamespace(showMessage=lambda *_a: None),
            _stale_editor_locks={id(page): "task compile"},
        )
        try:
            main_window.MainWindow._commit_leaving_page(owner, 0)
            self.assertEqual(page.calls, 0, "锁住的页不得提交")
            owner._stale_editor_locks = {}
            main_window.MainWindow._commit_leaving_page(owner, 0)
            self.assertEqual(page.calls, 1, "解锁后恢复正常提交")
        finally:
            page.deleteLater()

    def test_leaving_page_commit_failure_is_isolated(self) -> None:
        class Broken(QWidget):
            def commit_pending_on_leave(self):
                raise RuntimeError("boom")

        broken = Broken()
        owner = SimpleNamespace(
            _editor_instances=[broken],
            _editor_labels=["坏页"],
            _status=SimpleNamespace(showMessage=lambda *_a: None),
        )
        try:
            main_window.MainWindow._commit_leaving_page(owner, 0)  # 一个坏页不能阻断切页
        finally:
            broken.deleteLater()


if __name__ == "__main__":
    unittest.main()
