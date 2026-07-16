"""任务图节点拖动的真实鼠标事件回归（审查 P0-1）。

背景：旧 `_QuestGraphView.mousePressEvent` 对「左键命中节点」`event.accept(); return`
从不调 super()，item 永不进入抓取态——节点对真实鼠标「根本拖不动」，整条布局
持久化管线不可达。原护栏 `test_quest_graph_layout_persist.py` 手调 `setPos()+on_moved()`
绕过鼠标管线，6 测试全绿却掩盖断点。

本测试用**真实 QMouseEvent 序列**（press→move→release 打到 view.viewport()）驱动，
断言：
- 真实拖动 → 节点位置变化 + on_moved 回调 + 侧档落盘；
- 纯点击（press→release 零位移）→ on_moved 不写侧档（不把自动布局坐标钉进侧档）；
- 多选拖动 → 所有被移动的选中项都持久化。
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication
from PySide6.QtGui import QMouseEvent
from PySide6.QtCore import Qt, QPoint, QPointF, QEvent

from tools.editor.editors.quest_graph_scene import QuestGraphScene
from tools.editor.editors.quest_graph_layout_store import QuestGraphLayoutStore
from tools.editor.editors.quest_editor import _QuestGraphView
from tools.editor.editors.quest_graph_items import _notify_release
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


_GROUPS = [
    {"id": "g_main", "name": "主线", "type": "main"},
    {"id": "g_side", "name": "支线", "type": "side"},
]

_QUESTS = [
    {"id": "q_a", "group": "g_main", "title": "甲", "nextQuests": [{"questId": "q_b", "conditions": []}]},
    {"id": "q_b", "group": "g_main", "title": "乙", "nextQuests": []},
    {"id": "q_c", "group": "g_main", "title": "丙", "nextQuests": []},
]

_SIDE_FILE = (".editor", "quest_graph_layout.json")


class QuestGraphDragMouseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        m.quest_groups = copy.deepcopy(_GROUPS)
        m.quests = copy.deepcopy(_QUESTS)
        return m

    def _build_group_view(self, root: Path):
        m = self._model(root)
        store = QuestGraphLayoutStore(m.project_path)
        scene = QuestGraphScene(layout_store=store)
        scene.populate_group("g_main", m.quests, m.quest_groups)
        view = _QuestGraphView(scene)
        view.resize(800, 600)
        view.show()
        # 关掉自适应缩放，用恒等变换让 mapFromScene 坐标可预测。
        view.resetTransform()
        QApplication.processEvents()
        return m, scene, view

    def _node_viewport_center(self, view, node) -> QPoint:
        r = node.rect()
        p = node.pos()
        scene_center = QPointF(p.x() + r.width() / 2, p.y() + r.height() / 2)
        return view.mapFromScene(scene_center)

    def _send(self, view, etype, vp_pos: QPoint, buttons,
              modifiers=Qt.KeyboardModifier.NoModifier) -> None:
        gp = view.viewport().mapToGlobal(vp_pos)
        ev = QMouseEvent(
            etype, QPointF(vp_pos), QPointF(gp),
            Qt.MouseButton.LeftButton, buttons, modifiers,
        )
        QApplication.sendEvent(view.viewport(), ev)
        QApplication.processEvents()

    def _click(self, view, node, modifiers=Qt.KeyboardModifier.NoModifier) -> None:
        """真实左键点选：press→release 打到 viewport，走 super() 的选择管线。
        无修饰=独占选中；Ctrl=追加进 Qt 多选集（scene.selectedItems）。"""
        c = self._node_viewport_center(view, node)
        self._send(view, QEvent.Type.MouseButtonPress, c, Qt.MouseButton.LeftButton,
                   modifiers)
        self._send(view, QEvent.Type.MouseButtonRelease, c, Qt.MouseButton.NoButton,
                   modifiers)

    # ---- 真实拖动：位置变 + 回调 + 落盘 -----------------------------------
    def test_real_mouse_drag_moves_node_and_persists(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            m, scene, view = self._build_group_view(root)
            node = scene._node_items["q_a"]
            pos_before = (node.pos().x(), node.pos().y())

            start = self._node_viewport_center(view, node)
            mid = start + QPoint(60, 40)
            end = start + QPoint(120, 90)
            self._send(view, QEvent.Type.MouseButtonPress, start, Qt.MouseButton.LeftButton)
            self._send(view, QEvent.Type.MouseMove, mid, Qt.MouseButton.LeftButton)
            self._send(view, QEvent.Type.MouseMove, end, Qt.MouseButton.LeftButton)
            self._send(view, QEvent.Type.MouseButtonRelease, end, Qt.MouseButton.NoButton)

            pos_after = (node.pos().x(), node.pos().y())
            self.assertNotEqual(
                pos_after, pos_before,
                "真实鼠标拖动后节点位置必须变化（press 未转发 super 时纹丝不动）",
            )
            side = root.joinpath(*_SIDE_FILE)
            self.assertTrue(side.is_file(), "真实拖动后必须写入编辑器侧档")
            saved = json.loads(side.read_text(encoding="utf-8"))
            self.assertIn("grp::g_main::q_a", saved)
            self.assertEqual(
                tuple(saved["grp::g_main::q_a"]), pos_after,
                "侧档坐标应与拖动后的实际位置一致",
            )
            view.close()

    # ---- 纯点击：零位移不写侧档（探针）-----------------------------------
    def test_pure_click_does_not_write_layout(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            m, scene, view = self._build_group_view(root)
            node = scene._node_items["q_a"]
            pos_before = (node.pos().x(), node.pos().y())

            center = self._node_viewport_center(view, node)
            self._send(view, QEvent.Type.MouseButtonPress, center, Qt.MouseButton.LeftButton)
            self._send(view, QEvent.Type.MouseButtonRelease, center, Qt.MouseButton.NoButton)

            self.assertEqual(
                (node.pos().x(), node.pos().y()), pos_before,
                "纯点击不应移动节点",
            )
            side = root.joinpath(*_SIDE_FILE)
            self.assertFalse(
                side.is_file(),
                "纯点击（零位移）绝不能把自动布局坐标钉进侧档（审查 P0-1 ②）",
            )
            view.close()

    # ---- 多选拖动：所有被移动的选中项都持久化（真实鼠标管线）--------------
    def test_multi_select_drag_persists_all_moved(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            m, scene, view = self._build_group_view(root)
            na = scene._node_items["q_a"]
            nb = scene._node_items["q_b"]
            nc = scene._node_items["q_c"]
            a_before = (na.pos().x(), na.pos().y())
            b_before = (nb.pos().x(), nb.pos().y())
            c_before = (nc.pos().x(), nc.pos().y())

            # 真实鼠标建立双选：先左键独占选中 na，再 Ctrl+左键追加 nb（真实用户手势，
            # 全程走 super() 选择管线，而非 setSelected 直插）。
            self._click(view, na)
            self._click(view, nb, Qt.KeyboardModifier.ControlModifier)
            self.assertEqual(
                {id(it) for it in scene.selectedItems()}, {id(na), id(nb)},
                "左键+Ctrl 左键必须真实建立 na/nb 双选（press 未转发 super 时选不中）",
            )

            # 对已选中的 nb 起手 press→move→release：多选整体拖动，两节点一起位移，
            # release 只落在被抓取项 nb 上（QGraphicsScene 只给 grabber 发 release）。
            start = self._node_viewport_center(view, nb)
            mid = start + QPoint(45, 30)
            end = start + QPoint(90, 70)
            self._send(view, QEvent.Type.MouseButtonPress, start, Qt.MouseButton.LeftButton)
            self._send(view, QEvent.Type.MouseMove, mid, Qt.MouseButton.LeftButton)
            self._send(view, QEvent.Type.MouseMove, end, Qt.MouseButton.LeftButton)
            self._send(view, QEvent.Type.MouseButtonRelease, end, Qt.MouseButton.NoButton)

            a_after = (na.pos().x(), na.pos().y())
            b_after = (nb.pos().x(), nb.pos().y())
            self.assertNotEqual(b_after, b_before, "被抓取项 nb 必须移动")
            self.assertNotEqual(a_after, a_before,
                                "多选中随之移动的 na 也必须真实位移（整体拖动）")

            side = root.joinpath(*_SIDE_FILE)
            self.assertTrue(side.is_file(), "真实多选拖动后必须写入侧档")
            saved = json.loads(side.read_text(encoding="utf-8"))
            self.assertIn("grp::g_main::q_b", saved, "被抓取项必须持久化")
            self.assertIn("grp::g_main::q_a", saved,
                          "多选中随之移动的其它项也必须持久化（审查 P0-1 ③）")
            self.assertEqual(tuple(saved["grp::g_main::q_a"]), a_after)
            self.assertEqual(tuple(saved["grp::g_main::q_b"]), b_after)
            # 未选中的 q_c 既不应移动，也不应被写入侧档
            self.assertEqual((nc.pos().x(), nc.pos().y()), c_before,
                             "未选中的 q_c 不得随多选拖动移位")
            self.assertNotIn("grp::g_main::q_c", saved)
            view.close()

    # ---- 纯点击探针（模块级）：baseline 相等即不回调 ---------------------
    def test_notify_release_gated_on_position_change(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            m, scene, view = self._build_group_view(root)
            node = scene._node_items["q_a"]
            calls: list[tuple] = []
            orig = node.on_moved
            node.on_moved = lambda k, x, y: (calls.append((k, x, y)), orig(k, x, y))
            # 位置未变（baseline == pos）：不回调、不落盘
            _notify_release(node)
            self.assertEqual(calls, [], "零位移不得触发 on_moved 回调")
            self.assertFalse(root.joinpath(*_SIDE_FILE).is_file())
            # 真移动：回调一次
            node.setPos(node.pos().x() + 10, node.pos().y() + 10)
            _notify_release(node)
            self.assertEqual(len(calls), 1)
            view.close()


if __name__ == "__main__":
    unittest.main()
