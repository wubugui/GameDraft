"""图对话正向跳转（选了 graphId → 一键打开那张图）的入口覆盖与转接契约。

背景：主窗早就有 ``navigate_to_dialogue_graph``（全局搜索、Action 注册表「跳转到来源」、
图对话页「被引用」树在用），但**引用侧字段一个入口都没接**——选完一张图对话想去看/改，
只能自己回导航树翻。本探针锁两件事：

1. ``ReferencePickerField`` 的「↗」按钮语义（有值才可点、点了才回调、无回调不显示）；
2. 转接函数沿 parent 链找宿主窗口，找不到宿主时**返回 False 而不是抛**（独立小工具/
   离屏场景不能因为跳不动就把编辑器打挂）。
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QVBoxLayout, QWidget

from tools.editor.editors.scene_editor import ScenePropertyPanel
from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor, FilterableTypeCombo
from tools.editor.shared.dialogue_graph_refs import open_dialogue_graph_from_widget
from tools.editor.shared.reference_picker import ReferencePickerField
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class _FakeMainWindow(QWidget):
    """只实现跳转钩子的假宿主：转接是鸭子协议，不该依赖真 MainWindow。"""

    def __init__(self) -> None:
        super().__init__()
        self.opened: list[str] = []
        self._layout = QVBoxLayout(self)

    def navigate_to_dialogue_graph(self, graph_id: str) -> None:
        self.opened.append(graph_id)

    def host(self, child: QWidget) -> None:
        self._layout.addWidget(child)


class TestReferencePickerOpenButton(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication([])

    def test_open_button_hidden_without_handler(self) -> None:
        field = ReferencePickerField(lambda: [("g", "G", "")])
        try:
            self.assertFalse(field._open.isVisible() and field._open.isEnabled())
        finally:
            field.deleteLater()
            self._qt_app.processEvents()

    def test_open_button_enabled_only_with_a_value(self) -> None:
        seen: list[str] = []
        field = ReferencePickerField(lambda: [("g", "G", "")], on_open=seen.append)
        try:
            self.assertFalse(field._open.isEnabled(), "空值时不可点")
            field.set_value("g")
            self.assertTrue(field._open.isEnabled())
            field._open.click()
            self.assertEqual(seen, ["g"])
            field.clear_value()
            self.assertFalse(field._open.isEnabled())
        finally:
            field.deleteLater()
            self._qt_app.processEvents()

    def test_open_never_fires_on_empty_value(self) -> None:
        seen: list[str] = []
        field = ReferencePickerField(lambda: [], on_open=seen.append)
        try:
            field._open_target()      # 直接调也不许触发（按钮 disabled 只是 UI 层）
            self.assertEqual(seen, [])
        finally:
            field.deleteLater()
            self._qt_app.processEvents()

    def test_set_open_handler_toggles_visibility(self) -> None:
        field = ReferencePickerField(lambda: [("g", "G", "")])
        try:
            field.set_value("g")
            field.set_open_handler(lambda _g: None)
            self.assertTrue(field._open.isEnabled())
            field.set_open_handler(None)
            self.assertFalse(field._open.isEnabled())
        finally:
            field.deleteLater()
            self._qt_app.processEvents()


class TestOpenDialogueGraphTransfer(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication([])

    def test_walks_up_to_the_host_window(self) -> None:
        host = _FakeMainWindow()
        inner = QWidget()
        leaf = QWidget(inner)
        host.host(inner)
        try:
            self.assertTrue(open_dialogue_graph_from_widget(leaf, "寻狗_听书开场"))
            self.assertEqual(host.opened, ["寻狗_听书开场"])
        finally:
            host.deleteLater()
            self._qt_app.processEvents()

    def test_missing_host_returns_false_without_raising(self) -> None:
        orphan = QWidget()
        try:
            self.assertFalse(open_dialogue_graph_from_widget(orphan, "g"))
        finally:
            orphan.deleteLater()
            self._qt_app.processEvents()

    def test_blank_graph_id_is_a_noop(self) -> None:
        host = _FakeMainWindow()
        try:
            self.assertFalse(open_dialogue_graph_from_widget(host, "   "))
            self.assertEqual(host.opened, [])
        finally:
            host.deleteLater()
            self._qt_app.processEvents()

    def test_jump_from_inside_a_modal_dialog_is_allowed_on_purpose(self) -> None:
        """模态弹窗里点 ↗ 放行——这是查证后的决定，不是漏掉的护栏。

        叙事状态机的 actions 弹窗（QDialog + 内嵌 ActionEditor + exec）是常规用法，拦住就
        挡了正常干活。评估过的三条"坏"逐条不可达：离开页的 commit-on-leave 只有场景编辑器
        实现而场景页的 ↗ 全是内联控件（组合不存在）；图对话「未保存」询问会叠在最上层可交互、
        落盘需显式点保存；真正危险的引用重建已由 reference_rebuild_is_safe_now 在模态时整轮让路。
        """
        from PySide6.QtWidgets import QDialog

        host = _FakeMainWindow()
        dialog = QDialog(host)
        dialog.setModal(True)
        inner = QWidget(dialog)
        host.show()
        dialog.show()
        self._qt_app.processEvents()
        try:
            if QApplication.activeModalWidget() is None:
                self.skipTest("离屏平台没有活动模态窗口，跳过该分支")
            self.assertTrue(open_dialogue_graph_from_widget(inner, "某张图"))
            self.assertEqual(host.opened, ["某张图"])
        finally:
            dialog.deleteLater()
            host.hide()
            host.deleteLater()
            self._qt_app.processEvents()

    def test_host_failure_is_contained(self) -> None:
        class Boom(QWidget):
            def navigate_to_dialogue_graph(self, _gid: str) -> None:
                raise RuntimeError("nav broke")

        host = Boom()
        child = QWidget(host)
        try:
            self.assertFalse(open_dialogue_graph_from_widget(child, "g"))
        finally:
            host.deleteLater()
            self._qt_app.processEvents()


class TestEveryDialogueGraphFieldCanJump(unittest.TestCase):
    """逐个入口验：场景热区 / 场景 NPC / startDialogueGraph / owner / 信号来源。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication([])

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    def test_scene_hotspot_and_npc_graph_fields_jump(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            host = _FakeMainWindow()
            panel = ScenePropertyPanel(model)
            host.host(panel)
            try:
                for field, gid in (
                    (panel._hs_inspect_graph_combo, "热区图"),
                    (panel._npc_dialogue_graph, "NPC图"),
                ):
                    field.set_value(gid)
                    self.assertTrue(field._open.isEnabled(), "图对话字段必须有可用的跳转入口")
                    field._open.click()
                self.assertEqual(host.opened, ["热区图", "NPC图"])
            finally:
                host.deleteLater()
                self._qt_app.processEvents()

    def test_start_dialogue_graph_action_field_jumps(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            host = _FakeMainWindow()
            editor = ActionEditor("Actions")
            host.host(editor)
            try:
                editor.set_project_context(model, None)
                editor.set_data([{"type": "startDialogueGraph", "params": {"graphId": "开场白"}}])
                field = editor._rows[0]._param_widgets["graphId"]
                self.assertTrue(field._open.isEnabled())
                field._open.click()
                self.assertEqual(host.opened, ["开场白"])
            finally:
                host.deleteLater()
                self._qt_app.processEvents()

    def test_owner_id_jump_appears_only_for_dialogue_owner_type(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            host = _FakeMainWindow()
            editor = ActionEditor("Actions")
            host.host(editor)
            try:
                editor.set_project_context(model, None)
                editor.set_data([{"type": "startDialogueGraph", "params": {
                    "graphId": "g", "entry": "", "ownerType": "npc", "ownerId": "n0",
                }}])
                row = editor._rows[0]
                owner_id = row._param_widgets["ownerId"]
                owner_type = row._param_widgets["ownerType"]
                self.assertIsInstance(owner_type, FilterableTypeCombo)
                self.assertFalse(owner_id._open.isEnabled(), "owner 是 NPC 时不该出现图对话跳转")

                owner_type.set_committed_type("dialogue", emit=True)
                owner_id.set_value("某张图")
                self.assertTrue(owner_id._open.isEnabled())
                owner_id._open.click()
                self.assertEqual(host.opened, ["某张图"])

                owner_type.set_committed_type("npc", emit=True)
                self.assertFalse(owner_id._open.isEnabled(), "切回非 dialogue 必须收回入口")
            finally:
                host.deleteLater()
                self._qt_app.processEvents()

    def test_signal_source_id_jump_only_for_dialogue_source(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            host = _FakeMainWindow()
            editor = ActionEditor("Actions")
            host.host(editor)
            try:
                editor.set_project_context(model, None)
                editor.set_data([{"type": "emitNarrativeSignal", "params": {
                    "signal": "s", "sourceType": "dialogue", "sourceId": "来源图",
                }}])
                row = editor._rows[0]
                source_id = row._param_widgets["sourceId"]
                self.assertTrue(source_id._open.isEnabled())
                source_id._open.click()
                self.assertEqual(host.opened, ["来源图"])

                row._param_widgets["sourceType"].set_committed_type("scene", emit=True)
                self.assertFalse(source_id._open.isEnabled())
            finally:
                host.deleteLater()
                self._qt_app.processEvents()


if __name__ == "__main__":
    unittest.main()
