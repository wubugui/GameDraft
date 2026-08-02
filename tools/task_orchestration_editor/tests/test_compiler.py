from __future__ import annotations

import copy
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import snapshot_json_hashes, write_minimal_loadable_project
from tools.task_orchestration_editor.compiler import (
    CompileError,
    EventBindingSpec,
    apply_compilation_plan,
    build_event_plan,
    delete_event_spine,
    ensure_signal_before_reachable_ends,
    pending_dialogue_stub_conflicts,
    remove_event_binding,
    scan_event_bindings,
)


def _dump(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _project(root: Path, *, dialogue: dict | None = None) -> ProjectModel:
    write_minimal_loadable_project(root)
    narrative = {
        "schemaVersion": 3,
        "migrations": {"graphs": {}, "states": {}},
        "compositions": [
            {
                "id": "event_flow",
                "label": "旧庙事件",
                "mainGraph": {
                    "id": "flow_event",
                    "ownerType": "flow",
                    "ownerId": "event_flow",
                    "initialState": "ready",
                    "states": {
                        "ready": {"id": "ready", "label": "可发生", "meta": {"editor": {"x": 10, "y": 20}}},
                        "done": {"id": "done", "label": "已发生", "meta": {"editor": {"x": 280, "y": 20}}},
                    },
                    "transitions": [],
                },
                "elements": [],
            }
        ],
        "signals": [],
    }
    _dump(root / "public/assets/data/narrative_graphs.json", narrative)
    scene = {
        "id": "sc_a",
        "name": "旧庙",
        "unknownSceneKey": {"keep": 7},
        "spawnPoints": {},
        "npcs": [
            {
                "id": "npc_witness",
                "name": "目击者",
                "x": 11.25,
                "y": 22,
                "interactionRange": 64,
                "unknownNpcKey": [1, 2, 3],
                "conditions": [{"flag": "other_gate"}],
                "conditionHidesEntity": True,
            }
        ],
        "hotspots": [
            {
                "id": "hs_note",
                "type": "inspect",
                "label": "纸条",
                "x": 5,
                "y": 6,
                "interactionRange": 40,
                "data": {"graphId": "source_dialogue", "unknownDataKey": "keep"},
            }
        ],
        "zones": [
            {
                "id": "zone_event",
                "polygon": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}],
                "conditions": [{"flag": "legacy_gate", "value": True}],
                "onEnter": [{"type": "playSfx", "params": {"id": "old_sfx"}}],
                "unknownZoneKey": {"keep": True},
            }
        ],
    }
    _dump(root / "public/assets/scenes/sc_a.json", scene)
    dialogue = dialogue or {
        "schemaVersion": 1,
        "id": "source_dialogue",
        "entry": "root",
        "meta": {"title": "共享对话", "unknown": {"keep": 1}},
        "nodes": {
            "root": {
                "type": "choice",
                "options": [
                    {"id": "a", "text": "甲", "next": "end_a"},
                    {"id": "b", "text": "乙", "next": "end_b"},
                ],
            },
            "end_a": {"type": "end", "unknownEnd": 1},
            "end_b": {"type": "end"},
        },
    }
    _dump(root / "public/assets/dialogues/graphs/source_dialogue.json", dialogue)
    model = ProjectModel()
    model.load_project(root)
    return model


def _spec(**overrides) -> EventBindingSpec:
    values = {
        "composition_id": "event_flow",
        "transition_id": "t_event_done",
        "from_state": "ready",
        "to_state": "done",
        "signal_id": "event_flow__done",
        "scenario_element_id": "event_t_event_done",
        "scenario_graph_id": "scenario_event_flow__t_event_done",
        "prerequisite_graph_id": "flow_event",
        "prerequisite_state_id": "ready",
        "trigger_kind": "zone_dialogue",
        "scene_id": "sc_a",
        "trigger_entity_id": "zone_event",
        "dialogue_graph_id": "source_dialogue",
        "clone_dialogue": True,
        "dialogue_copy_id": "event_flow_dialogue",
        "visible_entities": (("npc", "npc_witness"), ("zone", "zone_event")),
    }
    values.update(overrides)
    return EventBindingSpec(**values)


