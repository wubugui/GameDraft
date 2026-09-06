"""Cross-graph entry references must be checked against the destination."""
import json

from tools.json_lang.lint import lint_dialogue_graphs


def _project(tmp_path, entry="alternate", local_next="end"):
    graphs = tmp_path / "public/assets/dialogues/graphs"
    graphs.mkdir(parents=True)
    documents = {
        "source": {"id": "source", "entry": "start", "nodes": {
            "start": {"type": "action", "actions": [{
                "type": "startDialogueGraph", "params": {"graphId": "target", "entry": entry},
            }], "next": local_next},
            "end": {"type": "end"},
        }},
        "target": {"id": "target", "entry": "start", "nodes": {
            "start": {"type": "end"}, "alternate": {"type": "end"},
        }},
    }
    for name, doc in documents.items():
        (graphs / f"{name}.json").write_text(json.dumps(doc), encoding="utf-8")


def test_handoff_entry_is_not_a_local_edge_or_destination_orphan(tmp_path):
    _project(tmp_path)
    assert lint_dialogue_graphs(tmp_path) == []


def test_missing_external_entry_is_still_reported_at_source(tmp_path):
    _project(tmp_path, entry="missing")
    errors = [issue for issue in lint_dialogue_graphs(tmp_path) if issue.severity == "error"]
    assert len(errors) == 1
    assert errors[0].file.endswith("source.json")
    assert "悬垂外部入口" in errors[0].message and "missing" in errors[0].message


def test_handoff_does_not_hide_a_broken_local_continuation(tmp_path):
    _project(tmp_path, local_next="missing")
    errors = [issue for issue in lint_dialogue_graphs(tmp_path) if issue.severity == "error"]
    assert len(errors) == 1
    assert "nodes.start.next" in errors[0].message
