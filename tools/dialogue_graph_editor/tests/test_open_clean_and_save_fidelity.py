"""打开即干净 + 存盘字节保真护栏。

针对两类回归：
1. 打开任意图、零编辑就被标脏（"啥都没改切走也弹保存框"）。
2. 打开→保存把 `preconditions` 缺省归一化成 `[]`（导出格式漂移）。

这两条都源于「校验回灌 widgets→model」+「apply_meta_patch 无条件标脏」+
「_widgets_to_data_meta 把缺省 preconditions normalize 成 []」。本测试钉死它们。
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
from tools.dialogue_graph_editor.graph_document import list_graph_files

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class OpenCleanAndSaveFidelityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _pump(self) -> None:
        for _ in range(5):
            self._app.processEvents()

    def test_open_graph_is_not_dirty(self) -> None:
        files = list_graph_files(_PROJECT_ROOT)
        self.assertTrue(files)
        dirty_after_open: list[str] = []
        for p in files:
            w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
            w.load_path(p)
            self._pump()
            if w.has_unsaved_changes():
                dirty_after_open.append(p.name)
            w.deleteLater()
        self.assertEqual(
            dirty_after_open, [], f"打开后即被标脏（零编辑）：{dirty_after_open[:20]}"
        )

    def test_model_matches_disk_after_open(self) -> None:
        """打开后 model.to_dict() 必须与磁盘语义一致（不得归一化 preconditions 等）。"""
        files = list_graph_files(_PROJECT_ROOT)
        mismatches: list[str] = []
        for p in files:
            disk = json.loads(p.read_text(encoding="utf-8"))
            w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
            w.load_path(p)
            self._pump()
            cur = w._model.to_dict()
            if cur != disk:
                diff = [
                    k for k in set(disk) | set(cur)
                    if disk.get(k, "<absent>") != cur.get(k, "<absent>")
                ]
                mismatches.append(f"{p.name}: 差异字段={diff}")
            w.deleteLater()
        self.assertEqual(mismatches, [], "打开后 model 与磁盘不一致：\n" + "\n".join(mismatches[:20]))

    def test_open_then_save_is_byte_identical(self) -> None:
        """零编辑打开→保存，磁盘字节必须完全不变（导出格式无变化）。

        磁盘图是外部工具按不一致风格预格式化的（同形状对象在不同文件里有时内联有时展开），
        没有任何序列化器能复现。因此保存路径在"内容相对磁盘零变化"时原样回写原始字节。
        本测试走真实保存决策 `_can_write_loaded_bytes_verbatim`。
        """
        import tempfile
        from tools.dialogue_graph_editor.graph_document import save_json

        files = list_graph_files(_PROJECT_ROOT)
        changed: list[str] = []
        for p in files:
            original_bytes = p.read_bytes()
            w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
            w.load_path(p)
            self._pump()
            # 复刻 _write_to_path 的写出决策（不落原文件）
            w._widgets_to_data_meta()
            w._flush_current_inspector_to_data()
            w._model.apply_meta_patch({"id": p.stem})
            if w._can_write_loaded_bytes_verbatim(p):
                out_bytes = w._loaded_disk_bytes
            else:
                with tempfile.TemporaryDirectory() as td:
                    out = Path(td) / p.name
                    save_json(out, w._model.to_dict())
                    out_bytes = out.read_bytes()
            if out_bytes != original_bytes:
                changed.append(p.name)
            w.deleteLater()
        self.assertEqual(changed, [], f"打开→保存字节发生变化：{changed[:20]}")


if __name__ == "__main__":
    unittest.main()
