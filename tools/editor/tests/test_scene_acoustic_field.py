# -*- coding: utf-8 -*-
"""场景属性页的 `acousticSpace` 字段：清单来源、往返保真、以及**不许用裸输入框**。

为什么单独测：这是我新加的引用字段，而编辑器规范里「裸 QLineEdit 承载引用字段」
是这一域最贵的一脚。同时这个字段运行时**不报错、不回落**——写错一个字只是
那个场景彻底没有回音，所以清单必须来自真文件、往返必须逐字节保真。
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


class AcousticSpaceIdsTests(unittest.TestCase):
    def test_model_lists_ids_from_real_file(self) -> None:
        from tools.editor.project_model import ProjectModel

        m = ProjectModel()
        m.load_project(REPO)
        ids = m.all_acoustic_space_ids()
        self.assertGreater(len(ids), 0, "没读到任何声学空间")
        on_disk = json.loads(
            (REPO / "public/assets/data/acoustic_spaces.json").read_text(encoding="utf-8")
        )["spaces"]
        self.assertEqual(sorted(ids), sorted(on_disk.keys()))

    def test_missing_file_degrades_to_empty(self) -> None:
        """缺文件不是错——返回空表，场景属性页显示一个空下拉，不炸。"""
        from tools.editor.project_model import ProjectModel

        with tempfile.TemporaryDirectory() as td:
            m = ProjectModel()
            m.project_path = Path(td)
            self.assertEqual(m.all_acoustic_space_ids(), [])

    def test_broken_file_degrades_to_empty(self) -> None:
        """文件坏了也不能让编辑器起不来（validate-data 那边会报 error 兜底）。"""
        from tools.editor.project_model import ProjectModel

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            d = root / "public/assets/data"
            d.mkdir(parents=True)
            (d / "acoustic_spaces.json").write_text("{ 这不是 json", encoding="utf-8")
            m = ProjectModel()
            m.project_path = root
            self.assertEqual(m.all_acoustic_space_ids(), [])


class SceneRoundTripTests(unittest.TestCase):
    """save_all 之后 acousticSpace 必须还在，且文件逐字节不变。

    这条是**数据丢失的护栏**：编辑器存盘若丢掉它不认识的字段，
    任何一次场景保存都会把回音配置抹掉，而且没有任何提示。

    在临时项目副本上跑 —— 仓库有写入护栏，测试不许改真工作树
    （`tools.testing.repo_write_guard`）。
    """

    def test_scene_field_survives_save_all(self) -> None:
        from tools.editor.project_model import ProjectModel
        from tools.editor.tests.save_test_utils import (
            copy_assets_subset, write_minimal_loadable_project,
        )

        real_scenes = REPO / "public/assets/scenes"
        named = [
            p.stem for p in real_scenes.glob("*.json")
            if "acousticSpace" in p.read_text(encoding="utf-8")
        ]
        self.assertGreater(len(named), 0, "没有任何场景写了 acousticSpace，这条断言形同虚设")

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            write_minimal_loadable_project(root)
            copy_assets_subset(REPO, root, ("scenes", "data"))
            targets = [
                p for p in (root / "public/assets/scenes").glob("*.json")
                if "acousticSpace" in p.read_text(encoding="utf-8")
            ]
            self.assertEqual(len(targets), len(named), "副本没带全那些场景")
            before = {p: p.read_bytes() for p in targets}

            m = ProjectModel()
            m.load_project(root)
            m.save_all()

            for p, raw in before.items():
                with self.subTest(scene=p.stem):
                    data = json.loads(p.read_text(encoding="utf-8"))
                    self.assertIn("acousticSpace", data, "存盘后字段没了")
                    self.assertTrue(str(data["acousticSpace"]).strip(), "存盘后变成空值")
                    self.assertEqual(p.read_bytes(), raw, "存盘后文件发生了变化")


class SelectorWidgetTests(unittest.TestCase):
    """控件类型的护栏：必须是 IdRefSelector，不许退回裸输入框。"""

    def test_scene_editor_uses_selector_not_lineedit(self) -> None:
        src = (REPO / "tools/editor/editors/scene_editor.py").read_text(encoding="utf-8")
        self.assertIn("self._sc_acoustic = IdRefSelector(", src,
                      "acousticSpace 必须用 IdRefSelector（引用字段不许用裸输入框）")
        self.assertNotIn("self._sc_acoustic = QLineEdit(", src)
        # 三处都要接上：建控件、载入、存盘
        self.assertIn('form.addRow("acousticSpace", self._sc_acoustic)', src)
        self.assertIn("self._sc_acoustic.set_items(self._model.all_acoustic_space_ids())", src)
        self.assertIn('sc["acousticSpace"] = aspace', src)
        # 留空要删键，不能留个空串（空串会被 validate-data 判 error）
        self.assertIn('elif "acousticSpace" in sc:', src)


class PropertyPanelFunctionalTests(unittest.TestCase):
    """真把控件建出来跑一遍 —— 源码断言只能证明代码写了，证明不了它能用。

    覆盖三件事：下拉里有真清单、载入把值填进去、存盘把值写回场景 dict，
    以及**清空要删键**（留空串会被 validate-data 判 error）。
    """

    @classmethod
    def setUpClass(cls) -> None:
        import sys as _sys
        from PySide6.QtWidgets import QApplication
        cls._app = QApplication.instance() or QApplication(_sys.argv)

    def _panel(self):
        from tools.editor.editors.scene_editor import ScenePropertyPanel
        from tools.editor.project_model import ProjectModel
        from tools.editor.tests.save_test_utils import (
            copy_assets_subset, write_minimal_loadable_project,
        )
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        copy_assets_subset(REPO, root, ("data",))
        model = ProjectModel()
        model.load_project(root)
        return ScenePropertyPanel(model), model

    def tearDown(self) -> None:
        tmp = getattr(self, "_tmp", None)
        if tmp is not None:
            tmp.cleanup()

    def test_dropdown_load_and_save_round_trip(self) -> None:
        from PySide6.QtWidgets import QApplication

        panel, model = self._panel()
        try:
            ids = model.all_acoustic_space_ids()
            self.assertGreater(len(ids), 0, "临时项目里没有声学空间清单")
            pick = ids[0]

            scene = {"id": "测试场景", "acousticSpace": pick}
            panel.load_scene_props(scene)
            QApplication.processEvents()
            self.assertEqual(panel._sc_acoustic.current_id(), pick, "载入没把值填进下拉")
            # 清单确实进了控件，不是只填了个孤儿值
            self.assertIn(pick, getattr(panel._sc_acoustic, "_ids", []))

            out: dict = {"id": "测试场景"}
            panel._flush_scene_widgets_into(out)
            self.assertEqual(out.get("acousticSpace"), pick, "存盘没把值写回")

            # 清空 => 删键，不能留空串
            panel._sc_acoustic.set_current("")
            QApplication.processEvents()
            out2: dict = {"id": "测试场景", "acousticSpace": pick}
            panel._flush_scene_widgets_into(out2)
            self.assertNotIn("acousticSpace", out2, "清空后应当删键而不是留空串")
        finally:
            panel.deleteLater()
            QApplication.processEvents()



class ListenerBindingTests(unittest.TestCase):
    """听者绑定 `acousticListener`：控件类型、往返、缺省不落键、联动禁用。

    听者不动＝走到崖边和站在路中间是同一个回音，实时就没意义了；
    所以这个字段必须能在编辑器里方便地设，而且**不能静默失效**。
    """

    @classmethod
    def setUpClass(cls) -> None:
        import sys as _sys
        from PySide6.QtWidgets import QApplication
        cls._app = QApplication.instance() or QApplication(_sys.argv)

    def _panel(self):
        from tools.editor.editors.scene_editor import ScenePropertyPanel
        from tools.editor.project_model import ProjectModel
        from tools.editor.tests.save_test_utils import (
            copy_assets_subset, write_minimal_loadable_project,
        )
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        copy_assets_subset(REPO, root, ("data",))
        model = ProjectModel()
        model.load_project(root)
        return ScenePropertyPanel(model)

    def tearDown(self) -> None:
        tmp = getattr(self, "_tmp", None)
        if tmp is not None:
            tmp.cleanup()

    def test_modes_round_trip(self) -> None:
        from PySide6.QtWidgets import QApplication

        panel = self._panel()
        try:
            for mode in ("camera", "fixed"):
                with self.subTest(mode=mode):
                    scene = {"id": "s", "acousticListener": {"mode": mode}}
                    panel.load_scene_props(scene)
                    QApplication.processEvents()
                    self.assertEqual(panel._sc_acoustic_listener.currentData(), mode)
                    out: dict = {"id": "s"}
                    panel._flush_scene_widgets_into(out)
                    self.assertEqual(out.get("acousticListener"), {"mode": mode})

            # entity 模式要带上 entityId
            scene = {
                "id": "s",
                "npcs": [{"id": "npc_a", "name": "甲"}],
                "acousticListener": {"mode": "entity", "entityId": "npc_a"},
            }
            panel.load_scene_props(scene)
            QApplication.processEvents()
            self.assertEqual(panel._sc_acoustic_listener.currentData(), "entity")
            self.assertEqual(panel._sc_acoustic_entity.current_id(), "npc_a")
            out2: dict = {"id": "s"}
            panel._flush_scene_widgets_into(out2)
            self.assertEqual(out2.get("acousticListener"),
                             {"mode": "entity", "entityId": "npc_a"})
        finally:
            panel.deleteLater()
            QApplication.processEvents()

    def test_player_is_default_and_writes_no_key(self) -> None:
        """player 是缺省语义 —— 不落键，旧场景零字节变化。"""
        from PySide6.QtWidgets import QApplication

        panel = self._panel()
        try:
            panel.load_scene_props({"id": "s"})
            QApplication.processEvents()
            self.assertEqual(panel._sc_acoustic_listener.currentData(), "player")
            out: dict = {"id": "s", "acousticListener": {"mode": "camera"}}
            panel._flush_scene_widgets_into(out)
            self.assertNotIn("acousticListener", out, "回到 player 应当删键")
        finally:
            panel.deleteLater()
            QApplication.processEvents()

    def test_entity_picker_disabled_unless_entity_mode(self) -> None:
        """非 entity 模式禁用实体选择器 —— 免得填了 id 却不生效（静默失效）。"""
        from PySide6.QtWidgets import QApplication

        panel = self._panel()
        try:
            panel.load_scene_props({"id": "s", "acousticListener": {"mode": "camera"}})
            QApplication.processEvents()
            self.assertFalse(panel._sc_acoustic_entity.isEnabled())
            panel.load_scene_props({
                "id": "s", "npcs": [{"id": "npc_a"}],
                "acousticListener": {"mode": "entity", "entityId": "npc_a"},
            })
            QApplication.processEvents()
            self.assertTrue(panel._sc_acoustic_entity.isEnabled())
        finally:
            panel.deleteLater()
            QApplication.processEvents()

if __name__ == "__main__":
    unittest.main()
