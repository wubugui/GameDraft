"""Real native property widgets, image picking and staged save acceptance."""
import copy
import json
import re
from pathlib import Path

import pytest
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QDoubleSpinBox

from tools.editor.editors.object_examine_editor import ObjectExamineEditor, _ENUMS
from tools.editor.project_model import ProjectModel
from tools.editor.shared.reference_picker import ReferencePickerField
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

ROOT = Path(__file__).resolve().parents[3]


def _app():
    return QApplication.instance() or QApplication([])


def test_background_choices_match_runtime_preset_registry():
    source = (ROOT / 'src/systems/objectExamine/types.ts').read_text('utf-8')
    registry = source.split('export const OBJECT_EXAMINE_BACKGROUND_PRESETS:', 1)[1].split('};', 1)[0]
    keys = re.findall(r'^\s+(\w+):\s*[\x27\x22]/resources/', registry, re.MULTILINE)
    assert _ENUMS['backgroundPreset'] == keys


def test_every_shipped_property_browses_without_mutating_data_or_dirty_state():
    app = _app()
    model = ProjectModel(); model.load_project(ROOT)
    before = copy.deepcopy(model.object_examine_instances)
    page = ObjectExamineEditor(model)
    for iid in before:
        assert page.select_by_id(iid)
        for path, node in list(page._tree_by_path.items()):
            page._tree.setCurrentItem(node)
            app.processEvents()
    assert model.object_examine_instances == before
    assert not model.is_dirty
    page.close(); page.deleteLater(); app.processEvents()


def test_pointer_selected_hotspot_edits_real_coordinate_and_saves_only_family(tmp_path):
    app = _app()
    write_minimal_loadable_project(tmp_path)
    model = ProjectModel(); model.load_project(tmp_path)
    instance = {'id': 'sample', 'label': 'sample', 'presentation': {
        'kind': 'still', 'image': '', 'physicalWidthCm': 120},
        'hotspots': [{'id': 'point', 'x': 10, 'y': 15, 'width': 80, 'height': 60,
                      'future_note': {'preserve': 7}}]}
    model.object_examine_instances = {'sample': copy.deepcopy(instance)}
    model.object_examine_index = [{'id': 'sample', 'label': 'sample', 'file': 'sample.json'}]
    page = ObjectExamineEditor(model); page.resize(1024, 720); page.show(); app.processEvents()
    region = next(i for i in page._scene.items() if i.data(0) == 0)
    point = page._preview.mapFromScene(region.sceneBoundingRect().center())
    QTest.mouseClick(page._preview.viewport(), Qt.MouseButton.LeftButton, pos=point)
    assert tuple(page._tree.currentItem().data(0, Qt.ItemDataRole.UserRole)) == ('hotspots', 0)
    node = page._tree_by_path[('hotspots', 0, 'x')]
    page._tree.setCurrentItem(node)
    spin = page._property_widget
    assert isinstance(spin, QDoubleSpinBox)
    spin.setFocus(); spin.selectAll(); QTest.keyClicks(spin, '22'); QTest.keyClick(spin, Qt.Key.Key_Tab)
    app.processEvents()
    assert model.object_examine_instances['sample']['hotspots'][0]['x'] == 22
    assert model._dirty == {'object_examine'}
    model.save_all()
    target = tmp_path / 'public/assets/data/object_examine/sample.json'
    saved = json.loads(target.read_text('utf-8'))
    assert saved['hotspots'][0] == {**instance['hotspots'][0], 'x': 22}
    assert not model.is_dirty
    page.close(); page.deleteLater(); app.processEvents()


def test_item_reference_widget_keeps_unknown_value_and_live_candidates():
    app = _app()
    model = ProjectModel()
    model.object_examine_instances = {'g': {'id': 'g', 'hotspots': [{
        'id': 'h', 'x': 0, 'y': 0, 'width': 20, 'height': 20,
        'itemUses': [{'itemId': 'missing_item', 'label': '使用', 'actions': []}],
    }]}}
    page = ObjectExamineEditor(model)
    page._tree.setCurrentItem(page._tree_by_path[('hotspots', 0, 'itemUses', 0, 'itemId')])
    assert isinstance(page._property_widget, ReferencePickerField)
    assert page._property_widget.current_value() == 'missing_item'
    assert not model.is_dirty
    page.close(); page.deleteLater(); app.processEvents()


def test_examine_save_rejects_index_paths_outside_its_family(tmp_path):
    model = ProjectModel(); model.project_path = tmp_path
    model.object_examine_index = [{'id': 'g', 'file': '../items.json'}]
    model.object_examine_instances = {'g': {'id': 'g'}}
    model.mark_dirty('object_examine')
    with pytest.raises(ValueError, match='实例路径'):
        model._object_examine_save_rows()
    assert model._dirty == {'object_examine'}
