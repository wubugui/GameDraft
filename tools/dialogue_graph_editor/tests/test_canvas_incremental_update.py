"""画布增量更新护栏：高频编辑不再整图删-建，且连线零丢失、端口变化能回退重建。

针对"画布行为糟糕"的根因——任何节点编辑都触发整图 rebuild（删全部+建全部，~70ms 闪烁）。
修复后：端口签名不变的编辑（改正文/选项文字等）走原地视觉更新，不重建、不丢边；
端口签名变化（增删分支/改类型）才回退整图重建。
"""
from __future__ import annotations

import copy
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
from tools.dialogue_graph_editor import flow_oden_controller as FOC
from tools.dialogue_graph_editor.graph_document import graphs_dir, list_graph_files

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class CanvasIncrementalUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def setUp(self) -> None:
        self._orig_rebuild = FOC.DialogueFlowOdenController.rebuild
        self._rebuild_calls = {"n": 0}

        def counted(inner_self, *a, **k):
            self._rebuild_calls["n"] += 1
            return self._orig_rebuild(inner_self, *a, **k)

        FOC.DialogueFlowOdenController.rebuild = counted

    def tearDown(self) -> None:
        FOC.DialogueFlowOdenController.rebuild = self._orig_rebuild

    def _pump(self) -> None:
        for _ in range(5):
            self._app.processEvents()

    def _pick_graph_with_types(self):
        # 选一个含 line 与 switch 的较大图
        for p in list_graph_files(_PROJECT_ROOT):
            import json

            d = json.loads(p.read_text(encoding="utf-8"))
            types = {n.get("type") for n in (d.get("nodes") or {}).values() if isinstance(n, dict)}
            if {"line", "switch"} <= types and len(d.get("nodes") or {}) >= 10:
                return p
        return graphs_dir(_PROJECT_ROOT) / "寻狗_看进山路.json"

    def _edge_count(self, w) -> int:
        g = w._oden._graph
        # 分组框 BackdropNode 无端口:数边只看带 output_ports 的真节点
        return sum(
            len(p.connected_ports())
            for n in g.all_nodes()
            if hasattr(n, "output_ports")
            for p in n.output_ports()
        )

    def test_text_edit_updates_in_place_without_rebuild_and_keeps_edges(self) -> None:
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        w.load_path(self._pick_graph_with_types())
        self._pump()
        before_edges = self._edge_count(w)

        line_nid = next(nid for nid, nd in w._model.nodes.items() if nd.get("type") == "line")
        nd = copy.deepcopy(w._model.nodes[line_nid])
        nd["text"] = "增量更新测试正文"
        w._model.set_node(line_nid, nd)

        self._rebuild_calls["n"] = 0
        ok = w._update_canvas_node_in_place(line_nid)

        self.assertTrue(ok, "端口签名不变的正文编辑应走原地更新")
        self.assertEqual(self._rebuild_calls["n"], 0, "原地更新不得触发整图重建")
        self.assertEqual(self._edge_count(w), before_edges, "原地更新不得丢失任何连线")
        node = w._oden._graph.get_node_by_name(line_nid)
        self.assertIn("增量更新测试正文", node.view.text_item.toPlainText())
        w.deleteLater()

    def test_port_signature_change_falls_back_to_rebuild(self) -> None:
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        w.load_path(self._pick_graph_with_types())
        self._pump()

        sw_nid = next(nid for nid, nd in w._model.nodes.items() if nd.get("type") == "switch")
        nd = copy.deepcopy(w._model.nodes[sw_nid])
        nd.setdefault("cases", []).append({"conditions": [{"flag": "x", "value": True}], "next": ""})
        w._model.set_node(sw_nid, nd)

        ok = w._update_canvas_node_in_place(sw_nid)
        self.assertFalse(ok, "增删分支改变端口签名，必须回退整图重建（返回 False）")
        w.deleteLater()

    def test_target_edit_is_detected_as_topology_change(self) -> None:
        """改连线目标(next/case.next…)必须被识别为拓扑变化→走整图重建(正确重画边+刷新诊断色)。"""
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        w.load_path(self._pick_graph_with_types())
        self._pump()
        line_nid = next(nid for nid, nd in w._model.nodes.items() if nd.get("type") == "line")
        old = copy.deepcopy(w._model.nodes[line_nid])
        visual = copy.deepcopy(old)
        visual["text"] = "纯视觉改动"
        target = copy.deepcopy(old)
        target["next"] = "__different_target__"
        self.assertEqual(
            w._node_output_targets(old), w._node_output_targets(visual),
            "改正文不应被当作拓扑变化",
        )
        self.assertNotEqual(
            w._node_output_targets(old), w._node_output_targets(target),
            "改 next 必须被识别为拓扑变化",
        )
        w.deleteLater()

    def test_fresh_push_does_not_full_rebuild_only_undo_redo_does(self) -> None:
        """编辑/拖动(全新入栈)不得整图重建(否则闪烁+拖动跳)；仅 undo/redo 才重建反映回退。"""
        from PySide6.QtGui import QUndoCommand

        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        w.load_path(self._pick_graph_with_types())
        self._pump()
        starts: list[int] = []
        w._inspector_scene_timer.start = lambda ms=0: starts.append(ms)  # type: ignore[assignment]

        class _Dummy(QUndoCommand):
            def redo(self):  # noqa: D401
                pass

            def undo(self):
                pass

        starts.clear()
        w._undo_stack.push(_Dummy())
        self.assertEqual(starts, [], "全新入栈(模拟编辑/移动)不得触发整图重建")
        starts.clear()
        w._undo_stack.undo()
        self.assertIn(80, starts, "undo 应触发整图重建以反映回退")
        starts.clear()
        w._undo_stack.redo()
        self.assertIn(80, starts, "redo 应触发整图重建")
        w.deleteLater()

    def test_choice_option_text_change_updates_port_caption_in_place(self) -> None:
        w = DialogueGraphEditorWidget(str(_PROJECT_ROOT), project_model=self._pm)
        # 找一个含 choice 的图
        import json

        target = None
        for p in list_graph_files(_PROJECT_ROOT):
            d = json.loads(p.read_text(encoding="utf-8"))
            if any(n.get("type") == "choice" for n in (d.get("nodes") or {}).values() if isinstance(n, dict)):
                target = p
                break
        if target is None:
            self.skipTest("无 choice 节点图")
        w.load_path(target)
        self._pump()
        ch_nid = next(nid for nid, nd in w._model.nodes.items() if nd.get("type") == "choice")
        nd = copy.deepcopy(w._model.nodes[ch_nid])
        if not nd.get("options"):
            self.skipTest("choice 无选项")
        nd["options"][0]["text"] = "改后的选项文字"
        w._model.set_node(ch_nid, nd)
        self._rebuild_calls["n"] = 0
        ok = w._update_canvas_node_in_place(ch_nid)
        self.assertTrue(ok, "选项文字变化（端口数不变）应原地更新")
        self.assertEqual(self._rebuild_calls["n"], 0)
        w.deleteLater()


if __name__ == "__main__":
    unittest.main()
