"""对话图「叙事归属」按信号自动推导到章节包的守护测试（2026-07-19）。

老 meta.scenarioId 手填 + scenarios.json 分组已废；左栏改为：
  对话图 emit 的信号 → 监听它的叙事图 → 该图所属章节包 → 分组键。
守护三点：①纯函数推导对（听书开场→scenario_听书 / 镇尸→scenario_义庄级）；②编辑器左树
真按章节里程碑序分组 + wrap 卷进章节 + 未归属兜底；③详情面板「叙事归属」只读、显示推导章节。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
from tools.dialogue_graph_editor.graph_analysis import (
    build_narrative_signal_owners,
    build_graph_package_map,
    derive_dialogue_owner,
    collect_emitted_signals,
)

_ROOT = Path(__file__).resolve().parents[3]


class TestChapterGrouping(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)
        cls._ng = json.load(open(_ROOT / "public/assets/data/narrative_graphs.json"))

    def _dlg(self, gid: str) -> dict:
        return json.load(open(_ROOT / f"public/assets/dialogues/graphs/{gid}.json"))

    def test_pure_derive_owner(self) -> None:
        owners = build_narrative_signal_owners(self._ng)
        # 听书开场喷 tingshu_kicked，被 scenario_听书 监听
        self.assertIn("tingshu_kicked", collect_emitted_signals(self._dlg("寻狗_听书开场")))
        self.assertEqual(derive_dialogue_owner(self._dlg("寻狗_听书开场"), owners), "scenario_听书")
        # 纯闲聊不喷叙事信号 → 无 owner
        self.assertEqual(derive_dialogue_owner(self._dlg("茶馆小二"), owners), "")
        # __draft__ / state:* 派生广播不进 owner 索引
        self.assertNotIn("__draft__", owners)
        self.assertFalse(any(k.startswith("state:") for k in owners))

    def test_owner_rolls_up_to_chapter(self) -> None:
        owners = build_narrative_signal_owners(self._ng)
        pkg_map = build_graph_package_map(self._ng)
        # 镇尸小交互 → owner 是 wrap/scenario 级 → 卷到 章节_义庄
        owner = derive_dialogue_owner(self._dlg("寻狗_镇尸_剪子"), owners)
        self.assertTrue(owner, "镇尸_剪子 应能推导出 owner")
        self.assertEqual(pkg_map.get(owner), "章节_义庄")

    def test_editor_tree_groups_by_chapter_in_milestone_order(self) -> None:
        m = ProjectModel()
        m.load_project(_ROOT)
        w = DialogueGraphEditorWidget(_ROOT, None, project_model=m)
        try:
            w._rebuild_file_tree()
            tree = w._file_tree
            titles = [tree.topLevelItem(i).text(0) for i in range(tree.topLevelItemCount())]
            joined = " ".join(titles)
            # 章节组存在（含 wrap 卷进的义庄）
            self.assertTrue(any("章节_听书" in t for t in titles))
            self.assertTrue(any("章节_义庄" in t for t in titles))
            # 两个兜底组
            self.assertTrue(any(t.startswith("常驻") for t in titles))
            self.assertTrue(any(t.startswith("未归属") for t in titles))
            # 里程碑序：听书在背尸前、背尸在梦前
            self.assertLess(joined.index("章节_听书"), joined.index("章节_背尸"))
            self.assertLess(joined.index("章节_背尸"), joined.index("章节_梦"))
        finally:
            w.deleteLater()

    def test_meta_field_readonly_shows_derived_chapter(self) -> None:
        m = ProjectModel()
        m.load_project(_ROOT)
        w = DialogueGraphEditorWidget(_ROOT, None, project_model=m)
        try:
            # 字段只读（自动推导，禁止手填）
            self.assertFalse(w._edit_meta_scenario.isEditable())
            self.assertFalse(w._edit_meta_scenario.isEnabled())
            w._data = self._dlg("寻狗_听书开场")
            w._apply_data_to_widgets()
            self.assertEqual(w._edit_meta_scenario.currentText(), "章节_听书")
            w._data = self._dlg("茶馆小二")
            w._apply_data_to_widgets()
            self.assertEqual(w._edit_meta_scenario.currentText(), "（未归属）")
        finally:
            w.deleteLater()


if __name__ == "__main__":
    unittest.main()
