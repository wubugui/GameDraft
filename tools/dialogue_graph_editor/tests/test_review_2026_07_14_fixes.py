"""图对话组 2026-07-14 审查修复的护栏测试（P2/P3）。

覆盖：
- P2-①：坏 [tag:…] 进图自己的校验门（validate_graph_tiered warnings）。
- P2-③：非 dict 节点值打开不崩，降级为校验错误 + 节点列表可列出。
- P2-④：节点删除 → 撤销 → 节点回来（结构级快照撤销）。
- P3：Save All 跳过「从未编辑过的全新草稿」；编辑过的草稿才落盘。
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
from tools.dialogue_graph_editor.graph_document import (
    auto_layout_node_positions,
    extract_flow_edges,
    extract_flow_edges_detailed,
    nodes_reachable_from_entry,
    scan_graph_embedded_tag_refs,
    validate_graph_tiered,
)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class TagGateTests(unittest.TestCase):
    """P2-①：坏 [tag:…] 并入 validate_graph_tiered 的 warnings。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def test_bad_tag_in_line_text_becomes_warning(self) -> None:
        data = {
            "id": "g",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "line",
                    "speaker": {"kind": "npc"},
                    "text": "看 [tag:item:__definitely_missing_item__] 呢",
                    "next": "",
                },
            },
        }
        errs = scan_graph_embedded_tag_refs(data, self._pm)
        self.assertTrue(
            any("__definitely_missing_item__" in m for m in errs),
            f"scan 未报坏 tag：{errs}",
        )
        _e, warnings = validate_graph_tiered(
            data, project_root=_PROJECT_ROOT, project_model=self._pm
        )
        self.assertTrue(
            any("__definitely_missing_item__" in m for m in warnings),
            f"坏 tag 未并入 validate_graph_tiered warnings：{warnings}",
        )

    def test_no_model_does_not_crash_or_flag(self) -> None:
        data = {"nodes": {"n": {"type": "line", "text": "[tag:item:x]"}}}
        self.assertEqual(scan_graph_embedded_tag_refs(data, None), [])

    def test_clean_graph_has_no_tag_warnings(self) -> None:
        data = {
            "id": "g",
            "entry": "root",
            "nodes": {"root": {"type": "line", "text": "普通台词", "next": ""}},
        }
        self.assertEqual(scan_graph_embedded_tag_refs(data, self._pm), [])


class GraphDocumentGuardTests(unittest.TestCase):
    """FIX-3：graph_document 布局/连边/校验入口对畸形容器降级为空图（不抛 AttributeError）。

    这些是「守卫是否真的挡住崩溃」的函数级证据：把 graph_document.py 的守卫去掉，
    本类应立刻抛 AttributeError（nodes.items()/nodes.keys()/data.get(...)）而 FAIL。
    """

    def test_extract_flow_edges_non_dict_container_degrades(self) -> None:
        # nodes 容器写成 list / str → 空边集，而非 AttributeError('...' has no attribute 'items')
        self.assertEqual(extract_flow_edges(["a", "b"]), [])
        self.assertEqual(extract_flow_edges("abc"), [])
        self.assertEqual(extract_flow_edges_detailed(["a"]), [])
        self.assertEqual(extract_flow_edges_detailed("x"), [])

    def test_auto_layout_non_dict_container_degrades(self) -> None:
        # auto_layout 内部会调 extract_flow_edges / _sugiyama(.keys())；畸形容器应回空布局
        self.assertEqual(auto_layout_node_positions(["a", "b"], "a"), {})
        self.assertEqual(auto_layout_node_positions("abc", "a"), {})

    def test_nodes_reachable_non_dict_container_degrades(self) -> None:
        self.assertEqual(nodes_reachable_from_entry(["a"], "a"), set())
        self.assertEqual(nodes_reachable_from_entry("abc", "a"), set())

    def test_validate_non_dict_container_reported_as_error(self) -> None:
        # nodes 容器非 dict → error；顶层文档非 dict → error（均不崩）
        e_list, _ = validate_graph_tiered({"id": "g", "entry": "r", "nodes": ["a", "b"]})
        self.assertTrue(any("nodes 必须是对象" in m for m in e_list), e_list)
        e_str, _ = validate_graph_tiered({"id": "g", "entry": "r", "nodes": "abc"})
        self.assertTrue(any("nodes 必须是对象" in m for m in e_str), e_str)
        e_top, _ = validate_graph_tiered(["a", "b", "c"])
        self.assertTrue(any("顶层文档必须是对象" in m for m in e_top), e_top)


