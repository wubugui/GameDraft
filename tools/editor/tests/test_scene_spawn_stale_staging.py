"""场景编辑器「直写源 × stale staging 盲提交」流程护栏（审查 P1-01 / P1-02）。

背景：spawnPoints 在 staging 里是 deepcopy 快照（不像 hotspots/npcs/zones 与模型共享
引用）。历史 bug：面板/画布有未 Apply 编辑时，删/增出生点直写源，随后 _load_scene 的
commit-on-leave 用打开场景时的旧 staging 快照整体覆盖 spawnPoints——删的「复活」、增的
静默丢失（P1-25 第二次复发）。撤销上次重构同族：撤销后迟到 commit 用新 id staging 覆盖
引擎撤销结果，引用网劈叉。

这些是流程层护栏（编辑→操作→断言模型），model 层测试全绿掩盖不了。修复前应为红。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

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
        ],
        "zones": [],
        "spawnPoints": {
            "entry": {"x": 5, "y": 5},
            "back": {"x": 9, "y": 9, "ai_meta": "keep"},
        },
    }


class SpawnStaleStagingFlowTests(unittest.TestCase):
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
        return ed, model

    # ---- P1-01: 有 pending 编辑时删出生点，不得「复活」 --------------------
    def test_delete_spawn_with_pending_edit_does_not_resurrect(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            # 关键：pending 必须在「删除那一刻」真实存在——否则删除路径的 commit 是空操作，
            # 去掉修复照样绿（假护栏）。因此先选中要删的出生点，再在 spawn 面板/画布上
            # 制造未应用编辑（拖动同一出生点改坐标），这会写进 stale staging 快照且置脏。
            ed._on_item_selected("spawn", "entry")
            ed._on_item_moved("spawn", "entry", 111.0, 222.0)
            self.assertTrue(
                ed._props.is_pending_dirty(),
                "删除前 spawn 面板必须有真实未应用编辑，否则护栏无从触发（假护栏）",
            )
            # 删除同一出生点 entry：删除路径必须先 commit 掉这份 pending，否则随后
            # _load_scene 的 commit-on-leave 用仍含 entry 的旧 staging 整体覆盖 spawnPoints，
            # 把刚删的出生点「复活」（审查 P1-01；P1-25 同族复发）。
            with mock.patch(
                "tools.editor.editors.scene_editor.confirm.confirm_delete",
                return_value=True,
            ):
                ed._delete_selected()
            sps = model.scenes["sc_a"]["spawnPoints"]
            self.assertNotIn("entry", sps, "删除的出生点不得因 stale staging 盲提交而复活")
            # 未删除的 back 及其 AI 未知键必须原样保留（commit 走 merge，不误伤旁邻出生点）
            self.assertIn("back", sps, "未删除的出生点不得被删除路径的 commit 波及")
            self.assertEqual(sps["back"].get("ai_meta"), "keep")

    # ---- P1-01: 有 pending 编辑时新增出生点，不得静默丢失 ------------------
    def test_add_spawn_with_pending_edit_survives(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("hotspot", "h1")
            ed._on_item_moved("hotspot", "h1", 321.0, 123.0)
            self.assertTrue(ed._props.is_pending_dirty())
            ed._add_spawn_at(700.0, 800.0)
            sps = model.scenes["sc_a"]["spawnPoints"]
            new_keys = [k for k in sps if k not in ("entry", "back")]
            self.assertEqual(len(new_keys), 1, "新增出生点不得因 stale staging 盲提交丢失")
            self.assertEqual(sps[new_keys[0]], {"x": 700.0, "y": 800.0})
            # 既有的 AI 未知键保住
            self.assertEqual(sps["back"].get("ai_meta"), "keep")

    # ---- P1-02: 撤销上次重构前先 commit pending，引用网不劈叉 --------------
    def test_undo_refactor_commits_pending_first(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            from tools.editor.shared import entity_refactor as er
            # 先真做一次改名（引擎），建立可撤销日志
            summary = er.rename_entity(model, "sc_a", "npc", "npc1", "npc1_new")
            er.push_journal(model, summary)
            ed._load_scene("sc_a", reset_view=False)
            # 选中改名后的实体并制造 pending 编辑（改坐标，不 Apply）
            ed._on_item_selected("npc", "npc1_new")
            ed._on_item_moved("npc", "npc1_new", 555.0, 666.0)
            self.assertTrue(ed._props.is_pending_dirty())
            # 撤销上次重构：撤销前必须 commit pending，否则迟到 commit 用新 id staging 覆盖。
            # _undo_entity_refactor 末尾弹 QMessageBox.information（离屏会阻塞），mock 掉。
            with mock.patch(
                "tools.editor.editors.scene_editor.QMessageBox.information",
                return_value=None,
            ):
                ed._undo_entity_refactor()
            ids = [n["id"] for n in model.scenes["sc_a"]["npcs"]]
            self.assertIn("npc1", ids, "撤销改名后实体 id 必须回到旧值")
            self.assertNotIn("npc1_new", ids,
                             "撤销后迟到的 commit-on-leave 不得用新 id staging 复活新 id")


if __name__ == "__main__":
    unittest.main()
