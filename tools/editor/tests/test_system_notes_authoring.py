import json
import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import pytest
from PySide6.QtWidgets import QApplication
from tools.editor.project_model import ProjectModel
from tools.editor.editors.system_notes_editor import SystemNotesEditor, note_usages
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


@pytest.fixture()
def model(tmp_path):
    app = QApplication.instance() or QApplication([])
    write_minimal_loadable_project(tmp_path)
    model = ProjectModel()
    model.load_project(tmp_path)
    yield model
    assert app is not None


def test_create_edit_save_reopen_and_unknown_preservation(model):
    editor = SystemNotesEditor(model)
    editor._add()
    editor._id.setText("new_note")
    editor._title.setText("三把火熄了")
    editor._body.setPlainText("阳气不强，莫随便过界。")
    editor._anchor.setCurrentIndex(editor._anchor.findData("threeFires"))
    assert editor.flush_to_model()
    model.system_notes["future"] = True
    model.system_notes["notes"][0]["future"] = {"test": 0.123456789}
    model.save_all()
    assert not model.is_dirty
    disk = json.loads((model.data_path / "system_notes.json").read_text(encoding="utf-8"))
    assert disk["future"] is True
    assert disk["notes"][0]["hudAnchor"] == "threeFires"
    editor.reload_from_model()
    assert not editor._is_dirty()
    editor._title.setText("过界")
    assert editor.commit_pending_on_leave()
    assert model.system_notes["notes"][0]["future"] == {"test": 0.123456789}
    editor.deleteLater()


def test_usage_checks_include_death_and_authored_calls(model):
    model.game_config["health"] = {"retry": {"firstDeathNoteId": "death"}}
    model.scenes["sc_a"]["hotspots"] = [{"id": "ghost", "healthThreat": {"deathNoteId": "death"},
        "actions": [{"type": "showSystemNote", "params": {"noteId": "death"}}]}]
    assert len(note_usages(model, "death")) == 2


def test_save_rejects_invalid_note_before_writing(model):
    model.system_notes = {"notes": [{"id": "bad", "title": "", "body": "x"}]}
    model.mark_dirty("system_notes")
    with pytest.raises(ValueError, match="说明卡"):
        model.save_all()
    assert not (model.data_path / "system_notes.json").exists()
