"""Native-schema compiler used by the task orchestration GUI.

There is deliberately no TaskSpec, manifest, sidecar, ownership marker or
private metadata in this module.  A plan is an in-memory transaction only.  On
apply it replaces complete *ProjectModel in-memory domains* with deep-copied
versions and marks the already existing dirty buckets.  ProjectModel.save_all
is still the sole disk writer.

Existing objects are patched narrowly: conditions/actions/nodes are appended
or adjusted in place and unknown keys and list order are preserved.  This is
important because an existing task has no unambiguous "generated" subset once
a designer has continued editing it in the regular editors.
"""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal

from tools.dialogue_graph_editor.dialogue_topology import iter_output_slots
from tools.dialogue_graph_editor.graph_document import (
    nodes_reachable_from_entry,
    validate_graph_tiered,
)
from tools.editor.shared.dialogue_graph_refs import dialogue_graph_document


TriggerKind = Literal[
    "zone_dialogue",
    "zone_instant",
    "npc_dialogue",
    "hotspot_dialogue",
]
EntityKind = Literal["npc", "hotspot", "zone"]


class CompileError(ValueError):
    """The requested high-level edit cannot be represented safely."""


@dataclass(frozen=True)
class EventBindingSpec:
    """One explicit event binding authored by the GUI.

    All values are either newly-defined IDs or references selected from the
    live ProjectModel catalog.  ``dialogue_copy_id`` is required when cloning;
    it becomes an ordinary graph file in dialogues/graphs.
    """

    composition_id: str
    transition_id: str
    from_state: str
    to_state: str
    signal_id: str
    scenario_element_id: str
    scenario_graph_id: str
    prerequisite_graph_id: str
    prerequisite_state_id: str
    trigger_kind: TriggerKind
    scene_id: str
    trigger_entity_id: str = ""
    dialogue_graph_id: str = ""
    clone_dialogue: bool = True
    dialogue_copy_id: str = ""
    visible_entities: tuple[tuple[EntityKind, str], ...] = ()
    quest_id: str = ""
    new_quest: dict[str, Any] | None = None
    replace_existing_dialogue: bool = False


@dataclass
class CompilationPlan:
    """Detached native documents ready for one ProjectModel transaction."""

    narrative_graphs: dict[str, Any]
    scenes: dict[str, dict[str, Any]]
    quests: list[dict[str, Any]]
    dialogue_edits: dict[str, dict[str, Any]] = field(default_factory=dict)
    dialogue_stubs: dict[str, dict[str, Any]] = field(default_factory=dict)
    changed_scene_ids: set[str] = field(default_factory=set)
    narrative_changed: bool = False
    quests_changed: bool = False
    changes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(
            self.narrative_changed
            or self.changed_scene_ids
            or self.quests_changed
            or self.dialogue_edits
            or self.dialogue_stubs
        )


@dataclass(frozen=True)
class BindingRow:
    kind: str
    owner: str
    path: str
    detail: str
    scene_id: str = ""
    entity_kind: str = ""
    entity_id: str = ""
    list_index: int = -1


_NATIVE_ID_RE = re.compile(r"^[^:|\r\n]+$")


def _clean(value: object) -> str:
    return str(value or "").strip()


def pending_dialogue_stub_conflicts(model: Any) -> list[str]:
    """Return pending native dialogue files that appeared on disk meanwhile.

    ``ProjectModel.save_all`` deliberately never overwrites an existing graph
    with a pending stub. A newly-appeared target must therefore block the
    surrounding transaction before its narrative references can be saved.
    """
    project_path = getattr(model, "project_path", None)
    if project_path is None:
        return []
    from tools.editor.shared.narrative_templates import _dialogue_id_error

    graphs_dir = Path(model.dialogues_path) / "graphs"
    out: list[str] = []
    for graph_id in sorted(getattr(model, "pending_dialogue_stubs", {}) or {}):
        gid = _clean(graph_id)
        if not gid or _dialogue_id_error(gid):
            continue
        target = graphs_dir / f"{gid}.json"
        if target.exists():
            out.append(str(target.relative_to(project_path)))
    return out


def _require_native_id(value: object, label: str) -> str:
    result = _clean(value)
    if not result:
        raise CompileError(f"{label}不能为空")
    if not _NATIVE_ID_RE.fullmatch(result):
        raise CompileError(f"{label} {result!r} 不合法：不能含 ':'、'|' 或换行")
    return result


def _require_dialogue_id(value: object, label: str = "对话图 ID") -> str:
    result = _clean(value)
    if not result:
        raise CompileError(f"{label}不能为空")
    try:
        from tools.editor.shared.narrative_templates import _dialogue_id_error

        error = _dialogue_id_error(result)
    except Exception:
        error = "不能含 /、\\、.. 或以 . 开头" if (
            "/" in result or "\\" in result or ".." in result or result.startswith(".")
        ) else None
    if error:
        raise CompileError(str(error))
    return result


def iter_graphs(narrative: dict[str, Any]) -> Iterable[tuple[dict[str, Any], dict[str, Any], str]]:
    """Yield ``(composition, graph, element_id)`` for every native graph."""
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            yield comp, main, ""
        for element in comp.get("elements") or []:
            if isinstance(element, dict) and isinstance(element.get("graph"), dict):
                yield comp, element["graph"], _clean(element.get("id"))


def find_composition(narrative: dict[str, Any], composition_id: str) -> dict[str, Any] | None:
    cid = _clean(composition_id)
    for comp in narrative.get("compositions") or []:
        if isinstance(comp, dict) and _clean(comp.get("id")) == cid:
            return comp
    return None


def find_graph(narrative: dict[str, Any], graph_id: str) -> dict[str, Any] | None:
    gid = _clean(graph_id)
    for _comp, graph, _element_id in iter_graphs(narrative):
        if _clean(graph.get("id")) == gid:
            return graph
    return None


def create_flow(
    model: Any,
    *,
    composition_id: str,
    graph_id: str,
    label: str = "",
    description: str = "",
    initial_state_id: str = "initial",
    initial_state_label: str = "未开始",
) -> dict[str, Any]:
    """Create one ordinary native composition in memory.

    The function mutates only ``model.narrative_graphs`` and the existing
    ``narrative_graphs`` dirty bucket.  IDs are immutable in the GUI after this
    point; project-wide renames belong to the existing refactor engine.
    """
    cid = _require_native_id(composition_id, "任务流 ID")
    gid = _require_native_id(graph_id, "主图 ID")
    sid = _require_native_id(initial_state_id, "初始阶段 ID")
    narrative = copy.deepcopy(getattr(model, "narrative_graphs", None) or {})
    narrative.setdefault("schemaVersion", 3)
    narrative.setdefault("signals", [])
    comps = narrative.setdefault("compositions", [])
    if not isinstance(comps, list):
        raise CompileError("narrative_graphs.compositions 不是数组，不能安全追加")
    if find_composition(narrative, cid):
        raise CompileError(f"任务流 ID {cid!r} 已存在")
    if find_graph(narrative, gid):
        raise CompileError(f"叙事图 ID {gid!r} 已存在")
    state: dict[str, Any] = {
        "id": sid,
        "meta": {"editor": {"x": 120, "y": 160}},
    }
    if _clean(initial_state_label) and _clean(initial_state_label) != sid:
        state["label"] = _clean(initial_state_label)
    graph: dict[str, Any] = {
        "id": gid,
        "ownerType": "flow",
        "ownerId": cid,
        "initialState": sid,
        "states": {sid: state},
        "transitions": [],
    }
    if _clean(label) and _clean(label) != gid:
        graph["label"] = _clean(label)
    comp: dict[str, Any] = {"id": cid, "mainGraph": graph, "elements": []}
    if _clean(label) and _clean(label) != cid:
        comp["label"] = _clean(label)
    if _clean(description):
        comp["description"] = str(description).strip()
    comps.append(comp)
    commit_model_documents(
        model,
        {"narrative_graphs": narrative},
        (("narrative_graphs", ""),),
    )
    return comp


def create_state(
    model: Any,
    composition_id: str,
    *,
    state_id: str,
    label: str = "",
    description: str = "",
) -> dict[str, Any]:
    """Append a native state to a composition's main graph."""
    sid = _require_native_id(state_id, "阶段 ID")
    narrative = copy.deepcopy(getattr(model, "narrative_graphs", None) or {})
    comp = find_composition(narrative, composition_id)
    if comp is None:
        raise CompileError(f"任务流 {composition_id!r} 不存在")
    graph = comp.get("mainGraph")
    states = graph.get("states") if isinstance(graph, dict) else None
    if not isinstance(states, dict):
        raise CompileError("主图 states 不是对象，不能安全追加")
    if sid in states:
        raise CompileError(f"阶段 ID {sid!r} 已存在")
    count = len(states)
    state: dict[str, Any] = {
        "id": sid,
        "meta": {"editor": {"x": 120 + count * 260, "y": 160}},
    }
    if _clean(label) and _clean(label) != sid:
        state["label"] = _clean(label)
    if _clean(description):
        state["description"] = str(description).strip()
    states[sid] = state
    commit_model_documents(
        model,
        {"narrative_graphs": narrative},
        (("narrative_graphs", ""),),
    )
    return state


def update_flow_text(model: Any, composition_id: str, label: str, description: str) -> None:
    original = getattr(model, "narrative_graphs", None) or {}
    narrative = copy.deepcopy(original)
    comp = find_composition(narrative, composition_id)
    if comp is None:
        raise CompileError(f"任务流 {composition_id!r} 不存在")
    clean_label = _clean(label)
    if clean_label:
        comp["label"] = clean_label
    else:
        comp.pop("label", None)
    clean_desc = str(description or "").strip()
    if clean_desc:
        comp["description"] = clean_desc
    else:
        comp.pop("description", None)
    main = comp.get("mainGraph")
    if isinstance(main, dict):
        if clean_label:
            main["label"] = clean_label
        else:
            main.pop("label", None)
    if narrative != original:
        commit_model_documents(
            model,
            {"narrative_graphs": narrative},
            (("narrative_graphs", ""),),
        )


