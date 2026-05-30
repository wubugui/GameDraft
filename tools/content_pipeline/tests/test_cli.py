"""Tests for the content pipeline compiler (tools/content_pipeline/cli.py).

Uses stdlib unittest to match the repo convention. Tests run the compiler in
validate mode (`emit=frozenset()`) so they never write artifacts to disk, and
assert on the in-memory build result / diagnostics.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.content_pipeline import cli  # noqa: E402

NO_EMIT = frozenset()


def codes(ctx: cli.BuildContext) -> list[str]:
    return [d.code for d in ctx.diagnostics]


def write_authoring(root: Path, *, dialogues=None, narrative=None, quests=None, tables=None) -> None:
    for sub in ("dialogues", "narrative", "quests", "tables"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    for name, text in (dialogues or {}).items():
        (root / "dialogues" / f"{name}.yaml").write_text(text, encoding="utf-8")
    for name, text in (narrative or {}).items():
        (root / "narrative" / f"{name}.yaml").write_text(text, encoding="utf-8")
    for name, text in (quests or {}).items():
        (root / "quests" / f"{name}.yaml").write_text(text, encoding="utf-8")
    for name, text in (tables or {}).items():
        (root / "tables" / f"{name}.csv").write_text(text, encoding="utf-8")


class SampleBuildTest(unittest.TestCase):
    """R6: golden build of the real shipped sample authoring set."""

    def test_build_sample_real_authoring(self):
        ctx, data = cli.build_all(emit=NO_EMIT)
        self.assertFalse([d for d in ctx.diagnostics if d.severity == "error"], codes(ctx))

        flag_keys = {f["key"] for f in data["flags"]["static"]}
        self.assertIn("case.bridge.heard_warning", flag_keys)

        quest = next(q for q in data["quests"] if q["id"] == "bridge_find_source")
        self.assertTrue(quest["acceptActions"])
        self.assertEqual(quest["acceptActions"][0]["type"], "showNotification")

        graph = next(comp["mainGraph"] for comp in data["narrative"]["compositions"] if comp["mainGraph"]["id"] == "npc.old_zhou")
        helpful = graph["states"]["helpful"]
        self.assertEqual(helpful["label"], "愿意帮忙")
        self.assertEqual(helpful["meta"]["editor"], {"x": 640, "y": 0})

        smap = ctx.source_map
        ref = "narrative:npc.old_zhou.state:helpful"
        self.assertIn(ref, smap["runtimeToSource"])
        sid = smap["runtimeToSource"][ref]
        self.assertEqual(
            smap["sources"][sid]["runtimePath"],
            f"narrative_graphs.compositions[{next(i for i, comp in enumerate(data['narrative']['compositions']) if comp['mainGraph']['id'] == 'npc.old_zhou')}].mainGraph.states.helpful",
        )

    def test_simulate_sample_dialogue_route(self):
        tsx = cli.ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
        if not tsx.exists():
            self.skipTest("tsx is not installed")
        cli.build_all()
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as f:
            json.dump({
                "flags": {},
                "quests": {},
                "scenarios": {},
                "scenarioLines": {},
                "narrative": {},
                "literals": {},
                "simulate": {
                    "type": "dialogueRoute",
                    "graphId": "sample_intro",
                    "choices": {"ask": "continue"},
                    "owner": {"type": "npc", "id": "old_zhou"},
                },
            }, f)
            case_path = f.name
        try:
            result = cli.run_simulate_runtime(case_path, echo=False)
        finally:
            Path(case_path).unlink(missing_ok=True)

        self.assertTrue(result["ok"], result.get("blocked"))
        self.assertEqual(result["finalState"]["flags"]["case.bridge.heard_warning"], True)
        self.assertEqual(result["finalState"]["narrative"]["npc.old_zhou"], "cautious")
        self.assertEqual(result["diff"]["quests"][0]["after"], "Active")
        self.assertIn("action_node", [step["nodeId"] for step in result["route"]])
        action_diffs = [
            event for event in result["events"]
            if event["type"] == "action" and event["phase"] == "diff"
        ]
        self.assertTrue(action_diffs)
        self.assertTrue(any(event["payload"]["diff"] for event in action_diffs))


class TempAuthoringTest(unittest.TestCase):
    """Tests that need a custom authoring tree; patches cli.AUTHORING."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.auth = Path(self._tmp.name) / "authoring"
        self.auth.mkdir(parents=True, exist_ok=True)
        self._orig_authoring = cli.AUTHORING
        self._orig_artifact = cli.ARTIFACT
        cli.AUTHORING = self.auth
        cli.ARTIFACT = Path(self._tmp.name) / "artifact" / "content_pipeline"
        preview = cli.ARTIFACT / "runtime_preview"
        (self.auth / "project.yaml").write_text(
            "\n".join([
                "publishRuntime: false",
                "previewOutputs:",
                f"  flagRegistry: {preview.as_posix()}/public/assets/data/flag_registry.json",
                f"  narrativeGraphs: {preview.as_posix()}/public/assets/data/narrative_graphs.json",
                f"  quests: {preview.as_posix()}/public/assets/data/quests.json",
                f"  dialogueGraphs: {preview.as_posix()}/public/assets/dialogues/graphs",
                "",
            ]),
            encoding="utf-8",
        )

    def tearDown(self):
        cli.AUTHORING = self._orig_authoring
        cli.ARTIFACT = self._orig_artifact
        self._tmp.cleanup()

    # --- R3: duplicate id diagnostics ---

    def test_duplicate_dialogue_id(self):
        write_authoring(self.auth, dialogues={
            "a": "id: dup\nentry: start\nnodes:\n  start:\n    type: end\n",
            "b": "id: dup\nentry: start\nnodes:\n  start:\n    type: end\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("dialogue.duplicate", codes(ctx))
        dup = [d for d in ctx.diagnostics if d.code == "dialogue.duplicate"]
        self.assertEqual(1, len(dup))
        self.assertTrue(dup[0].file.endswith("b.yaml"))
        self.assertIn("dup", dup[0].message)

    def test_duplicate_quest_id(self):
        write_authoring(self.auth, quests={
            "a": "id: dupq\npreconditions: []\ncompletionConditions: []\n",
            "b": "id: dupq\npreconditions: []\ncompletionConditions: []\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("quest.duplicate", codes(ctx))
        dup = [d for d in ctx.diagnostics if d.code == "quest.duplicate"]
        self.assertEqual(1, len(dup))
        self.assertTrue(dup[0].file.endswith("b.yaml"))
        self.assertIn("dupq", dup[0].message)

    def test_duplicate_narrative_id(self):
        g = "id: dupn\ninitialState: s\nstates:\n  s:\n    label: S\ntransitions: []\n"
        write_authoring(self.auth, narrative={"a": g, "b": g})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("narrative.duplicate", codes(ctx))
        dup = [d for d in ctx.diagnostics if d.code == "narrative.duplicate"]
        self.assertEqual(1, len(dup))
        self.assertTrue(dup[0].file.endswith("b.yaml"))
        self.assertIn("dupn", dup[0].message)

    def test_graph_id_and_display_name_are_separate(self):
        write_authoring(
            self.auth,
            dialogues={
                "dlg": (
                    "id: dlg_internal\n"
                    "kind: dialogueGraph\n"
                    "title: 显示用对话名\n"
                    "entry: start\n"
                    "nodes:\n"
                    "  start:\n"
                    "    type: end\n"
                ),
            },
            narrative={
                "flow": (
                    "id: flow_internal\n"
                    "title: 显示用流程名\n"
                    "initialState: start\n"
                    "states:\n"
                    "  start: {}\n"
                    "transitions: []\n"
                ),
            },
            quests={
                "quest": (
                    "id: quest_internal\n"
                    "name: 显示用任务名\n"
                    "preconditions: []\n"
                    "completionConditions: []\n"
                ),
            },
        )
        _, data = cli.build_all(emit=NO_EMIT)

        self.assertIn("dlg_internal", data["dialogues"])
        self.assertEqual("显示用对话名", data["dialogues"]["dlg_internal"]["meta"]["title"])

        graph = data["narrative"]["compositions"][0]["mainGraph"]
        self.assertEqual("flow_internal", graph["id"])
        self.assertEqual("显示用流程名", graph["label"])

        quest = data["quests"][0]
        self.assertEqual("quest_internal", quest["id"])
        self.assertEqual("显示用任务名", quest["title"])

    # --- R2: unknown node type (no silent downgrade) + passthrough ---

    def test_unknown_dialogue_node_type(self):
        write_authoring(self.auth, dialogues={
            "g": "id: g\nentry: n\nnodes:\n  n:\n    type: wormhole\n    payload: 42\n",
        })
        ctx, data = cli.build_all(emit=NO_EMIT)
        self.assertIn("dialogue.node.unknownType", codes(ctx))
        node = data["dialogues"]["g"]["nodes"]["n"]
        self.assertEqual(node["type"], "wormhole")
        self.assertEqual(node["payload"], 42)
        err = [d for d in ctx.diagnostics if d.severity == "error"]
        self.assertEqual(["dialogue.node.unknownType"], [d.code for d in err])

    # --- R2: ownerState + multi-line lines[] emitters ---

    def test_owner_state_passthrough(self):
        write_authoring(self.auth, dialogues={
            "g": (
                "id: g\nentry: root\nnodes:\n"
                "  root:\n"
                "    type: ownerState\n"
                "    wrapperGraphId: npc_x\n"
                "    cases:\n"
                "      - state: a\n        next: na\n"
                "    defaultNext: nd\n"
                "    missingWrapperNext: nm\n"
            ),
        })
        _, data = cli.build_all(emit=NO_EMIT)
        node = data["dialogues"]["g"]["nodes"]["root"]
        self.assertEqual(node["type"], "ownerState")
        self.assertEqual(node["wrapperGraphId"], "npc_x")
        self.assertEqual(node["defaultNext"], "nd")
        self.assertEqual(node["missingWrapperNext"], "nm")
        self.assertEqual(node["cases"][0]["state"], "a")

    def test_context_state_emitter(self):
        write_authoring(self.auth, dialogues={
            "g": (
                "id: g\nentry: root\nnodes:\n"
                "  root:\n"
                "    type: contextState\n"
                "    graphId: case.bridge\n"
                "    cases:\n"
                "      - state: source_found\n        next: hit\n"
                "    defaultNext: miss\n"
                "  hit:\n    type: end\n"
                "  miss:\n    type: end\n"
            ),
        })
        ctx, data = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("dialogue.node.unknownType", codes(ctx))
        node = data["dialogues"]["g"]["nodes"]["root"]
        self.assertEqual(node["type"], "contextState")
        self.assertEqual(node["graphId"], "case.bridge")
        self.assertEqual(node["cases"][0], {"state": "source_found", "next": "hit"})
        self.assertEqual(node["defaultNext"], "miss")
        self.assertIn("case.bridge.source_found", ctx.index["narrativeStates"])

    def test_dialogue_topology_missing_target_is_error(self):
        write_authoring(self.auth, dialogues={
            "g": "id: g\nentry: root\nnodes:\n  root:\n    type: line\n    text: hi\n    next: missing\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("dialogue.edge.targetMissing", codes(ctx))
        err = [d for d in ctx.diagnostics if d.severity == "error"]
        self.assertEqual(["dialogue.edge.targetMissing"], [d.code for d in err])
        self.assertIn("missing", err[0].message)
        self.assertTrue(err[0].file)

    def test_dialogue_topology_unreachable_and_dead_end_are_warnings(self):
        write_authoring(self.auth, dialogues={
            "g": (
                "id: g\nentry: root\nnodes:\n"
                "  root:\n    type: end\n"
                "  orphan:\n    type: line\n    text: alone\n    next: ''\n"
            ),
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("dialogue.node.unreachable", codes(ctx))
        self.assertIn("dialogue.node.deadEnd", codes(ctx))
        self.assertFalse([d for d in ctx.diagnostics if d.severity == "error"])

    def test_action_flag_value_type_validation(self):
        write_authoring(
            self.auth,
            tables={"flags": "key,type,owner,meaning,default,notes\nflag.bool,bool,test,Test,false,\n"},
            dialogues={
                "g": (
                    "id: g\nentry: root\nnodes:\n"
                    "  root:\n"
                    "    type: runActions\n"
                    "    actions:\n"
                    "      - type: setFlag\n"
                    "        params:\n"
                    "          key: flag.bool\n"
                    "          value: nope\n"
                    "    next: end\n"
                    "  end:\n    type: end\n"
                ),
            },
        )
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("action.flag.valueType", codes(ctx))
        err = [d for d in ctx.diagnostics if d.severity == "error"]
        self.assertEqual(["action.flag.valueType"], [d.code for d in err])
        self.assertIn("flag.bool", err[0].message)

    def test_condition_schema_validation(self):
        write_authoring(
            self.auth,
            narrative={
                "g": (
                    "id: g\ninitialState: a\nstates:\n  a: {}\n  b: {}\n"
                    "transitions:\n"
                    "  - id: bad\n    from: a\n    to: b\n    signal: go\n"
                    "    conditions:\n"
                    "      - flag: flag.bool\n        op: '>'\n        value: true\n"
                ),
            },
            tables={"flags": "key,type,owner,meaning,default,notes\nflag.bool,bool,test,Test,false,\n", "signals": "key,owner,meaning\ngo,test,Go\n"},
        )
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("condition.flag.op.type", codes(ctx))
        err = [d for d in ctx.diagnostics if d.severity == "error"]
        self.assertEqual(["condition.flag.op.type"], [d.code for d in err])

    def test_scene_reference_validation(self):
        write_authoring(self.auth, dialogues={
            "g": (
                "id: g\nentry: root\nnodes:\n"
                "  root:\n"
                "    type: runActions\n"
                "    actions:\n"
                "      - type: switchScene\n"
                "        params:\n"
                "          targetScene: definitely_missing_scene\n"
                "    next: end\n"
                "  end:\n    type: end\n"
            ),
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("scene.undeclared", codes(ctx))
        hits = [d for d in ctx.diagnostics if d.code == "scene.undeclared"]
        self.assertEqual(1, len(hits))
        self.assertEqual("warning", hits[0].severity)
        self.assertIn("definitely_missing_scene", hits[0].message)
        self.assertFalse([d for d in ctx.diagnostics if d.severity == "error"])

    def test_unknown_action_type_is_error(self):
        write_authoring(self.auth, dialogues={
            "g": (
                "id: g\nentry: root\nnodes:\n"
                "  root:\n"
                "    type: runActions\n"
                "    actions:\n"
                "      - type: definitelyUnknownAction\n"
                "        params: {}\n"
                "    next: end\n"
                "  end:\n    type: end\n"
            ),
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("action.type.unknown", codes(ctx))
        err = [d for d in ctx.diagnostics if d.severity == "error"]
        self.assertEqual(["action.type.unknown"], [d.code for d in err])
        self.assertIn("definitelyUnknownAction", err[0].message)

    def test_generic_action_param_type_validation(self):
        write_authoring(self.auth, dialogues={
            "g": (
                "id: g\nentry: root\nnodes:\n"
                "  root:\n"
                "    type: runActions\n"
                "    actions:\n"
                "      - type: waitMs\n"
                "        params:\n"
                "          durationMs: slow\n"
                "    next: end\n"
                "  end:\n    type: end\n"
            ),
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("action.param.type", codes(ctx))
        err = [d for d in ctx.diagnostics if d.severity == "error"]
        self.assertEqual(["action.param.type"], [d.code for d in err])
        self.assertIn("durationMs", err[0].message)

    def test_multiline_lines_emitter(self):
        write_authoring(self.auth, dialogues={
            "g": (
                "id: g\nentry: n\nnodes:\n"
                "  n:\n"
                "    type: line\n"
                "    next: end\n"
                "    lines:\n"
                "      - speaker: player\n        text: first\n"
                "      - speaker: npc\n        text: second\n"
                "  end:\n    type: end\n"
            ),
        })
        _, data = cli.build_all(emit=NO_EMIT)
        node = data["dialogues"]["g"]["nodes"]["n"]
        self.assertEqual([b["text"] for b in node["lines"]], ["first", "second"])
        self.assertEqual(node["lines"][0]["speaker"], {"kind": "player", "name": "player"})
        self.assertEqual(node["text"], "first")

    # --- negative counterparts (no false positives) ---

    def test_duplicate_dialogue_id_clean(self):
        write_authoring(self.auth, dialogues={"a": "id: unique_dlg\nentry: s\nnodes:\n  s:\n    type: end\n"})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("dialogue.duplicate", codes(ctx))

    def test_duplicate_quest_id_clean(self):
        write_authoring(self.auth, quests={"a": "id: unique_quest\npreconditions: []\ncompletionConditions: []\n"})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("quest.duplicate", codes(ctx))

    def test_duplicate_narrative_id_clean(self):
        write_authoring(self.auth, narrative={"a": "id: unique_narr\ninitialState: s\nstates:\n  s: {}\ntransitions: []\n"})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("narrative.duplicate", codes(ctx))

    def test_duplicate_dialogue_id_has_file_location(self):
        write_authoring(self.auth, dialogues={
            "a": "id: dup\nentry: s\nnodes:\n  s:\n    type: end\n",
            "b": "id: dup\nentry: s\nnodes:\n  s:\n    type: end\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        dup_diags = [d for d in ctx.diagnostics if d.code == "dialogue.duplicate"]
        self.assertTrue(dup_diags)
        self.assertTrue(dup_diags[0].file, "diagnostic must carry a file location")

    def test_dialogue_topology_clean_graph_no_false_positives(self):
        write_authoring(self.auth, dialogues={"g": (
            "id: g\nentry: root\nnodes:\n"
            "  root:\n    type: line\n    text: hi\n    next: end\n"
            "  end:\n    type: end\n"
        )})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("dialogue.edge.targetMissing", codes(ctx))
        self.assertNotIn("dialogue.node.unreachable", codes(ctx))
        self.assertNotIn("dialogue.node.deadEnd", codes(ctx))

    def test_action_flag_value_type_clean(self):
        write_authoring(
            self.auth,
            tables={"flags": "key,type,owner,meaning,default,notes\nflag.bool,bool,test,Test,false,\n"},
            dialogues={"g": (
                "id: g\nentry: root\nnodes:\n"
                "  root:\n    type: runActions\n    actions:\n"
                "      - type: setFlag\n        params:\n          key: flag.bool\n          value: true\n"
                "    next: end\n  end:\n    type: end\n"
            )},
        )
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("action.flag.valueType", codes(ctx))

    def test_unknown_action_type_clean(self):
        write_authoring(self.auth, dialogues={"g": (
            "id: g\nentry: root\nnodes:\n"
            "  root:\n    type: runActions\n    actions:\n"
            "      - type: setFlag\n        params:\n          key: x\n          value: true\n"
            "    next: end\n  end:\n    type: end\n"
        )})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("action.type.unknown", codes(ctx))

    def test_simulator_cascades_broadcast_on_enter_signal(self):
        tsx = cli.ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
        if not tsx.exists():
            self.skipTest("tsx is not installed")
        write_authoring(
            self.auth,
            tables={"signals": "key,owner,meaning\ngo,test,Go\n"},
            narrative={
                "a": (
                    "id: a\ninitialState: start\n"
                    "states:\n"
                    "  start: {}\n"
                    "  done:\n"
                    "    broadcastOnEnter: true\n"
                    "transitions:\n"
                    "  - id: finish\n"
                    "    from: start\n"
                    "    to: done\n"
                    "    signal: go\n"
                ),
                "b": (
                    "id: b\ninitialState: wait\n"
                    "states:\n"
                    "  wait: {}\n"
                    "  after: {}\n"
                    "transitions:\n"
                    "  - id: follow\n"
                    "    from: wait\n"
                    "    to: after\n"
                    "    signal: state:a:done\n"
                ),
            },
        )
        cli.build_all()
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as f:
            json.dump({
                "flags": {},
                "quests": {},
                "scenarios": {},
                "scenarioLines": {},
                "narrative": {},
                "literals": {},
                "simulate": {"type": "emitSignal", "signal": "go"},
            }, f)
            case_path = f.name
        try:
            result = cli.run_simulate_runtime(case_path, echo=False)
        finally:
            Path(case_path).unlink(missing_ok=True)

        self.assertTrue(result["ok"], result.get("blocked"))
        self.assertEqual(result["finalState"]["narrative"]["a"], "done")
        self.assertEqual(result["finalState"]["narrative"]["b"], "after")
        self.assertIn("state:a:done", [event["label"] for event in result["events"] if event["type"] == "signal"])


class PublishOwnershipTest(unittest.TestCase):
    """R1: publish path honours ownership; legacy_editor is never published."""

    def test_publish_respects_legacy_ownership(self):
        cfg = cli._default_config()  # all outputs owned by legacy_editor
        target, published = cli.resolve_output_target(cfg, "flagRegistry", publish=True)
        self.assertFalse(published)
        self.assertIn("runtime_preview", target.as_posix())

    def test_publish_writes_pipeline_owned(self):
        cfg = cli._default_config()
        cfg["ownership"]["public/assets/data/flag_registry.json"] = "pipeline"
        target, published = cli.resolve_output_target(cfg, "flagRegistry", publish=True)
        self.assertTrue(published)
        self.assertTrue(target.as_posix().endswith("public/assets/data/flag_registry.json"))
        self.assertNotIn("runtime_preview", target.as_posix())

    def test_no_publish_stays_preview(self):
        cfg = cli._default_config()
        cfg["ownership"]["public/assets/data/flag_registry.json"] = "pipeline"
        target, published = cli.resolve_output_target(cfg, "flagRegistry", publish=False)
        self.assertFalse(published)
        self.assertIn("runtime_preview", target.as_posix())

    def test_runtime_compatibility_detects_bad_transition_endpoint(self):
        issues = cli.runtime_compatibility_issues({
            "flags": {"static": []},
            "quests": [],
            "dialogues": {},
            "narrative": {
                "compositions": [
                    {
                        "mainGraph": {
                            "id": "flow",
                            "initialState": "a",
                            "states": {"a": {}, "b": {}},
                            "transitions": [
                                {"id": "bad", "from": "a", "to": "missing", "signal": "go"},
                            ],
                        },
                    },
                ],
            },
        })
        self.assertIn("runtime.narrative.transitionEndpointMissing", [issue["code"] for issue in issues])

    def test_runtime_compatibility_checks_embedded_wrapper_graphs(self):
        issues = cli.runtime_compatibility_issues({
            "flags": {"static": []},
            "quests": [],
            "dialogues": {},
            "narrative": {
                "schemaVersion": 3,
                "compositions": [
                    {
                        "mainGraph": {
                            "id": "flow",
                            "ownerType": "flow",
                            "ownerId": "flow",
                            "initialState": "a",
                            "states": {"a": {}},
                            "transitions": [],
                        },
                        "elements": [
                            {
                                "kind": "wrapperGraph",
                                "graph": {
                                    "id": "npc_wrapper",
                                    "ownerType": "npc",
                                    "ownerId": "npc",
                                    "initialState": "idle",
                                    "states": {"idle": {}},
                                    "transitions": [
                                        {"id": "bad", "from": "idle", "to": "missing", "signal": "go"},
                                    ],
                                },
                            },
                        ],
                    },
                ],
            },
        })
        self.assertIn("runtime.narrative.transitionEndpointMissing", [issue["code"] for issue in issues])


class ActionSchemaCoverageTest(unittest.TestCase):
    def test_action_schema_covers_runtime_and_editor_action_types(self):
        registry_text = (REPO_ROOT / "src/core/ActionRegistry.ts").read_text(encoding="utf-8")
        runtime_types = set(re.findall(r"executor\.register\('([^']+)'", registry_text))

        editor_text = (REPO_ROOT / "tools/editor/shared/action_editor.py").read_text(encoding="utf-8")
        action_types_match = re.search(r"ACTION_TYPES\s*=\s*\[(.*?)\]", editor_text, re.S)
        self.assertIsNotNone(action_types_match)
        editor_types = set(re.findall(r'"([^"]+)"', action_types_match.group(1)))

        schema_types = set(cli.ACTION_PARAM_TYPES)
        missing = sorted((runtime_types | editor_types) - schema_types)
        self.assertEqual([], missing)


class ContentIndexDepthTest(unittest.TestCase):
    """Plan 06: content index bucket coverage, duplicate-ID detection, cross-owner write risk."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.auth = Path(self._tmp.name) / "authoring"
        self.auth.mkdir(parents=True, exist_ok=True)
        self._orig_authoring = cli.AUTHORING
        cli.AUTHORING = self.auth

    def tearDown(self):
        cli.AUTHORING = self._orig_authoring
        self._tmp.cleanup()

    def _action_dialogue(self, action_block: str) -> str:
        return (
            "id: g\nentry: root\nnodes:\n"
            "  root:\n    type: runActions\n    actions:\n"
            f"{action_block}\n"
            "    next: end\n  end:\n    type: end\n"
        )

    # --- bucket indexing ---

    def test_items_bucket_indexed_via_giveItem(self):
        write_authoring(self.auth, dialogues={"g": self._action_dialogue(
            "      - type: giveItem\n        params:\n          id: magic_sword\n          count: 1"
        )})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("magic_sword", ctx.index.get("items", {}))

    def test_items_bucket_indexed_via_removeItem(self):
        write_authoring(self.auth, dialogues={"g": self._action_dialogue(
            "      - type: removeItem\n        params:\n          id: old_key"
        )})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("old_key", ctx.index.get("items", {}))

    def test_audio_bucket_indexed_via_playBgm(self):
        write_authoring(self.auth, dialogues={"g": self._action_dialogue(
            "      - type: playBgm\n        params:\n          id: dungeon_theme"
        )})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("dungeon_theme", ctx.index.get("audio", {}))

    def test_rules_bucket_indexed_via_giveRule(self):
        write_authoring(self.auth, dialogues={"g": self._action_dialogue(
            "      - type: giveRule\n        params:\n          id: fishing_rule"
        )})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("fishing_rule", ctx.index.get("rules", {}))

    def test_archive_bucket_indexed_via_addArchiveEntry(self):
        write_authoring(self.auth, dialogues={"g": self._action_dialogue(
            "      - type: addArchiveEntry\n        params:\n          bookType: lore\n          entryId: chapter_one"
        )})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("chapter_one", ctx.index.get("archive", {}))

    # --- duplicate runtime IDs ---

    def test_narrative_dialogue_id_collision(self):
        write_authoring(self.auth,
            narrative={"ng": "id: same\ninitialState: s\nstates:\n  s: {}\ntransitions: []\n"},
            dialogues={"dg": "id: same\nentry: n\nnodes:\n  n:\n    type: end\n"},
        )
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("runtime.id.collision", codes(ctx))
        coll = [d for d in ctx.diagnostics if d.code == "runtime.id.collision"]
        self.assertEqual(1, len(coll))
        self.assertIn("same", coll[0].message)

    def test_narrative_dialogue_id_no_collision_when_distinct(self):
        write_authoring(self.auth,
            narrative={"ng": "id: narr_foo\ninitialState: s\nstates:\n  s: {}\ntransitions: []\n"},
            dialogues={"dg": "id: dlg_bar\nentry: n\nnodes:\n  n:\n    type: end\n"},
        )
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("runtime.id.collision", codes(ctx))

    def test_flag_signal_collision(self):
        write_authoring(self.auth, tables={
            "flags":   "key,type,owner,meaning,default,notes\nshared_id,bool,test,Test,false,\n",
            "signals": "key,owner,meaning\nshared_id,test,Shared\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("runtime.id.flagSignalCollision", codes(ctx))
        coll = [d for d in ctx.diagnostics if d.code == "runtime.id.flagSignalCollision"]
        self.assertEqual(1, len(coll))
        self.assertIn("shared_id", coll[0].message)

    def test_flag_signal_no_collision_when_distinct(self):
        write_authoring(self.auth, tables={
            "flags":   "key,type,owner,meaning,default,notes\nflag_only,bool,test,Test,false,\n",
            "signals": "key,owner,meaning\nsignal_only,test,Signal\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("runtime.id.flagSignalCollision", codes(ctx))

    # --- cross-owner write risk ---

    def test_cross_owner_write_warns(self):
        # graph alpha (npc:alice) onEnterActions writes to beta (npc:bob) state t2
        write_authoring(self.auth, narrative={
            "alpha": (
                "id: alpha\nowner:\n  type: npc\n  id: alice\n"
                "initialState: s1\nstates:\n"
                "  s1: {}\n  s2:\n"
                "    onEnterActions:\n"
                "      - type: setNarrativeState\n"
                "        params:\n          graphId: beta\n          stateId: t2\n"
                "transitions: []\n"
            ),
            "beta": (
                "id: beta\nowner:\n  type: npc\n  id: bob\n"
                "initialState: t1\nstates:\n  t1: {}\n  t2: {}\ntransitions: []\n"
            ),
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("ownership.crossOwnerWrite", codes(ctx))
        xo = [d for d in ctx.diagnostics if d.code == "ownership.crossOwnerWrite"]
        self.assertEqual(1, len(xo))
        self.assertIn("beta", xo[0].message)
        self.assertTrue(xo[0].file)

    def test_cross_owner_write_same_owner_silent(self):
        # Both owned by npc:alice — no cross-owner warning
        write_authoring(self.auth, narrative={
            "alpha": (
                "id: alpha\nowner:\n  type: npc\n  id: alice\n"
                "initialState: s1\nstates:\n"
                "  s1: {}\n  s2:\n"
                "    onEnterActions:\n"
                "      - type: setNarrativeState\n"
                "        params:\n          graphId: beta\n          stateId: t2\n"
                "transitions: []\n"
            ),
            "beta": (
                "id: beta\nowner:\n  type: npc\n  id: alice\n"
                "initialState: t1\nstates:\n  t1: {}\n  t2: {}\ntransitions: []\n"
            ),
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("ownership.crossOwnerWrite", codes(ctx))


class RuntimeCompatibilityExtendedTest(unittest.TestCase):
    """Plan 07: runtime_compatibility_issues — flag valueType, quest type, narrative/dialogue
    schemaVersion, narrative ownerMissing."""

    def _base(self) -> dict:
        return {
            "flags": {"static": []},
            "quests": [],
            "dialogues": {},
            "narrative": {"schemaVersion": 3, "compositions": []},
        }

    def _codes(self, data: dict) -> list[str]:
        return [i["code"] for i in cli.runtime_compatibility_issues(data)]

    def _warn_codes(self, data: dict) -> list[str]:
        return [i["code"] for i in cli.runtime_compatibility_issues(data) if i.get("severity") == "warning"]

    # --- flag valueType ---

    def test_flag_unknown_valueType_flagged(self):
        data = self._base()
        data["flags"]["static"] = [{"key": "x", "valueType": "mystery_type"}]
        issues = cli.runtime_compatibility_issues(data)
        self.assertIn("runtime.flag.valueType", [i["code"] for i in issues])
        vt = [i for i in issues if i["code"] == "runtime.flag.valueType"]
        self.assertEqual(1, len(vt))
        self.assertEqual("flag:x", vt[0]["runtimeRef"])

    def test_flag_known_valuetypes_clean(self):
        data = self._base()
        data["flags"]["static"] = [
            {"key": "a", "valueType": "bool"},
            {"key": "b", "valueType": "float"},
            {"key": "c", "valueType": "string"},
            {"key": "d", "valueType": "int"},
        ]
        self.assertNotIn("runtime.flag.valueType", self._codes(data))

    def test_flag_missing_valueType_defaults_bool_clean(self):
        data = self._base()
        data["flags"]["static"] = [{"key": "x"}]  # absent → treated as "bool"
        self.assertNotIn("runtime.flag.valueType", self._codes(data))

    # --- quest type ---

    def test_quest_unknown_type_flagged(self):
        data = self._base()
        data["quests"] = [{"id": "q", "type": "epic_adventure"}]
        issues = cli.runtime_compatibility_issues(data)
        self.assertIn("runtime.quest.type", [i["code"] for i in issues])
        qt = [i for i in issues if i["code"] == "runtime.quest.type"]
        self.assertEqual(1, len(qt))
        self.assertEqual("quest:q", qt[0]["runtimeRef"])

    def test_quest_known_types_clean(self):
        data = self._base()
        data["quests"] = [
            {"id": "q1", "type": "main"},
            {"id": "q2", "type": "side"},
            {"id": "q3", "type": "optional"},
            {"id": "q4", "type": "hidden"},
        ]
        self.assertNotIn("runtime.quest.type", self._codes(data))

    def test_quest_empty_type_clean(self):
        data = self._base()
        data["quests"] = [{"id": "q"}]  # no type field → skip check
        self.assertNotIn("runtime.quest.type", self._codes(data))

    # --- narrative schemaVersion ---

    def test_narrative_wrong_schema_version_flagged(self):
        data = self._base()
        data["narrative"]["schemaVersion"] = 2
        self.assertIn("runtime.narrative.schemaVersion", self._codes(data))

    def test_narrative_correct_schema_version_clean(self):
        self.assertNotIn("runtime.narrative.schemaVersion", self._codes(self._base()))

    # --- narrative ownerMissing (warning severity) ---

    def test_narrative_owner_missing_warns(self):
        data = self._base()
        data["narrative"]["compositions"] = [{
            "mainGraph": {
                "id": "g", "initialState": "s", "states": {"s": {}}, "transitions": [],
            }
        }]
        issues = cli.runtime_compatibility_issues(data)
        om = [i for i in issues if i["code"] == "runtime.narrative.ownerMissing"]
        self.assertEqual(1, len(om))
        self.assertEqual("warning", om[0]["severity"])
        self.assertEqual("narrative:g", om[0]["runtimeRef"])

    def test_narrative_with_owner_no_warning(self):
        data = self._base()
        data["narrative"]["compositions"] = [{
            "mainGraph": {
                "id": "g", "ownerType": "npc", "ownerId": "bob",
                "initialState": "s", "states": {"s": {}}, "transitions": [],
            }
        }]
        self.assertNotIn("runtime.narrative.ownerMissing", self._warn_codes(data))

    # --- dialogue schemaVersion ---

    def test_dialogue_wrong_schema_version_flagged(self):
        data = self._base()
        data["dialogues"] = {"g": {"id": "g", "schemaVersion": 2, "entry": "n", "nodes": {"n": {"type": "end"}}}}
        issues = cli.runtime_compatibility_issues(data)
        self.assertIn("runtime.dialogue.schemaVersion", [i["code"] for i in issues])
        sv = [i for i in issues if i["code"] == "runtime.dialogue.schemaVersion"]
        self.assertEqual(1, len(sv))
        self.assertEqual("dialogue:g", sv[0]["runtimeRef"])

    def test_dialogue_correct_schema_version_clean(self):
        data = self._base()
        data["dialogues"] = {"g": {"id": "g", "schemaVersion": 1, "entry": "n", "nodes": {"n": {"type": "end"}}}}
        self.assertNotIn("runtime.dialogue.schemaVersion", self._codes(data))


class OwnershipStatusTest(unittest.TestCase):
    """Plan 07: ownership_status() and collect_generated_output_paths()."""

    def test_ownership_status_legacy(self):
        cfg = {"ownership": {"public/assets/data/flag_registry.json": "legacy_editor"}}
        s = cli.ownership_status("public/assets/data/flag_registry.json", cfg)
        self.assertTrue(s["legacyOwned"])
        self.assertFalse(s["pipelineOwned"])
        self.assertFalse(s["canPublish"])
        self.assertTrue(s["readonlySource"])

    def test_ownership_status_pipeline(self):
        cfg = {"ownership": {"public/assets/data/flag_registry.json": "pipeline"}}
        s = cli.ownership_status("public/assets/data/flag_registry.json", cfg)
        self.assertFalse(s["legacyOwned"])
        self.assertTrue(s["pipelineOwned"])
        self.assertTrue(s["canPublish"])
        self.assertFalse(s["readonlySource"])

    def test_ownership_status_unlisted_defaults_to_pipeline(self):
        cfg = {"ownership": {}}
        s = cli.ownership_status("public/assets/data/some_new_file.json", cfg)
        self.assertTrue(s["pipelineOwned"])
        self.assertFalse(s["legacyOwned"])

    def test_collect_generated_paths_excludes_legacy_runtime(self):
        cfg = cli._default_config()
        paths = cli.collect_generated_output_paths(cfg)
        # All three standard runtime outputs are legacy_editor → must NOT appear
        self.assertNotIn(cfg["runtimeOutputs"]["flagRegistry"], paths)
        self.assertNotIn(cfg["runtimeOutputs"]["narrativeGraphs"], paths)
        self.assertNotIn(cfg["runtimeOutputs"]["quests"], paths)

    def test_collect_generated_paths_includes_preview(self):
        cfg = cli._default_config()
        paths = cli.collect_generated_output_paths(cfg)
        self.assertIn(cfg["previewOutputs"]["flagRegistry"], paths)
        self.assertIn(cfg["previewOutputs"]["narrativeGraphs"], paths)


class ValidateMixedOwnershipTest(unittest.TestCase):
    """Plan 07: validate_mixed_ownership detects pipeline/legacy runtime ID collisions.

    Patches cli.ROOT, cli.AUTHORING, and cli.ARTIFACT to an isolated temp tree.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.auth = self.root / "authoring"
        for sub in (
            "authoring/dialogues", "authoring/narrative",
            "authoring/quests", "authoring/tables",
            "artifact/content_pipeline",
        ):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        self._orig_root = cli.ROOT
        self._orig_authoring = cli.AUTHORING
        self._orig_artifact = cli.ARTIFACT
        cli.ROOT = self.root
        cli.AUTHORING = self.auth
        cli.ARTIFACT = self.root / "artifact" / "content_pipeline"

    def tearDown(self):
        cli.ROOT = self._orig_root
        cli.AUTHORING = self._orig_authoring
        cli.ARTIFACT = self._orig_artifact
        self._tmp.cleanup()

    def _write_legacy_narrative(self, graph_id: str) -> None:
        path = self.root / "public" / "assets" / "data" / "narrative_graphs.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schemaVersion": 3,
            "compositions": [{
                "id": graph_id,
                "mainGraph": {"id": graph_id, "initialState": "s", "states": {"s": {}}, "transitions": []},
            }],
        }), encoding="utf-8")

    def _write_authoring_narrative(self, graph_id: str) -> None:
        (self.auth / "narrative" / f"{graph_id}.yaml").write_text(
            f"id: {graph_id}\ninitialState: s\nstates:\n  s: {{}}\ntransitions: []\n",
            encoding="utf-8",
        )

    def test_warns_when_authoring_id_collides_with_legacy_narrative(self):
        self._write_legacy_narrative("flow_conflict")
        self._write_authoring_narrative("flow_conflict")
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("ownership.legacyConflict", codes(ctx))

    def test_no_warn_when_legacy_file_absent(self):
        # No legacy file on disk → nothing to conflict with
        self._write_authoring_narrative("flow_new")
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("ownership.legacyConflict", codes(ctx))

    def test_no_warn_when_ids_are_distinct(self):
        self._write_legacy_narrative("flow_legacy")
        self._write_authoring_narrative("flow_pipeline")
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertNotIn("ownership.legacyConflict", codes(ctx))


if __name__ == "__main__":
    unittest.main()
