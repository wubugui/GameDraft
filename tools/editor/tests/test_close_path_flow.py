"""关闭路径流程护栏（复核 P1-01 / P1-06 修复）。

族性缺陷：closeEvent 先逐页 confirm_close 再统一 flush_to_model——若某编辑器的
Discard 分支只返回 True 而不把表单回滚到模型值，随后的 flush 会按 UI≠模型判脏，
把刚被用户放弃的编辑重新提交进模型（图对话 tab 甚至直接写盘）。

本文件对代表性面板做「编辑 → Discard → flush → 断言模型未变且不再判脏」探针；
7 月审查的教训：模型层往返测试全绿也盖不住这类流程层缺陷，必须有流程探针。
"""
from __future__ import annotations

import copy
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_DISCARD = QMessageBox.StandardButton.Discard


def _patch_discard():
    """把所有 QMessageBox.question 弹窗替换为「放弃」。"""
    return patch.object(QMessageBox, "question", return_value=_DISCARD)


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m


class TestDiscardNeutralizesPendingEdits(_Base):
    """confirm_close 选 Discard 后：模型不变、编辑器不再判脏、flush 为 no-op。"""

    def test_item_editor_discard_then_flush_keeps_model(self) -> None:
        from tools.editor.editors.item_editor import ItemEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            ed = ItemEditor(m)
            ed._on_select(0)
            before = copy.deepcopy(m.items[0])
            ed._i_name.setText("被放弃的编辑")
            self.assertTrue(ed._is_dirty())
            with _patch_discard():
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(ed._is_dirty(), "Discard 后表单必须回滚到模型值")
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(m.items[0], before, "被放弃的编辑不得经 flush 重新提交")

    def test_shop_editor_discard_then_flush_keeps_model(self) -> None:
        from tools.editor.editors.shop_editor import ShopEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.shops.append({"id": "shop_a", "name": "老铺", "items": []})
            ed = ShopEditor(m)
            ed._on_select(0)
            before = copy.deepcopy(m.shops[0])
            ed._s_name.setText("被放弃的编辑")
            self.assertTrue(ed._is_dirty())
            with _patch_discard():
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(m.shops[0], before)

    def test_plane_editor_discard_then_flush_keeps_model(self) -> None:
        from tools.editor.editors.plane_editor import PlaneEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.planes = [{"id": "normal"}, {"id": "yin", "label": "阴面"}]
            ed = PlaneEditor(m)
            ed._list.setCurrentRow(1)
            before = copy.deepcopy(m.planes[1])
            ed._f_label.setText("被放弃的编辑")
            self.assertTrue(ed._is_dirty())
            with _patch_discard():
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(m.planes[1], before)

    def test_game_config_editor_discard_then_flush_keeps_model(self) -> None:
        from tools.editor.editors.game_config_editor import GameConfigEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            ed = GameConfigEditor(m)
            # 最小工程的 config 缺省键不全，先经编辑器规范化一轮（写回会补全键），
            # 使「未编辑 ⇒ 不判脏」成立后再做 Discard 探针。
            ed._apply()
            ed._load()
            self.assertFalse(ed._is_dirty())
            before = copy.deepcopy(m.game_config)
            ed._initial_scene.set_current("sc_b")
            self.assertTrue(ed._is_dirty())
            with _patch_discard():
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(m.game_config, before)

    def test_pressure_hold_editor_discard_then_flush_keeps_model(self) -> None:
        from tools.editor.editors.pressure_signal_editor import PressureHoldEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.pressure_holds.append({"id": "hold_a", "prompt": "按住"})
            ed = PressureHoldEditor(m)
            ed._on_select(0)
            # 最小 fixture 缺省键不全：先规范化一轮（写回补全 fillSeconds 等），
            # 使「未编辑 ⇒ 不判脏」成立后再做 Discard 探针。
            ed._apply()
            ed._on_select(0)
            self.assertFalse(ed._is_dirty())
            before = copy.deepcopy(m.pressure_holds[0])
            ed._f_prompt.setText("被放弃的编辑")
            self.assertTrue(ed._is_dirty())
            with _patch_discard():
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(m.pressure_holds[0], before)


class TestCharacterRegistryStaging(_Base):
    """P1-06：角色注册表此前完全缺 flush/confirm/commit-on-leave 钩子。"""

    def _editor(self, m: ProjectModel):
        from tools.editor.editors.character_registry_editor import CharacterRegistryEditor
        m.character_registry["c1"] = {"id": "c1", "name": "老王"}
        m.character_registry["c2"] = {"id": "c2", "name": "老李"}
        ed = CharacterRegistryEditor(m)
        ed.reload_refs_from_model()
        return ed

    def test_flush_commits_pending_edit(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            ed = self._editor(m)
            ed._select_id("c1")
            ed._name.setText("王大改")
            self.assertTrue(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(m.character_registry["c1"]["name"], "王大改")
            self.assertIn("characterRegistry", m._dirty)

    def test_commit_on_leave_when_switching_rows(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            ed = self._editor(m)
            ed._select_id("c1")
            ed._name.setText("王临走改")
            ed._select_id("c2")
            self.assertEqual(m.character_registry["c1"]["name"], "王临走改")

    def test_confirm_close_discard_rolls_back(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            ed = self._editor(m)
            ed._select_id("c1")
            ed._name.setText("被放弃的编辑")
            with _patch_discard():
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(ed._is_dirty())
            self.assertTrue(ed.flush_to_model())
            self.assertEqual(m.character_registry["c1"]["name"], "老王")

    def test_unknown_keys_preserved_on_apply(self) -> None:
        """往返规范：Apply 不得丢角色条目上的未知键。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.character_registry["c1"] = {"id": "c1", "name": "老王", "x_custom": 7}
            from tools.editor.editors.character_registry_editor import CharacterRegistryEditor
            ed = CharacterRegistryEditor(m)
            ed._select_id("c1")
            ed._name.setText("王改")
            self.assertTrue(ed._apply_to_model())
            self.assertEqual(m.character_registry["c1"].get("x_custom"), 7)


class TestDialogueWidgetDiscard(unittest.TestCase):
    """图对话面板：Discard 必须真正放弃（重载磁盘），否则嵌入 tab 的 flush 会直接写盘。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_discard_unsaved_changes_reloads_disk(self) -> None:
        import json
        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            gdir = root / "public" / "assets" / "dialogues" / "graphs"
            gdir.mkdir(parents=True, exist_ok=True)
            gp = gdir / "probe_graph.json"
            graph = {
                "id": "probe_graph",
                "entry": "n1",
                "nodes": {"n1": {"type": "line", "speaker": "旁白", "text": "原文"}},
            }
            gp.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            m = ProjectModel()
            m.load_project(root)
            w = DialogueGraphEditorWidget(str(root), project_model=m)
            w.load_path(gp)
            nd = copy.deepcopy(w._model.nodes["n1"])
            nd["text"] = "被放弃的编辑"
            w._model.set_node("n1", nd)
            self.assertTrue(w.has_unsaved_changes())
            w.discard_unsaved_changes()
            self.assertFalse(w.has_unsaved_changes(), "Discard 后不得再有未保存修改")
            self.assertEqual(
                w._model.to_dict()["nodes"]["n1"]["text"], "原文",
                "Discard 必须回滚到磁盘内容",
            )
            self.assertEqual(
                json.loads(gp.read_text(encoding="utf-8"))["nodes"]["n1"]["text"], "原文",
                "Discard 绝不写盘",
            )
            w.deleteLater()


if __name__ == "__main__":
    unittest.main()
