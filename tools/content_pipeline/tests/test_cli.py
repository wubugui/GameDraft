"""Tests for the content pipeline compiler (tools/content_pipeline/cli.py).

Uses stdlib unittest to match the repo convention. Tests run the compiler in
validate mode (`emit=frozenset()`) so they never write artifacts to disk, and
assert on the in-memory build result / diagnostics.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
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

        graph = data["narrative"]["compositions"][0]["mainGraph"]
        helpful = graph["states"]["helpful"]
        self.assertEqual(helpful["label"], "愿意帮忙")
        self.assertEqual(helpful["meta"]["editor"], {"x": 640, "y": 0})

        smap = ctx.source_map
        ref = "narrative:npc.old_zhou.state:helpful"
        self.assertIn(ref, smap["runtimeToSource"])
        sid = smap["runtimeToSource"][ref]
        self.assertEqual(
            smap["sources"][sid]["runtimePath"],
            "narrative_graphs.compositions[0].mainGraph.states.helpful",
        )


class TempAuthoringTest(unittest.TestCase):
    """Tests that need a custom authoring tree; patches cli.AUTHORING."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.auth = Path(self._tmp.name) / "authoring"
        self.auth.mkdir(parents=True, exist_ok=True)
        self._orig_authoring = cli.AUTHORING
        cli.AUTHORING = self.auth

    def tearDown(self):
        cli.AUTHORING = self._orig_authoring
        self._tmp.cleanup()

    # --- R3: duplicate id diagnostics ---

    def test_duplicate_dialogue_id(self):
        write_authoring(self.auth, dialogues={
            "a": "id: dup\nentry: start\nnodes:\n  start:\n    type: end\n",
            "b": "id: dup\nentry: start\nnodes:\n  start:\n    type: end\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("dialogue.duplicate", codes(ctx))

    def test_duplicate_quest_id(self):
        write_authoring(self.auth, quests={
            "a": "id: dupq\npreconditions: []\ncompletionConditions: []\n",
            "b": "id: dupq\npreconditions: []\ncompletionConditions: []\n",
        })
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("quest.duplicate", codes(ctx))

    def test_duplicate_narrative_id(self):
        g = "id: dupn\ninitialState: s\nstates:\n  s:\n    label: S\ntransitions: []\n"
        write_authoring(self.auth, narrative={"a": g, "b": g})
        ctx, _ = cli.build_all(emit=NO_EMIT)
        self.assertIn("narrative.duplicate", codes(ctx))

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


if __name__ == "__main__":
    unittest.main()
