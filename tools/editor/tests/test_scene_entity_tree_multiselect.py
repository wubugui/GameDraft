"""场景编辑器实体树 + 多选 + 分组（P2）流程探针。

护栏语义：
- 实体树 ↔ 画布选中双向同步（树点选=画布选中聚焦；画布选中=树高亮）；
- 多选批量操作（整体拖动/删除/复制/指派分组）各为**单条**撤销命令；
- 真实 QMouseEvent 多选整体拖动从最外层入口验证（Qt 组拖 + 批量 release 信号）；
- group 纯标签写入 dict 顶层键，Apply/往返保留，撤销可回滚。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPoint, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _scene(sid: str) -> dict:
    return {
        "id": sid,
        "name": sid,
        "hotspots": [
            {"id": "h1", "type": "inspect", "label": "", "x": 50, "y": 50,
             "interactionRange": 50, "data": {"text": ""}},
        ],
        "npcs": [
            {"id": "npc1", "name": "甲", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "npc2", "name": "乙", "x": 200, "y": 200, "interactionRange": 50},
        ],
        "zones": [
            {"id": "z1", "polygon": [{"x": 10, "y": 10}, {"x": 60, "y": 10},
                                      {"x": 60, "y": 60}, {"x": 10, "y": 60}]},
        ],
        "spawnPoints": {"door": {"x": 5, "y": 5}},
    }


class SceneEntityTreeMultiselectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            try:
                ed._scene_npc_anim_timer.stop()
                ed._patrol_overlay_refresh_timer.stop()
                ed._canvas._gfx.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene("sc_a"), "sc_b": _scene("sc_b")}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        return ed, model

    def _npc(self, model, sid, nid):
        for n in model.scenes[sid]["npcs"]:
            if n.get("id") == nid:
                return n
        raise AssertionError(f"npc {nid} not found in {sid}")

    def _tree_leaves(self, ed) -> dict[tuple[str, str], object]:
        out = {}
        root = ed._entity_tree.invisibleRootItem()
        for i in range(root.childCount()):
            top = root.child(i)
            for j in range(top.childCount()):
                leaf = top.child(j)
                data = leaf.data(0, Qt.ItemDataRole.UserRole)
                if data:
                    out[tuple(data)] = leaf
        return out

    # ---- 树构建 / 过滤 -----------------------------------------------------

    def test_tree_lists_all_entities(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            leaves = self._tree_leaves(ed)
            for key in (("hotspot", "h1"), ("npc", "npc1"), ("npc", "npc2"),
                        ("zone", "z1"), ("spawn", "door")):
                self.assertIn(key, leaves, f"实体树缺 {key}")

    def test_tree_filter_hides_nonmatching(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            ed._tree_filter.setText("npc1")
            leaves = self._tree_leaves(ed)
            self.assertFalse(leaves[("npc", "npc1")].isHidden())
            self.assertTrue(leaves[("npc", "npc2")].isHidden())
            self.assertTrue(leaves[("hotspot", "h1")].isHidden())
            ed._tree_filter.setText("")
            leaves = self._tree_leaves(ed)
            self.assertFalse(leaves[("npc", "npc2")].isHidden())

    # ---- 双向同步 ----------------------------------------------------------

    def test_tree_click_selects_canvas_and_loads_props(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            leaves = self._tree_leaves(ed)
            leaves[("npc", "npc2")].setSelected(True)
            QApplication.processEvents()
            sel = ed._canvas_selected_entity_refs()
            self.assertEqual(sel, [("npc", "npc2")], "树点选应同步画布选中")
            st = ed._props._staging_npc
            self.assertIsNotNone(st)
            self.assertEqual(str(st.get("id")), "npc2", "树点选应装载该实体属性面板")

    def test_canvas_select_highlights_tree(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            item = ed._canvas._entity_items.get("npc:npc1")
            item.setSelected(True)
            QApplication.processEvents()
            leaves = self._tree_leaves(ed)
            self.assertTrue(leaves[("npc", "npc1")].isSelected(),
                            "画布选中应高亮树对应行")

    # ---- 多选批量：移动 ----------------------------------------------------

    def test_batch_move_is_single_undo_command(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_canvas_drag_press()
            ed._on_items_batch_moved([
                ("npc", "npc1", 111.0, 112.0),
                ("npc", "npc2", 211.0, 212.0),
            ])
            self.assertEqual(
                (self._npc(model, "sc_a", "npc1")["x"],
                 self._npc(model, "sc_a", "npc2")["x"]), (111.0, 211.0))
            self.assertEqual(ed._undo.stack.count(), 1, "一次批量移动=一条命令")

            ed.editor_undo()
            n1 = self._npc(model, "sc_a", "npc1")
            n2 = self._npc(model, "sc_a", "npc2")
            self.assertEqual((n1["x"], n1["y"], n2["x"], n2["y"]),
                             (100, 100, 200, 200), "一次撤销应回滚全部成员")
            self.assertIsInstance(n1["x"], int)

    def test_real_mouse_multidrag_moves_both_one_command(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed.resize(1200, 800)
            ed.show()
            QApplication.processEvents()
            ed._canvas.fit_all()
            QApplication.processEvents()

            it1 = ed._canvas._entity_items.get("npc:npc1")
            it2 = ed._canvas._entity_items.get("npc:npc2")
            it1.setSelected(True)
            it2.setSelected(True)
            QApplication.processEvents()

            start_vp = ed._canvas.mapFromScene(it1.pos())
            end_vp = start_vp + QPoint(30, 24)
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start_vp)
            QTest.mouseMove(vp, pos=start_vp + QPoint(12, 9))
            QTest.mouseMove(vp, pos=end_vp)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end_vp)
            QApplication.processEvents()

            n1 = self._npc(model, "sc_a", "npc1")
            n2 = self._npc(model, "sc_a", "npc2")
            self.assertNotEqual((n1["x"], n1["y"]), (100, 100), "组拖应移动成员1")
            self.assertNotEqual((n2["x"], n2["y"]), (200, 200), "组拖应移动成员2")
            self.assertEqual(ed._undo.stack.count(), 1,
                             "真实多选拖动一次手势=一条撤销命令")
            ed.editor_undo()
            n1 = self._npc(model, "sc_a", "npc1")
            n2 = self._npc(model, "sc_a", "npc2")
            self.assertEqual((n1["x"], n1["y"], n2["x"], n2["y"]),
                             (100, 100, 200, 200))

    # ---- 多选批量：删除 / 复制 ---------------------------------------------

    def test_batch_delete_undo_restores_all(self) -> None:
        from tools.editor.shared import confirm as confirm_mod

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._canvas._entity_items["npc:npc1"].setSelected(True)
            ed._canvas._entity_items["hotspot:h1"].setSelected(True)
            QApplication.processEvents()
            real = confirm_mod.confirm_delete
            confirm_mod.confirm_delete = lambda *a, **k: True
            try:
                ed._delete_selected()
            finally:
                confirm_mod.confirm_delete = real
            self.assertFalse(
                any(n.get("id") == "npc1" for n in model.scenes["sc_a"]["npcs"]))
            self.assertFalse(
                any(h.get("id") == "h1" for h in model.scenes["sc_a"]["hotspots"]))
            self.assertEqual(ed._undo.stack.count(), 1, "批量删除=一条命令")

            ed.editor_undo()
            self.assertTrue(
                any(n.get("id") == "npc1" for n in model.scenes["sc_a"]["npcs"]))
            self.assertTrue(
                any(h.get("id") == "h1" for h in model.scenes["sc_a"]["hotspots"]))

    def test_batch_duplicate_undo(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._canvas._entity_items["npc:npc1"].setSelected(True)
            ed._canvas._entity_items["npc:npc2"].setSelected(True)
            QApplication.processEvents()
            n0 = len(model.scenes["sc_a"]["npcs"])
            ed._duplicate_selected()
            self.assertEqual(len(model.scenes["sc_a"]["npcs"]), n0 + 2,
                             "批量复制应各出一个副本")
            self.assertEqual(ed._undo.stack.count(), 1, "批量复制=一条命令")
            ed.editor_undo()
            self.assertEqual(len(model.scenes["sc_a"]["npcs"]), n0)

    # ---- 分组指派 -----------------------------------------------------------

    def test_assign_group_write_and_undo(self) -> None:
        from PySide6.QtWidgets import QInputDialog

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._canvas._entity_items["npc:npc1"].setSelected(True)
            ed._canvas._entity_items["hotspot:h1"].setSelected(True)
            QApplication.processEvents()
            orig_get_item = QInputDialog.getItem
            QInputDialog.getItem = staticmethod(lambda *a, **k: ("夜巡", True))
            try:
                ed._assign_group_to_selection()
            finally:
                QInputDialog.getItem = orig_get_item
            self.assertEqual(self._npc(model, "sc_a", "npc1").get("group"), "夜巡")
            hs = model.scenes["sc_a"]["hotspots"][0]
            self.assertEqual(hs.get("group"), "夜巡")

            # 分组视图应出现「组 夜巡」节点
            ed._tree_mode.setCurrentIndex(1)
            titles = []
            root = ed._entity_tree.invisibleRootItem()
            for i in range(root.childCount()):
                titles.append(root.child(i).text(0))
            self.assertTrue(any("夜巡" in t for t in titles), f"分组视图缺组节点: {titles}")

            ed.editor_undo()
            self.assertNotIn("group", self._npc(model, "sc_a", "npc1"),
                             "撤销应移除 group 键（缺省不写）")

    # ---- 多选状态页 ---------------------------------------------------------

    def test_multi_selection_shows_multi_panel(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            ed._canvas._entity_items["npc:npc1"].setSelected(True)
            ed._canvas._entity_items["npc:npc2"].setSelected(True)
            QApplication.processEvents()
            self.assertIs(ed._props._stack.currentWidget(), ed._props._multi_panel,
                          "多选应切到多选状态页")
            self.assertIn("2", ed._props._multi_label.text())


class TreeOnlySelectionBatchTests(unittest.TestCase):
    """审查 P1-B：树能选中画布上选不中的实体（cutscene-only 等），
    批量操作目标集必须并入树选中，不得静默漏删。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            try:
                ed._scene_npc_anim_timer.stop()
                ed._patrol_overlay_refresh_timer.stop()
                ed._canvas._gfx.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def test_batch_delete_includes_tree_only_cutscene_entity(self) -> None:
        from tools.editor.shared import confirm as confirm_mod

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            sc = _scene("sc_a")
            # cutscene-only 实体：树里可见，画布不建图元（选不中）
            sc["hotspots"].append({
                "id": "h_cut", "type": "inspect", "label": "", "x": 90, "y": 90,
                "interactionRange": 50, "data": {"text": ""},
                "cutsceneIds": ["cs_x"],
            })
            model.scenes = {"sc_a": sc}
            ed = SceneEditor(model)
            ed._refresh_scene_list()
            ed._load_scene("sc_a")
            self._editors.append(ed)
            model._dirty.clear()
            model._dirty_scene_ids.clear()
            model._dirty_scenes_all = False
            ed._undo.clear()

            self.assertIsNone(
                ed._canvas._entity_items.get("hotspot:h_cut"),
                "前提：cutscene-only 实体画布无图元")
            leaves = {}
            r = ed._entity_tree.invisibleRootItem()
            for i in range(r.childCount()):
                for j in range(r.child(i).childCount()):
                    leaf = r.child(i).child(j)
                    d = leaf.data(0, Qt.ItemDataRole.UserRole)
                    if d:
                        leaves[tuple(d)] = leaf
            leaves[("hotspot", "h1")].setSelected(True)
            leaves[("hotspot", "h_cut")].setSelected(True)
            QApplication.processEvents()

            refs = ed._selected_entity_refs_plural()
            self.assertIn(("hotspot", "h_cut"), refs,
                          "批量目标集必须并入树选中（画布选不中的成员）")

            real = confirm_mod.confirm_delete
            confirm_mod.confirm_delete = lambda *a, **k: True
            try:
                ed._delete_selected()
            finally:
                confirm_mod.confirm_delete = real
            ids = [h.get("id") for h in model.scenes["sc_a"]["hotspots"]]
            self.assertNotIn("h1", ids)
            self.assertNotIn("h_cut", ids, "树选中的 cutscene-only 实体也必须被删")

            ed.editor_undo()
            ids = [h.get("id") for h in model.scenes["sc_a"]["hotspots"]]
            self.assertIn("h1", ids)
            self.assertIn("h_cut", ids)


if __name__ == "__main__":
    unittest.main()
