"""新画布的跨文件重构入口（改名 / 迁移 / 安全删除）。

这一组测试的由来：新画布曾经**手拼**过一份简化版重构弹窗，而它与
`shared/entity_refactor` 引擎四处对不上，且**全部静默**——

1. 读 `usages["total"]` / `["rows"]` / `["hits"]`，可报告里计数叫 `totalRefs`、
   明细是按处置类别分的组，那三个键一个都不存在。于是三个框恒报
   「全项目有 0 处引用」+ 空预览：**越是引用多的实体，越是被这句话骗着删掉**；
2. `move_entity` 的实参整体错位一格（把目标场景传成了 kind）；
3. `delete_entity` 不传 `force`、也没接返回的 `reverse_ops`；
4. 三条路径都没 `push_journal`，于是「撤销上次重构」永远撤不到本页做的事。

现在改为复用与老画布同一套共享对话框。下面每条都对着上面某一条锁：
锁的是**行为**（数字对不对、实体去了哪、撤销撤不撤得回来），不是"调了哪个函数"。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication, QMenu, QMessageBox

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.shared import entity_refactor as er
from tools.editor.shared import entity_refactor_dialog as erd
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "重构街"
_OTHER = "重构巷"


def _scene(sid: str) -> dict:
    return {
        "id": sid, "name": sid, "worldWidth": 800, "worldHeight": 600,
        "hotspots": [
            # npc 型热点的 data.npcId 指着 n1：一条**本场景其它容器里的裸引用**
            # （scan 归入 sceneLocal，改名时机械跟随）。旧实现正是在这种实体上
            # 报「0 处引用」。type 必须是 "npc" —— 引擎的改写面只认 npc 型热点。
            {"id": "h1", "type": "npc", "x": 100, "y": 100,
             "data": {"npcId": "n1"}},
        ],
        "npcs": [{"id": "n1", "name": "甲", "x": 300, "y": 300}],
        "zones": [],
        "spawnPoint": {"x": 50, "y": 500},
        "spawnPoints": {"north": {"x": 700, "y": 50}},
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_SCENE] = _scene(_SCENE)
        self.model.scenes[_OTHER] = {
            "id": _OTHER, "name": _OTHER, "worldWidth": 800, "worldHeight": 600,
            "hotspots": [], "npcs": [], "zones": [],
            "spawnPoint": {"x": 10, "y": 10},
        }
        self.page = SceneEditorV2(self.model)
        self.page.load_scene(_SCENE)
        # 结果提示是模态框：不挡住，测试会停在那儿等人点确定。
        self._boxes = patch.multiple(
            QMessageBox,
            information=lambda *a, **k: QMessageBox.StandardButton.Ok,
            warning=lambda *a, **k: QMessageBox.StandardButton.Ok,
        )
        self._boxes.start()
        self.addCleanup(self._boxes.stop)

    def tearDown(self) -> None:
        self.page.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def _select(self, kind: str, eid: str) -> None:
        assert self.page._doc is not None
        self.page._doc.set_selection([EntityRef(kind, eid)])

    def _npc_ids(self, sid: str) -> list[str]:
        return [str(n.get("id")) for n in self.model.scenes[sid].get("npcs") or []]


class ReferenceCountTests(_Base):
    """1. 计数必须是引擎报告里的真数。"""

    def test_delete_dialog_sees_the_real_reference_count(self) -> None:
        """被 `hotspot.data.npcId` 指着的 NPC，删除框里**不能**是 0 处引用。

        旧实现读的 `usages["total"]` 在报告里根本不存在，于是恒 0——用户看到
        「全项目有 0 处引用」就点了删除，实际那条热区从此指空。
        """
        seen: dict[str, int] = {}

        def fake_exec(dlg) -> int:
            seen["total"] = int(dlg._report["totalRefs"])
            seen["external"] = int(dlg._report["totalRefs"] - dlg._report["selfRefs"])
            return 0  # 取消，只看报告

        self._select("npc", "n1")
        with patch.object(erd.SafeDeleteEntityDialog, "exec", fake_exec):
            self.assertFalse(self.page.refactor_selected("delete"))
        self.assertGreater(
            seen.get("total", 0), 0,
            "删除框拿到的引用数仍是 0——计数又没走引擎报告的 totalRefs")
        self.assertGreater(
            seen.get("external", 0), 0,
            "外部引用数为 0，强制删除的门就形同虚设")

    def test_scan_report_has_no_total_or_rows_key(self) -> None:
        """守住键名本身：报告里从来没有 `total` / `rows` / `hits`。

        这三个键是旧实现凭空假设的。留这条断言，是因为一旦有人再按直觉写
        `usages.get("total", 0)`，症状仍是"恒 0"这种**不报错**的假消息。
        """
        report = er.scan_entity_usages(self.model, _SCENE, "npc", "n1")
        for absent in ("total", "rows", "hits"):
            self.assertNotIn(absent, report)
        self.assertIn("totalRefs", report)


class SafeDeleteTests(_Base):
    """3./4. force 要传、reverse_ops 要接、日志要推（否则撤不回来）。"""

    def _delete_with_force(self) -> bool:
        def fake_exec(dlg) -> int:
            dlg._force.setChecked(True)   # 有外部引用，必须勾强制
            dlg._on_accept()
            return 1

        self._select("npc", "n1")
        with patch.object(erd.SafeDeleteEntityDialog, "exec", fake_exec):
            return self.page.refactor_selected("delete")

    def test_forced_delete_removes_the_entity(self) -> None:
        """有外部引用的实体，勾了强制就该真删掉（旧实现不传 force，引擎硬拒）。"""
        self.assertIn("n1", self._npc_ids(_SCENE))
        self.assertTrue(self._delete_with_force())
        self.assertNotIn("n1", self._npc_ids(_SCENE))

    def test_delete_is_undoable_through_the_refactor_journal(self) -> None:
        """删完必须能用「撤销上次重构」按位重插——旧实现不推日志，撤了个寂寞。"""
        self.assertTrue(self._delete_with_force())
        self.assertEqual(er.journal_size(self.model), 1,
                         "重构日志是空的：undo_last 撤到的会是别处更早那一次")
        self.assertTrue(self.page.undo_last_refactor())
        self.assertIn("n1", self._npc_ids(_SCENE))


class MoveTests(_Base):
    """2. 实参顺序：`move_entity(model, src, kind, entity_id, dst)`。"""

    def test_move_lands_in_the_target_scene(self) -> None:
        """旧实现把目标场景当 kind 传，这条必崩（"场景 'npc' 不存在"）。"""
        def fake_exec(dlg) -> int:
            dlg._dst.set_current(_OTHER)
            dlg._on_accept()
            return 1

        self._select("npc", "n1")
        with patch.object(erd.MoveEntityDialog, "exec", fake_exec):
            self.assertTrue(self.page.refactor_selected("move"))
        self.assertNotIn("n1", self._npc_ids(_SCENE))
        self.assertIn("n1", self._npc_ids(_OTHER))
        self.assertEqual(er.journal_size(self.model), 1)


class RenameTests(_Base):
    def _rename_to(self, new_id: str) -> bool:
        def fake_exec(dlg) -> int:
            dlg._new_id.setText(new_id)
            dlg._on_accept()
            return 1

        self._select("npc", "n1")
        with patch.object(erd.RenameEntityDialog, "exec", fake_exec):
            return self.page.refactor_selected("rename")

    def test_rename_follows_the_inbound_reference(self) -> None:
        """改名要带着那条 `hotspot.data.npcId` 一起走，否则热区当场指空。"""
        self.assertTrue(self._rename_to("n1_new"))
        self.assertIn("n1_new", self._npc_ids(_SCENE))
        hs = self.model.scenes[_SCENE]["hotspots"][0]
        self.assertEqual(hs["data"]["npcId"], "n1_new")

    def test_rename_reselects_the_new_id(self) -> None:
        """不回选的话，属性面板挂在一个已经不存在的 id 上，打的字哪儿都不写。"""
        self.assertTrue(self._rename_to("n1_new"))
        assert self.page._doc is not None
        self.assertEqual([r.key for r in self.page._doc.selection], ["npc:n1_new"])

    def test_refactor_clears_the_field_level_undo_stack(self) -> None:
        """跨文件改写之后 Ctrl+Z 必须无路可退。

        字段级命令的快照是重构**前**那份场景，撤过这道坎就是把已经机械改写过的
        引用网撕成半截。`reload_from_model` 在场景 dict 对象身份没变时刻意保住
        撤销栈，所以清栈这一步只能由重构入口自己做。
        """
        assert self.page._doc is not None
        self.assertTrue(self._rename_to("n1_new"))
        self.assertEqual(self.page._doc.undo_stack.count(), 0)


class _CapturingMenu(QMenu):
    """顶替 page 模块里的 `QMenu`：不真弹，只把菜单项文案记下来。"""

    captured: list[str] = []

    def exec(self, *args, **kwargs):  # noqa: A003 - 覆盖 QMenu.exec
        type(self).captured = [a.text() for a in self.actions()]
        return None


class MenuEntryTests(_Base):
    """重构入口挂在哪：画布右键与实体树右键**必须一致**。

    画布上此前一个重构入口都没有，唯一的删除是裸删（无引用报告）——而摆位就是
    在画布上做的，右键删掉一个被别处引用的实体不会有任何提示。
    """

    _WANTED = ("重命名 id…", "迁移到场景…", "安全删除（引用报告）…", "撤销上次重构")

    def _menu_texts(self, show) -> list[str]:
        """弹出菜单并取回菜单项文案（`exec` 是模态的，必须挡掉）。

        挡法是**替掉 page 模块里的 `QMenu` 名字**，不是 `patch.object(QMenu, "exec")`
        —— PySide6 的类型是 Shiboken 类型，往上打补丁不生效，菜单会真的弹出来把
        pytest worker 卡死（实测 `node down: Not properly terminated`）。
        """
        _CapturingMenu.captured = []
        with patch("tools.editor.editors.scene_v2.page.QMenu", _CapturingMenu):
            show()
        return list(_CapturingMenu.captured)

    def _canvas_texts(self) -> list[str]:
        from PySide6.QtCore import QPoint, QPointF
        return self._menu_texts(
            lambda: self.page._show_canvas_menu(QPointF(10, 10), QPoint(0, 0)))

    def _tree_texts(self) -> list[str]:
        from PySide6.QtCore import QPoint
        return self._menu_texts(lambda: self.page._show_tree_menu(QPoint(0, 0)))

    def test_canvas_menu_offers_refactor_on_a_single_entity(self) -> None:
        self._select("npc", "n1")
        texts = self._canvas_texts()
        for wanted in self._WANTED:
            self.assertIn(wanted, texts)

    def test_tree_menu_offers_refactor_on_a_single_entity(self) -> None:
        self._select("npc", "n1")
        texts = self._tree_texts()
        for wanted in self._WANTED:
            self.assertIn(wanted, texts)

    def test_canvas_menu_offers_refactor_for_a_spawn_point(self) -> None:
        """出生点也走重构（改名/迁移都有入站引用要跟随）。"""
        self._select("spawn", "north")
        self.assertIn("重命名 id…", self._canvas_texts())

    def test_no_refactor_entry_without_a_single_target(self) -> None:
        """没选、或多选：菜单里不该出现只对单实体成立的入口。"""
        assert self.page._doc is not None
        self.page._doc.clear_selection()
        self.assertNotIn("重命名 id…", self._canvas_texts())
        self.page._doc.set_selection([EntityRef("npc", "n1"), EntityRef("hotspot", "h1")])
        self.assertNotIn("重命名 id…", self._canvas_texts())
        self.assertNotIn("重命名 id…", self._tree_texts())

    def test_menu_visibility_matches_what_refactor_selected_accepts(self) -> None:
        """**菜单显示 == 真能点动**。

        树菜单旧门条件是「非 spawn 实体恰好 1 个」：选中 [npc, spawn] 时菜单照挂，
        点下去却被 `refactor_selected` 以"请先选中恰好一个实体"拒绝。
        """
        assert self.page._doc is not None
        self.page._doc.set_selection([EntityRef("npc", "n1"), EntityRef("spawn", "north")])
        shown = "重命名 id…" in self._tree_texts()
        with patch.object(erd.RenameEntityDialog, "exec", lambda dlg: 0):
            accepted = self.page.refactor_selected("rename")
        self.assertFalse(shown, "两个可重构目标却挂出了单实体入口")
        self.assertFalse(accepted)


class GuardTests(_Base):
    def test_default_spawn_is_refused(self) -> None:
        """默认出生点是场景结构件，没有 id 可改、也不该被"安全删除"。"""
        self._select("spawn", "default")
        self.assertFalse(self.page.refactor_selected("delete"))

    def test_multi_selection_is_refused(self) -> None:
        assert self.page._doc is not None
        self.page._doc.set_selection([EntityRef("npc", "n1"), EntityRef("hotspot", "h1")])
        self.assertFalse(self.page.refactor_selected("rename"))

    def test_unknown_op_is_refused(self) -> None:
        self._select("npc", "n1")
        self.assertFalse(self.page.refactor_selected("convert"))


if __name__ == "__main__":
    unittest.main()
