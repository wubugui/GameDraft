"""构造冒烟：在最小工程上实例化每个被布局重构触及的编辑器面板。

py_compile 只查语法；本测试在 offscreen 下真正 build 每个面板的 __init__，
捕获 QGroupBox→CollapsibleSection 转换、compact_form 包裹、宽高调整等运行期错误。
"""
from __future__ import annotations

import ast
import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor import theme
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _editor_classes() -> list:
    from tools.editor.editors.scene_editor import SceneEditor
    from tools.editor.editors.map_editor import MapEditor
    from tools.editor.editors.timeline_editor import TimelineEditor
    from tools.editor.editors.encounter_editor import EncounterEditor
    from tools.editor.editors.pressure_signal_editor import PressureHoldEditor, SignalCueEditor
    from tools.editor.editors.water_minigame_editor import WaterMinigameEditor
    from tools.editor.editors.sugar_wheel_editor import SugarWheelEditor
    from tools.editor.editors.paper_craft_editor import PaperCraftEditor
    from tools.editor.editors.narrative_data_editors import (
        ScenariosCatalogEditor,
        DocumentRevealsEditor,
    )
    from tools.editor.editors.quest_editor import QuestEditor
    from tools.editor.editors.rule_editor import RuleEditor
    from tools.editor.editors.shop_editor import ShopEditor
    from tools.editor.editors.item_editor import ItemEditor
    from tools.editor.editors.filter_editor import FilterEditor
    from tools.editor.editors.flag_registry_editor import FlagRegistryEditor
    from tools.editor.editors.archive_editor import ArchiveEditor
    from tools.editor.editors.string_editor import StringEditor
    from tools.editor.editors.audio_editor import AudioEditor
    from tools.editor.editors.anim_editor import AnimEditor
    from tools.editor.editors.player_avatar_editor import PlayerAvatarEditor
    from tools.editor.editors.overlay_images_editor import OverlayImagesEditor
    from tools.editor.editors.game_config_editor import GameConfigEditor
    from tools.editor.editors.plane_editor import PlaneEditor
    from tools.editor.editors.character_registry_editor import CharacterRegistryEditor

    return [
        SceneEditor, MapEditor, TimelineEditor, EncounterEditor,
        PressureHoldEditor, SignalCueEditor, WaterMinigameEditor,
        SugarWheelEditor, PaperCraftEditor, ScenariosCatalogEditor,
        DocumentRevealsEditor, QuestEditor, RuleEditor, ShopEditor,
        ItemEditor, FilterEditor, FlagRegistryEditor, ArchiveEditor,
        StringEditor, AudioEditor, AnimEditor, PlayerAvatarEditor,
        OverlayImagesEditor, GameConfigEditor, PlaneEditor,
        CharacterRegistryEditor,
    ]


class TestAllEditorsConstruct(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_every_touched_editor_constructs(self) -> None:
        failures: list[str] = []
        original_theme = theme.current_theme_id()
        original_font = theme.current_font_px()
        try:
            theme.apply_application_theme(
                self._qt_app,
                theme.THEME_MODERN,
                theme.MAX_FONT_PX,
            )
            with TemporaryDirectory() as td:
                root = Path(td) / "p"
                write_minimal_loadable_project(root)
                model = ProjectModel()
                model.load_project(root)
                for cls in _editor_classes():
                    try:
                        ed = cls(model)
                        ed.deleteLater()
                        QApplication.processEvents()
                    except Exception as e:  # noqa: BLE001
                        import traceback
                        failures.append(f"{cls.__name__}: {e}\n{traceback.format_exc()}")
        finally:
            theme.apply_application_theme(self._qt_app, original_theme, original_font)
        if failures:
            self.fail("编辑器构造失败:\n\n" + "\n---\n".join(failures))

    def test_main_editor_has_no_local_fixed_font_sizes(self) -> None:
        repo = Path(__file__).resolve().parents[3]
        files = [
            path
            for path in (repo / "tools" / "editor").rglob("*.py")
            if "tests" not in path.parts and path.name != "theme.py"
        ]
        files.append(repo / "tools" / "dialogue_graph_editor" / "editor_widget.py")
        fixed_qss = re.compile(r"font(?:-size)?\s*:\s*\d", re.IGNORECASE)
        violations: list[str] = []

        def literal_text(node: ast.AST) -> str:
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                return node.value
            if isinstance(node, ast.JoinedStr):
                return "".join(
                    part.value
                    if isinstance(part, ast.Constant) and isinstance(part.value, str)
                    else "0" if isinstance(part, ast.FormattedValue)
                    else ""
                    for part in node.values
                )
            return ""

        for path in files:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            assigned_strings: dict[str, str] = {}
            for candidate in ast.walk(tree):
                if not isinstance(candidate, ast.Assign):
                    continue
                value = literal_text(candidate.value)
                if not value:
                    continue
                for target in candidate.targets:
                    if isinstance(target, ast.Name):
                        assigned_strings[target.id] = value
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                name = func.id if isinstance(func, ast.Name) else (
                    func.attr if isinstance(func, ast.Attribute) else ""
                )
                if name == "setStyleSheet" and node.args:
                    arg = node.args[0]
                    text = literal_text(arg)
                    if not text and isinstance(arg, ast.Name):
                        text = assigned_strings.get(arg.id, "")
                    if fixed_qss.search(text):
                        violations.append(f"{path.relative_to(repo)}:{node.lineno}: fixed QSS font")
                elif name == "QFont" and len(node.args) >= 2:
                    if isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, (int, float)):
                        violations.append(f"{path.relative_to(repo)}:{node.lineno}: numeric QFont size")
                elif name in {"setPointSize", "setPointSizeF", "setPixelSize"} and node.args:
                    if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, (int, float)):
                        violations.append(f"{path.relative_to(repo)}:{node.lineno}: numeric {name}")
        self.assertEqual(
            violations,
            [],
            "字号必须由 tools/editor/theme.py 派生，发现局部固定字号:\n" + "\n".join(violations),
        )


if __name__ == "__main__":
    unittest.main()
