"""Native objective reference picker: scoped candidates, no open/save mutation."""
import copy

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor
from tools.editor.shared.id_ref_selector import IdRefSelector
from tools.editor.tests.test_quest_objectives_guidance import _write_project, _quest
from tools.editor.validator import validate


def test_focus_action_minimal_full_and_orphan_are_lossless():
    app = QApplication.instance() or QApplication([])
    model = ProjectModel()
    model.quests = [{'id': 'a', 'title': '甲', 'objectives': [{'id': 'one', 'text': '工位'}]}]
    for params in [{'id': 'a'}, {'id': 'a', 'objectiveId': 'one'},
                   {'id': 'a', 'objectiveId': 'missing'}, {'id': '', 'objectiveId': ''}]:
        ed = ActionEditor('Actions'); ed.set_project_context(model)
        src = [{'type': 'setFocusedQuest', 'params': params}]
        ed.set_data(copy.deepcopy(src))
        assert isinstance(ed._rows[0]._param_widgets['objectiveId'], IdRefSelector)
        assert ed.to_list() == src
        ed.deleteLater(); app.processEvents()


def test_changing_quest_refreshes_objectives_and_preserves_orphan_until_user_selects():
    app = QApplication.instance() or QApplication([])
    model = ProjectModel()
    model.quests = [{'id': key, 'title': key, 'objectives': [{'id': 'obj_' + key, 'text': key}]}
                    for key in ['a', 'b']]
    ed = ActionEditor('Actions'); ed.set_project_context(model)
    ed.set_data([{'type': 'setFocusedQuest', 'params': {'id': 'a', 'objectiveId': 'obj_a'}}])
    ed.show(); app.processEvents()
    widgets = ed._rows[0]._param_widgets
    q, obj = widgets['id'], widgets['objectiveId']
    assert obj._ids == ['', 'obj_a']
    QTest.keyClick(q, Qt.Key.Key_Down)
    assert q.current_id() == 'b'
    assert 'obj_b' in obj._ids
    assert obj.current_id() == 'obj_a'
    QTest.keyClick(obj, Qt.Key.Key_Up)
    assert obj.current_id() == 'obj_b'
    assert ed.to_list()[0]['params']['objectiveId'] == 'obj_b'
    ed.deleteLater(); app.processEvents()


def test_validator_rejects_objective_from_another_quest(tmp_path):
    q = _quest(objectives=[{'id': 'here', 'text': '本任务目标'}], rewards=[
        {'type': 'setFocusedQuest', 'params': {'id': 'q', 'objectiveId': 'elsewhere'}}])
    model = _write_project(tmp_path / 'project', [q])
    errors = [i.message for i in validate(model) if i.severity == 'error']
    assert any('elsewhere' in message and '不属于' in message for message in errors)
