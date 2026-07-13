"""对话图分组增强：每组不同颜色（可选色）+ 可折叠（隐藏组内节点）。"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class GroupColorCollapseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from PySide6.QtWidgets import QApplication
        from tools.editor.project_model import ProjectModel

        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _widget(self):
        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget

        return DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=self._pm)

    def _load_multi_node_graph(self, w):
        from tools.dialogue_graph_editor.graph_document import graphs_dir

        target = graphs_dir(_PROJECT_ROOT) / "寻狗_义庄门口拦活.json"
        if not target.is_file():
            self.skipTest("样例图缺失")
        w.load_path(target)
        return list((w._data.get("nodes") or {}).keys())

    # ---- 颜色 ----
    def test_new_groups_get_distinct_colors(self) -> None:
        w = self._widget()
        try:
            gids = [w._new_editor_group_id_and_register(n) for n in ("A", "B", "C")]
            colors = [w._editor_groups[g]["color"] for g in gids]
            self.assertEqual(len(set(colors)), 3, colors)
        finally:
            w.deleteLater()

    def test_legacy_same_color_groups_autocolored_distinct(self) -> None:
        w = self._widget()
        try:
            w._editor_groups = {
                "x": {"name": "x", "color": "#4a6fa8"},
                "y": {"name": "y", "color": "#4a6fa8"},
                "z": {"name": "z", "color": "#4a6fa8"},
            }
            self.assertTrue(w._maybe_autocolor_legacy_groups())
            after = [w._editor_groups[g]["color"] for g in ("x", "y", "z")]
            self.assertEqual(len(set(after)), 3, after)
        finally:
            w.deleteLater()

    def test_explicit_color_is_kept(self) -> None:
        w = self._widget()
        try:
            w._editor_groups = {"a": {"name": "a", "color": "#ff0000"}}
            self.assertFalse(w._maybe_autocolor_legacy_groups())
            self.assertEqual(w._editor_groups["a"]["color"], "#ff0000")
        finally:
            w.deleteLater()

    # ---- 折叠 ----
    def test_collapse_hides_member_nodes_and_expand_restores(self) -> None:
        w = self._widget()
        try:
            node_ids = self._load_multi_node_graph(w)
            pts = [w._positions[n] for n in node_ids[:3] if n in w._positions]
            if len(pts) < 2:
                self.skipTest("布局坐标不足")
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            w._editor_groups["g_test"] = {"name": "测试组", "color": "#a8564a"}
            w._editor_group_frames["g_test"] = {
                "x": min(xs) - 60, "y": min(ys) - 60,
                "width": (max(xs) - min(xs)) + 280, "height": (max(ys) - min(ys)) + 220,
            }
            w._rebuild_flow_scene()  # 几何归属
            members = sorted(n for n, g in w._node_to_group.items() if g == "g_test")
            self.assertTrue(members, "分组框应至少圈住一个节点")
            graph = w._oden._graph
            self.assertTrue(all(graph.get_node_by_name(n) is not None for n in members))

            w._toggle_editor_group_collapsed("g_test")
            self.assertTrue(w._editor_groups["g_test"]["collapsed"])
            self.assertEqual(sorted(w._hidden_node_ids()), members)
            # 折叠后组内节点不在画布
            self.assertTrue(all(graph.get_node_by_name(n) is None for n in members))

            w._toggle_editor_group_collapsed("g_test")
            self.assertFalse(w._editor_groups["g_test"]["collapsed"])
            self.assertTrue(all(graph.get_node_by_name(n) is not None for n in members))
        finally:
            w.deleteLater()

    def _edge_pairs(self, graph):
        pairs = set()
        for n in graph.all_nodes():
            for op in getattr(n, "output_ports", lambda: [])():
                for cp in op.connected_ports():
                    pairs.add((n.name(), cp.node().name()))
        return pairs

    def _linear_data(self):
        # a → b → c → d → e （b,c 将归入折叠组）
        return {
            "entry": "a",
            "nodes": {
                "a": {"type": "line", "next": "b"},
                "b": {"type": "line", "next": "c"},
                "c": {"type": "line", "next": "d"},
                "d": {"type": "line", "next": "e"},
                "e": {"type": "end"},
            },
        }, {"a": (0, 0), "b": (200, 0), "c": (400, 0), "d": (600, 0), "e": (800, 0)}

    def test_collapsed_group_becomes_super_node_and_reroutes_edges(self) -> None:
        """折叠 = 变成一个超级节点；跨组连线改接到它、组内连线不画。图数据不变。"""
        from tools.dialogue_graph_editor.editor_group_geometry import group_super_node_name

        w = self._widget()
        try:
            data, positions = self._linear_data()
            n2g = {"b": "grp", "c": "grp"}
            frames = {"grp": {"x": 160, "y": -60, "width": 320, "height": 160}}
            oden = w._oden
            oden.rebuild(
                data, positions, {}, selected_id=None, entry="a", node_diag={},
                node_group_colors={},
                editor_groups={"grp": {"name": "组", "color": "#a8564a", "collapsed": True}},
                node_to_group=n2g, editor_group_frames=frames,
            )
            sup = group_super_node_name("grp")
            names = {n.name() for n in oden._graph.all_nodes()}
            self.assertNotIn("b", names)
            self.assertNotIn("c", names)
            self.assertIn(sup, names)
            pairs = self._edge_pairs(oden._graph)
            self.assertIn(("a", sup), pairs)      # 外部→成员 ⇒ 外部→超级
            self.assertIn((sup, "d"), pairs)      # 成员→外部 ⇒ 超级→外部
            self.assertIn(("d", "e"), pairs)      # 外部→外部 不变
            self.assertNotIn(("b", "c"), pairs)   # 组内部边不画
            self.assertNotIn((sup, sup), pairs)
            # 关键：折叠只是画布呈现，源数据 data 分毫未改
            self.assertEqual(data["nodes"]["b"]["next"], "c")
        finally:
            w.deleteLater()

    def test_uncollapsed_group_edges_strictly_identical_to_no_group(self) -> None:
        w = self._widget()
        try:
            data, positions = self._linear_data()
            n2g = {"b": "grp", "c": "grp"}
            frames = {"grp": {"x": 160, "y": -60, "width": 320, "height": 160}}
            oden = w._oden
            oden.rebuild(
                data, positions, {}, selected_id=None, entry="a", node_diag={},
                node_group_colors={},
                editor_groups={"grp": {"name": "组", "collapsed": False}},
                node_to_group=n2g, editor_group_frames=frames,
            )
            uncollapsed = self._edge_pairs(oden._graph)
            oden.rebuild(
                data, positions, {}, selected_id=None, entry="a", node_diag={},
                node_group_colors={}, editor_groups={}, node_to_group={}, editor_group_frames={},
            )
            no_group = self._edge_pairs(oden._graph)
            self.assertEqual(uncollapsed, no_group)
        finally:
            w.deleteLater()

    def test_collapsed_flag_round_trips_through_layout_store(self) -> None:
        """collapsed 标记随 groups 一起持久化（布局存储保留任意组元数据键）。"""
        from tools.dialogue_graph_editor.flow_layout_store import _normalize_groups

        groups = {"g1": {"name": "组1", "color": "#a8564a", "collapsed": True}}
        restored = _normalize_groups(groups)
        self.assertTrue(restored["g1"]["collapsed"])
        self.assertEqual(restored["g1"]["color"], "#a8564a")


if __name__ == "__main__":
    unittest.main()