def _remove_all_non_scenario_bindings(model: ProjectModel) -> None:
    while True:
        rows = scan_event_bindings(model, "event_flow", "t_event_done")
        removable = next((row for row in rows if row.kind != "scenario"), None)
        if removable is None:
            return
        remove_event_binding(model, "event_flow", "t_event_done", removable)


class TestTaskOrchestrationCompiler(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def test_zone_dialogue_event_compiles_only_to_native_domains(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            original_scene = copy.deepcopy(model.scenes["sc_a"])
            original_dialogue = json.loads(
                (root / "public/assets/dialogues/graphs/source_dialogue.json").read_text(encoding="utf-8")
            )

            plan = build_event_plan(model, _spec())

            self.assertTrue(plan.changed)
            self.assertEqual(model.scenes["sc_a"], original_scene, "preview must be detached")
            zone = plan.scenes["sc_a"]["zones"][0]
            npc = plan.scenes["sc_a"]["npcs"][0]
            self.assertEqual(zone["unknownZoneKey"], {"keep": True})
            self.assertEqual(zone["conditions"][0], {"flag": "legacy_gate", "value": True})
            self.assertEqual(zone["onEnter"][0], {"type": "playSfx", "params": {"id": "old_sfx"}})
            self.assertEqual(npc["unknownNpcKey"], [1, 2, 3])
            self.assertEqual(npc["x"], 11.25)
            self.assertTrue(npc["conditionHidesEntity"])
            event_gate = {"narrative": "scenario_event_flow__t_event_done", "state": "ready"}
            self.assertIn(event_gate, zone["conditions"])
            self.assertIn(event_gate, npc["conditions"])
            self.assertEqual(
                zone["onEnter"][-1],
                {"type": "startDialogueGraph", "params": {"graphId": "event_flow_dialogue"}},
            )
            clone = plan.dialogue_stubs["event_flow_dialogue"]
            self.assertEqual(clone["id"], "event_flow_dialogue")
            self.assertEqual(clone["meta"]["unknown"], {"keep": 1})
            self.assertEqual(clone["nodes"]["end_a"]["type"], "runActions")
            terminal_a = clone["nodes"]["end_a"]["next"]
            self.assertEqual(clone["nodes"][terminal_a], {"type": "end", "unknownEnd": 1})
            self.assertEqual(
                json.loads((root / "public/assets/dialogues/graphs/source_dialogue.json").read_text(encoding="utf-8")),
                original_dialogue,
                "source dialogue must stay untouched when clone mode is selected",
            )
            self.assertFalse(any("task" in key.lower() for key in plan.narrative_graphs.keys()))
            comp = plan.narrative_graphs["compositions"][0]
            main_transition = comp["mainGraph"]["transitions"][0]
            self.assertEqual(
                main_transition["signal"],
                "state:scenario_event_flow__t_event_done:done",
            )
            scenario_element = next(
                row for row in comp["elements"] if row.get("kind") == "scenarioSubgraph"
            )
            scenario = scenario_element["graph"]
            self.assertEqual(scenario["ownerType"], "scenario")
            self.assertEqual(scenario["initialState"], "locked")
            self.assertEqual(scenario["entryState"], "ready")
            self.assertEqual(scenario["exitStates"], ["done", "expired"])
            self.assertIs(scenario["states"]["done"]["broadcastOnEnter"], True)
            by_id = {row["id"]: row for row in scenario["transitions"]}
            self.assertEqual(
                by_id["unlock"]["conditions"],
                [{"narrative": "flow_event", "state": "ready"}],
            )
            self.assertEqual(by_id["complete"]["signal"], "event_flow__done")

    def test_entry_end_is_wrapped_without_changing_entry(self) -> None:
        graph = {"schemaVersion": 1, "id": "g", "entry": "end", "nodes": {"end": {"type": "end", "x": 1}}}
        patched, changes = ensure_signal_before_reachable_ends(graph, "sig", source_id="g")
        self.assertEqual(patched["entry"], "end")
        self.assertEqual(patched["nodes"]["end"]["type"], "runActions")
        terminal = patched["nodes"]["end"]["next"]
        self.assertEqual(patched["nodes"][terminal], {"type": "end", "x": 1})
        self.assertEqual(len(changes), 1)

    def test_multiple_ends_emit_once_and_transform_is_idempotent(self) -> None:
        graph = {
            "id": "g",
            "entry": "c",
            "nodes": {
                "c": {"type": "choice", "options": [{"text": "A", "next": "a"}, {"text": "B", "next": "b"}]},
                "a": {"type": "end"},
                "b": {"type": "end"},
            },
        }
        once, changes = ensure_signal_before_reachable_ends(graph, "sig", source_id="g")
        twice, changes_again = ensure_signal_before_reachable_ends(once, "sig", source_id="g")
        self.assertEqual(len(changes), 2)
        self.assertEqual(changes_again, [])
        self.assertEqual(twice, once)

    def test_nested_dialogue_is_blocked_in_natural_completion_mode(self) -> None:
        graph = {
            "id": "g",
            "entry": "run",
            "nodes": {
                "run": {
                    "type": "runActions",
                    "actions": [{"type": "startDialogueGraph", "params": {"graphId": "child"}}],
                    "next": "end",
                },
                "end": {"type": "end"},
            },
        }
        with self.assertRaisesRegex(CompileError, "链式对话"):
            ensure_signal_before_reachable_ends(graph, "sig", source_id="g")

    def test_conditional_nested_emit_is_not_treated_as_guaranteed_exit_guard(self) -> None:
        graph = {
            "id": "g",
            "entry": "maybe",
            "nodes": {
                "maybe": {
                    "type": "runActions",
                    "actions": [{
                        "type": "conditionalActions",
                        "params": {"then": [{"type": "emitNarrativeSignal", "params": {"signal": "sig"}}]},
                    }],
                    "next": "end",
                },
                "end": {"type": "end"},
            },
        }
        with self.assertRaisesRegex(CompileError, "exactly-once"):
            ensure_signal_before_reachable_ends(graph, "sig", source_id="g")

    def test_duplicate_or_early_dialogue_emit_is_rejected(self) -> None:
        exact = {"type": "emitNarrativeSignal", "params": {
            "signal": "sig", "sourceType": "dialogue", "sourceId": "g",
        }}
        duplicate = {
            "id": "g",
            "entry": "guard",
            "nodes": {
                "guard": {"type": "runActions", "actions": [exact, copy.deepcopy(exact)], "next": "end"},
                "end": {"type": "end"},
            },
        }
        with self.assertRaisesRegex(CompileError, "exactly-once"):
            ensure_signal_before_reachable_ends(duplicate, "sig", source_id="g")

        early_and_guarded = {
            "id": "g",
            "entry": "early",
            "nodes": {
                "early": {"type": "runActions", "actions": [copy.deepcopy(exact)], "next": "guard"},
                "guard": {"type": "runActions", "actions": [copy.deepcopy(exact)], "next": "end"},
                "end": {"type": "end"},
            },
        }
        with self.assertRaisesRegex(CompileError, "exactly-once"):
            ensure_signal_before_reachable_ends(early_and_guarded, "sig", source_id="g")

    def test_new_event_rejects_reusing_registered_signal(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            model.narrative_graphs["signals"].append({"id": "event_flow__done"})
            with self.assertRaisesRegex(CompileError, "两个任务串线"):
                build_event_plan(model, _spec())

    def test_apply_marks_existing_dirty_buckets_and_roundtrips_save(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            before = snapshot_json_hashes(root / "public/assets")
            plan = build_event_plan(model, _spec())
            apply_compilation_plan(model, plan)
            self.assertEqual(
                model._dirty,
                {"narrative_graphs", "scene", "dialogue_stubs"},
            )
            self.assertEqual(model._dirty_scene_ids, {"sc_a"})
            self.assertFalse((root / "public/assets/dialogues/graphs/event_flow_dialogue.json").exists())
            model.save_all()
            self.assertFalse(model.is_dirty)
            self.assertTrue((root / "public/assets/dialogues/graphs/event_flow_dialogue.json").is_file())
            after = snapshot_json_hashes(root / "public/assets")
            changed = {key for key in after if after.get(key) != before.get(key)}
            self.assertEqual(
                changed,
                {
                    "data/narrative_graphs.json",
                    "dialogues/graphs/event_flow_dialogue.json",
                    "scenes/sc_a.json",
                },
            )
            reopened = ProjectModel()
            reopened.load_project(root)
            rows = scan_event_bindings(reopened, "event_flow", "t_event_done")
            self.assertTrue(any(row.kind == "trigger" for row in rows))
            self.assertTrue(any(row.kind == "availability" and row.entity_kind == "npc" for row in rows))
            from tools.editor.validator import validate

            errors = [issue for issue in validate(reopened) if issue.severity == "error"]
            self.assertEqual(errors, [], "compiled data must pass the regular editor's full validator")

    def test_failed_apply_restores_exact_document_object_identities(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            plan = build_event_plan(model, _spec())
            original_objects = {
                name: getattr(model, name)
                for name in (
                    "narrative_graphs",
                    "scenes",
                    "quests",
                    "pending_dialogue_graph_edits",
                    "pending_dialogue_stubs",
                )
            }
            original_dirty = copy.deepcopy(model._dirty)
            real_mark_dirty = model.mark_dirty
            calls = 0

            def fail_third_bucket(data_type: str, item_id: str = "") -> None:
                nonlocal calls
                calls += 1
                real_mark_dirty(data_type, item_id)
                if calls == 3:
                    raise RuntimeError("injected dirty failure")

            with patch.object(model, "mark_dirty", side_effect=fail_third_bucket):
                with self.assertRaisesRegex(RuntimeError, "injected dirty failure"):
                    apply_compilation_plan(model, plan)

            for name, original in original_objects.items():
                self.assertIs(getattr(model, name), original, name)
            self.assertEqual(model._dirty, original_dirty)

    def test_stub_created_after_ui_preflight_rolls_back_whole_native_transaction(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            target = root / "public/assets/dialogues/graphs/event_flow_dialogue.json"
            watched = [
                root / "public/assets/data/narrative_graphs.json",
                root / "public/assets/data/quests.json",
                root / "public/assets/scenes/sc_a.json",
            ]
            before = {path: path.read_bytes() for path in watched}
            external = b'{"external":"won-before-save"}\n'

            self.assertEqual(pending_dialogue_stub_conflicts(model), [])
            target.write_bytes(external)
            with self.assertRaises(OSError):
                model.save_all()

            self.assertEqual({path: path.read_bytes() for path in watched}, before)
            self.assertEqual(target.read_bytes(), external)
            self.assertIn("event_flow_dialogue", model.pending_dialogue_stubs)
            self.assertTrue(model.is_dirty)

    def test_stub_created_at_atomic_install_rolls_back_whole_native_transaction(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            target = root / "public/assets/dialogues/graphs/event_flow_dialogue.json"
            watched = [
                root / "public/assets/data/narrative_graphs.json",
                root / "public/assets/data/quests.json",
                root / "public/assets/scenes/sc_a.json",
            ]
            before = {path: path.read_bytes() for path in watched}
            external = b'{"external":"won-at-commit"}\n'
            real_link = os.link
            injected = False

            def collide(src: object, dst: object, *args: object, **kwargs: object):
                nonlocal injected
                if not injected and Path(dst) == target:
                    injected = True
                    target.write_bytes(external)
                return real_link(src, dst, *args, **kwargs)

            with patch("tools.editor.file_io.os.link", side_effect=collide):
                with self.assertRaises(OSError):
                    model.save_all()

            self.assertTrue(injected)
            self.assertEqual({path: path.read_bytes() for path in watched}, before)
            self.assertEqual(target.read_bytes(), external)
            self.assertIn("event_flow_dialogue", model.pending_dialogue_stubs)
            self.assertTrue(model.is_dirty)
            leftovers = [
                path for path in (root / "public/assets").rglob(".*")
                if path.suffix in {".tmp", ".rollback"}
            ]
            self.assertEqual(leftovers, [])

    def test_external_change_is_detected_before_save(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            apply_compilation_plan(model, build_event_plan(model, _spec(trigger_kind="zone_instant", dialogue_graph_id="", dialogue_copy_id="")))
            path = root / "public/assets/scenes/sc_a.json"
            path.write_text(path.read_text(encoding="utf-8") + " ", encoding="utf-8")
            self.assertIn("public/assets/scenes/sc_a.json", model.detect_external_changes())

    def test_instant_zone_event_does_not_touch_dialogue_domains(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            plan = build_event_plan(
                model,
                _spec(trigger_kind="zone_instant", dialogue_graph_id="", dialogue_copy_id=""),
            )
            self.assertFalse(plan.dialogue_edits)
            self.assertFalse(plan.dialogue_stubs)
            action = plan.scenes["sc_a"]["zones"][0]["onEnter"][-1]
            self.assertEqual(action["type"], "emitNarrativeSignal")

    def test_new_event_cannot_modify_shared_dialogue_in_place(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            with self.assertRaisesRegex(CompileError, "不能原地修改共享对话"):
                build_event_plan(model, _spec(clone_dialogue=False, dialogue_copy_id=""))

    def test_independent_event_flow_can_be_unlocked_by_external_mainline_state(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            model.narrative_graphs["compositions"].append({
                "id": "mainline",
                "mainGraph": {
                    "id": "flow_mainline",
                    "ownerType": "flow",
                    "initialState": "chapter_1",
                    "states": {
                        "chapter_1": {"id": "chapter_1"},
                        "chapter_2": {"id": "chapter_2"},
                    },
                    "transitions": [],
                },
                "elements": [],
            })
            plan = build_event_plan(
                model,
                _spec(
                    prerequisite_graph_id="flow_mainline",
                    prerequisite_state_id="chapter_2",
                ),
            )
            comp = plan.narrative_graphs["compositions"][0]
            scenario = next(row["graph"] for row in comp["elements"] if row.get("kind") == "scenarioSubgraph")
            unlock = next(row for row in scenario["transitions"] if row["id"] == "unlock")
            self.assertEqual(
                unlock["conditions"],
                [
                    {"narrative": "flow_mainline", "state": "chapter_2"},
                    {"narrative": "flow_event", "state": "ready"},
                ],
            )
            self.assertIn(
                {"narrative": scenario["id"], "state": "ready"},
                plan.scenes["sc_a"]["zones"][0]["conditions"],
            )

    def test_impossible_or_self_referential_prerequisite_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            with self.assertRaisesRegex(CompileError, "不可能同时处于"):
                build_event_plan(model, _spec(prerequisite_state_id="done"))
            with self.assertRaisesRegex(CompileError, "不能把自己设为解锁前置"):
                build_event_plan(
                    model,
                    _spec(
                        prerequisite_graph_id="scenario_event_flow__t_event_done",
                        prerequisite_state_id="ready",
                    ),
                )

    def test_legacy_entity_conditions_are_not_reinterpreted(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            npc = model.scenes["sc_a"]["npcs"][0]
            npc.pop("conditionHidesEntity")
            before = copy.deepcopy(model.scenes["sc_a"])
            with self.assertRaisesRegex(CompileError, "永久改变旧条件"):
                build_event_plan(model, _spec())
            self.assertEqual(model.scenes["sc_a"], before)

    def test_zone_existing_dialogue_requires_explicit_replacement(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            model.scenes["sc_a"]["zones"][0]["onEnter"].append(
                {"type": "startDialogueGraph", "params": {"graphId": "source_dialogue", "entry": "root"}}
            )
            with self.assertRaisesRegex(CompileError, "明确替换"):
                build_event_plan(model, _spec())
            plan = build_event_plan(model, _spec(replace_existing_dialogue=True))
            starts = [
                row for row in plan.scenes["sc_a"]["zones"][0]["onEnter"]
                if row.get("type") == "startDialogueGraph"
            ]
            self.assertEqual(len(starts), 1)
            self.assertEqual(starts[0]["params"]["graphId"], "event_flow_dialogue")
            self.assertEqual(starts[0]["params"]["entry"], "root")

    def test_npc_hotspot_type_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            model.scenes["sc_a"]["hotspots"][0]["type"] = "npc"
            with self.assertRaisesRegex(CompileError, "只有 inspect"):
                build_event_plan(
                    model,
                    _spec(
                        trigger_kind="hotspot_dialogue",
                        trigger_entity_id="hs_note",
                        replace_existing_dialogue=True,
                    ),
                )

    def test_repeatable_quest_mirror_is_rejected(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            model.quests = [{"id": "q_repeat", "type": "repeatable", "title": "每天", "group": ""}]
            with self.assertRaisesRegex(CompileError, "repeatable"):
                build_event_plan(
                    model,
                    _spec(
                        trigger_kind="zone_instant",
                        dialogue_graph_id="",
                        dialogue_copy_id="",
                        quest_id="q_repeat",
                    ),
                )

    def test_bindings_can_be_unlinked_then_standard_event_spine_deleted(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            _remove_all_non_scenario_bindings(model)
            delete_event_spine(model, "event_flow", "t_event_done")
            comp = model.narrative_graphs["compositions"][0]
            self.assertEqual(comp["mainGraph"]["transitions"], [])
            self.assertFalse(any(row.get("kind") == "scenarioSubgraph" for row in comp["elements"]))
            zone_box = next(row for row in comp["elements"] if row.get("kind") == "zoneBlackbox")
            self.assertEqual(zone_box["meta"]["reads"], [])
            self.assertTrue(any(row.get("kind") == "dialogueBlackbox" for row in comp["elements"]))

    def test_event_delete_rejects_old_editor_semantic_extensions_transactionally(self) -> None:
        mutations = {
            "state action": lambda comp, scenario: scenario["states"]["done"].update({
                "onEnterActions": [{"type": "setFlag", "params": {"flag": "author"}}],
            }),
            "complete condition": lambda comp, scenario: next(
                row for row in scenario["transitions"] if row["id"] == "complete"
            ).update({"conditions": [{"flag": "author"}]}),
            "main condition": lambda comp, scenario: comp["mainGraph"]["transitions"][0].update({
                "conditions": [{"flag": "author"}],
            }),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), TemporaryDirectory() as td:
                model = _project(Path(td) / "p")
                apply_compilation_plan(model, build_event_plan(model, _spec()))
                _remove_all_non_scenario_bindings(model)
                comp = model.narrative_graphs["compositions"][0]
                scenario = next(
                    row["graph"] for row in comp["elements"] if row.get("kind") == "scenarioSubgraph"
                )
                mutate(comp, scenario)
                before = copy.deepcopy(model.narrative_graphs)
                with self.assertRaises(CompileError):
                    delete_event_spine(model, "event_flow", "t_event_done")
                self.assertEqual(model.narrative_graphs, before)

    def test_event_delete_never_globally_removes_author_blackbox_reads(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            _remove_all_non_scenario_bindings(model)
            comp = model.narrative_graphs["compositions"][0]
            dialogue_box = next(row for row in comp["elements"] if row.get("kind") == "dialogueBlackbox")
            dialogue_box["meta"]["reads"].append("scenario_event_flow__t_event_done")
            before = copy.deepcopy(model.narrative_graphs)
            with self.assertRaisesRegex(CompileError, "其它原生引用"):
                delete_event_spine(model, "event_flow", "t_event_done")
            self.assertEqual(model.narrative_graphs, before)

    def test_duplicate_native_rows_are_unbound_one_selected_index_at_a_time(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            apply_compilation_plan(model, build_event_plan(
                model,
                _spec(trigger_kind="zone_instant", dialogue_graph_id="", dialogue_copy_id=""),
            ))
            zone = model.scenes["sc_a"]["zones"][0]
            emit = next(row for row in zone["onEnter"] if row.get("type") == "emitNarrativeSignal")
            zone["onEnter"].append(copy.deepcopy(emit))
            gate = {"narrative": "scenario_event_flow__t_event_done", "state": "ready"}
            zone["conditions"].append(copy.deepcopy(gate))

            rows = scan_event_bindings(model, "event_flow", "t_event_done")
            triggers = [row for row in rows if row.kind == "trigger" and row.entity_kind == "zone"]
            availability = [row for row in rows if row.kind == "availability" and row.entity_kind == "zone"]
            self.assertEqual([row.list_index for row in triggers], [1, 2])
            self.assertEqual([row.list_index for row in availability], [1, 2])

            remove_event_binding(model, "event_flow", "t_event_done", triggers[0])
            self.assertEqual(sum(row == emit for row in zone["onEnter"]), 2, "detached local must not be reused")
            zone = model.scenes["sc_a"]["zones"][0]
            self.assertEqual(sum(row == emit for row in zone["onEnter"]), 1)
            comp = model.narrative_graphs["compositions"][0]
            zone_box = next(row for row in comp["elements"] if row.get("kind") == "zoneBlackbox")
            self.assertIn("scenario_event_flow__t_event_done", zone_box["meta"]["reads"])
            self.assertIn("event_flow__done", zone_box["meta"]["emits"])

            # Re-scan because list indexes are intentionally stale after a deletion.
            trigger = next(
                row for row in scan_event_bindings(model, "event_flow", "t_event_done")
                if row.kind == "trigger" and row.entity_kind == "zone"
            )
            remove_event_binding(model, "event_flow", "t_event_done", trigger)
            comp = model.narrative_graphs["compositions"][0]
            zone_box = next(row for row in comp["elements"] if row.get("kind") == "zoneBlackbox")
            self.assertNotIn("event_flow__done", zone_box["meta"]["emits"])
            self.assertIn(
                "scenario_event_flow__t_event_done",
                zone_box["meta"]["reads"],
                "availability gates still make the Zone projection read the scenario",
            )

            while True:
                gate_row = next((
                    row for row in scan_event_bindings(model, "event_flow", "t_event_done")
                    if row.kind == "availability" and row.entity_kind == "zone"
                ), None)
                if gate_row is None:
                    break
                remove_event_binding(model, "event_flow", "t_event_done", gate_row)
            comp = model.narrative_graphs["compositions"][0]
            zone_box = next(row for row in comp["elements"] if row.get("kind") == "zoneBlackbox")
            self.assertNotIn("scenario_event_flow__t_event_done", zone_box["meta"]["reads"])

    def test_zone_trigger_unbind_rolls_back_both_domains_when_second_dirty_mark_fails(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            apply_compilation_plan(model, build_event_plan(model, _spec(
                trigger_kind="zone_instant",
                dialogue_graph_id="",
                dialogue_copy_id="",
            )))
            model.save_all()
            trigger = next(
                row for row in scan_event_bindings(model, "event_flow", "t_event_done")
                if row.kind == "trigger" and row.entity_kind == "zone"
            )
            original_scenes = model.scenes
            original_narrative = model.narrative_graphs
            original_dirty = copy.deepcopy(model._dirty)
            real_mark_dirty = model.mark_dirty

            def fail_narrative(data_type: str, item_id: str = "") -> None:
                if data_type == "narrative_graphs":
                    raise RuntimeError("injected second-domain failure")
                real_mark_dirty(data_type, item_id)

            with patch.object(model, "mark_dirty", side_effect=fail_narrative):
                with self.assertRaisesRegex(RuntimeError, "second-domain failure"):
                    remove_event_binding(model, "event_flow", "t_event_done", trigger)

            self.assertIs(model.scenes, original_scenes)
            self.assertIs(model.narrative_graphs, original_narrative)
            self.assertEqual(model._dirty, original_dirty)
            zone = model.scenes["sc_a"]["zones"][0]
            self.assertTrue(any(
                row.get("type") == "emitNarrativeSignal"
                for row in zone.get("onEnter") or []
            ))

    def test_existing_signal_transition_with_runtime_extension_is_not_reused(self) -> None:
        for target in ("main", "complete"):
            with self.subTest(target=target), TemporaryDirectory() as td:
                model = _project(Path(td) / "p")
                apply_compilation_plan(model, build_event_plan(model, _spec()))
                comp = model.narrative_graphs["compositions"][0]
                if target == "main":
                    row = comp["mainGraph"]["transitions"][0]
                else:
                    scenario = next(
                        element["graph"] for element in comp["elements"]
                        if element.get("kind") == "scenarioSubgraph"
                    )
                    row = next(item for item in scenario["transitions"] if item["id"] == "complete")
                row["conditions"] = [{"flag": "blocks"}]
                with self.assertRaisesRegex(CompileError, "运行语义"):
                    build_event_plan(model, _spec(clone_dialogue=False, dialogue_copy_id=""))


if __name__ == "__main__":
    unittest.main()
