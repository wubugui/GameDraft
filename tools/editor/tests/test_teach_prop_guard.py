"""护火教学动作必须能从编辑器创建、编辑、往返，阈值非法时拒绝。"""
import os
from pathlib import Path

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

from PySide6.QtWidgets import QApplication
from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor, ACTION_TYPES, ACTION_PERSISTENCE


def test_guard_lesson_roundtrip():
    app = QApplication.instance() or QApplication([])
    model = ProjectModel()
    model.load_project(Path(__file__).resolve().parents[3])
    assert 'teachPropGuard' in ACTION_TYPES
    assert ACTION_PERSISTENCE['teachPropGuard'] == 'save'
    editor = ActionEditor('护火教学')
    editor.set_project_context(model, '跑马梁')
    action = {'type': 'teachPropGuard', 'params': {
        'vitality': 1, 'text': '[tag:string:tutorial:torchGuardRecovery]'}}
    try:
        editor.set_data([action])
        assert editor.to_list() == [action]
        changed = {'type': 'teachPropGuard', 'params': {
            'vitality': 0.85, 'text': '继续按住 Q'}}
        editor.set_data([changed])
        assert editor.to_list() == [changed]
        shared = {'type': 'teachPropGuard', 'params': {
            'vitality': 'guardSafety', 'text': '按住 Q 护到安全线以上'}}
        editor.set_data([shared])
        assert editor.to_list() == [shared]
    finally:
        editor.deleteLater()
        app.processEvents()


def test_guard_safety_preset_field_edits_only_its_value():
    from tools.editor.editors.prop_preset_blocks import PropPlayerControlBlock
    app = QApplication.instance() or QApplication([])
    block = PropPlayerControlBlock()
    original = {'guardSafety': 0.637, 'hintBelow': 0.8, 'future': {'keep': True}}
    try:
        block.set_data({'playerControl': original})
        assert block.dump() == original
        block._guard_safety._spin.setValue(0.73)
        assert block.dump() == {**original, 'guardSafety': 0.73}
    finally:
        block.deleteLater()
        app.processEvents()
