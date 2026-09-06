"""Native authored event forms, under the repository's filesystem/Qt guards."""
import copy
import json
from pathlib import Path

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.quest_guidance_editor import ObjectivesEditor
from tools.editor.editors.water_minigame_editor import WaterMinigameEditor
from tools.editor.editors.paper_craft_editor import PaperCraftEditor
from tools.editor.editors.sugar_wheel_editor import SugarWheelEditor
from tools.editor.editors.narrative_state_editor import _normalize_file
from tools.dialogue_graph_editor.node_inspector import NodeInspector


def test_authored_open_world_forms_are_lossless():
    app = QApplication.instance() or QApplication([])
    root = Path(__file__).resolve().parents[3]
    model = ProjectModel()
    model.load_project(root)
    for quest in model.quests:
        if not quest['id'].startswith('ow_'):
            continue
        editor = ObjectivesEditor(model)
        editor.set_data(copy.deepcopy(quest['objectives']))
        assert editor.to_list() == quest['objectives'], quest['id']
        editor.deleteLater()
        app.processEvents()
    before = copy.deepcopy(model.water_minigames_instances)
    editor = WaterMinigameEditor(model)
    for row, item in enumerate(model.water_minigames_index):
        if item['id'].startswith('ow_'):
            editor._inst_list_w.setCurrentRow(row)
            for entity_row in range(editor._ent_list_w.count()):
                editor._ent_list_w.setCurrentRow(entity_row)
                app.processEvents()
    editor.flush_to_model()
    assert model.water_minigames_instances == before
    editor.deleteLater()
    before = copy.deepcopy(model.paper_craft_instances)
    editor = PaperCraftEditor(model)
    for row, item in enumerate(model.paper_craft_index):
        if not item['id'].startswith('ow_'):
            continue
        editor.instance_list.setCurrentRow(row)
        for order_row in range(editor.order_combo.count()):
            editor.order_combo.setCurrentRow(order_row)
            for field in ['part_combo', 'slot_combo', 'paper_combo', 'finish_combo']:
                control = getattr(editor, field)
                for child_row in range(control.count()):
                    control.setCurrentRow(child_row)
                    app.processEvents()
    editor.flush_to_model()
    assert model.paper_craft_instances == before
    editor.deleteLater()
    before = copy.deepcopy(model.sugar_wheel_instances)
    editor = SugarWheelEditor(model)
    for row, item in enumerate(model.sugar_wheel_index):
        if not item['id'].startswith('ow_'):
            continue
        editor._list.setCurrentRow(row)
        for sector_row in range(editor._sector_table.rowCount()):
            editor._sector_table.selectRow(sector_row)
            app.processEvents()
        for group_row in range(editor._atmos_group_list.count()):
            editor._atmos_group_list.setCurrentRow(group_row)
            app.processEvents()
    editor.flush_to_model()
    assert model.sugar_wheel_instances == before
    editor.deleteLater()
    data = json.loads((root / 'public/assets/data/narrative_graphs.json').read_text('utf-8'))
    assert _normalize_file(copy.deepcopy(data)) == data


def test_open_world_dialogues_roundtrip_through_native_inspector():
    app = QApplication.instance() or QApplication([])
    root = Path(__file__).resolve().parents[3]
    model = ProjectModel(); model.load_project(root)
    for path in (root / 'public/assets/dialogues/graphs').glob('开放世界_*.json'):
        doc = json.loads(path.read_text('utf-8'))
        inspector = NodeInspector(lambda: list(doc['nodes']), project_root=root,
            project_model_getter=lambda: model, dialogue_graph_id_getter=lambda: doc['id'])
        for nid, node in doc['nodes'].items():
            inspector.set_node(nid, copy.deepcopy(node))
            assert inspector.get_node() == node, f'{path.name}/{nid}'
        inspector.deleteLater(); app.processEvents()
