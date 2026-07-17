"""场景编辑器撤销/重做（P1）流程探针。

护栏语义（对齐 editor-change-verification-gate 的两道升级门）：
- 撤销必须把「模型层」精确回滚（含 int/float 数值表示与未知键——零丢失往返）；
- 交互特性从最外层用户入口验证：真实 QMouseEvent 拖拽 → Ctrl+Z 路径（editor_undo）；
- pending（未 Apply 的 staging 编辑）在 Ctrl+Z 时先提交为命令再撤销，不得静默丢弃。
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
             "interactionRange": 50, "data": {"text": ""},
             "aiCustomKey": {"keep": ["me"]}},
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


class SceneUndoRedoTests(unittest.TestCase):
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

    # ---- 拖拽 → 撤销 → 重做（数值表示保真） --------------------------------

    def test_drag_undo_restores_exact_int_repr(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            # 模拟画布手势：press 捕获 before → 拖拽 release 写回
            ed._on_canvas_drag_press()
            ed._on_item_moved("npc", "npc1", 333.0, 444.0)
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (333.0, 444.0))

            ed.editor_undo()
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (100, 100))
            self.assertIsInstance(n["x"], int, "撤销必须还原 int 表示，不得漂成 float")
            self.assertIsInstance(n["y"], int)

            ed.editor_redo()
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (333.0, 444.0))

    def test_drag_undo_via_real_mouse_events(self) -> None:
        """最外层入口探针：真实 QMouseEvent 拖拽 → editor_undo 回滚模型。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed.resize(1200, 800)
            ed.show()
            QApplication.processEvents()
            ed._canvas.fit_all()
            QApplication.processEvents()

            item = ed._canvas._entity_items.get("npc:npc2")
            self.assertIsNotNone(item, "画布上应有 npc2 圆点")
            item.setSelected(True)
            start_vp = ed._canvas.mapFromScene(item.pos())
            end_vp = start_vp + QPoint(40, 30)

            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start_vp)
            QTest.mouseMove(vp, pos=start_vp + QPoint(15, 10))
            QTest.mouseMove(vp, pos=end_vp)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end_vp)
            QApplication.processEvents()

            n = self._npc(model, "sc_a", "npc2")
            moved = (n["x"], n["y"])
            self.assertNotEqual(moved, (200, 200), "真实拖拽应已写回新坐标")
            self.assertTrue(ed._undo.stack.canUndo(), "拖拽后应产生可撤销命令")

            ed.editor_undo()
            n = self._npc(model, "sc_a", "npc2")
            self.assertEqual((n["x"], n["y"]), (200, 200))

    # ---- 删除 / 新增 / 复制 -------------------------------------------------

    def test_delete_undo_restores_entity_with_unknown_keys(self) -> None:
        from tools.editor.shared import confirm as confirm_mod

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("hotspot", "h1")
            ed._try_select_canvas_item("hotspot", "h1")
            orig = None
            for h in model.scenes["sc_a"]["hotspots"]:
                if h["id"] == "h1":
                    import copy as _c
                    orig = _c.deepcopy(h)
            self.assertIsNotNone(orig)

            real_confirm = confirm_mod.confirm_delete
            confirm_mod.confirm_delete = lambda *a, **k: True
            try:
                ed._delete_selected()
            finally:
                confirm_mod.confirm_delete = real_confirm
            self.assertFalse(
                any(h.get("id") == "h1" for h in model.scenes["sc_a"]["hotspots"]),
                "Delete 后实体应已移除")

            ed.editor_undo()
            back = [h for h in model.scenes["sc_a"]["hotspots"] if h.get("id") == "h1"]
            self.assertEqual(len(back), 1, "撤销删除应恢复实体")
            self.assertEqual(back[0], orig, "恢复必须深等（含未知键 aiCustomKey）")
            self.assertIsInstance(back[0]["x"], int)

            ed.editor_redo()
            self.assertFalse(
                any(h.get("id") == "h1" for h in model.scenes["sc_a"]["hotspots"]),
                "重做应再次删除")

    def test_add_entity_undo_redo(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            n0 = len(model.scenes["sc_a"]["npcs"])
            ed._add_npc_at(300, 300)
            self.assertEqual(len(model.scenes["sc_a"]["npcs"]), n0 + 1)
            new_id = model.scenes["sc_a"]["npcs"][-1]["id"]

            ed.editor_undo()
            self.assertEqual(len(model.scenes["sc_a"]["npcs"]), n0, "撤销新增应移除实体")

            ed.editor_redo()
            self.assertEqual(len(model.scenes["sc_a"]["npcs"]), n0 + 1)
            self.assertEqual(
                model.scenes["sc_a"]["npcs"][-1]["id"], new_id,
                "重做必须恢复同一 id（快照回放确定性）")

    def test_duplicate_undo_removes_copy(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._try_select_canvas_item("npc", "npc1")
            n0 = len(model.scenes["sc_a"]["npcs"])
            ed._duplicate_selected()
            self.assertEqual(len(model.scenes["sc_a"]["npcs"]), n0 + 1, "复制应新增副本")

            ed.editor_undo()
            self.assertEqual(len(model.scenes["sc_a"]["npcs"]), n0, "撤销应移除副本")

    # ---- pending（未 Apply 编辑）与 Ctrl+Z 的关系 ---------------------------

    def test_pending_edit_committed_as_command_then_undone(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            st = ed._props._staging_npc
            self.assertIsNotNone(st)
            ed._props.sync_npc_xy_widgets("npc1", 555.0, 666.0)
            st["x"] = 555.0
            st["y"] = 666.0
            ed._props._set_pending_dirty(True)

            ed.editor_undo()  # 应先把 pending 提交为命令，再撤销这条命令
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (100, 100),
                             "pending 编辑不得被 Ctrl+Z 静默跳过或丢弃")

    # ---- Apply 命令化 -------------------------------------------------------

    def test_apply_props_is_undoable(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            st = ed._props._staging_npc
            ed._props.sync_npc_xy_widgets("npc1", 777.0, 888.0)
            st["x"] = 777.0
            st["y"] = 888.0
            ed._props._set_pending_dirty(True)
            ed._apply_props()
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (777.0, 888.0))

            ed.editor_undo()
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (100, 100), "Apply 必须可撤销")
            self.assertIsInstance(n["x"], int)

    # ---- 撤销后标脏（写盘感知） --------------------------------------------

    def test_undo_marks_scene_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_canvas_drag_press()
            ed._on_item_moved("npc", "npc1", 333.0, 444.0)
            model._dirty.clear()
            model._dirty_scene_ids.clear()
            model._dirty_scenes_all = False

            ed.editor_undo()
            self.assertTrue(model.is_dirty, "撤销是模型变更，必须标脏可保存")

    # ---- 零位移不产生命令 ---------------------------------------------------

    def test_no_op_drag_pushes_nothing(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_canvas_drag_press()
            ed._on_item_moved("npc", "npc1", 100.0, 100.0)  # 原位 release
            self.assertFalse(ed._undo.stack.canUndo(), "零位移不得产生撤销命令")
            self.assertFalse(model.is_dirty, "零位移不得标脏")

    # ---- Zone 多边形提交可撤销 ----------------------------------------------

    def test_zone_polygon_commit_undoable(self) -> None:
        import copy as _c

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            orig_poly = _c.deepcopy(model.scenes["sc_a"]["zones"][0]["polygon"])
            new_poly = [{"x": 20, "y": 20}, {"x": 90, "y": 20},
                        {"x": 90, "y": 90}, {"x": 20, "y": 90}]
            ed._on_item_zone_polygon_committed("zone", "z1", new_poly)
            self.assertEqual(model.scenes["sc_a"]["zones"][0]["polygon"], new_poly)

            ed.editor_undo()
            self.assertEqual(
                model.scenes["sc_a"]["zones"][0]["polygon"], orig_poly,
                "Zone 多边形编辑必须可撤销")

    # ---- 跨文件重构清栈 -----------------------------------------------------

    def test_refactor_journal_undo_clears_snapshot_stack(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_canvas_drag_press()
            ed._on_item_moved("npc", "npc1", 333.0, 444.0)
            self.assertTrue(ed._undo.stack.canUndo())

            from tools.editor.shared import entity_refactor as er
            # 夹具两场景实体同名：先清掉目标场景同 id 实体，迁移才合法
            model.scenes["sc_b"]["npcs"] = [
                n for n in model.scenes["sc_b"]["npcs"] if n.get("id") != "npc1"]
            summary = er.move_entity(model, "sc_a", "npc", "npc1", "sc_b")
            er.push_journal(model, summary)
            # 静音信息弹窗
            from PySide6.QtWidgets import QMessageBox
            orig_info = QMessageBox.information
            QMessageBox.information = staticmethod(lambda *a, **k: None)
            try:
                ed._undo_entity_refactor()
            finally:
                QMessageBox.information = orig_info
            self.assertFalse(
                ed._undo.stack.canUndo(),
                "journal 回退后快照栈必须清空（防跨文件半份回退）")


if __name__ == "__main__":
    unittest.main()