def update_state(
    model: Any,
    composition_id: str,
    state_id: str,
    *,
    label: str,
    description: str,
    initial: bool,
    exit_state: bool,
    broadcast_on_enter: bool,
    on_enter_actions: list[dict[str, Any]] | None = None,
    on_exit_actions: list[dict[str, Any]] | None = None,
) -> None:
    """Patch fields understood by the existing narrative editor."""
    original = getattr(model, "narrative_graphs", None) or {}
    narrative = copy.deepcopy(original)
    comp = find_composition(narrative, composition_id)
    graph = comp.get("mainGraph") if isinstance(comp, dict) else None
    states = graph.get("states") if isinstance(graph, dict) else None
    state = states.get(state_id) if isinstance(states, dict) else None
    if not isinstance(state, dict):
        raise CompileError(f"阶段 {state_id!r} 不存在")
    for key, value in (("label", label), ("description", description)):
        cleaned = str(value or "").strip()
        if cleaned:
            state[key] = cleaned
        else:
            state.pop(key, None)
    if broadcast_on_enter:
        state["broadcastOnEnter"] = True
    else:
        state.pop("broadcastOnEnter", None)
    if on_enter_actions is not None:
        if on_enter_actions:
            state["onEnterActions"] = copy.deepcopy(on_enter_actions)
        else:
            state.pop("onEnterActions", None)
    if on_exit_actions is not None:
        if on_exit_actions:
            state["onExitActions"] = copy.deepcopy(on_exit_actions)
        else:
            state.pop("onExitActions", None)
    if initial and state.get("onEnterActions"):
        raise CompileError(
            "初始阶段的 onEnterActions 在运行时载入时不会执行，旧叙事编辑器也会阻止保存。"
            "请把这些动作放到第一个事件到达的阶段。"
        )
    if initial:
        graph["initialState"] = state_id
    exits = graph.get("exitStates")
    exit_ids = [str(x) for x in exits] if isinstance(exits, list) else []
    if exit_state and state_id not in exit_ids:
        exit_ids.append(state_id)
    elif not exit_state:
        exit_ids = [x for x in exit_ids if x != state_id]
    if exit_ids:
        graph["exitStates"] = exit_ids
    else:
        graph.pop("exitStates", None)
    if narrative != original:
        commit_model_documents(
            model,
            {"narrative_graphs": narrative},
            (("narrative_graphs", ""),),
        )


def _native_condition(graph_id: str, state_id: str, *, reached: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"narrative": graph_id, "state": state_id}
    if reached:
        out["reached"] = True
    return out


def _contains_exact(items: Any, needle: dict[str, Any]) -> bool:
    return isinstance(items, list) and any(isinstance(row, dict) and row == needle for row in items)


def _append_exact(owner: dict[str, Any], key: str, value: dict[str, Any]) -> bool:
    rows = owner.get(key)
    if rows is None:
        owner[key] = [copy.deepcopy(value)]
        return True
    if not isinstance(rows, list):
        raise CompileError(f"{key} 不是数组，不能安全追加")
    if _contains_exact(rows, value):
        return False
    rows.append(copy.deepcopy(value))
    return True


def _find_scene_entity(scene: dict[str, Any], kind: EntityKind, entity_id: str) -> dict[str, Any]:
    key = {"npc": "npcs", "hotspot": "hotspots", "zone": "zones"}[kind]
    rows = scene.get(key)
    if not isinstance(rows, list):
        raise CompileError(f"场景 {key} 不是数组")
    matches = [row for row in rows if isinstance(row, dict) and _clean(row.get("id")) == entity_id]
    if len(matches) != 1:
        raise CompileError(f"{kind} {entity_id!r} 在场景中{'不存在' if not matches else '重复'}")
    return matches[0]


def _emit_action(signal_id: str, source_type: str, source_id: str) -> dict[str, Any]:
    params: dict[str, Any] = {"signal": signal_id}
    if source_type and source_id:
        params["sourceType"] = source_type
        params["sourceId"] = source_id
    return {"type": "emitNarrativeSignal", "params": params}


def _start_dialogue_action(graph_id: str, *, npc_id: str = "") -> dict[str, Any]:
    params: dict[str, Any] = {"graphId": graph_id}
    if npc_id:
        params["npcId"] = npc_id
    return {"type": "startDialogueGraph", "params": params}


def _action_key(action: Any) -> tuple[str, tuple[tuple[str, str], ...]]:
    if not isinstance(action, dict):
        return "", ()
    params = action.get("params") if isinstance(action.get("params"), dict) else {}
    return _clean(action.get("type")), tuple(sorted((str(k), repr(v)) for k, v in params.items()))


def _append_action(owner: dict[str, Any], key: str, action: dict[str, Any]) -> bool:
    rows = owner.get(key)
    if rows is None:
        owner[key] = [copy.deepcopy(action)]
        return True
    if not isinstance(rows, list):
        raise CompileError(f"{key} 不是数组，不能安全追加")
    wanted = _action_key(action)
    if any(_action_key(row) == wanted for row in rows):
        return False
    rows.append(copy.deepcopy(action))
    return True


