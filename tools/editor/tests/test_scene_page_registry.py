""""哪些页是场景页"必须只有一份登记 —— 五处判定漏一处就是一种静默失效。

主窗口对场景页有五处判定：任务编排前的强制提交、页签注册、两处"改完数据要刷新
哪些页"的映射、全局搜索的跳转路由。新增第二个场景页时，**每漏一处的死法都不同**：

| 漏哪处 | 死法 |
|---|---|
| 编排前强制提交 | 新页不被提交，编排替换后编辑丢失 |
| 刷新映射（两处） | 别的编辑器改了场景，新页显示旧数据 |
| 跳转路由 | 搜索永远落在先注册的那个页，点过去发现是空的 |

本文件锁的不是"当前有几个场景页"，而是**"判定只有一处"这件事本身**。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from tools.editor import scene_page_registry as reg

REPO = Path(__file__).resolve().parents[3]
MAIN_WINDOW = REPO / "tools/editor/main_window.py"


class RegistryShapeTests(unittest.TestCase):
    def test_scene_page_types_contains_the_old_canvas(self) -> None:
        from tools.editor.editors.scene_editor import SceneEditor
        self.assertIn(SceneEditor, reg.scene_page_types())

    def test_navigation_picks_exactly_one_page(self) -> None:
        """跳转落点只能有一个 —— 两个页同时可导航会让"跳过去不是自己那个页"成为日常。"""
        self.assertEqual(len(reg.navigation_scene_page_types()), 1)

    def test_navigation_target_is_a_known_value(self) -> None:
        self.assertIn(reg.NAV_TARGET, ("v1", "v2"))

    def test_navigation_target_is_a_subset_of_all_pages(self) -> None:
        """跳转落点必须也在"全部场景页"里，否则它拿不到提交/刷新。"""
        for cls in reg.navigation_scene_page_types():
            self.assertIn(cls, reg.scene_page_types())

    def test_missing_v2_degrades_quietly(self) -> None:
        """新画布还没落地时，登记处必须能正常工作（本文件先于它存在）。"""
        self.assertGreaterEqual(len(reg.scene_page_types()), 1)


class MainWindowUsesTheRegistryTests(unittest.TestCase):
    """主窗口里不许再出现裸的 `SceneEditor` 判定。"""

    def setUp(self) -> None:
        self.src = MAIN_WINDOW.read_text(encoding="utf-8")

    def test_only_the_page_construction_site_imports_the_class(self) -> None:
        """直接导入只准剩**一处**：页签注册。

        那一处要的是"建哪个页"（需要具体类去实例化），不是"判定哪些页"。
        原先有 5 处，其余 4 处是判定，已全部改走登记处。
        """
        hits = re.findall(r"^\s*from \.editors\.scene_editor import SceneEditor",
                          self.src, re.M)
        self.assertEqual(
            len(hits), 1,
            f"直接导入 SceneEditor 的地方应当只剩页签注册那一处，实际 {len(hits)} 处 ——"
            "多出来的多半是又硬写了一处判定")

    def test_no_isinstance_against_scene_editor(self) -> None:
        self.assertNotIn(
            "isinstance(ed, SceneEditor)", self.src,
            "跳转路由又硬判定 SceneEditor 了 —— 应当走 navigation_scene_page_types()")

    def test_registry_is_actually_referenced(self) -> None:
        """反向断言：确认这几处真的改成了登记处，而不是被整段删掉。"""
        self.assertIn("scene_page_types()", self.src)
        self.assertIn("navigation_scene_page_types()", self.src)

    def test_page_tab_registration_still_lists_a_scene_page(self) -> None:
        """页签注册那处仍需显式列出类（它要的是"建哪个页"，不是"判定哪些页"）。"""
        self.assertRegex(self.src, r'"Scene", \w+')


if __name__ == "__main__":
    unittest.main()
