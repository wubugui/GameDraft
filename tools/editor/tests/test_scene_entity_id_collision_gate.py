"""场景实体 id 撞名闸的流程探针：从最外层用户入口进（画布选中 → 改 id 框 → Apply/切走）。

历史缺陷：npc / hotspot / zone 的 id 输入框是裸写入（``ent["id"] = 输入框文本``），提交前
零校验。撞名只有事后 ``validate-data`` 才报 error，而那时运行时 ``getNpcById`` 已经 first-wins
拿错实体、画布图元按 ``kind:id`` 建键互相覆盖、属性/删除按 id 首匹配串台。对照组：同一个文件里
出生点改名（``_write_spawn_widgets_to_dict``）与新建场景 id 都是撞名直接拒绝。

口径（与 validator「实体 id 重复」检查、entity_refactor 的撞名互拒一致）：
npc 与 hotspot 共用一个命名空间，zone 独立。撞名/空 id 一律退回原 id，**本轮其它编辑照常提交**。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class TestSceneEntityIdCollisionGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _bootstrap_editor(self, root: Path) -> tuple[SceneEditor, str]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        sid = next(iter(model.scenes.keys()))
        sc = model.scenes[sid]
        sc.setdefault("npcs", []).extend([
            {"id": "n0", "name": "N0", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "n1", "name": "N1", "x": 150, "y": 150, "interactionRange": 50},
        ])
        sc.setdefault("hotspots", []).append({
            "id": "h0", "type": "inspect", "label": "", "x": 200, "y": 200,
            "interactionRange": 50, "data": {"text": ""},
        })
        sc.setdefault("zones", []).extend([
            {"id": "z0", "polygon": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}]},
            {"id": "z1", "polygon": [{"x": 20, "y": 0}, {"x": 30, "y": 0}, {"x": 30, "y": 10}]},
        ])
        editor = SceneEditor(model)
        editor._load_scene(sid)
        return editor, sid

    def _settle_and_close_editor(self, editor: SceneEditor) -> None:
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

    def _select(self, editor: SceneEditor, kind: str, eid: str) -> None:
        editor._canvas._entity_items[f"{kind}:{eid}"].setSelected(True)
        editor._on_item_selected(kind, eid)
        self._qt_app.processEvents()

    # ---- 撞名被拦 ------------------------------------------------------- #

    def test_npc_id_renamed_onto_another_npc_is_rejected_and_reverted(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "npc", "n0")
                editor._props._npc_id.setText("n1")          # 撞同场景另一个 NPC
                editor._props._npc_name.setText("同轮改的名字")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertTrue(warn.called, "撞名必须弹窗告知，不能静默吞掉")
                npcs = editor._model.scenes[sid]["npcs"]
                self.assertEqual([n["id"] for n in npcs], ["n0", "n1"], "两个 NPC 都必须还在，id 不得被顶掉")
                # 同一轮里其它字段照常提交——不能因为一个 id 冲突把整批编辑卡住
                self.assertEqual(npcs[0]["name"], "同轮改的名字")
                # 面板也回滚到原 id，不能继续显示被拒绝的名字
                self.assertEqual(editor._props._npc_id.text(), "n0")
            finally:
                self._settle_and_close_editor(editor)

    def test_npc_id_colliding_with_hotspot_is_rejected_shared_namespace(self) -> None:
        """npc 与 hotspot 共用寻址命名空间（emote/实体动作目标），跨类撞名同样拦。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "npc", "n0")
                editor._props._npc_id.setText("h0")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertTrue(warn.called)
                self.assertEqual([n["id"] for n in editor._model.scenes[sid]["npcs"]], ["n0", "n1"])
                self.assertEqual([h["id"] for h in editor._model.scenes[sid]["hotspots"]], ["h0"])
            finally:
                self._settle_and_close_editor(editor)

    def test_hotspot_id_colliding_with_npc_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "hotspot", "h0")
                editor._props._hs_id.setText("n1")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertTrue(warn.called)
                self.assertEqual([h["id"] for h in editor._model.scenes[sid]["hotspots"]], ["h0"])
            finally:
                self._settle_and_close_editor(editor)

    def test_zone_id_collision_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "zone", "z0")
                editor._props._zn_id.setText("z1")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertTrue(warn.called)
                self.assertEqual([z["id"] for z in editor._model.scenes[sid]["zones"]], ["z0", "z1"])
            finally:
                self._settle_and_close_editor(editor)

    def test_zone_may_reuse_an_npc_id_independent_namespace(self) -> None:
        """zone 是独立命名空间（validator 单查），不该被 npc/hotspot 的 id 误伤。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "zone", "z0")
                editor._props._zn_id.setText("n1")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertFalse(warn.called, "zone 与 npc 不共用命名空间，不得误拦")
                self.assertEqual([z["id"] for z in editor._model.scenes[sid]["zones"]], ["n1", "z1"])
            finally:
                self._settle_and_close_editor(editor)

    def test_empty_id_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "npc", "n0")
                editor._props._npc_id.setText("   ")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertTrue(warn.called)
                self.assertEqual([n["id"] for n in editor._model.scenes[sid]["npcs"]], ["n0", "n1"])
            finally:
                self._settle_and_close_editor(editor)

    # ---- 合法改名仍然放行 ------------------------------------------------ #

    def test_free_rename_still_applies(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "npc", "n0")
                editor._props._npc_id.setText("守夜人")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertFalse(warn.called, "不撞名的改名不得被拦")
                self.assertEqual([n["id"] for n in editor._model.scenes[sid]["npcs"]], ["守夜人", "n1"])
            finally:
                self._settle_and_close_editor(editor)

    def test_unchanged_id_never_triggers_the_gate(self) -> None:
        """只改别的字段、id 原样时闸门必须完全无感（不弹窗、不回填）。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "npc", "n0")
                editor._props._npc_name.setText("只改名字")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    editor._apply_props()
                self.assertFalse(warn.called)
                self.assertEqual(editor._model.scenes[sid]["npcs"][0]["name"], "只改名字")
            finally:
                self._settle_and_close_editor(editor)

    # ---- commit-on-leave 同样过闸（不能靠切走绕开） ----------------------- #

    def test_collision_is_gated_on_commit_on_leave_too(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self._select(editor, "npc", "n0")
                editor._props._npc_id.setText("n1")
                with patch.object(QMessageBox, "warning", return_value=QMessageBox.StandardButton.Ok) as warn:
                    self._select(editor, "npc", "n1")   # 切实体 → commit-on-leave
                self.assertTrue(warn.called, "切走提交也必须过同一道闸")
                self.assertEqual([n["id"] for n in editor._model.scenes[sid]["npcs"]], ["n0", "n1"])
            finally:
                self._settle_and_close_editor(editor)

    # ---- 新建取号跨命名空间 --------------------------------------------- #

    def test_new_entity_numbering_spans_the_shared_namespace(self) -> None:
        """自动取号必须查整个命名空间：hotspots 里已占 new_npc_0 时不能再发同名给 NPC。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                editor._model.scenes[sid]["hotspots"].append({
                    "id": "new_npc_0", "type": "inspect", "label": "", "x": 10, "y": 10,
                    "interactionRange": 50, "data": {"text": ""},
                })
                editor._add_npc_at(300, 300)
                self._qt_app.processEvents()
                npc_ids = [n["id"] for n in editor._model.scenes[sid]["npcs"]]
                self.assertIn("new_npc_1", npc_ids)
                self.assertNotIn("new_npc_0", npc_ids)
            finally:
                self._settle_and_close_editor(editor)


if __name__ == "__main__":
    unittest.main()