def _walk_actions(node: Any) -> Iterable[dict[str, Any]]:
    if isinstance(node, dict):
        if isinstance(node.get("type"), str) and isinstance(node.get("params"), dict):
            yield node
        for value in node.values():
            yield from _walk_actions(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk_actions(value)


def _run_actions_directly_emits(node: Any, signal_id: str, source_id: str) -> bool:
    """Whether this node *unconditionally* emits before following ``next``.

    Recursive action walking is correct for collision discovery, but not for
    proving that an end is guarded: an emit nested in a conditional/random
    branch is not guaranteed to execute.  The transform only treats the exact
    top-level native ``runActions.actions`` shape it writes itself as a guard.
    """
    if not isinstance(node, dict) or _clean(node.get("type")) != "runActions":
        return False
    actions = node.get("actions")
    if not isinstance(actions, list) or len(actions) != 1:
        return False
    action = actions[0]
    return (
        isinstance(action, dict)
        and set(action) == {"type", "params"}
        and _clean(action.get("type")) == "emitNarrativeSignal"
        and action.get("params") == {
            "signal": signal_id,
            "sourceType": "dialogue",
            "sourceId": source_id,
        }
    )


def _reachable_nested_dialogues(graph: dict[str, Any]) -> list[tuple[str, str]]:
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        return []
    entry = _clean(graph.get("entry"))
    reachable = nodes_reachable_from_entry(nodes, entry)
    out: list[tuple[str, str]] = []
    for node_id in sorted(reachable):
        node = nodes.get(node_id)
        for action in _walk_actions(node):
            if _clean(action.get("type")) != "startDialogueGraph":
                continue
            target = _clean((action.get("params") or {}).get("graphId"))
            if target:
                out.append((node_id, target))
    return out


def ensure_signal_before_reachable_ends(
    graph: dict[str, Any],
    signal_id: str,
    *,
    source_id: str,
) -> tuple[dict[str, Any], list[str]]:
    """Return a graph where every reachable terminal emits exactly once.

    Each native ``end`` node is changed to ``runActions`` using the same ID and
    points to a new native ``end`` node.  Incoming edges and entry=end therefore
    remain valid.  A graph with reachable nested ``startDialogueGraph`` actions
    is rejected because the root end may occur before the deferred child graph
    actually completes.
    """
    out = copy.deepcopy(graph)
    nodes = out.get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        raise CompileError("对话图 nodes 为空或不是对象")
    entry = _clean(out.get("entry"))
    if entry not in nodes:
        raise CompileError(f"对话图 entry {entry!r} 不存在")
    nested = _reachable_nested_dialogues(out)
    if nested:
        sample = "、".join(f"{nid}→{gid}" for nid, gid in nested[:6])
        raise CompileError(
            "所选对话从入口可达的节点含 startDialogueGraph 链式对话，"
            f"无法保证根图 end 就是整段对话结束（{sample}）。请在实际末级对话显式发信号。"
        )
    reachable = nodes_reachable_from_entry(nodes, entry)
    end_ids = [
        node_id for node_id in nodes
        if node_id in reachable
        and isinstance(nodes.get(node_id), dict)
        and _clean(nodes[node_id].get("type")) == "end"
    ]
    if not end_ids:
        raise CompileError("所选对话从 entry 没有可达的 end 节点，不能编译“自然结束后推进”")

    incoming: dict[str, list[str]] = {end_id: [] for end_id in end_ids}
    for source_id_node in reachable:
        raw = nodes.get(source_id_node)
        if not isinstance(raw, dict):
            continue
        for slot in iter_output_slots(raw):
            if slot.target in incoming:
                incoming[slot.target].append(source_id_node)

    # Any occurrence reserves the signal.  Only the exact direct guard shape
    # below proves idempotency; nested conditional/random emits are not proof.
    existing_emit_nodes: list[str] = []
    for node_id in reachable:
        for action in _walk_actions(nodes.get(node_id)):
            if (
                _clean(action.get("type")) == "emitNarrativeSignal"
                and _clean((action.get("params") or {}).get("signal")) == signal_id
            ):
                existing_emit_nodes.append(node_id)
    exact_guard_nodes = {
        node_id
        for node_id in reachable
        if _run_actions_directly_emits(nodes.get(node_id), signal_id, source_id)
    }
    terminal_guard_nodes = {
        node_id
        for predecessors in incoming.values()
        for node_id in predecessors
        if node_id in exact_guard_nodes
    }
    if existing_emit_nodes and (
        len(existing_emit_nodes) != len(exact_guard_nodes)
        or set(existing_emit_nodes) != exact_guard_nodes
        or exact_guard_nodes != terminal_guard_nodes
    ):
        raise CompileError(
            f"对话可达路径中的信号 {signal_id!r} 不是工具生成的唯一、线性出口守卫；"
            "存在早发、重复、条件分支或来源不一致，不能保证 exactly-once。"
        )
    changes: list[str] = []
    for end_id in end_ids:
        predecessors = incoming.get(end_id, [])
        guarded = [
            node_id
            for node_id in predecessors
            if _run_actions_directly_emits(nodes.get(node_id), signal_id, source_id)
        ]
        if guarded and len(guarded) != len(predecessors):
            raise CompileError(
                f"对话出口 {end_id!r} 的部分入边已发信号、部分没有；为避免重复/漏发，"
                "请先在图对话编辑器统一该出口。"
            )
        if predecessors and len(guarded) == len(predecessors):
            continue
        if existing_emit_nodes:
            raise CompileError(
                f"对话可达路径中已存在信号 {signal_id!r}，但并非每个 end 都由它直接守卫；"
                "工具不能猜测分支语义，请先在图对话编辑器整理。"
            )
        suffix = f"{end_id}__after_{_safe_id_fragment(signal_id)}"
        terminal_id = _unique_id(suffix, nodes.keys())
        original_end = copy.deepcopy(nodes[end_id])
        nodes[end_id] = {
            "type": "runActions",
            "actions": [_emit_action(signal_id, "dialogue", source_id)],
            "next": terminal_id,
        }
        nodes[terminal_id] = original_end
        changes.append(f"对话 {source_id}: 出口 {end_id} 前插入 emitNarrativeSignal({signal_id})")
    return out, changes


def _safe_id_fragment(value: str) -> str:
    out = re.sub(r"[^0-9A-Za-z_一-鿿]+", "_", value).strip("_")
    return out[:48] or "signal"


def _unique_id(base: str, existing: Iterable[object]) -> str:
    used = {_clean(x) for x in existing}
    if base not in used:
        return base
    index = 2
    while f"{base}_{index}" in used:
        index += 1
    return f"{base}_{index}"


def _ensure_author_signal(narrative: dict[str, Any], signal_id: str) -> bool:
    if signal_id == "__draft__" or signal_id.startswith("state:"):
        raise CompileError("作者信号不能使用保留值 __draft__ 或 state: 前缀")
    signals = narrative.setdefault("signals", [])
    if not isinstance(signals, list):
        raise CompileError("narrative_graphs.signals 不是数组")
    for row in signals:
        if isinstance(row, dict) and _clean(row.get("id")) == signal_id:
            return False
    signals.append({"id": signal_id, "label": signal_id})
    return True


def _assert_exact_signal_transition(
    row: dict[str, Any],
    *,
    transition_id: str,
    from_state: str,
    to_state: str,
    signal_id: str,
) -> None:
    current = (_clean(row.get("from")), _clean(row.get("to")), _clean(row.get("signal")))
    wanted = (from_state, to_state, signal_id)
    if current != wanted:
        raise CompileError(
            f"既有迁移 {transition_id!r} 是 {current[0]}→{current[1]} / {current[2]!r}；"
            "工具不会把另一条原生迁移猜成当前事件。请新建迁移或先在旧状态机编辑器修改。"
        )
    unexpected = set(row) - {
        "id", "from", "to", "signal", "label", "description", "meta",
    }
    if unexpected:
        fields = "、".join(sorted(unexpected))
        raise CompileError(
            f"既有迁移 {transition_id!r} 还含会改变运行语义的字段（{fields}）。"
            "工具只会复用无条件、无优先级、无附加动作的标准信号迁移。"
        )


def _ensure_transition(
    graph: dict[str, Any],
    *,
    transition_id: str,
    from_state: str,
    to_state: str,
    signal_id: str,
) -> bool:
    states = graph.get("states")
    if not isinstance(states, dict):
        raise CompileError("主图 states 不是对象")
    if from_state not in states or to_state not in states:
        raise CompileError(f"迁移端点不存在：{from_state!r} → {to_state!r}")
    transitions = graph.setdefault("transitions", [])
    if not isinstance(transitions, list):
        raise CompileError("主图 transitions 不是数组")
    existing = [
        row for row in transitions
        if isinstance(row, dict) and _clean(row.get("id")) == transition_id
    ]
    if len(existing) > 1:
        raise CompileError(f"迁移 ID {transition_id!r} 重复")
    if existing:
        row = existing[0]
        _assert_exact_signal_transition(
            row,
            transition_id=transition_id,
            from_state=from_state,
            to_state=to_state,
            signal_id=signal_id,
        )
        return False
    transitions.append({
        "id": transition_id,
        "from": from_state,
        "to": to_state,
        "signal": signal_id,
    })
    return True


def _assert_exact_reactive_transition(
    row: dict[str, Any],
    wanted: dict[str, Any],
    *,
    graph_id: str,
) -> None:
    """Prove that a reactive transition still has the generated semantics."""
    semantic = {key: row.get(key) for key in wanted}
    unexpected = set(row) - {*wanted, "label", "description", "meta"}
    if semantic != wanted or unexpected:
        extra = f"；额外字段：{'、'.join(sorted(unexpected))}" if unexpected else ""
        raise CompileError(
            f"既有事件子图 {graph_id!r}.{wanted['id']} 的前置/失效语义已变化{extra}，"
            "工具不会覆盖旧编辑器里的编排。"
        )


def _ensure_scenario_event_graph(
    narrative: dict[str, Any],
    comp: dict[str, Any],
    *,
    element_id: str,
    graph_id: str,
    content_signal_id: str,
    prerequisite_graph_id: str,
    prerequisite_state_id: str,
    target_graph_id: str,
    target_from_state: str,
    label: str,
) -> tuple[dict[str, Any], bool]:
    """Create/verify the native scenario beat between content and main flow.

    This is the project signal spine in concrete form: the world/dialogue emits
    ``content_signal_id``; this scenario graph consumes it and enters its exit
    state; ``broadcastOnEnter`` then emits ``state:<graph>:done`` for the main
    milestone graph.  No tool-private ownership marker is involved.
    """
    elements = comp.setdefault("elements", [])
    if not isinstance(elements, list):
        raise CompileError("composition.elements 不是数组")

    same_graph: list[dict[str, Any]] = []
    same_element_id: list[dict[str, Any]] = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        if _clean(element.get("id")) == element_id:
            same_element_id.append(element)
        inner = element.get("graph")
        if isinstance(inner, dict) and _clean(inner.get("id")) == graph_id:
            same_graph.append(element)
    if len(same_graph) > 1 or len(same_element_id) > 1:
        raise CompileError("事件子图或元素 ID 在 composition 内重复，不能安全编排")
    if same_element_id and same_element_id[0] not in same_graph:
        raise CompileError(f"元素 ID {element_id!r} 已被其它原生元素占用")

    changed = False
    if same_graph:
        element = same_graph[0]
        if _clean(element.get("kind")) != "scenarioSubgraph":
            raise CompileError(f"叙事图 ID {graph_id!r} 已被非 scenarioSubgraph 元素占用")
        graph = element.get("graph")
        if not isinstance(graph, dict):  # defensive; same_graph already proved it
            raise CompileError("事件子图 graph 不是对象")
    else:
        # A graph id is global even across compositions.
        existing = find_graph(narrative, graph_id)
        if existing is not None:
            raise CompileError(f"叙事图 ID {graph_id!r} 已在其它位置存在")
        index = len(elements)
        graph = {
            "id": graph_id,
            "ownerType": "scenario",
            "ownerId": graph_id,
            "initialState": "locked",
            "entryState": "ready",
            "exitStates": ["done", "expired"],
            "states": {
                "locked": {
                    "id": "locked",
                    "label": "等待前置主线阶段",
                    "meta": {"editor": {"x": -200, "y": 120}},
                },
                "ready": {
                    "id": "ready",
                    "label": "可由玩家触发",
                    "meta": {"editor": {"x": 80, "y": 120}},
                },
                "done": {
                    "id": "done",
                    "label": "事件已完成",
                    "broadcastOnEnter": True,
                    "meta": {"editor": {"x": 360, "y": 120}},
                },
                "expired": {
                    "id": "expired",
                    "label": "主线阶段已错过",
                    "meta": {"editor": {"x": 360, "y": 300}},
                },
            },
            "transitions": [],
        }
        element = {
            "id": element_id,
            "kind": "scenarioSubgraph",
            "label": label or element_id,
            "ownerType": "scenario",
            "ownerId": graph_id,
            "refId": graph_id,
            "x": 24 + (index % 6) * 250,
            "y": 140 + (index // 6) * 180,
            "graph": graph,
            "meta": {"emits": [], "reads": [], "commands": []},
        }
        elements.append(element)
        changed = True

    required_scalars = {
        "ownerType": "scenario",
        "initialState": "locked",
        "entryState": "ready",
    }
    for key, wanted in required_scalars.items():
        current = _clean(graph.get(key))
        if current != wanted:
            raise CompileError(
                f"既有事件子图 {graph_id!r} 的 {key}={current!r}，"
                f"而顶层编排需要 {wanted!r}；工具不会覆盖旧编辑器里的语义。"
            )
    states = graph.get("states")
    required_states = {"locked", "ready", "done", "expired"}
    if not isinstance(states, dict) or any(not isinstance(states.get(sid), dict) for sid in required_states):
        raise CompileError(f"既有事件子图 {graph_id!r} 缺少 locked/ready/done/expired 原生阶段")
    exits = graph.get("exitStates")
    if not isinstance(exits, list) or not {"done", "expired"}.issubset({_clean(value) for value in exits}):
        raise CompileError(f"既有事件子图 {graph_id!r} 没有把 done/expired 声明为 exitState")
    if states["done"].get("broadcastOnEnter") is not True:
        raise CompileError(f"既有事件子图 {graph_id!r}.done 没有开启 broadcastOnEnter")

    transitions = graph.setdefault("transitions", [])
    if not isinstance(transitions, list):
        raise CompileError("事件子图 transitions 不是数组")
    unlock_conditions = [_native_condition(prerequisite_graph_id, prerequisite_state_id)]
    target_condition = _native_condition(target_graph_id, target_from_state)
    if target_condition not in unlock_conditions:
        unlock_conditions.append(target_condition)
    expire_conditions = [{"not": copy.deepcopy(condition)} for condition in unlock_conditions]
    reactive_specs = (
        ("unlock", "locked", "ready", "reactiveAll", unlock_conditions),
        ("expire", "ready", "expired", "reactiveAny", expire_conditions),
    )
    for transition_id, from_state, to_state, trigger, conditions in reactive_specs:
        matches = [
            row for row in transitions
            if isinstance(row, dict) and _clean(row.get("id")) == transition_id
        ]
        if len(matches) > 1:
            raise CompileError(f"事件子图迁移 {transition_id!r} 重复")
        wanted = {
            "id": transition_id,
            "from": from_state,
            "to": to_state,
            "trigger": trigger,
            "conditions": conditions,
            "signal": "__draft__",
        }
        if matches:
            _assert_exact_reactive_transition(matches[0], wanted, graph_id=graph_id)
        else:
            transitions.append(wanted)
            changed = True

    if _ensure_transition(
        graph,
        transition_id="complete",
        from_state="ready",
        to_state="done",
        signal_id=content_signal_id,
    ):
        changed = True
    return graph, changed


def _ensure_blackbox(
    comp: dict[str, Any],
    *,
    kind: str,
    ref_id: str,
    label: str,
    graph_id: str,
    emitted_signal: str = "",
) -> bool:
    """Patch/create an ordinary projection blackbox understood by old editor."""
    elements = comp.setdefault("elements", [])
    if not isinstance(elements, list):
        raise CompileError("composition.elements 不是数组")
    matches = [
        element for element in elements
        if isinstance(element, dict)
        and _clean(element.get("kind")) == kind
        and _clean(element.get("refId")) == ref_id
    ]
    if len(matches) > 1:
        raise CompileError(f"编排里 {kind}:{ref_id} 有多个黑盒，无法选择应更新哪一个")
    changed = False
    if matches:
        element = matches[0]
    else:
        existing_ids = [_clean(row.get("id")) for row in elements if isinstance(row, dict)]
        base = "dialogue" if kind == "dialogueBlackbox" else "zone"
        index = len(elements)
        element = {
            "id": _unique_id(f"{base}_{_safe_id_fragment(ref_id)}", existing_ids),
            "kind": kind,
            "label": label,
            "refId": ref_id,
            "x": 24 + (index % 6) * 250,
            "y": -140 - (index // 6) * 100,
            "meta": {"emits": [], "reads": [], "commands": []},
        }
        elements.append(element)
        changed = True
    meta = element.get("meta")
    if not isinstance(meta, dict):
        raise CompileError(f"黑盒 {ref_id!r} 的 meta 不是对象")
    for key in ("emits", "reads", "commands"):
        if key not in meta:
            meta[key] = []
            changed = True
        elif not isinstance(meta[key], list):
            raise CompileError(f"黑盒 {ref_id!r} 的 meta.{key} 不是数组")
    if graph_id and graph_id not in meta["reads"]:
        meta["reads"].append(graph_id)
        changed = True
    if emitted_signal and emitted_signal not in meta["emits"]:
        meta["emits"].append(emitted_signal)
        changed = True
    return changed


def _ensure_visibility_gate(
    entity: dict[str, Any],
    kind: EntityKind,
    gate: dict[str, Any],
    *,
    owner: str,
) -> bool:
    """Append a native visibility gate without changing legacy condition semantics.

    NPC/Hotspot conditions only hide the entity when ``conditionHidesEntity``
    is true.  Turning that flag on when legacy conditions already exist would
    silently reinterpret those old conditions, and there is no ownership data
    with which to restore it later.  Such entities must therefore opt in from
    the regular SceneEditor before this compiler may append a task gate.
    """
    conditions = entity.get("conditions")
    if conditions is not None and not isinstance(conditions, list):
        raise CompileError(f"{owner}.conditions 不是数组，不能安全追加")
    if kind in {"npc", "hotspot"}:
        hides = entity.get("conditionHidesEntity")
        if conditions and hides is not True:
            raise CompileError(
                f"{owner} 已有 {len(conditions)} 条旧 conditions，但 conditionHidesEntity 未开启。"
                "顶层工具若代为开启，会永久改变旧条件的含义；请先在“场景实体布置”页明确开启"
                "“条件失败时隐藏”，再回来编排。"
            )
        if hides is False:
            raise CompileError(
                f"{owner}.conditionHidesEntity 被明确关闭；请先在“场景实体布置”页确认并开启后再编排。"
            )
    changed = _append_exact(entity, "conditions", gate)
    if kind in {"npc", "hotspot"} and entity.get("conditionHidesEntity") is not True:
        entity["conditionHidesEntity"] = True
        changed = True
    return changed


def _validate_plan_narrative(plan: CompilationPlan, model: Any) -> None:
    from tools.editor.editors.narrative_state_editor import (
        _normalize_file,
        _validation_errors_for_save,
    )

    normalized = _normalize_file(plan.narrative_graphs)
    errors = _validation_errors_for_save(normalized, model)
    if errors:
        preview = "；".join(str(row.get("message") or row.get("code")) for row in errors[:6])
        raise CompileError(f"编译后的叙事状态机未通过旧编辑器保存校验：{preview}")
    plan.narrative_graphs = normalized


def build_event_plan(model: Any, spec: EventBindingSpec) -> CompilationPlan:
    """Compile one explicit binding into detached native-schema documents."""
    cid = _require_native_id(spec.composition_id, "任务流 ID")
    transition_id = _require_native_id(spec.transition_id, "事件/迁移 ID")
    from_state = _require_native_id(spec.from_state, "发生前阶段")
    to_state = _require_native_id(spec.to_state, "发生后阶段")
    signal_id = _require_native_id(spec.signal_id, "内容完成信号 ID")
    scenario_element_id = _require_native_id(spec.scenario_element_id, "事件子图元素 ID")
    scenario_graph_id = _require_native_id(spec.scenario_graph_id, "事件子图 ID")
    prerequisite_graph_id = _require_native_id(spec.prerequisite_graph_id, "前置叙事图 ID")
    prerequisite_state_id = _require_native_id(spec.prerequisite_state_id, "前置叙事阶段 ID")
    scene_id = _clean(spec.scene_id)
    if not scene_id:
        raise CompileError("必须从现有场景中选择一个场景")

    narrative = copy.deepcopy(getattr(model, "narrative_graphs", None) or {})
    scenes = copy.deepcopy(getattr(model, "scenes", None) or {})
    quests = copy.deepcopy(getattr(model, "quests", None) or [])
    plan = CompilationPlan(narrative, scenes, quests)
    comp = find_composition(narrative, cid)
    if comp is None:
        raise CompileError(f"任务流 {cid!r} 不存在")
    main_graph = comp.get("mainGraph")
    if not isinstance(main_graph, dict):
        raise CompileError("任务流缺少 mainGraph")
    main_graph_id = _clean(main_graph.get("id"))
    if prerequisite_graph_id == scenario_graph_id:
        raise CompileError(
            "事件 scenario 子图不能把自己设为解锁前置；locked 状态会依赖本图尚未到达的状态，"
            "形成自锁或重入。请改选主线图或另一个独立任务流。"
        )
    if prerequisite_graph_id == main_graph_id and prerequisite_state_id != from_state:
        raise CompileError(
            f"同一主图 {main_graph_id!r} 不可能同时处于前置阶段 {prerequisite_state_id!r} "
            f"和事件发生前阶段 {from_state!r}，事件将永远锁定。"
            "同一主图前置必须等于“发生前阶段”；若要表达历史到达，请使用独立任务流或现有 reached 条件。"
        )
    prerequisite_graph = find_graph(narrative, prerequisite_graph_id)
    prerequisite_states = prerequisite_graph.get("states") if isinstance(prerequisite_graph, dict) else None
    if not isinstance(prerequisite_states, dict) or prerequisite_state_id not in prerequisite_states:
        raise CompileError(
            f"前置阶段 {prerequisite_graph_id}.{prerequisite_state_id} 不存在；"
            "必须从现有叙事图与阶段中选择。"
        )
    scene = scenes.get(scene_id)
    if not isinstance(scene, dict):
        raise CompileError(f"场景 {scene_id!r} 不存在")

    existing_scenario_graph = find_graph(narrative, scenario_graph_id)
    existing_content_listener = False
    if isinstance(existing_scenario_graph, dict):
        existing_content_listener = any(
            isinstance(row, dict)
            and _clean(row.get("id")) == "complete"
            and _clean(row.get("from")) == "ready"
            and _clean(row.get("to")) == "done"
            and _clean(row.get("signal")) == signal_id
            for row in existing_scenario_graph.get("transitions") or []
        )
    registered_signal_ids = {
        _clean(row.get("id"))
        for row in narrative.get("signals") or []
        if isinstance(row, dict) and _clean(row.get("id"))
    }
    emitted_signal_ids: set[str] = set()
    if not existing_content_listener:
        try:
            from tools.editor.shared.narrative_catalog import emitted_signal_ids as collect_emitted

            emitted_signal_ids = set(collect_emitted(model))
        except Exception as error:
            raise CompileError(f"无法确认完成信号是否与现有发射源撞名：{error}") from error
    if not existing_content_listener and signal_id in (registered_signal_ids | emitted_signal_ids):
        where = "作者信号表或实际发射源"
        raise CompileError(
            f"新事件的信号 {signal_id!r} 已在{where}中存在。"
            "为避免两个任务串线，请为新事件定义独立信号 ID。"
        )
    if _ensure_author_signal(narrative, signal_id):
        plan.changes.append(f"narrative_graphs.signals: 新增作者信号 {signal_id}")
        plan.narrative_changed = True

    _scenario_graph, scenario_changed = _ensure_scenario_event_graph(
        narrative,
        comp,
        element_id=scenario_element_id,
        graph_id=scenario_graph_id,
        content_signal_id=signal_id,
        prerequisite_graph_id=prerequisite_graph_id,
        prerequisite_state_id=prerequisite_state_id,
        target_graph_id=main_graph_id,
        target_from_state=from_state,
        label=f"{transition_id} · 事件拍子",
    )
    if scenario_changed:
        plan.changes.append(
            f"narrative_graphs.elements: 新增/接好事件子图 {scenario_graph_id} "
            f"（{prerequisite_graph_id}.{prerequisite_state_id} 解锁 → ready → done/expired）"
        )
        plan.narrative_changed = True

    derived_signal = f"state:{scenario_graph_id}:done"
    if _ensure_transition(
        main_graph,
        transition_id=transition_id,
        from_state=from_state,
        to_state=to_state,
        signal_id=derived_signal,
    ):
        plan.changes.append(
            f"{main_graph_id}.transitions: 新增 {transition_id}（{from_state} → {to_state}），"
            f"只监听子图末态广播 {derived_signal}"
        )
        plan.narrative_changed = True

    # Scene availability reads the event scenario's ready state.  The scenario
    # itself reacts to an arbitrary external prerequisite graph/state and moves
    # to expired if that prerequisite ceases to be current before completion.
    # This gives independent task flows a real mainline gate without private
    # metadata or a one-shot global flag.
    gate = _native_condition(scenario_graph_id, "ready")
    trigger_kind = spec.trigger_kind
    trigger_entity_id = _clean(spec.trigger_entity_id)
    dialogue_id = ""
    dialogue_nodes: set[str] = set()
    dialogue_source_id = _clean(spec.dialogue_graph_id)
    needs_dialogue = trigger_kind in {"zone_dialogue", "npc_dialogue", "hotspot_dialogue"}
    if needs_dialogue:
        dialogue_source_id = _require_dialogue_id(dialogue_source_id)
        source_doc = dialogue_graph_document(model, dialogue_source_id)
        if not isinstance(source_doc, dict):
            raise CompileError(f"对话图 {dialogue_source_id!r} 不存在或无法读取")
        if spec.clone_dialogue:
            dialogue_id = _require_dialogue_id(spec.dialogue_copy_id, "任务专用对话副本 ID")
            if dialogue_id in set(getattr(model, "all_dialogue_graph_ids")()):
                raise CompileError(f"任务专用对话副本 ID {dialogue_id!r} 已存在")
            working = copy.deepcopy(source_doc)
            working["id"] = dialogue_id
            patched, dialogue_changes = ensure_signal_before_reachable_ends(
                working,
                signal_id,
                source_id=dialogue_id,
            )
            plan.dialogue_stubs[dialogue_id] = patched
            plan.changes.append(f"dialogues/graphs/{dialogue_id}.json: 从 {dialogue_source_id} 创建安全副本")
        else:
            dialogue_id = dialogue_source_id
            patched, dialogue_changes = ensure_signal_before_reachable_ends(
                source_doc,
                signal_id,
                source_id=dialogue_id,
            )
            if patched != source_doc:
                raise CompileError(
                    "新事件不能原地修改共享对话。请启用“任务专用安全副本”；"
                    "只有这张图本来就已在所有自然出口发出同一信号时，才允许复用。"
                )
        plan.changes.extend(dialogue_changes)
        errors, warnings = validate_graph_tiered(
            patched,
            project_root=getattr(model, "project_path", None),
            project_model=model,
        )
        if errors:
            raise CompileError(
                f"编译后的对话图 {dialogue_id!r} 未通过旧图对话编辑器校验："
                + "；".join(errors[:8])
            )
        plan.warnings.extend(f"对话图 {dialogue_id}: {warning}" for warning in warnings)
        dialogue_nodes = {
            _clean(node_id)
            for node_id in (patched.get("nodes") or {})
            if _clean(node_id)
        } if isinstance(patched.get("nodes"), dict) else set()

    if trigger_kind in {"zone_dialogue", "zone_instant"}:
        if not trigger_entity_id:
            raise CompileError("必须选择现有 Zone")
        zone = _find_scene_entity(scene, "zone", trigger_entity_id)
        if _ensure_visibility_gate(
            zone, "zone", gate, owner=f"Zone {scene_id}:{trigger_entity_id}",
        ):
            plan.changes.append(f"scenes/{scene_id}.json zones[{trigger_entity_id}].conditions: 仅在 {from_state} 生效")
        if trigger_kind == "zone_instant":
            action = _emit_action(signal_id, "zone", f"{scene_id}:{trigger_entity_id}")
            if _append_action(zone, "onEnter", action):
                plan.changes.append(f"zones[{trigger_entity_id}].onEnter: 进入后直接发 {signal_id}")
        else:
            action = _start_dialogue_action(dialogue_id)
            on_enter = zone.get("onEnter")
            if on_enter is not None and not isinstance(on_enter, list):
                raise CompileError(f"Zone {scene_id}:{trigger_entity_id}.onEnter 不是数组")
            all_starts = [
                row for row in _walk_actions(on_enter or [])
                if _clean(row.get("type")) == "startDialogueGraph"
            ]
            exact = [row for row in all_starts if _action_key(row) == _action_key(action)]
            if all_starts and not exact:
                top_level_starts = [
                    row for row in (on_enter or [])
                    if isinstance(row, dict) and _clean(row.get("type")) == "startDialogueGraph"
                ]
                if not spec.replace_existing_dialogue:
                    current = "、".join(
                        _clean((row.get("params") or {}).get("graphId")) or "<空>"
                        for row in all_starts
                    )
                    raise CompileError(
                        f"Zone {scene_id}:{trigger_entity_id} 已启动其它对话（{current}）。"
                        "追加第二个 startDialogueGraph 在运行时可能被忽略；"
                        "请勾选明确替换，或先在场景实体布置页整理。"
                    )
                if len(all_starts) != 1 or len(top_level_starts) != 1:
                    raise CompileError("Zone 有多个或嵌套的 startDialogueGraph，不能安全自动替换")
                params = top_level_starts[0].get("params")
                if not isinstance(params, dict):
                    raise CompileError("Zone 既有 startDialogueGraph.params 不是对象")
                old_graph_id = _clean(params.get("graphId"))
                old_entry = _clean(params.get("entry"))
                params["graphId"] = dialogue_id
                if old_entry and old_graph_id != dialogue_source_id:
                    params.pop("entry", None)
                elif old_entry and old_entry not in dialogue_nodes:
                    raise CompileError(
                        f"Zone 既有对话入口 {old_entry!r} 在源图 {dialogue_source_id!r} 中不存在"
                    )
                plan.changes.append(
                    f"zones[{trigger_entity_id}].onEnter: 明确替换为对话 {dialogue_id}"
                )
            elif not exact and _append_action(zone, "onEnter", action):
                plan.changes.append(f"zones[{trigger_entity_id}].onEnter: 启动对话 {dialogue_id}")
        if _ensure_blackbox(
            comp,
            kind="zoneBlackbox",
            ref_id=f"{scene_id}:{trigger_entity_id}",
            label=f"{scene_id} / {trigger_entity_id}",
            graph_id=scenario_graph_id,
            emitted_signal=signal_id if trigger_kind == "zone_instant" else "",
        ):
            plan.narrative_changed = True
            plan.changes.append("narrative_graphs.elements: 同步 Zone 黑盒投影")
    elif trigger_kind == "npc_dialogue":
        if not trigger_entity_id:
            raise CompileError("必须选择现有 NPC")
        npc = _find_scene_entity(scene, "npc", trigger_entity_id)
        if _ensure_visibility_gate(
            npc, "npc", gate, owner=f"NPC {scene_id}:{trigger_entity_id}",
        ):
            plan.changes.append(f"npcs[{trigger_entity_id}].conditions: 仅在 {from_state} 生效")
        old_graph = _clean(npc.get("dialogueGraphId"))
        if old_graph and old_graph != dialogue_id and not spec.replace_existing_dialogue:
            raise CompileError(
                f"NPC {scene_id}:{trigger_entity_id} 当前绑定对话 {old_graph!r}。"
                "请勾选明确替换，避免无意改变已有 NPC 语义。"
            )
        if old_graph != dialogue_id:
            npc["dialogueGraphId"] = dialogue_id
            old_entry = _clean(npc.get("dialogueGraphEntry"))
            if old_entry and old_graph != dialogue_source_id:
                npc.pop("dialogueGraphEntry", None)
            elif old_entry and old_entry not in dialogue_nodes:
                raise CompileError(
                    f"NPC 既有对话入口 {old_entry!r} 在源图 {dialogue_source_id!r} 中不存在"
                )
            plan.changes.append(f"npcs[{trigger_entity_id}].dialogueGraphId: {dialogue_id}")
    elif trigger_kind == "hotspot_dialogue":
        if not trigger_entity_id:
            raise CompileError("必须选择现有 Hotspot")
        hotspot = _find_scene_entity(scene, "hotspot", trigger_entity_id)
        if _clean(hotspot.get("type")) != "inspect":
            raise CompileError("只有 inspect 类型 Hotspot 会在运行时读取 data.graphId")
        if _ensure_visibility_gate(
            hotspot, "hotspot", gate, owner=f"Hotspot {scene_id}:{trigger_entity_id}",
        ):
            plan.changes.append(f"hotspots[{trigger_entity_id}].conditions: 仅在 {from_state} 生效")
        data = hotspot.get("data")
        if not isinstance(data, dict):
            raise CompileError(f"Hotspot {trigger_entity_id!r} 的 data 不是对象")
        old_graph = _clean(data.get("graphId"))
        if old_graph and old_graph != dialogue_id and not spec.replace_existing_dialogue:
            raise CompileError(
                f"Hotspot {scene_id}:{trigger_entity_id} 当前绑定对话 {old_graph!r}。"
                "请勾选明确替换，避免无意改变已有 Hotspot 语义。"
            )
        if old_graph != dialogue_id:
            data["graphId"] = dialogue_id
            old_entry = _clean(data.get("entry"))
            if old_entry and old_graph != dialogue_source_id:
                data.pop("entry", None)
            elif old_entry and old_entry not in dialogue_nodes:
                raise CompileError(
                    f"Hotspot 既有对话入口 {old_entry!r} 在源图 {dialogue_source_id!r} 中不存在"
                )
            plan.changes.append(f"hotspots[{trigger_entity_id}].data.graphId: {dialogue_id}")
    else:
        raise CompileError(f"未知触发类型 {trigger_kind!r}")

    if needs_dialogue:
        if _ensure_blackbox(
            comp,
            kind="dialogueBlackbox",
            ref_id=dialogue_id,
            label=dialogue_id,
            graph_id="",
            emitted_signal=signal_id,
        ):
            plan.narrative_changed = True
            plan.changes.append("narrative_graphs.elements: 同步对话黑盒 emits 投影")

    gated: set[tuple[str, str]] = set(spec.visible_entities)
    if trigger_kind.startswith("zone_"):
        gated.add(("zone", trigger_entity_id))
    elif trigger_kind == "npc_dialogue":
        gated.add(("npc", trigger_entity_id))
    elif trigger_kind == "hotspot_dialogue":
        gated.add(("hotspot", trigger_entity_id))
    for kind, entity_id_raw in sorted(gated):
        entity_id = _clean(entity_id_raw)
        if kind not in {"npc", "hotspot", "zone"} or not entity_id:
            continue
        entity = _find_scene_entity(scene, kind, entity_id)  # type: ignore[arg-type]
        if _ensure_visibility_gate(
            entity,
            kind,  # type: ignore[arg-type]
            gate,
            owner=f"{kind} {scene_id}:{entity_id}",
        ):
            plan.changes.append(f"{kind} {scene_id}:{entity_id}: 追加事件可用条件 {scenario_graph_id}.ready")
    plan.changed_scene_ids.add(scene_id)

    quest_id = _clean(spec.quest_id)
    if spec.new_quest is not None:
        new_quest = copy.deepcopy(spec.new_quest)
        quest_id = _require_native_id(new_quest.get("id"), "新 Quest ID")
        if any(isinstance(row, dict) and _clean(row.get("id")) == quest_id for row in quests):
            raise CompileError(f"Quest ID {quest_id!r} 已存在")
        new_quest["id"] = quest_id
        new_quest["group"] = _clean(new_quest.get("group"))
        if _clean(new_quest.get("type")) not in {"main", "side"}:
            new_quest["type"] = "side"
        new_quest["title"] = _clean(new_quest.get("title")) or quest_id
        new_quest["description"] = str(new_quest.get("description") or "").strip()
        new_quest.setdefault("preconditions", [])
        new_quest.setdefault("completionConditions", [])
        new_quest.setdefault("acceptActions", [])
        new_quest.setdefault("rewards", [])
        new_quest.setdefault("nextQuests", [])
        quests.append(new_quest)
        plan.quests_changed = True
        plan.changes.append(f"quests.json: 新建镜像任务 {quest_id}")
    if quest_id:
        matches = [row for row in quests if isinstance(row, dict) and _clean(row.get("id")) == quest_id]
        if len(matches) != 1:
            raise CompileError(f"Quest {quest_id!r} {'不存在' if not matches else '重复'}")
        quest = matches[0]
        if _clean(quest.get("type")) == "repeatable":
            raise CompileError(f"Quest {quest_id!r} 是 repeatable；运行时不读取 completionConditions，不能绑定")
        completion = _native_condition(main_graph_id, to_state, reached=True)
        if _append_exact(quest, "completionConditions", completion):
            plan.quests_changed = True
            plan.changes.append(f"quests[{quest_id}].completionConditions: 到达 {main_graph_id}.{to_state} 完成")

    plan.narrative_changed = plan.narrative_changed or narrative != getattr(model, "narrative_graphs", None)
    if scene == (getattr(model, "scenes", None) or {}).get(scene_id):
        plan.changed_scene_ids.discard(scene_id)
    plan.quests_changed = plan.quests_changed or quests != getattr(model, "quests", None)
    _validate_plan_narrative(plan, model)
    if not plan.changes:
        plan.warnings.append("现有原生数据已经包含这条接线，本次没有需要应用的变化。")
    return plan


def apply_compilation_plan(model: Any, plan: CompilationPlan) -> None:
    """Apply a detached plan to ProjectModel with rollback-on-exception."""
    if not plan.changed:
        return
    # Detached plans only *replace* these documents; they never mutate the
    # previous objects. Keep their exact identities for rollback because old
    # editor pages may hold references into them (notably Scene property
    # forms). Restoring deep copies would silently detach those pages.
    document_attrs = (
        "narrative_graphs",
        "scenes",
        "quests",
        "pending_dialogue_graph_edits",
        "pending_dialogue_stubs",
    )
    metadata_attrs = (
        "_dirty",
        "_dirty_scene_ids",
        "_dirty_scenes_all",
    )
    document_snapshot = {name: getattr(model, name) for name in document_attrs}
    metadata_snapshot = {
        name: copy.deepcopy(getattr(model, name)) for name in metadata_attrs
    }
    try:
        if plan.narrative_changed:
            model.narrative_graphs = copy.deepcopy(plan.narrative_graphs)
            model.mark_dirty("narrative_graphs")
        if plan.changed_scene_ids:
            model.scenes = copy.deepcopy(plan.scenes)
            for scene_id in sorted(plan.changed_scene_ids):
                model.mark_dirty("scene", scene_id)
        if plan.quests_changed:
            model.quests = copy.deepcopy(plan.quests)
            model.mark_dirty("quest")
        if plan.dialogue_edits:
            pending = copy.deepcopy(model.pending_dialogue_graph_edits)
            pending.update(copy.deepcopy(plan.dialogue_edits))
            model.pending_dialogue_graph_edits = pending
            model.mark_dirty("dialogue_graph_edits")
        if plan.dialogue_stubs:
            pending_stubs = copy.deepcopy(model.pending_dialogue_stubs)
            overlap = set(pending_stubs) & set(plan.dialogue_stubs)
            if overlap:
                raise CompileError(f"待保存的新对话图发生 ID 冲突：{sorted(overlap)}")
            pending_stubs.update(copy.deepcopy(plan.dialogue_stubs))
            model.pending_dialogue_stubs = pending_stubs
            model.mark_dirty("dialogue_stubs")
    except Exception:
        for name, value in document_snapshot.items():
            setattr(model, name, value)
        for name, value in metadata_snapshot.items():
            setattr(model, name, value)
        # mark_dirty may already have notified MainWindow before a later
        # bucket failed. Re-announce restored dirty truth without hiding the
        # original transaction exception if notification itself misbehaves.
        try:
            model.dirty_changed.emit(bool(model.is_dirty))
        except Exception:
            pass
        raise


def commit_model_documents(
    model: Any,
    updates: dict[str, Any],
    dirty_marks: Iterable[tuple[str, str]],
) -> None:
    """Replace native domains atomically in memory, preserving object identity on failure."""
    if not updates:
        return
    document_snapshot = {name: getattr(model, name) for name in updates}
    metadata_attrs = ("_dirty", "_dirty_scene_ids", "_dirty_scenes_all")
    metadata_snapshot = {
        name: copy.deepcopy(getattr(model, name)) for name in metadata_attrs
    }
    try:
        for name, value in updates.items():
            setattr(model, name, value)
        for data_type, item_id in dirty_marks:
            model.mark_dirty(data_type, item_id)
    except Exception:
        for name, value in document_snapshot.items():
            setattr(model, name, value)
        for name, value in metadata_snapshot.items():
            setattr(model, name, value)
        try:
            model.dirty_changed.emit(bool(model.is_dirty))
        except Exception:
            pass
        raise


def _contains_emit(node: Any, signal_id: str) -> bool:
    return any(
        _clean(action.get("type")) == "emitNarrativeSignal"
        and _clean((action.get("params") or {}).get("signal")) == signal_id
        for action in _walk_actions(node)
    )


def _dialogue_guarantees_completion_signal(model: Any, dialogue_id: str, signal_id: str) -> bool:
    doc = dialogue_graph_document(model, dialogue_id)
    if not isinstance(doc, dict):
        return False
    try:
        patched, changes = ensure_signal_before_reachable_ends(
            doc,
            signal_id,
            source_id=dialogue_id,
        )
    except CompileError:
        return False
    return not changes and patched == doc


def scan_event_bindings(model: Any, composition_id: str, transition_id: str) -> list[BindingRow]:
    """Reverse-project one transition's native references without guessing ownership."""
    narrative = getattr(model, "narrative_graphs", None) or {}
    comp = find_composition(narrative, composition_id)
    graph = comp.get("mainGraph") if isinstance(comp, dict) else None
    if not isinstance(graph, dict):
        return []
    transition = next((
        row for row in graph.get("transitions") or []
        if isinstance(row, dict) and _clean(row.get("id")) == transition_id
    ), None)
    if not isinstance(transition, dict):
        return []
    graph_id = _clean(graph.get("id"))
    from_state = _clean(transition.get("from"))
    to_state = _clean(transition.get("to"))
    main_signal_id = _clean(transition.get("signal"))
    content_signal_id = main_signal_id
    availability_graph_id = graph_id
    availability_state_id = from_state
    out: list[BindingRow] = []
    if main_signal_id.startswith("state:"):
        tail = main_signal_id[len("state:"):]
        if ":" in tail:
            scenario_graph_id, exit_state = tail.rsplit(":", 1)
            scenario_graph = find_graph(narrative, scenario_graph_id)
            if isinstance(scenario_graph, dict):
                availability_graph_id = scenario_graph_id
                availability_state_id = "ready"
                listeners = [
                    row for row in scenario_graph.get("transitions") or []
                    if isinstance(row, dict)
                    and _clean(row.get("to")) == exit_state
                    and _clean(row.get("signal"))
                ]
                if len(listeners) == 1:
                    content_signal_id = _clean(listeners[0].get("signal"))
                    unlock = next((
                        row for row in scenario_graph.get("transitions") or []
                        if isinstance(row, dict) and _clean(row.get("id")) == "unlock"
                    ), None)
                    prerequisites: list[str] = []
                    if isinstance(unlock, dict):
                        conditions = unlock.get("conditions")
                        for leaf in conditions if isinstance(conditions, list) else []:
                            if isinstance(leaf, dict):
                                ref = f"{_clean(leaf.get('narrative'))}.{_clean(leaf.get('state'))}"
                                if ref.strip("."):
                                    prerequisites.append(ref)
                    out.append(BindingRow(
                        "scenario",
                        scenario_graph_id,
                        f"narrative_graphs.graphs[{scenario_graph_id}]",
                        (f"前置 {' AND '.join(prerequisites)} → ready；" if prerequisites else "")
                        + f"内容信号 {content_signal_id} → 子图末态 {exit_state} → 广播 {main_signal_id}",
                    ))
    for scene_id, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        for key, kind in (("zones", "zone"), ("npcs", "npc"), ("hotspots", "hotspot")):
            for index, entity in enumerate(scene.get(key) or []):
                if not isinstance(entity, dict):
                    continue
                entity_id = _clean(entity.get("id")) or str(index)
                path = f"scenes[{scene_id}].{key}[{index}]"
                # Only claim the exact top-level leaf shape written by this tool.
                # A matching leaf nested under any/not has different semantics;
                # without ownership metadata we must not guess it is availability.
                conditions = entity.get("conditions") if isinstance(entity.get("conditions"), list) else []
                gate = _native_condition(availability_graph_id, availability_state_id)
                for condition_index, condition in enumerate(conditions):
                    if not isinstance(condition, dict) or condition != gate:
                        continue
                    out.append(BindingRow(
                        "availability",
                        f"{scene_id}:{entity_id}",
                        f"{path}.conditions[{condition_index}]",
                        f"仅在事件阶段 {availability_graph_id}.{availability_state_id} 生效" + (
                            "；条件失败时隐藏" if entity.get("conditionHidesEntity") is True else ""
                        ),
                        str(scene_id), kind, entity_id, condition_index,
                    ))
                if kind == "zone":
                    on_enter = entity.get("onEnter") if isinstance(entity.get("onEnter"), list) else []
                    for action_index, action in enumerate(on_enter):
                        if not isinstance(action, dict):
                            continue
                        if (
                            _clean(action.get("type")) == "emitNarrativeSignal"
                            and _clean((action.get("params") or {}).get("signal")) == content_signal_id
                        ):
                            out.append(BindingRow(
                                "trigger", f"{scene_id}:{entity_id}", f"{path}.onEnter[{action_index}]",
                                f"进入 Zone 直接发内容信号 {content_signal_id}",
                                str(scene_id), kind, entity_id, action_index,
                            ))
                            continue
                        if _clean(action.get("type")) != "startDialogueGraph":
                            continue
                        dialogue_id = _clean((action.get("params") or {}).get("graphId"))
                        if dialogue_id and _dialogue_guarantees_completion_signal(model, dialogue_id, content_signal_id):
                            out.append(BindingRow(
                                "trigger", f"{scene_id}:{entity_id}", f"{path}.onEnter[{action_index}]",
                                f"进入 Zone 播放 {dialogue_id}，对话出口发 {content_signal_id}",
                                str(scene_id), kind, entity_id, action_index,
                            ))
                elif kind == "npc":
                    dialogue_id = _clean(entity.get("dialogueGraphId"))
                    if dialogue_id and _dialogue_guarantees_completion_signal(model, dialogue_id, content_signal_id):
                        out.append(BindingRow(
                            "trigger", f"{scene_id}:{entity_id}", f"{path}.dialogueGraphId",
                            f"与 NPC 交谈完成后由 {dialogue_id} 发 {content_signal_id}",
                            str(scene_id), kind, entity_id,
                        ))
                else:
                    data = entity.get("data") if isinstance(entity.get("data"), dict) else {}
                    dialogue_id = _clean(data.get("graphId"))
                    if dialogue_id and _dialogue_guarantees_completion_signal(model, dialogue_id, content_signal_id):
                        out.append(BindingRow(
                            "trigger", f"{scene_id}:{entity_id}", f"{path}.data.graphId",
                            f"交互完成后由 {dialogue_id} 发 {content_signal_id}",
                            str(scene_id), kind, entity_id,
                        ))
    for index, quest in enumerate(getattr(model, "quests", None) or []):
        if not isinstance(quest, dict):
            continue
        quest_id = _clean(quest.get("id")) or str(index)
        completion_conditions = (
            quest.get("completionConditions")
            if isinstance(quest.get("completionConditions"), list)
            else []
        )
        completion = _native_condition(graph_id, to_state, reached=True)
        for condition_index, condition in enumerate(completion_conditions):
            if not isinstance(condition, dict) or condition != completion:
                continue
            out.append(BindingRow(
                "quest", quest_id, f"quests[{index}].completionConditions[{condition_index}]",
                f"到达 {to_state} 后任务完成",
                list_index=condition_index,
            ))
    return out


def remove_event_binding(
    model: Any,
    composition_id: str,
    transition_id: str,
    binding: BindingRow,
) -> None:
    """Remove one user-selected native binding, never an inferred bundle."""
    if binding.kind == "scenario":
        raise CompileError("事件子图是主图与内容之间的必需脊椎，不能单独解绑；请删除整个事件。")
    narrative = getattr(model, "narrative_graphs", None) or {}
    comp = find_composition(narrative, composition_id)
    main = comp.get("mainGraph") if isinstance(comp, dict) else None
    if not isinstance(main, dict):
        raise CompileError("任务流主图不存在")
    transition = next((
        row for row in main.get("transitions") or []
        if isinstance(row, dict) and _clean(row.get("id")) == transition_id
    ), None)
    if not isinstance(transition, dict):
        raise CompileError("事件 transition 不存在")
    main_graph_id = _clean(main.get("id"))
    from_state = _clean(transition.get("from"))
    to_state = _clean(transition.get("to"))
    main_signal = _clean(transition.get("signal"))
    content_signal = main_signal
    availability_graph_id = main_graph_id
    availability_state_id = from_state
    scenario_graph_id = ""
    if main_signal.startswith("state:") and ":" in main_signal[len("state:"):]:
        scenario_graph_id, exit_state = main_signal[len("state:"):].rsplit(":", 1)
        scenario = find_graph(narrative, scenario_graph_id)
        if isinstance(scenario, dict):
            availability_graph_id = scenario_graph_id
            availability_state_id = "ready"
            candidates = [
                row for row in scenario.get("transitions") or []
                if isinstance(row, dict)
                and _clean(row.get("to")) == exit_state
                and _clean(row.get("signal"))
            ]
            if len(candidates) == 1:
                content_signal = _clean(candidates[0].get("signal"))

    if binding.kind in {"availability", "trigger"}:
        scenes = copy.deepcopy(getattr(model, "scenes", None) or {})
        narrative_edit: dict[str, Any] | None = None
        remove_projection_read = False
        remove_projection_emit = False
        scene = scenes.get(binding.scene_id)
        if not isinstance(scene, dict):
            raise CompileError(f"场景 {binding.scene_id!r} 不存在")
        entity = _find_scene_entity(
            scene,
            binding.entity_kind,  # type: ignore[arg-type]
            binding.entity_id,
        )
        if binding.kind == "availability":
            gate = _native_condition(availability_graph_id, availability_state_id)
            rows = entity.get("conditions")
            if (
                not isinstance(rows, list)
                or binding.list_index < 0
                or binding.list_index >= len(rows)
                or rows[binding.list_index] != gate
            ):
                raise CompileError("所选阶段门闸已变化，请重新扫描")
            del rows[binding.list_index]
            if not rows:
                entity.pop("conditions", None)
            if binding.entity_kind == "zone" and scenario_graph_id:
                remove_projection_read = not _zone_entity_still_references_event(
                    model,
                    entity,
                    gate=gate,
                    content_signal=content_signal,
                )
        elif binding.entity_kind == "zone":
            rows = entity.get("onEnter")
            if (
                not isinstance(rows, list)
                or binding.list_index < 0
                or binding.list_index >= len(rows)
            ):
                raise CompileError("所选 Zone.onEnter 接线已变化，请重新扫描")
            removed_action = rows[binding.list_index]
            removed_kind = _zone_event_action_kind(model, removed_action, content_signal)
            if not removed_kind:
                raise CompileError("所选 Zone 顶层触发动作已变化，请重新扫描")
            del rows[binding.list_index]
            if not rows:
                entity.pop("onEnter", None)
            if scenario_graph_id:
                gate = _native_condition(availability_graph_id, availability_state_id)
                remove_projection_read = not _zone_entity_still_references_event(
                    model,
                    entity,
                    gate=gate,
                    content_signal=content_signal,
                )
                remove_projection_emit = removed_kind == "instant" and not any(
                    _zone_event_action_kind(model, action, content_signal) == "instant"
                    for action in (entity.get("onEnter") or [])
                )
        elif binding.entity_kind == "npc":
            dialogue_id = _clean(entity.get("dialogueGraphId"))
            if not dialogue_id or not _dialogue_guarantees_completion_signal(model, dialogue_id, content_signal):
                raise CompileError("NPC 对话绑定已变化，请重新扫描")
            entity.pop("dialogueGraphId", None)
            entity.pop("dialogueGraphEntry", None)
        elif binding.entity_kind == "hotspot":
            data = entity.get("data")
            dialogue_id = _clean(data.get("graphId")) if isinstance(data, dict) else ""
            if not dialogue_id or not _dialogue_guarantees_completion_signal(model, dialogue_id, content_signal):
                raise CompileError("Hotspot 对话绑定已变化，请重新扫描")
            data.pop("graphId", None)
            data.pop("entry", None)
        else:
            raise CompileError("未知场景实体类型")
        if (
            binding.entity_kind == "zone"
            and scenario_graph_id
            and (remove_projection_read or remove_projection_emit)
        ):
            narrative_edit = copy.deepcopy(narrative)
            projection_changed = _remove_zone_projection_binding(
                narrative_edit,
                composition_id=composition_id,
                zone_ref=f"{binding.scene_id}:{binding.entity_id}",
                scenario_graph_id=scenario_graph_id,
                content_signal=content_signal,
                remove_read=remove_projection_read,
                remove_emit=remove_projection_emit,
            )
            if not projection_changed:
                narrative_edit = None
        updates: dict[str, Any] = {"scenes": scenes}
        dirty_marks: list[tuple[str, str]] = [("scene", binding.scene_id)]
        if narrative_edit is not None:
            updates["narrative_graphs"] = narrative_edit
            dirty_marks.append(("narrative_graphs", ""))
        commit_model_documents(model, updates, dirty_marks)
        return

    if binding.kind == "quest":
        quests = copy.deepcopy(getattr(model, "quests", None) or [])
        matches = [row for row in quests if isinstance(row, dict) and _clean(row.get("id")) == binding.owner]
        if len(matches) != 1:
            raise CompileError("Quest 已不存在或 ID 重复")
        quest = matches[0]
        completion = _native_condition(main_graph_id, to_state, reached=True)
        rows = quest.get("completionConditions")
        if (
            not isinstance(rows, list)
            or binding.list_index < 0
            or binding.list_index >= len(rows)
            or rows[binding.list_index] != completion
        ):
            raise CompileError("Quest 镜像条件已变化，请重新扫描")
        del rows[binding.list_index]
        commit_model_documents(
            model,
            {"quests": quests},
            (("quest", ""),),
        )
        return
    raise CompileError(f"不支持解绑原生接线类别 {binding.kind!r}")


def _zone_event_action_kind(model: Any, action: Any, content_signal: str) -> str:
    if not isinstance(action, dict):
        return ""
    if (
        _clean(action.get("type")) == "emitNarrativeSignal"
        and _clean((action.get("params") or {}).get("signal")) == content_signal
    ):
        return "instant"
    if _clean(action.get("type")) != "startDialogueGraph":
        return ""
    dialogue_id = _clean((action.get("params") or {}).get("graphId"))
    if dialogue_id and _dialogue_guarantees_completion_signal(model, dialogue_id, content_signal):
        return "dialogue"
    return ""


def _zone_entity_still_references_event(
    model: Any,
    entity: dict[str, Any],
    *,
    gate: dict[str, Any],
    content_signal: str,
) -> bool:
    if _contains_exact(entity.get("conditions"), gate):
        return True
    return any(
        _zone_event_action_kind(model, action, content_signal)
        for action in (entity.get("onEnter") if isinstance(entity.get("onEnter"), list) else [])
    )


def _remove_zone_projection_binding(
    narrative: dict[str, Any],
    *,
    composition_id: str,
    zone_ref: str,
    scenario_graph_id: str,
    content_signal: str,
    remove_read: bool,
    remove_emit: bool,
) -> bool:
    """Remove only the projection entries paired with one selected Zone trigger.

    The blackbox itself and every unrelated declaration remain intact.  This
    precision is required because no private ownership manifest exists.
    """
    comp = find_composition(narrative, composition_id)
    elements = comp.get("elements") if isinstance(comp, dict) else None
    if not isinstance(elements, list):
        raise CompileError("composition.elements 不是数组")
    matches = [
        element for element in elements
        if isinstance(element, dict)
        and _clean(element.get("kind")) == "zoneBlackbox"
        and _clean(element.get("refId")) == zone_ref
    ]
    if len(matches) > 1:
        raise CompileError(f"Zone 黑盒 {zone_ref!r} 重复，不能证明应清理哪一条投影")
    if not matches:
        return False
    meta = matches[0].get("meta")
    if not isinstance(meta, dict):
        raise CompileError(f"Zone 黑盒 {zone_ref!r}.meta 不是对象")
    changed = False
    if remove_read:
        reads = meta.get("reads")
        if not isinstance(reads, list):
            raise CompileError(f"Zone 黑盒 {zone_ref!r}.meta.reads 不是数组")
        read_indexes = [index for index, value in enumerate(reads) if _clean(value) == scenario_graph_id]
        if len(read_indexes) > 1:
            raise CompileError(
                f"Zone 黑盒 {zone_ref!r} 对事件图 {scenario_graph_id!r} 有重复 reads；"
                "无法区分工具接线与作者声明。"
            )
        if read_indexes:
            del reads[read_indexes[0]]
            changed = True
    if remove_emit:
        emits = meta.get("emits")
        if not isinstance(emits, list):
            raise CompileError(f"Zone 黑盒 {zone_ref!r}.meta.emits 不是数组")
        emit_indexes = [index for index, value in enumerate(emits) if _clean(value) == content_signal]
        if len(emit_indexes) > 1:
            raise CompileError(
                f"Zone 黑盒 {zone_ref!r} 对内容信号 {content_signal!r} 有重复 emits；"
                "无法区分工具接线与作者声明。"
            )
        if emit_indexes:
            del emits[emit_indexes[0]]
            changed = True
    return changed


def _assert_standard_event_spine_for_delete(
    *,
    element: dict[str, Any],
    scenario: dict[str, Any],
    scenario_graph_id: str,
    main_graph_id: str,
    main_from_state: str,
) -> None:
    """Reject deletion unless every removable field is the standard skeleton."""
    element_allowed = {
        "id", "kind", "label", "description", "ownerType", "ownerId", "refId",
        "x", "y", "graph", "meta",
    }
    element_extra = set(element) - element_allowed
    if element_extra:
        raise CompileError(
            "事件子图元素含旧编辑器扩展字段（"
            + "、".join(sorted(element_extra))
            + "），不能安全删除"
        )
    if (
        _clean(element.get("kind")) != "scenarioSubgraph"
        or _clean(element.get("ownerType")) != "scenario"
        or _clean(element.get("ownerId")) != scenario_graph_id
        or _clean(element.get("refId")) != scenario_graph_id
    ):
        raise CompileError("事件子图元素的原生归属字段已变化，不能按标准骨架删除")
    meta = element.get("meta")
    if (
        not isinstance(meta, dict)
        or set(meta) != {"emits", "reads", "commands"}
        or any(meta.get(key) != [] for key in ("emits", "reads", "commands"))
    ):
        raise CompileError("事件子图元素 meta 含作者登记或扩展，不能随元素一起删除")

    graph_allowed = {
        "id", "label", "description", "meta", "ownerType", "ownerId",
        "initialState", "entryState", "exitStates", "states", "transitions",
    }
    graph_extra = set(scenario) - graph_allowed
    exits = scenario.get("exitStates")
    if (
        graph_extra
        or _clean(scenario.get("id")) != scenario_graph_id
        or _clean(scenario.get("ownerType")) != "scenario"
        or _clean(scenario.get("ownerId")) != scenario_graph_id
        or _clean(scenario.get("initialState")) != "locked"
        or _clean(scenario.get("entryState")) != "ready"
        or not isinstance(exits, list)
        or len(exits) != 2
        or {_clean(value) for value in exits} != {"done", "expired"}
    ):
        detail = f"（额外字段：{'、'.join(sorted(graph_extra))}）" if graph_extra else ""
        raise CompileError(f"事件子图的图级语义已在旧编辑器中变化{detail}，不能安全删除")

    states = scenario.get("states")
    if not isinstance(states, dict) or set(states) != {"locked", "ready", "done", "expired"}:
        raise CompileError("事件子图已增加、删除或改名阶段，不能安全删除")
    presentation = {"id", "label", "description", "meta"}
    for state_id, state in states.items():
        if not isinstance(state, dict) or _clean(state.get("id")) != state_id:
            raise CompileError(f"事件子图阶段 {state_id!r} 结构已变化，不能安全删除")
        allowed = presentation | ({"broadcastOnEnter"} if state_id == "done" else set())
        extra = set(state) - allowed
        if extra or (state_id == "done" and state.get("broadcastOnEnter") is not True):
            detail = f"（运行字段：{'、'.join(sorted(extra))}）" if extra else ""
            raise CompileError(
                f"事件子图阶段 {state_id!r} 含动作、平面或其它旧编辑器扩展{detail}，不能安全删除"
            )

    rows = scenario.get("transitions")
    if (
        not isinstance(rows, list)
        or len(rows) != 3
        or any(not isinstance(row, dict) for row in rows)
    ):
        raise CompileError("事件子图已增加、删除或破坏迁移，不能安全删除")
    by_id = {_clean(row.get("id")): row for row in rows}
    if set(by_id) != {"unlock", "expire", "complete"}:
        raise CompileError("事件子图迁移 ID 已变化或重复，不能安全删除")

    unlock_conditions = by_id["unlock"].get("conditions")
    if (
        not isinstance(unlock_conditions, list)
        or not 1 <= len(unlock_conditions) <= 2
        or any(
            not isinstance(condition, dict)
            or set(condition) != {"narrative", "state"}
            or not _clean(condition.get("narrative"))
            or not _clean(condition.get("state"))
            for condition in unlock_conditions
        )
        or len({(_clean(row["narrative"]), _clean(row["state"])) for row in unlock_conditions})
        != len(unlock_conditions)
        or _native_condition(main_graph_id, main_from_state) not in unlock_conditions
    ):
        raise CompileError("事件子图 unlock 已不再是标准前置 + 主图当前阶段条件，不能安全删除")
    unlock_wanted = {
        "id": "unlock",
        "from": "locked",
        "to": "ready",
        "trigger": "reactiveAll",
        "conditions": unlock_conditions,
        "signal": "__draft__",
    }
    expire_wanted = {
        "id": "expire",
        "from": "ready",
        "to": "expired",
        "trigger": "reactiveAny",
        "conditions": [{"not": copy.deepcopy(condition)} for condition in unlock_conditions],
        "signal": "__draft__",
    }
    _assert_exact_reactive_transition(by_id["unlock"], unlock_wanted, graph_id=scenario_graph_id)
    _assert_exact_reactive_transition(by_id["expire"], expire_wanted, graph_id=scenario_graph_id)
    content_signal = _clean(by_id["complete"].get("signal"))
    if not content_signal or content_signal == "__draft__" or content_signal.startswith("state:"):
        raise CompileError("事件子图 complete 不再监听标准作者内容信号，不能安全删除")
    _assert_exact_signal_transition(
        by_id["complete"],
        transition_id="complete",
        from_state="ready",
        to_state="done",
        signal_id=content_signal,
    )


def delete_event_spine(model: Any, composition_id: str, transition_id: str) -> None:
    """Delete an event transition and its exact four-state scenario spine.

    Content/scene/Quest bindings must be explicitly removed first.  Unbinding
    a Zone trigger precisely removes only its paired blackbox read/emit entry;
    author signals, dialogue assets and the blackbox elements remain because,
    without a private ownership manifest, their ownership cannot be proven.
    """
    remaining = [
        row for row in scan_event_bindings(model, composition_id, transition_id)
        if row.kind != "scenario"
    ]
    if remaining:
        raise CompileError(f"事件仍有 {len(remaining)} 条玩家触发、门闸或 Quest 接线；请先逐条解绑")
    narrative = copy.deepcopy(getattr(model, "narrative_graphs", None) or {})
    comp = find_composition(narrative, composition_id)
    main = comp.get("mainGraph") if isinstance(comp, dict) else None
    if not isinstance(main, dict):
        raise CompileError("任务流主图不存在")
    transitions = main.get("transitions")
    if not isinstance(transitions, list):
        raise CompileError("主图 transitions 不是数组")
    matches = [
        row for row in transitions
        if isinstance(row, dict) and _clean(row.get("id")) == transition_id
    ]
    if len(matches) != 1:
        raise CompileError("事件 transition 不存在或重复")
    signal = _clean(matches[0].get("signal"))
    if not signal.startswith("state:") or ":" not in signal[len("state:"):]:
        raise CompileError("该迁移不是本工具支持的 scenario 末态广播接线，不能自动删除")
    scenario_graph_id, exit_state = signal[len("state:"):].rsplit(":", 1)
    if exit_state != "done":
        raise CompileError("事件子图末态不是 done，不能按标准事件骨架删除")
    from tools.editor.shared.signal_refactor import scan_graph_usages

    usages = scan_graph_usages(model, scenario_graph_id)
    if (
        int(usages.get("metaReads") or 0) != 0
        or int(usages.get("totalRefs") or 0) != 1
        or int(usages.get("derivedListeners") or 0) != 1
    ):
        raise CompileError(f"事件子图 {scenario_graph_id!r} 还有其它原生引用，不能安全删除")
    elements = comp.get("elements")
    if not isinstance(elements, list):
        raise CompileError("composition.elements 不是数组")
    targets = []
    for element in elements:
        graph = element.get("graph") if isinstance(element, dict) else None
        if isinstance(graph, dict) and _clean(graph.get("id")) == scenario_graph_id:
            targets.append(element)
    if len(targets) != 1 or _clean(targets[0].get("kind")) != "scenarioSubgraph":
        raise CompileError("事件子图元素不存在、重复或类型已变化")
    scenario = targets[0].get("graph")
    if not isinstance(scenario, dict):
        raise CompileError("事件子图 graph 不是对象")
    main_graph_id = _clean(main.get("id"))
    main_transition = matches[0]
    _assert_exact_signal_transition(
        main_transition,
        transition_id=transition_id,
        from_state=_clean(main_transition.get("from")),
        to_state=_clean(main_transition.get("to")),
        signal_id=signal,
    )
    _assert_standard_event_spine_for_delete(
        element=targets[0],
        scenario=scenario,
        scenario_graph_id=scenario_graph_id,
        main_graph_id=main_graph_id,
        main_from_state=_clean(main_transition.get("from")),
    )
    main["transitions"] = [row for row in transitions if row is not matches[0]]
    comp["elements"] = [row for row in elements if row is not targets[0]]
    commit_model_documents(
        model,
        {"narrative_graphs": narrative},
        (("narrative_graphs", ""),),
    )


def plan_text(plan: CompilationPlan) -> str:
    if not plan.changes and not plan.warnings:
        return "没有变化。"
    lines: list[str] = []
    if plan.changes:
        lines.append("将写入现有原生数据：")
        lines.extend(f"  + {item}" for item in plan.changes)
    if plan.warnings:
        lines.append("\n需要人工确认：")
        lines.extend(f"  ! {item}" for item in plan.warnings)
    lines.append("\n不会创建 TaskSpec / manifest / sidecar，也不会直接写盘。")
    return "\n".join(lines)
