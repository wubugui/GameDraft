"""对话图「备用入口」单一登记面：收集口径 + 两个消费方的语义 parity 门。

由来（2026-08-07）：`主线_藏钱` 被两个热区各从不同节点进入（雾津街头 → n_start、
码头白天 → n_2），运行时完全支持（`GraphDialogueManager` 认 `params.entry`，
`InteractionCoordinator` 把 inspect 热区的 `data.entry` 原样传下去），
可两处校验都把 n_2 报成「流程孤儿」：

- 图对话编辑器（`graph_document`）**一个备用入口都不看**，只拿图自己的 entry 当根；
- 主校验器（`validator`）看备用入口，但键名清单只有 `dialogueGraphId`/`dialogueGraphEntry`
  一套，收不到 inspect 热区实际用的 `data.graphId`/`data.entry`——文案却写着「含备用入口」，
  比没有更误导。

所以这里锁两件事：
1. 收集口径覆盖运行时全部 entry 来源（少一种就红）；
2. 两个消费方对同一份工程给出**同一个结论**——键名清单再分家就红。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.dialogue_graph_editor.graph_document import validate_graph_tiered
from tools.editor.shared.dialogue_entry_overrides import (
    collect_dialogue_graph_entry_overrides,
    graph_entry_roots,
)
from tools.editor.validator import _validate_dialogue_graphs


class _FakeModel:
    """只带 collector / dialogue 校验用得上的字段；缺字段的模型必须当空处理不抛。"""

    def __init__(self, **kw):
        self.scenes = kw.pop("scenes", {})
        self.character_registry = kw.pop("character_registry", {})
        self.quests = kw.pop("quests", [])
        self.cutscenes = kw.pop("cutscenes", [])
        self.narrative_graphs = kw.pop("narrative_graphs", {})
        self.scenarios_catalog = kw.pop("scenarios_catalog", {})
        for k, v in kw.items():
            setattr(self, k, v)


def _scene_with_hotspot(data: dict) -> dict:
    return {"hotspots": [{"id": "hs", "type": "inspect", "data": data}], "npcs": []}


class CollectEntryOverridesTests(unittest.TestCase):
    def test_inspect_hotspot_graph_mode_keys(self) -> None:
        """inspect 热区用的是 data.graphId + data.entry（运行时 InteractionCoordinator 就读这两个）。"""
        model = _FakeModel(scenes={"码头": _scene_with_hotspot({"graphId": "g", "entry": "n_2"})})
        self.assertEqual(collect_dialogue_graph_entry_overrides(model), {"g": {"n_2"}})

    def test_hotspot_dialogue_graph_keys(self) -> None:
        model = _FakeModel(
            scenes={"街": _scene_with_hotspot({"dialogueGraphId": "g", "dialogueGraphEntry": "n_9"})}
        )
        self.assertEqual(collect_dialogue_graph_entry_overrides(model), {"g": {"n_9"}})

    def test_npc_entry_inherited_from_character_registry(self) -> None:
        """角色级绑定不在摆放的就地字段上，只读原始键会漏收。"""
        model = _FakeModel(
            scenes={"街": {"npcs": [{"id": "npc_1", "characterId": "granny"}], "hotspots": []}},
            character_registry={"granny": {"dialogueGraphId": "g", "dialogueGraphEntry": "n_granny"}},
        )
        self.assertEqual(collect_dialogue_graph_entry_overrides(model)["g"], {"n_granny"})

    def test_start_dialogue_graph_action_entry(self) -> None:
        """动作面：任意容器任意深度的 startDialogueGraph 都可能带 entry。"""
        action = {"type": "startDialogueGraph", "params": {"graphId": "g", "entry": "n_act"}}
        model = _FakeModel(
            quests=[{"id": "q", "steps": [{"onComplete": [action]}]}],
            narrative_graphs={"graphs": [{"states": {"s": {"onEnterActions": [action]}}}]},
        )
        self.assertEqual(collect_dialogue_graph_entry_overrides(model), {"g": {"n_act"}})

    def test_missing_attributes_and_junk_shapes_are_tolerated(self) -> None:
        class _Bare:
            pass

        self.assertEqual(collect_dialogue_graph_entry_overrides(_Bare()), {})
        junk = _FakeModel(scenes={"街": {"npcs": ["not-a-dict"], "hotspots": [None]}})
        self.assertEqual(collect_dialogue_graph_entry_overrides(junk), {})

    def test_entry_without_graph_id_is_not_a_root(self) -> None:
        """光有 entry 没有 graphId 挂不到任何图上，收了只会污染别的图的根集合。"""
        model = _FakeModel(scenes={"街": _scene_with_hotspot({"entry": "n_2"})})
        self.assertEqual(collect_dialogue_graph_entry_overrides(model), {})

    def test_graph_handoffs_use_effective_staging_and_respect_deletion(self) -> None:
        def handoff(entry):
            return {"nodes": {"handoff": {"type": "action", "actions": [{
                "type": "startDialogueGraph", "params": {"graphId": "g", "entry": entry},
            }]}}}

        model = _FakeModel(
            pending_dialogue_graph_edits={"source": handoff("edited")},
            pending_dialogue_stubs={"new": handoff("new_entry")},
            all_dialogue_graph_ids=lambda: ["source", "deleted"],
            pending_dialogue_graph_deletes={"deleted"},
            dialogues_path=Path("unused"),
            _load=lambda path, default: handoff("on_disk"),
        )
        self.assertEqual(collect_dialogue_graph_entry_overrides(model), {"g": {"edited", "new_entry"}})
        model.pending_dialogue_graph_edits.clear()
        self.assertEqual(collect_dialogue_graph_entry_overrides(model), {"g": {"on_disk", "new_entry"}})


class GraphEntryRootsTests(unittest.TestCase):
    def test_only_existing_nodes_become_roots(self) -> None:
        nodes = {"n_start": {}, "n_2": {}}
        roots = graph_entry_roots(nodes, "n_start", ("g",), {"g": {"n_2", "n_deleted"}})
        self.assertEqual(roots, {"n_start", "n_2"})

    def test_alt_graph_keys_all_consulted(self) -> None:
        """引用方写的可能是文件名 stem、meta.id 或 id 字段，少查一个就漏一批入口。"""
        nodes = {"a": {}, "b": {}, "c": {}}
        roots = graph_entry_roots(nodes, "a", ("stem", "", "self_id"), {"stem": {"b"}, "self_id": {"c"}})
        self.assertEqual(roots, {"a", "b", "c"})


class OrphanVerdictParityTests(unittest.TestCase):
    """同一份工程，编辑器保存门与全量校验必须给出同一个结论。"""

    GRAPH = {
        "id": "g",
        "entry": "n_start",
        "nodes": {
            "n_start": {"type": "line", "text": "A", "next": "n_end"},
            "n_alt": {"type": "line", "text": "B", "next": "n_end"},
            "n_end": {"type": "end"},
        },
    }

    def _validator_orphans(self, model: _FakeModel, root: Path) -> list[str]:
        graphs = root / "dialogues" / "graphs"
        graphs.mkdir(parents=True, exist_ok=True)
        (graphs / "g.json").write_text(json.dumps(self.GRAPH, ensure_ascii=False), encoding="utf-8")
        model.dialogues_path = root / "dialogues"
        model.project_path = root
        issues: list = []
        _validate_dialogue_graphs(model, issues)
        return [i.message for i in issues if "流程孤儿" in i.message]

    def _editor_orphans(self, model: _FakeModel) -> list[str]:
        _errors, warnings = validate_graph_tiered(self.GRAPH, project_model=model)
        return [w for w in warnings if "流程孤儿" in w]

    def test_alternate_entry_is_not_an_orphan_on_either_side(self) -> None:
        model = _FakeModel(scenes={"码头": _scene_with_hotspot({"graphId": "g", "entry": "n_alt"})})
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self._validator_orphans(model, Path(tmp)), [])
        self.assertEqual(self._editor_orphans(model), [])

    def test_真孤儿两侧都照报(self) -> None:
        """去掉那个热区，n_alt 就是货真价实的孤儿——两侧都不许把它放过。"""
        model = _FakeModel(scenes={"码头": _scene_with_hotspot({"graphId": "别的图", "entry": "n_alt"})})
        with tempfile.TemporaryDirectory() as tmp:
            self.assertTrue(any("n_alt" in m for m in self._validator_orphans(model, Path(tmp))))
        self.assertTrue(any("n_alt" in w for w in self._editor_orphans(model)))

    def test_cross_graph_handoff_is_an_entry_on_both_sides(self) -> None:
        model = _FakeModel(pending_dialogue_stubs={"source": {
            "entry": "handoff", "nodes": {"handoff": {"type": "action", "actions": [{
                "type": "startDialogueGraph", "params": {"graphId": "g", "entry": "n_alt"},
            }]}},
        }})
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self._validator_orphans(model, Path(tmp)), [])
        self.assertEqual(self._editor_orphans(model), [])


if __name__ == "__main__":
    unittest.main()
