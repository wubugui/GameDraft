"""构造冒烟：在最小工程上实例化每个被布局重构触及的编辑器面板。

py_compile 只查语法；本测试在 offscreen 下真正 build 每个面板的 __init__，
捕获 QGroupBox→CollapsibleSection 转换、compact_form 包裹、宽高调整等运行期错误。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

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
        if failures:
            self.fail("编辑器构造失败:\n\n" + "\n---\n".join(failures))


if __name__ == "__main__":
    unittest.main()
