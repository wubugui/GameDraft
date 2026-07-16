"""任务图节点坐标持久化（审查项 M22）安全网。

红线：导出游戏数据逐字节一致。节点坐标只进编辑器侧档
``<project>/.editor/quest_graph_layout.json``，**绝不**进 quests.json / questGroups.json
/ types.ts。本测试断言：

- 拖动节点后，坐标落到侧档（且键命名空间正确）。
- 重新填充（模拟编辑/刷新）后，被拖过的节点保留手动坐标；新节点回退自动布局。
- 顶层与分组视图各自命名空间，互不串台。
- 侧档缺失/损坏不崩。
- 关键：以上全程 model.quests / model.quest_groups / 磁盘 quest JSON 不被改动。
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor import theme
from tools.editor.editors.quest_graph_scene import QuestGraphScene
from tools.editor.editors.quest_graph_layout_store import QuestGraphLayoutStore
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


_GROUPS = [
    {"id": "g_main", "name": "主线", "type": "main"},
    {"id": "g_side", "name": "支线", "type": "side"},
]

_QUESTS = [
    {"id": "q_a", "group": "g_main", "title": "甲", "nextQuests": [{"questId": "q_b", "conditions": []}]},
    {"id": "q_b", "group": "g_main", "title": "乙", "nextQuests": []},
]

_SIDE_FILE = (".editor", "quest_graph_layout.json")


class QuestGraphLayoutPersistTests(unittest.TestCase):
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

    def _quest_json_snapshot(self, root: Path) -> tuple[str, str]:
        dp = root / "public" / "assets" / "data"
        return (
            (dp / "quests.json").read_text(encoding="utf-8"),
            (dp / "questGroups.json").read_text(encoding="utf-8"),
        )

    # ---- 拖动 → 落侧档；重填充保留；新节点回退自动布局 ----------------------
    def test_drag_persists_and_survives_repopulate(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            m = self._model(root)
            quests_before = copy.deepcopy(m.quests)
            groups_before = copy.deepcopy(m.quest_groups)
            disk_before = self._quest_json_snapshot(root)

            store = QuestGraphLayoutStore(m.project_path)
            scene = QuestGraphScene(layout_store=store)
            scene.populate_group("g_main", m.quests, m.quest_groups)

            # 模拟拖动 q_a：直接调节点 mouseRelease 路径用的回调（setPos + on_moved）。
            node_a = scene._node_items["q_a"]
            node_a.setPos(777.0, 333.0)
            node_a.on_moved(node_a.layout_key, 777.0, 333.0)

            # 侧档已写入，键带分组命名空间
            side = root.joinpath(*_SIDE_FILE)
            self.assertTrue(side.is_file(), "拖动后必须生成编辑器侧档")
            saved = json.loads(side.read_text(encoding="utf-8"))
            self.assertEqual(saved.get("grp::g_main::q_a"), [777.0, 333.0])

            # 新增一个全新任务，模拟编辑后刷新（新 store 实例重新读盘）
            m.quests.append({"id": "q_c", "group": "g_main", "title": "丙", "nextQuests": []})
            store2 = QuestGraphLayoutStore(m.project_path)
            scene2 = QuestGraphScene(layout_store=store2)
            scene2.populate_group("g_main", m.quests, m.quest_groups)

            # 被拖过的 q_a 保留手动坐标
            pa = scene2._node_items["q_a"].pos()
            self.assertEqual((pa.x(), pa.y()), (777.0, 333.0),
                             "重填充后被拖过的节点必须保留侧档坐标")
            # 新节点 q_c 没有侧档坐标 → 落自动布局（绝不是被拖到的坐标）
            pc = scene2._node_items["q_c"].pos()
            self.assertNotEqual((pc.x(), pc.y()), (777.0, 333.0),
                                "新节点应回退自动布局，而非继承别人的坐标")

            # 关键红线：游戏数据（内存 + 磁盘）一字未改
            self.assertEqual(m.quest_groups, groups_before)
            self.assertEqual(
                [q for q in m.quests if q["id"] != "q_c"], quests_before,
                "持久化不得改动原有 quest 数据",
            )
            self.assertEqual(self._quest_json_snapshot(root), disk_before,
                             "磁盘 quest JSON 不得被坐标持久化改动")
            # 侧档不在 public/assets/data 下
            self.assertFalse(
                str(side).startswith(str(root / "public" / "assets" / "data")),
                "侧档必须落在 .editor/，不能进游戏数据目录",
            )

    # ---- 顶层视图命名空间独立 ---------------------------------------------
    def test_top_level_namespace(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            m = self._model(root)
            store = QuestGraphLayoutStore(m.project_path)
            scene = QuestGraphScene(layout_store=store)
            scene.populate_top_level(m.quest_groups, m.quests)
            node = scene._node_items["g_main"]
            node.on_moved(node.layout_key, 10.0, 20.0)
            saved = json.loads(root.joinpath(*_SIDE_FILE).read_text(encoding="utf-8"))
            self.assertEqual(saved.get("top::g_main"), [10.0, 20.0])

    # ---- stale 条目被忽略（删除的节点不报错、不复活） ----------------------
    def test_stale_entry_ignored_and_pruned(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            m = self._model(root)
            side = root.joinpath(*_SIDE_FILE)
            side.parent.mkdir(parents=True, exist_ok=True)
            side.write_text(json.dumps({
                "grp::g_main::q_a": [5.0, 5.0],
                "grp::g_main::q_ghost": [9.0, 9.0],  # 不存在的节点
            }), encoding="utf-8")

            store = QuestGraphLayoutStore(m.project_path)
            scene = QuestGraphScene(layout_store=store)
            scene.populate_group("g_main", m.quests, m.quest_groups)
            # q_a 恢复 stored 坐标；ghost 不存在不崩
            self.assertEqual(
                (scene._node_items["q_a"].pos().x(), scene._node_items["q_a"].pos().y()),
                (5.0, 5.0),
            )
            # 触发一次保存以裁剪：拖 q_b
            nb = scene._node_items["q_b"]
            nb.on_moved(nb.layout_key, 1.0, 2.0)
            saved = json.loads(side.read_text(encoding="utf-8"))
            self.assertNotIn("grp::g_main::q_ghost", saved,
                             "保存时应裁掉已不存在节点的陈旧条目")
            self.assertIn("grp::g_main::q_a", saved)
            self.assertEqual(saved.get("grp::g_main::q_b"), [1.0, 2.0])

    # ---- 容错：缺失 / 损坏 / 无工程不崩 -----------------------------------
    def test_missing_and_corrupt_side_file(self) -> None:
        # 无工程路径：set/get 不崩、不落盘（内存值无害）
        s_none = QuestGraphLayoutStore(None)
        self.assertIsNone(s_none.get("top::x"))
        s_none.set("top::x", 1.0, 2.0)  # 不崩、不落盘

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            root.mkdir(parents=True)
            # 缺失
            s_missing = QuestGraphLayoutStore(root)
            self.assertIsNone(s_missing.get("top::x"))
            # 损坏
            side = root.joinpath(*_SIDE_FILE)
            side.parent.mkdir(parents=True, exist_ok=True)
            side.write_text("{ not json", encoding="utf-8")
            s_corrupt = QuestGraphLayoutStore(root)
            self.assertIsNone(s_corrupt.get("grp::g::n"))  # 当作空，不崩

    def test_scene_construct_without_store(self) -> None:
        # 不传 store 也能构造并填充（退化为不持久化），不崩。
        scene = QuestGraphScene()
        scene.populate_top_level(copy.deepcopy(_GROUPS), copy.deepcopy(_QUESTS))
        self.assertIn("g_main", scene._node_items)

    def test_font_refresh_changes_only_graphics_geometry(self) -> None:
        app = self._qt_app
        original_theme = theme.current_theme_id()
        original_font = theme.current_font_px()
        try:
            with TemporaryDirectory() as td:
                root = Path(td) / "p"
                model = self._model(root)
                model_before = (copy.deepcopy(model.quests), copy.deepcopy(model.quest_groups))
                disk_before = self._quest_json_snapshot(root)
                side = root.joinpath(*_SIDE_FILE)

                theme.apply_application_theme(app, theme.THEME_MODERN, theme.MIN_FONT_PX)
                scene = QuestGraphScene(layout_store=QuestGraphLayoutStore(model.project_path))
                scene.populate_group("g_main", model.quests, model.quest_groups)
                node = scene._node_items["q_a"]
                pos_before = (node.pos().x(), node.pos().y())
                rect_before = node.rect()
                font_before = node._id_text.font().pixelSize()
                edge_calls: dict[int, int] = {}
                for edge in scene._edge_items:
                    key = id(edge)
                    edge_calls[key] = 0
                    original_update = edge.update_path

                    def counted_update(*, _key=key, _original=original_update) -> None:
                        edge_calls[_key] += 1
                        _original()

                    edge.update_path = counted_update  # type: ignore[method-assign]

                theme.apply_application_theme(app, theme.THEME_MODERN, theme.MAX_FONT_PX)
                theme.refresh_graphics_scene_fonts(scene)
                rect_after = node.rect()
                font_after = node._id_text.font().pixelSize()

                self.assertEqual((node.pos().x(), node.pos().y()), pos_before)
                self.assertGreater(font_after, font_before)
                self.assertGreater(rect_after.height(), rect_before.height())
                self.assertTrue(edge_calls)
                self.assertTrue(all(count == 1 for count in edge_calls.values()))
                self.assertEqual((model.quests, model.quest_groups), model_before)
                self.assertEqual(self._quest_json_snapshot(root), disk_before)
                self.assertFalse(side.exists(), "纯字体刷新不得生成或改写布局侧档")
        finally:
            theme.apply_application_theme(app, original_theme, original_font)


if __name__ == "__main__":
    unittest.main()