class MalformedNodeTests(unittest.TestCase):
    """P2-③ + FIX-3：畸形图打开不崩，且经 validate 报为 error。

    与旧版不同：``test_widget_opens_malformed_graph_via_load_path`` 走**真实
    ``load_path`` 磁盘加载链**（写临时文件→``w.load_path(path)``），而非旧版用
    ``_model.load`` + ``_populate_node_list`` 绕开 load_path（假护栏，V6 指出的同款盲区）。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _pump(self) -> None:
        for _ in range(5):
            self._app.processEvents()

    def _load_doc_via_real_load_path(self, doc: object) -> DialogueGraphEditorWidget:
        """写临时 JSON → 走真实 w.load_path()（含 read_bytes/json.loads/auto_layout/画布重建）。"""
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        tmpdir = tempfile.mkdtemp()
        self.addCleanup(w.deleteLater)
        path = Path(tmpdir) / "malformed_graph.json"
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        w.load_path(path)  # 真实磁盘加载链；畸形容器/顶层必须降级不崩
        self._pump()
        return w

    def test_string_node_value_reported_as_error(self) -> None:
        data = {"id": "g", "entry": "root", "nodes": {"root": "我是个字符串不是对象"}}
        errors, _w = validate_graph_tiered(
            data, project_root=_PROJECT_ROOT, project_model=self._pm
        )
        self.assertTrue(
            any("不是对象" in m for m in errors), f"畸形节点未报错误：{errors}"
        )

    def test_widget_opens_malformed_graph_via_load_path(self) -> None:
        """走真实 load_path，覆盖四类畸形：①nodes=list ②nodes=str ③顶层=list ④节点值非dict。"""
        cases = {
            "nodes_is_list": {"id": "g", "entry": "root", "nodes": ["a", "b"]},
            "nodes_is_str": {"id": "g", "entry": "root", "nodes": "abc"},
            "toplevel_is_list": ["a", "b", "c"],
            "node_value_non_dict": {
                "id": "g",
                "entry": "root",
                "nodes": {
                    "root": {"type": "line", "text": "ok", "next": ""},
                    "bad": "字符串节点",
                },
            },
        }
        for name, doc in cases.items():
            with self.subTest(case=name):
                # 若 load_path 未降级会在此抛 AttributeError（list/str .items()/.keys()/.get()）
                w = self._load_doc_via_real_load_path(doc)
                if name == "node_value_non_dict":
                    # 合法节点保留、畸形节点值降级为「畸形项」列出（既不崩也不丢），可选中
                    labels = [
                        w._node_list.item(i).text()
                        for i in range(w._node_list.count())
                    ]
                    self.assertTrue(
                        any("bad" in s for s in labels), f"畸形节点未列出：{labels}"
                    )
                    self.assertTrue(w._select_node_row_by_id("bad"))
                    w._apply_selected_node_to_inspector()  # 检查器守卫透传不崩
                    self._pump()
                else:
                    # 畸形容器/顶层 → 降级为空图（节点列表为空），关键是「不崩」
                    self.assertEqual(
                        w._node_list.count(), 0, f"{name} 未降级为空图"
                    )


class StructureUndoTests(unittest.TestCase):
    """P2-④：节点删除/新增纳入撤销。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _pump(self) -> None:
        for _ in range(5):
            self._app.processEvents()

    def test_delete_then_undo_restores_node(self) -> None:
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        try:
            w.create_new_graph_draft()
            self._pump()
            # 直接加一个可删除的孤立节点（走结构撤销入栈路径）
            snap = w._begin_structure_snapshot()
            w._model.add_node("extra", {"type": "end"})
            w._populate_node_list()
            w._push_structure_undo("新增 extra", snap)
            self._pump()
            self.assertIn("extra", w._model.nodes)
            # 删除 extra（无外部入边 → 直接确认路径；这里直接调 _delete_nodes 会弹框，
            # 故走底层 model + 快照，等价于删除命令）
            snap2 = w._begin_structure_snapshot()
            w._model.remove_nodes(["extra"])
            w._populate_node_list(select_first=True)
            w._push_structure_undo("删除 extra", snap2)
            self._pump()
            self.assertNotIn("extra", w._model.nodes)
            # 撤销删除 → extra 回来
            w._undo_stack.undo()
            self._pump()
            self.assertIn("extra", w._model.nodes)
            # 再撤销新增 → extra 又消失
            w._undo_stack.undo()
            self._pump()
            self.assertNotIn("extra", w._model.nodes)
            # 重做 → 回到有 extra
            w._undo_stack.redo()
            self._pump()
            self.assertIn("extra", w._model.nodes)
        finally:
            w.deleteLater()


class NewDraftSaveAllSkipTests(unittest.TestCase):
    """P3：Save All 不静默物化「从未编辑过的全新草稿」。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _pump(self) -> None:
        for _ in range(5):
            self._app.processEvents()

    def test_untouched_new_draft_is_flagged(self) -> None:
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        try:
            w.create_new_graph_draft()
            self._pump()
            self.assertTrue(w.has_unsaved_changes())
            self.assertTrue(
                w.is_untouched_new_draft(),
                "刚新建的全新草稿应判为 untouched",
            )
        finally:
            w.deleteLater()

    def test_edited_new_draft_is_not_untouched(self) -> None:
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        try:
            w.create_new_graph_draft()
            self._pump()
            w._model.add_node("added", {"type": "end"})
            self.assertFalse(
                w.is_untouched_new_draft(),
                "编辑过的草稿不应再判为 untouched",
            )
        finally:
            w.deleteLater()


if __name__ == "__main__":
    unittest.main()
