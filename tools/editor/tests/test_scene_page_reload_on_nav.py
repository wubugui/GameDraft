"""主窗口：**手点导航树切页**也必须按模型重载场景页。

`_refresh_scene_page_on_activate` 是并存期的第二道防线（两个场景页各持同一份模型的
投影），但它此前只挂在 `_show_stack_page`（跨页跳转 / 导航历史）上；用户在左侧导航树
上点一下走的是 `_on_nav_tree_current_changed` → `setCurrentIndex`，根本不经过那条路。
于是在一个场景页删掉一个热点、点到另一个场景页，那边照旧画着它 —— 图元还能点中、
再删提示"没有此实体"，只有重开编辑器才消失。

本探针从最外层入口（导航树 `setCurrentItem`）进，两个方向都锁。用**不广播**的裸直写
制造陈旧（Task / 别的编辑器就是这么改场景的），把"切页重载"与"广播重投影"两道防线
分开验 —— 否则后者绿了会把前者的缺口盖住。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("GAMEDRAFT_EDITOR_NO_LSP", "1")

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.main_window import MainWindow
from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets, quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "切页街"
_H1 = EntityRef("hotspot", "h1")


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 800, "worldHeight": 600,
        "spawnPoint": {"x": 10, "y": 10},
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "h2", "type": "inspect", "x": 200, "y": 100, "interactionRange": 50},
        ],
        "npcs": [], "zones": [],
    }


class ScenePageReloadOnNavTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.window = MainWindow()
        self.window._model.load_project(root)
        self.window._model.scenes[_SCENE] = _scene()
        self.window._populate_tabs()
        self.v1_idx = self.window._editor_labels.index("Scene")
        self.v2_idx = self.window._editor_labels.index("Scene（新画布）")
        self.v1 = self.window._editor_instances[self.v1_idx]
        self.v2 = self.window._editor_instances[self.v2_idx]
        self.assertIsInstance(self.v1, SceneEditor)
        self.assertIsInstance(self.v2, SceneEditorV2)
        self.v1._load_scene(_SCENE)
        self.v1._canvas._auto_fit_after_layout = False
        self.v2.load_scene(_SCENE)

    def tearDown(self) -> None:
        quiesce_scene_editor(self.v1)
        self.window.deleteLater()
        QApplication.processEvents()
        destroy_leftover_qt_widgets()
        self._tmp.cleanup()

    def _click_nav(self, index: int) -> None:
        """用户在左侧导航树上点某页 —— 最外层入口。"""
        self.window._nav_tree.setCurrentItem(self.window._stack_index_to_item[index])
        QApplication.processEvents()
        self.assertEqual(self.window._stack.currentIndex(), index, "切页被门闸拒了")

    def _silent_delete(self, hid: str) -> None:
        """不广播、不发事件的裸直写 —— 只有切页重载能救。"""
        lst = self.window._model.scenes[_SCENE]["hotspots"]
        lst[:] = [h for h in lst if h.get("id") != hid]

    def test_clicking_over_to_the_new_canvas_reloads_it(self) -> None:
        self._click_nav(self.v1_idx)
        self._silent_delete("h1")
        self.assertIsNotNone(self.v2.view.item_for(_H1, "handle"),
                             "前置条件：新画布此刻还不知道（没人告诉它）")
        doc_before = self.v2.document
        self._click_nav(self.v2_idx)
        self.assertEqual(self.v2.view.items_of(_H1), [],
                         "手点导航树切到新画布没有重载 —— 幽灵图元留到重开编辑器")
        self.assertIs(self.v2.document, doc_before,
                      "场景对象没换却整份重建了 —— 视口与撤销历史一起没")

    def test_clicking_over_to_the_old_canvas_reloads_it(self) -> None:
        self._click_nav(self.v2_idx)
        self._silent_delete("h1")
        self.assertIn("hotspot:h1", self.v1._canvas._entity_items, "前置条件")
        self._click_nav(self.v1_idx)
        self.assertNotIn("hotspot:h1", self.v1._canvas._entity_items,
                         "手点导航树切到老画布没有重载")

    def test_programmatic_jump_reloads_exactly_once(self) -> None:
        """跳转路径把重载挂到了 `currentChanged` 上之后，不能再多刷一遍。"""
        calls: list[int] = []
        real = self.v2.reload_from_model
        self.v2.reload_from_model = lambda _r=real, _c=calls: (_c.append(1), _r())[1]
        try:
            self.window._show_stack_page(self.v1_idx)
            calls.clear()
            self.window._show_stack_page(self.v2_idx)
            self.assertEqual(len(calls), 1, f"跨页跳转重载了 {len(calls)} 次，应当恰好一次")
            # 页已经是当前页：`currentChanged` 不发，跳转仍要保证重载过一次
            self.window._show_stack_page(self.v2_idx)
            self.assertEqual(len(calls), 2)
        finally:
            del self.v2.reload_from_model


if __name__ == "__main__":
    unittest.main()
