"""手写的「嵌套动作树遍历」必须下钻到每一个容器槽位（2026-09-14）。

唯一真相源是 `tools/editor/shared/action_structure.py::NESTED_ACTION_SLOTS`（它自己对运行时
ActionRegistry.ts 的护栏在 test_action_outline_editor.py::test_slot_registry_matches_runtime_containers）。
历史漏洞：以下遍历各写一份 if/elif，全都漏了 `runActionsIf` 的 actions / elseActions——
里面的未知动作、坏参数、伪造保留信号、悬垂 [tag:…] 引用、flag 读写边一律看不见：

- 叙事编辑器 Python 兜底校验 `narrative_state_editor._validate_action_def`
- 嵌入引用校验 `ref_validator.walk_action_defs_embedded_refs`
- 关系图解析 `graph_editor.parsers.json_parser._extract_flags_from_actions`
  （还漏 runActions / chooseAction / addDelayedEvent，且不读 runActionsIf.condition 的 flag）
- TS 权威 `src/core/narrativeGraphValidation.ts::validateActionDef`（语义测试在
  `narrativeGraphValidation.nestedActions.test.ts`；本文件锁它的槽位表 == 登记表）

用例按登记表逐槽参数化：登记表新增容器，三个遍历自动被要求跟上。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from tools.editor.shared.action_structure import NESTED_ACTION_SLOTS, ActionListSlot

REPO = Path(__file__).resolve().parents[3]

SLOT_CASES = [
    pytest.param(action_type, slot, id=f"{action_type}.{slot.key}")
    for action_type, slots in NESTED_ACTION_SLOTS.items()
    for slot in slots
]


def test_run_actions_if_branches_are_in_the_cases():
    ids = {(t, s.key) for t, slots in NESTED_ACTION_SLOTS.items() for s in slots}
    assert {("runActionsIf", "actions"), ("runActionsIf", "elseActions")} <= ids


def _wrap(action_type: str, slot: ActionListSlot, children: list) -> tuple[dict, str]:
    """造一条容器动作，把 children 放进指定槽位；返回 (动作, 子列表相对 params 的路径)。"""
    if slot.kind == "list":
        params: dict = {slot.key: children}
        rel = slot.key
    else:
        params = {slot.key: [{"text": "x", "ruleId": "r", slot.item_actions_key: children}]}
        rel = f"{slot.key}[0].{slot.item_actions_key}"
    if action_type == "runActionsIf":
        params["condition"] = {"flag": "k"}
    return {"type": action_type, "params": params}, rel


# ---------------------------------------------------------------- TS 槽位表对账


def _ts_validator_slots() -> dict[str, list[tuple[str, str]]]:
    text = (REPO / "src/core/narrativeGraphValidation.ts").read_text("utf-8")
    start = text.find("const NESTED_ACTION_LIST_SLOTS")
    assert start >= 0, "narrativeGraphValidation.ts 里找不到 NESTED_ACTION_LIST_SLOTS 槽位表"
    body = text[text.find("= {", start): text.find("\n};", start)]
    out: dict[str, list[tuple[str, str]]] = {}
    for m in re.finditer(r"^\s*(\w+):\s*\[(.*)\],\s*$", body, re.MULTILINE):
        out[m.group(1)] = [
            (sm.group(1), sm.group(3) or "")
            for sm in re.finditer(r"\{\s*key:\s*'(\w+)'(\s*,\s*itemActionsKey:\s*'(\w+)')?\s*\}", m.group(2))
        ]
    assert out, "槽位表解析为空：表的书写格式变了，同步改本解析"
    return out


def test_ts_narrative_validator_slots_match_registry():
    expected = {
        t: [(s.key, s.item_actions_key if s.kind == "items" else "") for s in slots]
        for t, slots in NESTED_ACTION_SLOTS.items()
    }
    assert _ts_validator_slots() == expected


# ---------------------------------------------------------------- 叙事 Python 兜底


def _bad_children() -> list:
    return [
        {"type": "__no_such_action__", "params": {}},
        {"type": "setFlag", "params": {"value": True}},
        {"type": "emitNarrativeSignal", "params": {"signal": "state:flow:done"}},
    ]


@pytest.mark.parametrize("action_type,slot", SLOT_CASES)
def test_narrative_fallback_validates_children_in_every_slot(action_type, slot):
    from tools.editor.editors.narrative_state_editor import _validate_actions

    act, rel = _wrap(action_type, slot, _bad_children())
    outer, outer_rel = _wrap("runActionsIf", NESTED_ACTION_SLOTS["runActionsIf"][1], [act])
    issues: list[dict] = []
    _validate_actions([outer], "acts", issues, "owner")
    base = f"acts[0].params.{outer_rel}[0].params.{rel}"
    got = {(i["code"], i["path"]) for i in issues}
    assert ("action.type.unknown", f"{base}[0].type") in got, issues
    assert ("action.param.missing", f"{base}[1].params.key") in got, issues
    assert ("action.signal.reserved", f"{base}[2].params.signal") in got, issues


def test_narrative_fallback_container_shape_codes():
    from tools.editor.editors.narrative_state_editor import _validate_actions

    issues: list[dict] = []
    _validate_actions([
        {"type": "runActionsIf", "params": {"condition": {"flag": "k"}, "elseActions": "nope"}},
        {"type": "chooseAction", "params": {"prompt": "p", "options": "nope"}},
        {"type": "enableRuleOffers", "params": {"slots": 7}},
    ], "acts", issues, "owner")
    by_path = {i["path"]: i["code"] for i in issues}
    assert by_path.get("acts[0].params.elseActions") == "actions.shape"
    assert by_path.get("acts[1].params.options") == "action.container.shape"
    assert by_path.get("acts[2].params.slots") == "action.container.shape"


# ---------------------------------------------------------------- 嵌入引用


@pytest.fixture(scope="module")
def ref_model(tmp_path_factory):
    from tools.editor.project_model import ProjectModel
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project

    root = tmp_path_factory.mktemp("refs") / "p"
    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    return model


@pytest.mark.parametrize("action_type,slot", SLOT_CASES)
def test_embedded_refs_scanned_in_every_slot(ref_model, action_type, slot):
    from tools.editor.shared.ref_validator import walk_action_defs_embedded_refs

    dangling = {
        "type": "playScriptedDialogue",
        "params": {"lines": [{"speaker": "", "text": "[tag:npc:__definitely_missing_npc__]"}]},
    }
    act, rel = _wrap(action_type, slot, [dangling])
    outer, outer_rel = _wrap("runActionsIf", NESTED_ACTION_SLOTS["runActionsIf"][0], [act])
    errs: list[str] = []
    walk_action_defs_embedded_refs([outer], "t", ref_model, errs)
    where = f"t[0].{outer_rel}[0].{rel}[0].lines[0].text"
    assert any(e.startswith(f"{where}:") and "invalid [tag:npc]" in e for e in errs), errs


# ---------------------------------------------------------------- 关系图 flag 边


def _flag_edges(actions: list) -> set[tuple[str, str, str]]:
    from tools.graph_editor.model.graph_model import GameGraph
    from tools.graph_editor.parsers.json_parser import _extract_flags_from_actions

    graph = GameGraph()
    _extract_flags_from_actions(graph, "owner", actions)
    return {(u, v, d["edge_type"].name) for u, v, d in graph.all_edges()}


@pytest.mark.parametrize("action_type,slot", SLOT_CASES)
def test_graph_parser_descends_into_every_slot(action_type, slot):
    act, _rel = _wrap(action_type, slot, [{"type": "setFlag", "params": {"key": "deep_flag", "value": True}}])
    outer, _ = _wrap("runActionsIf", NESTED_ACTION_SLOTS["runActionsIf"][1], [act])
    assert ("owner", "deep_flag", "WRITES_FLAG") in _flag_edges([outer])


def test_graph_parser_reads_run_actions_if_condition_flags():
    edges = _flag_edges([{
        "type": "runActionsIf",
        "params": {"condition": {"any": [{"flag": "a"}, {"all": [{"not": {"flag": "b", "value": False}}]}]}},
    }])
    assert ("a", "owner", "READS_FLAG") in edges
    assert ("b", "owner", "READS_FLAG") in edges
