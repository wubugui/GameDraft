"""对话图「被引用」反查：纯 finder 单测 + 一个离屏面板填充冒烟。"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from tools.dialogue_graph_editor.dialogue_references import (
    Referrer,
    find_dialogue_referrers,
    group_by_category,
    subtree_references_dialogue,
)

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class FindDialogueReferrersTests(unittest.TestCase):
    def _navs(self, refs: list[Referrer]) -> set[tuple]:
        return {r.nav for r in refs}

    def test_scene_entities_all_shapes(self) -> None:
        scenes = {
            "义庄": {
                "npcs": [
                    {"id": "管事", "name": "义庄管事", "dialogueGraphId": "TARGET"},
                    {"id": "别人", "dialogueGraphId": "别的对话"},  # 引用别图，不该命中
                ],
                "hotspots": [
                    # inspect 型：data.graphId
                    {"id": "hs_看", "type": "inspect", "data": {"graphId": "TARGET"},
                     "conditions": [{"narrative": "flow_x", "state": "s1"}]},  # narrative≠dialogue
                    # 动作型：actions[].params.graphId
                    {"id": "hs_act", "actions": [{"type": "startDialogueGraph", "params": {"graphId": "TARGET"}}]},
                ],
                "zones": [
                    {"id": "z1", "actions": [{"type": "playScriptedDialogue", "params": {"graphId": "TARGET"}}]},
                ],
                # 场景级动作（不挂具名实体）
                "onEnterActions": [{"type": "startDialogueGraph", "params": {"graphId": "TARGET"}}],
            }
        }
        refs = find_dialogue_referrers("TARGET", scenes=scenes)
        navs = self._navs(refs)
        self.assertIn(("navigate_to_scene_entity", ("npc", "管事", "义庄")), navs)
        self.assertIn(("navigate_to_scene_entity", ("hotspot", "hs_看", "义庄")), navs)
        self.assertIn(("navigate_to_scene_entity", ("hotspot", "hs_act", "义庄")), navs)
        self.assertIn(("navigate_to_scene_entity", ("zone", "z1", "义庄")), navs)
        self.assertIn(("_on_navigate_to_source", ("scene", "义庄", "")), navs)
        # 引用别图的 NPC 不该出现
        self.assertNotIn(("navigate_to_scene_entity", ("npc", "别人", "义庄")), navs)
        self.assertTrue(all(r.category == "地图实体" for r in refs))

    def test_narrative_condition_key_is_not_a_dialogue_ref(self) -> None:
        # 条件里的 narrative/state 指叙事图，绝不能被当成对话引用
        scenes = {"s": {"hotspots": [{"id": "h", "conditions": [{"narrative": "TARGET", "state": "x"}]}]}}
        self.assertEqual(find_dialogue_referrers("TARGET", scenes=scenes), [])

    def test_scenarios(self) -> None:
        cat = {"scenarios": [
            {"id": "义庄镇尸", "description": "镇尸", "dialogueGraphIds": ["TARGET", "别的"]},
            {"id": "无关", "dialogueGraphIds": ["别的"]},
        ]}
        refs = find_dialogue_referrers("TARGET", scenarios_catalog=cat)
        self.assertEqual(self._navs(refs), {("navigate_to_scenario_catalog", ("义庄镇尸",))})
        self.assertEqual(refs[0].category, "Scenario")

    def test_narrative_dialogue_blackbox(self) -> None:
        narr = {"compositions": [{
            "id": "comp", "mainGraph": {"id": "flow"},
            "elements": [
                {"id": "e", "kind": "dialogueBlackbox", "refId": "TARGET", "label": "看板黑盒"},
                {"id": "e2", "kind": "dialogueBlackbox", "refId": "别的"},
                {"id": "e3", "kind": "scenarioSubgraph", "refId": "TARGET"},  # scenario 不是 dialogue
            ],
        }]}
        refs = find_dialogue_referrers("TARGET", narrative_graphs=narr)
        self.assertEqual(self._navs(refs), {("navigate_to_narrative_state", ("flow", ""))})
        self.assertEqual(refs[0].category, "叙事图")

    def test_other_dialogues_jump(self) -> None:
        others = {
            "跳来的图": {"nodes": {"n": {"actions": [{"type": "startDialogueGraph", "params": {"graphId": "TARGET"}}]}}},
            "无关图": {"nodes": {"n": {"text": "hi"}}},
            "TARGET": {"nodes": {}},  # 自身不算
        }
        refs = find_dialogue_referrers("TARGET", other_dialogues=others)
        self.assertEqual(self._navs(refs), {("navigate_to_dialogue_graph", ("跳来的图",))})

    def test_empty_target_and_no_refs(self) -> None:
        self.assertEqual(find_dialogue_referrers(""), [])
        self.assertEqual(find_dialogue_referrers("TARGET", scenes={"s": {"npcs": []}}), [])

    def test_group_by_category_order(self) -> None:
        refs = [
            Referrer("其它对话", "d", "", ("navigate_to_dialogue_graph", ("d",))),
            Referrer("地图实体", "n", "", ("navigate_to_scene_entity", ("npc", "n", "s")), scene_id="s"),
            Referrer("Scenario", "sc", "", ("navigate_to_scenario_catalog", ("sc",))),
        ]
        self.assertEqual(list(group_by_category(refs).keys()), ["地图实体", "Scenario", "其它对话"])

    def test_subtree_helper_matches_list_and_nested(self) -> None:
        self.assertTrue(subtree_references_dialogue({"a": [{"graphId": "T"}]}, "T"))
        self.assertTrue(subtree_references_dialogue({"dialogueGraphIds": ["x", "T"]}, "T"))
        self.assertFalse(subtree_references_dialogue({"graphId": "other"}, "T"))


class ReferrersPanelSmokeTest(unittest.TestCase):
    """离屏冒烟：真实工程里打开一张被引用的图，左栏「被引用」树应有内容。"""

    @classmethod
    def setUpClass(cls) -> None:
        from PySide6.QtWidgets import QApplication
        from tools.editor.project_model import ProjectModel

        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def test_referrers_populate_for_referenced_graph(self) -> None:
        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
        from tools.dialogue_graph_editor.graph_document import graphs_dir

        target = graphs_dir(_PROJECT_ROOT) / "寻狗_义庄门口拦活.json"
        if not target.is_file():
            self.skipTest("样例被引用图缺失（内容已变）")

        widget = DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=self._pm)
        try:
            widget.load_path(target)
            tree = widget._refs_tree
            # 至少有一个类别顶层项，且树里出现引用它的义庄 NPC
            self.assertGreater(tree.topLevelItemCount(), 0, widget._refs_hint.text())
            labels: list[str] = []

            def _walk(item) -> None:
                labels.append(item.text(0))
                for i in range(item.childCount()):
                    _walk(item.child(i))

            for i in range(tree.topLevelItemCount()):
                _walk(tree.topLevelItem(i))
            joined = " | ".join(labels)
            self.assertIn("地图实体", joined)
            self.assertTrue(any("义庄" in lbl for lbl in labels), joined)
        finally:
            widget.deleteLater()

    def test_double_click_dispatches_to_window_navigate(self) -> None:
        """双击一条引用 → 调用宿主主窗对应 navigate_* 方法；分组行不跳转、不报错。"""
        from PySide6.QtCore import Qt
        from PySide6.QtWidgets import QMainWindow, QTreeWidgetItem
        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget

        calls: list[tuple] = []

        class FakeHost(QMainWindow):
            def navigate_to_scene_entity(self, kind, eid, scene_id):  # noqa: ANN001
                calls.append((kind, eid, scene_id))

        host = FakeHost()
        widget = DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=self._pm)
        host.setCentralWidget(widget)  # widget.window() → host
        try:
            leaf = QTreeWidgetItem(["x"])
            leaf.setData(0, Qt.ItemDataRole.UserRole, ("navigate_to_scene_entity", ("npc", "管事", "义庄")))
            widget._on_referrer_double_clicked(leaf, 0)
            self.assertEqual(calls, [("npc", "管事", "义庄")])
            # 分组行（无 payload）：不跳转、不抛
            widget._on_referrer_double_clicked(QTreeWidgetItem(["分组"]), 0)
            self.assertEqual(len(calls), 1)
        finally:
            host.deleteLater()

    def test_collapse_toggle_and_persist_across_widgets(self) -> None:
        """整段可折叠（body 隐藏）+ 折叠态用 QSettings 跨 widget 记住。"""
        from PySide6.QtCore import QSettings
        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget

        s = QSettings("GameDraft", "DialogueGraphEditor")
        saved = s.value("referrers_panel_collapsed")  # 存回原值，避免污染真实编辑器偏好
        try:
            w = DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=self._pm)
            try:
                w._set_refs_collapsed(False)
                self.assertFalse(w._refs_body.isHidden())
                self.assertEqual(w._refs_toggle.text(), "收起")
                w._toggle_refs_panel()  # 折叠 → 隐藏 body、写设置
                self.assertTrue(w._refs_collapsed)
                self.assertTrue(w._refs_body.isHidden())
                self.assertEqual(w._refs_toggle.text(), "展开")
            finally:
                w.deleteLater()
            # 新建的 widget 应从设置恢复为「折叠」
            w2 = DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=self._pm)
            try:
                self.assertTrue(w2._refs_collapsed)
                self.assertTrue(w2._refs_body.isHidden())
            finally:
                w2.deleteLater()
        finally:
            if saved is None:
                s.remove("referrers_panel_collapsed")
            else:
                s.setValue("referrers_panel_collapsed", saved)


if __name__ == "__main__":
    unittest.main()
