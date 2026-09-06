import copy
import json
from pathlib import Path

import pytest
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.rule_editor import RuleEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.rule_knowledge_validation import validate_rule_knowledge
from tools.editor.shared.signal_refactor import rename_state, scan_state_usages, push_journal, undo_last
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((ROOT/'src/core/fixtures/rule-knowledge-validation.json').read_text('utf-8'))


@pytest.mark.parametrize('case', CASES['cases'], ids=lambda c: c['name'])
def test_shared_validation_contract(case):
    rule = {**CASES['rule'], **case.get('rule', {})}
    assert validate_rule_knowledge(rule, case.get('graphs', CASES['graphs']), case.get('fragments', [])) == case['errors']


def make_editor(tmp_path):
    app = QApplication.instance() or QApplication([])
    root = tmp_path/'game'
    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    model.rules_data = {'rules': [copy.deepcopy(CASES['rule'])], 'fragments': []}
    model.narrative_graphs = {'compositions': [{'id':'c', 'mainGraph':copy.deepcopy(CASES['graphs'][0]), 'elements': []}]}
    editor = RuleEditor(model)
    editor.resize(840, 740)
    editor.show()
    app.processEvents()
    editor.select_by_id('r')
    return app, model, editor


def test_lazy_panel_browse_is_lossless(tmp_path):
    app, model, editor = make_editor(tmp_path)
    before = copy.deepcopy(model.rules_data)
    assert editor._knowledge_editor is None
    QTest.mouseClick(editor._knowledge_section._header, Qt.MouseButton.LeftButton)
    app.processEvents()
    child = editor._knowledge_editor
    assert child is not None
    for i in range(child.state.count()):
        child.state.setCurrentIndex(i)
        app.processEvents()
    assert not editor._is_dirty_rule()
    editor.flush_to_model()
    assert model.rules_data == before
    editor.close()


def test_user_text_edit_survives_state_switch_and_save_all(tmp_path):
    app, model, editor = make_editor(tmp_path)
    before_layers = copy.deepcopy(model.rules_data['rules'][0]['layers'])
    QTest.mouseClick(editor._knowledge_section._header, Qt.MouseButton.LeftButton)
    child = editor._knowledge_editor
    child.state.setCurrentIndex(child.state.findData('known'))
    # IdRefSelector stores ids itself; choose the row through the same index signal.
    if child.state.current_id() != 'known':
        child.state.setCurrentIndex(2 if child.state.itemText(0) == '（未选择）' else 1)
    assert child.state.current_id() == 'known'
    text = child.fields['xiang'][1]._edit
    text.setFocus()
    QTest.keyClick(text, Qt.Key.Key_End, Qt.KeyboardModifier.ControlModifier)
    QTest.keyClicks(text, ' evidence')
    child.state.setCurrentIndex(0)
    editor.flush_to_model()
    rule = model.rules_data['rules'][0]
    assert rule['narrativeStates']['known']['layers']['xiang']['text'].endswith(' evidence')
    assert rule['layers'] == before_layers
    assert editor._r_id.isReadOnly()
    assert model.save_all() is not False
    saved = json.loads((tmp_path/'game/public/assets/data/rules.json').read_text('utf-8'))
    assert saved == model.rules_data
    editor.close()


def test_discard_does_not_return_through_flush(tmp_path, monkeypatch):
    app, model, editor = make_editor(tmp_path)
    before = copy.deepcopy(model.rules_data)
    QTest.mouseClick(editor._knowledge_section._header, Qt.MouseButton.LeftButton)
    child = editor._knowledge_editor
    child.enabled.click()
    assert editor._is_dirty_rule()
    monkeypatch.setattr(QMessageBox, 'question', lambda *_a, **_k: QMessageBox.StandardButton.Discard)
    assert editor.confirm_close()
    editor.flush_to_model()
    assert model.rules_data == before
    editor.close()


def test_state_rename_and_undo_keep_knowledge_bound(tmp_path):
    _, model, editor = make_editor(tmp_path)
    before = copy.deepcopy(model.rules_data)
    assert scan_state_usages(model, 'g', 'known')['ruleKnowledge'] == 1
    result = rename_state(model, 'g', 'known', 'tested')
    push_journal(model, result)
    assert model.rules_data['rules'][0]['narrativeStates']['tested'] == before['rules'][0]['narrativeStates']['known']
    assert 'known' not in model.rules_data['rules'][0]['narrativeStates']
    assert undo_last(model)['ok']
    assert model.rules_data == before
    editor.close()


def test_save_blocks_orphaned_knowledge_before_any_file_is_written(tmp_path):
    _, model, editor = make_editor(tmp_path)
    path = tmp_path/'game/public/assets/data/rules.json'
    before = path.read_bytes()
    model.rules_data['rules'][0]['narrativeStates']['typo'] = {'layers': {}}
    model.mark_dirty('rules')
    with pytest.raises(ValueError, match='规矩状态正文'):
        model.save_all()
    assert path.read_bytes() == before
    editor.close()
