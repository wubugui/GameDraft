"""Readable static graph diagnostics for the production workbench."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tools.editor.project_model import ProjectModel

from .runtime_debug import RuntimeDebugSnapshotReport, load_runtime_debug_snapshot
from .story_units import StoryUnit, load_story_unit_workspace


@dataclass
class CompositionGraphDiagnostics:
    composition_id: str
    label: str
    production_status: str
    trigger_edges: list[dict[str, Any]] = field(default_factory=list)
    read_edges: list[dict[str, Any]] = field(default_factory=list)
    state_command_edges: list[dict[str, Any]] = field(default_factory=list)
    action_read_write_edges: list[dict[str, str]] = field(default_factory=list)
    dialogue_routes: list[str] = field(default_factory=list)
    owner_boundary_warnings: list[str] = field(default_factory=list)
    projection_warnings: list[str] = field(default_factory=list)
    validation_issues: list[str] = field(default_factory=list)
    quests: list[str] = field(default_factory=list)
    dialogues: list[str] = field(default_factory=list)
    scenarios: list[str] = field(default_factory=list)
    signals: list[str] = field(default_factory=list)

    @property
    def issue_count(self) -> int:
        return (
            len(self.projection_warnings)
            + len(self.validation_issues)
            + len(self.state_command_edges)
            + len(self.owner_boundary_warnings)
        )


@dataclass
class GraphDiagnosticsReport:
    project_root: Path
    compositions: list[CompositionGraphDiagnostics]
    global_warnings: list[str] = field(default_factory=list)
    runtime_snapshot: RuntimeDebugSnapshotReport | None = None

    @property
    def trigger_count(self) -> int:
        return sum(len(c.trigger_edges) for c in self.compositions)

    @property
    def read_count(self) -> int:
        return sum(len(c.read_edges) for c in self.compositions)

    @property
    def state_command_count(self) -> int:
        return sum(len(c.state_command_edges) for c in self.compositions)

    @property
    def action_read_write_count(self) -> int:
        return sum(len(c.action_read_write_edges) for c in self.compositions)


def build_graph_diagnostics(project_root: Path) -> GraphDiagnosticsReport:
    project_root = project_root.resolve()
    model = ProjectModel()
    model.load_project(project_root)
    workspace = load_story_unit_workspace(project_root)

    from tools.editor.editors.narrative_state_editor import derive_projection

    projection = derive_projection(model.narrative_graphs, model)
    units_by_id = workspace.by_id()
    dialogue_graphs = _load_dialogue_graphs(project_root)
    compositions_by_id = {
        str(comp.get("id") or "").strip(): comp
        for comp in (model.narrative_graphs.get("compositions") or [])
        if isinstance(comp, dict) and str(comp.get("id") or "").strip()
    }
    compositions: list[CompositionGraphDiagnostics] = []
    for unit in workspace.units:
        cid = unit.record.composition_id
        state_command_edges = _edges_for_composition(
            projection,
            "stateCommandEdges",
            cid,
        )
        raw_comp = compositions_by_id.get(cid, {})
        dialogue_ids = list(unit.summary.dialogues)
        compositions.append(
            CompositionGraphDiagnostics(
                composition_id=cid,
                label=unit.record.display_name or unit.summary.label or cid,
                production_status=unit.record.production_status,
                trigger_edges=_edges_for_composition(projection, "triggerEdges", cid),
                read_edges=_edges_for_composition(projection, "readEdges", cid),
                state_command_edges=state_command_edges,
                action_read_write_edges=_action_read_write_edges(raw_comp, dialogue_ids, dialogue_graphs),
                dialogue_routes=_dialogue_route_lines(dialogue_ids, dialogue_graphs),
                owner_boundary_warnings=_owner_boundary_warnings(raw_comp, state_command_edges),
                projection_warnings=list(unit.summary.projection_warnings),
                validation_issues=list(unit.summary.validation_issues),
                quests=list(unit.summary.quests),
                dialogues=list(unit.summary.dialogues),
                scenarios=list(unit.summary.scenarios),
                signals=list(unit.summary.signals),
            )
        )

    known_ids = set(units_by_id)
    global_warnings: list[str] = []
    for warning in projection.get("warnings", []) or []:
        if not isinstance(warning, dict):
            continue
        cid = str(warning.get("compositionId") or "").strip()
        if cid and cid in known_ids:
            continue
        global_warnings.append(_issue_text(warning))

    return GraphDiagnosticsReport(
        project_root=project_root,
        compositions=compositions,
        global_warnings=global_warnings,
        runtime_snapshot=load_runtime_debug_snapshot(project_root),
    )


def format_graph_diagnostics_report(
    report: GraphDiagnosticsReport,
    *,
    composition_id: str | None = None,
) -> str:
    selected = [
        c for c in report.compositions
        if not composition_id or c.composition_id == composition_id
    ]
    lines = [
        "Graph 诊断（静态）",
        f"工程: {report.project_root}",
        (
            f"Composition: {len(report.compositions)} | "
            f"Signal flow: {report.trigger_count} | "
            f"State read: {report.read_count} | "
            f"State direct write: {report.state_command_count} | "
            f"Action read/write: {report.action_read_write_count}"
        ),
        "说明: 静态引用/因果诊断 + 最新 runtime trace timeline（如果运行中的浏览器已上报快照）。",
        "",
    ]
    if report.global_warnings:
        lines.append("全局警告:")
        lines.extend(f"- {x}" for x in report.global_warnings)
        lines.append("")
    if not selected:
        lines.append("没有可诊断的 composition。")
        return "\n".join(lines)
    for comp in selected:
        lines.extend(_format_composition(comp))
        lines.append("")
    if report.runtime_snapshot is not None:
        lines.extend(_format_runtime_timeline(report.runtime_snapshot))
    return "\n".join(lines).rstrip()


def _format_composition(comp: CompositionGraphDiagnostics) -> list[str]:
    lines = [
        f"== {comp.label} ({comp.composition_id}) ==",
        f"制作状态: {comp.production_status}",
        _compact_refs("Dialogue", comp.dialogues),
        _compact_refs("Quest", comp.quests),
        _compact_refs("Scenario", comp.scenarios),
        _compact_refs("Signal", comp.signals),
        "",
        "Signal flow:",
    ]
    lines.extend(_format_edges(comp.trigger_edges, empty="无 signal flow"))
    lines.append("")
    lines.append("State read:")
    lines.extend(_format_edges(comp.read_edges, empty="无 state read"))
    lines.append("")
    lines.append("Flag / Action read-write:")
    if comp.action_read_write_edges:
        lines.extend(_format_action_read_write_edges(comp.action_read_write_edges))
    else:
        lines.append("- 无可识别 flag/action 读写")
    lines.append("")
    lines.append("Quest dependency:")
    if comp.quests:
        lines.extend(f"- {quest}" for quest in comp.quests)
    else:
        lines.append("- 无 quest 依赖")
    lines.append("")
    lines.append("Dialogue route explain:")
    if comp.dialogue_routes:
        lines.extend(f"- {line}" for line in comp.dialogue_routes)
    else:
        lines.append("- 无 dialogue route")
    lines.append("")
    lines.append("State direct write / 风险:")
    if comp.state_command_edges:
        lines.extend(_format_edges(comp.state_command_edges, prefix="[风险] "))
    else:
        lines.append("- 无直接写 state")
    lines.append("")
    lines.append("Owner boundary / 跨 owner:")
    if comp.owner_boundary_warnings:
        lines.extend(f"- {x}" for x in comp.owner_boundary_warnings)
    else:
        lines.append("- 未发现跨 owner 直接写入")
    if comp.projection_warnings:
        lines.append("")
        lines.append("Projection warning:")
        lines.extend(f"- {x}" for x in comp.projection_warnings)
    if comp.validation_issues:
        lines.append("")
        lines.append("Validation issue:")
        lines.extend(f"- {x}" for x in comp.validation_issues)
    return lines


def _format_action_read_write_edges(edges: list[dict[str, str]]) -> list[str]:
    out: list[str] = []
    for edge in edges:
        source = edge.get("source") or "?"
        target = edge.get("target") or "?"
        kind = edge.get("kind") or "ref"
        detail = edge.get("detail") or ""
        out.append(f"- {kind}: {source} -> {target}{f' | {detail}' if detail else ''}")
    return out


def _format_runtime_timeline(snapshot: RuntimeDebugSnapshotReport) -> list[str]:
    lines = [
        "Runtime trace timeline:",
        f"快照: {'可用' if snapshot.ok else '不可用'} | {snapshot.captured_at or '(无时间)'} | {snapshot.reason or snapshot.message or '(无原因)'}",
    ]
    if not snapshot.ok:
        lines.append(f"- {snapshot.message or '没有 runtime snapshot'}")
        return lines
    if not snapshot.trace:
        lines.append("- 无 runtime trace")
    else:
        for event in snapshot.trace[-24:]:
            seq = f"#{event.get('seq')} " if event.get("seq") is not None else ""
            typ = str(event.get("type") or "trace")
            graph = f" {event.get('graphId')}" if event.get("graphId") else ""
            transition = f".{event.get('transitionId')}" if event.get("transitionId") else ""
            from_to = f" {event.get('from', '?')} -> {event.get('to', '?')}" if event.get("from") or event.get("to") else ""
            trigger = f" [{event.get('triggerKey')}]" if event.get("triggerKey") else ""
            message = f" - {event.get('message')}" if event.get("message") else ""
            lines.append(f"- {seq}{typ}{graph}{transition}{from_to}{trigger}{message}")
    if snapshot.runtime_command_results:
        lines.append("")
        lines.append("Runtime command results:")
        for item in snapshot.runtime_command_results[-12:]:
            status = "OK" if item.get("ok") else "FAIL"
            lines.append(f"- {status}: {item.get('type') or '?'} - {item.get('message') or ''}".rstrip())
    return lines


def _format_edges(
    edges: list[dict[str, Any]],
    *,
    empty: str = "无",
    prefix: str = "",
) -> list[str]:
    if not edges:
        return [f"- {empty}"]
    out: list[str] = []
    for edge in edges:
        source = _clean_node(str(edge.get("source") or ""))
        target = _clean_node(str(edge.get("target") or ""))
        label = str(edge.get("label") or "").strip()
        detail = str(edge.get("detail") or "").strip()
        tail = f" | {detail}" if detail and detail != label else ""
        out.append(f"- {prefix}{source} -> {target} [{label}]{tail}")
    return out


def _compact_refs(label: str, items: list[str]) -> str:
    return f"{label}: {', '.join(items) if items else '无'}"


def _edges_for_composition(
    projection: dict[str, Any],
    key: str,
    composition_id: str,
) -> list[dict[str, Any]]:
    raw = projection.get(key)
    if not isinstance(raw, list):
        return []
    return [
        dict(edge)
        for edge in raw
        if isinstance(edge, dict)
        and str(edge.get("compositionId") or "").strip() == composition_id
    ]


def _load_dialogue_graphs(project_root: Path) -> dict[str, dict[str, Any]]:
    base = project_root / "public" / "assets" / "dialogues" / "graphs"
    graphs: dict[str, dict[str, Any]] = {}
    if not base.is_dir():
        return graphs
    import json

    for path in sorted(base.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - diagnostics should stay best-effort
            continue
        if not isinstance(data, dict):
            continue
        graph_id = str(data.get("id") or path.stem).strip()
        if graph_id:
            graphs[graph_id] = data
    return graphs


def _action_read_write_edges(
    comp: dict[str, Any],
    dialogue_ids: list[str],
    dialogue_graphs: dict[str, dict[str, Any]],
) -> list[dict[str, str]]:
    edges: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()

    def add(kind: str, source: str, target: str, detail: str = "") -> None:
        key = (kind, source, target, detail)
        if key in seen:
            return
        seen.add(key)
        edges.append({"kind": kind, "source": source, "target": target, "detail": detail})

    def scan_conditions(source: str, value: Any) -> None:
        if isinstance(value, dict):
            if "flag" in value:
                add("flag-read", source, str(value.get("flag") or ""), _condition_detail(value))
            if "all" in value:
                scan_conditions(source, value.get("all"))
            if "any" in value:
                scan_conditions(source, value.get("any"))
            if "not" in value:
                scan_conditions(source, value.get("not"))
            for key, child in value.items():
                if key not in {"flag", "all", "any", "not"}:
                    scan_conditions(source, child)
        elif isinstance(value, list):
            for child in value:
                scan_conditions(source, child)

    def scan_actions(source: str, actions: Any) -> None:
        if not isinstance(actions, list):
            return
        for action in actions:
            if not isinstance(action, dict):
                continue
            typ = str(action.get("type") or "").strip()
            params = action.get("params") if isinstance(action.get("params"), dict) else {}
            if typ in {"setFlag", "clearFlag"}:
                key = str(params.get("key") or params.get("flag") or "").strip()
                if key:
                    add("flag-write", source, key, typ)
            elif typ == "emitNarrativeSignal":
                signal = str(params.get("signal") or "").strip()
                if signal:
                    add("signal-emit", source, signal, typ)
            elif typ in {"setQuestStatus", "startQuest", "completeQuest"}:
                quest = str(params.get("questId") or params.get("id") or "").strip()
                if quest:
                    add("quest-write", source, quest, typ)
            elif typ in {"startDialogueGraph", "debugStartDialogueGraph"}:
                graph = str(params.get("graphId") or "").strip()
                if graph:
                    add("dialogue-start", source, graph, typ)

    main_graph = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
    for transition in main_graph.get("transitions") or []:
        if isinstance(transition, dict):
            source = f"graph:{main_graph.get('id') or '?'} transition:{transition.get('id') or '?'}"
            scan_conditions(source, transition.get("conditions"))
            scan_actions(source, transition.get("actions"))
    for state_id, state in (main_graph.get("states") or {}).items():
        if isinstance(state, dict):
            source = f"graph:{main_graph.get('id') or '?'} state:{state_id}"
            scan_actions(source, state.get("onEnterActions"))
            scan_actions(source, state.get("onExitActions"))

    for element in comp.get("elements") or []:
        if not isinstance(element, dict):
            continue
        source = f"element:{element.get('id') or '?'}"
        scan_conditions(source, element.get("conditions"))
        meta = element.get("meta") if isinstance(element.get("meta"), dict) else {}
        scan_actions(source, meta.get("actions"))
        graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
        for transition in graph.get("transitions") or []:
            if isinstance(transition, dict):
                scan_conditions(f"{source} transition:{transition.get('id') or '?'}", transition.get("conditions"))
                scan_actions(f"{source} transition:{transition.get('id') or '?'}", transition.get("actions"))

    for graph_id in dialogue_ids:
        graph = dialogue_graphs.get(graph_id)
        if not graph:
            continue
        nodes = graph.get("nodes") if isinstance(graph.get("nodes"), dict) else {}
        for node_id, node in nodes.items():
            if not isinstance(node, dict):
                continue
            source = f"dialogue:{graph_id}.{node_id}"
            scan_conditions(source, node.get("condition"))
            scan_conditions(source, node.get("requireCondition"))
            scan_conditions(source, node.get("preconditions"))
            for choice in node.get("choices") or []:
                if isinstance(choice, dict):
                    scan_conditions(source, choice.get("requireCondition"))
            for case in node.get("cases") or []:
                if isinstance(case, dict):
                    scan_conditions(source, case.get("condition"))
            scan_actions(source, node.get("actions"))
    return edges


def _condition_detail(value: dict[str, Any]) -> str:
    if "value" in value:
        return f"== {value.get('value')}"
    return ""


def _dialogue_route_lines(dialogue_ids: list[str], dialogue_graphs: dict[str, dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for graph_id in dialogue_ids:
        graph = dialogue_graphs.get(graph_id)
        if not graph:
            lines.append(f"{graph_id}: graph 文件不存在")
            continue
        nodes = graph.get("nodes") if isinstance(graph.get("nodes"), dict) else {}
        entry = str(graph.get("entry") or "").strip() or "(无 entry)"
        edges: list[str] = []
        for node_id, node in nodes.items():
            if not isinstance(node, dict):
                continue
            next_id = str(node.get("next") or "").strip()
            if next_id:
                edges.append(f"{node_id}->{next_id}")
            default_next = str(node.get("defaultNext") or "").strip()
            if default_next:
                edges.append(f"{node_id}->default:{default_next}")
            for choice in node.get("choices") or []:
                if isinstance(choice, dict) and choice.get("next"):
                    label = str(choice.get("text") or choice.get("id") or "choice")
                    edges.append(f"{node_id}->choice:{label}->{choice.get('next')}")
            for case in node.get("cases") or []:
                if isinstance(case, dict) and case.get("next"):
                    label = str(case.get("state") or case.get("value") or "case")
                    edges.append(f"{node_id}->case:{label}->{case.get('next')}")
        preview = "; ".join(edges[:8])
        if len(edges) > 8:
            preview += f"; ... +{len(edges) - 8}"
        lines.append(f"{graph_id}: entry={entry}, nodes={len(nodes)}, route={preview or '(无边)'}")
    return lines


def _clean_node(node: str) -> str:
    if node.startswith("element:"):
        return node[len("element:"):]
    if node.startswith("graph:"):
        return node[len("graph:"):]
    if node.startswith("state:"):
        return node[len("state:"):]
    if node.startswith("transition-anchor:"):
        return node[len("transition-anchor:"):]
    return node or "?"


def _owner_boundary_warnings(comp: dict[str, Any], state_edges: list[dict[str, Any]]) -> list[str]:
    if not comp or not state_edges:
        return []
    graph_owners, element_owners = _owner_indexes(comp)
    warnings: list[str] = []
    seen: set[str] = set()
    for edge in state_edges:
        source = str(edge.get("source") or "")
        graph_id = str(edge.get("graphId") or "").strip()
        label = str(edge.get("label") or "").strip()
        detail = str(edge.get("detail") or "").strip()
        source_owner = _owner_for_source(source, graph_owners, element_owners)
        target_owner = graph_owners.get(graph_id)
        if source_owner is None and target_owner is None:
            message = f"{label}: owner 未知，仍是直接写 state 风险"
        elif source_owner is None:
            message = f"{label}: 来源 owner 未知 -> 目标 {_owner_label(target_owner)}"
        elif target_owner is None:
            message = f"{label}: {_owner_label(source_owner)} -> 目标 owner 未知"
        elif source_owner != target_owner:
            message = f"{label}: 跨 owner 直接写入 {_owner_label(source_owner)} -> {_owner_label(target_owner)}"
        else:
            message = f"{label}: {_owner_label(source_owner)} 内部直接写 state，仍会绕过 transition/conditions"
        if detail:
            message = f"{message} | {detail}"
        if message not in seen:
            seen.add(message)
            warnings.append(message)
    return warnings


def _owner_indexes(comp: dict[str, Any]) -> tuple[dict[str, tuple[str, str]], dict[str, tuple[str, str]]]:
    graph_owners: dict[str, tuple[str, str]] = {}
    element_owners: dict[str, tuple[str, str]] = {}
    main_graph = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
    main_owner = _owner_tuple(main_graph)
    main_gid = str(main_graph.get("id") or "").strip()
    if main_gid and main_owner:
        graph_owners[main_gid] = main_owner
    for element in comp.get("elements") or []:
        if not isinstance(element, dict):
            continue
        element_id = str(element.get("id") or "").strip()
        graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
        owner = _owner_tuple(element) or _owner_tuple(graph)
        if element_id and owner:
            element_owners[element_id] = owner
        graph_id = str(graph.get("id") or "").strip()
        graph_owner = _owner_tuple(graph) or owner
        if graph_id and graph_owner:
            graph_owners[graph_id] = graph_owner
    return graph_owners, element_owners


def _owner_for_source(
    source: str,
    graph_owners: dict[str, tuple[str, str]],
    element_owners: dict[str, tuple[str, str]],
) -> tuple[str, str] | None:
    clean = _clean_node(source)
    if source.startswith("element:"):
        return element_owners.get(clean)
    if source.startswith("graph:"):
        return graph_owners.get(clean)
    if source.startswith("state:") or ":state:" in source:
        return None
    return element_owners.get(clean) or graph_owners.get(clean)


def _owner_tuple(value: dict[str, Any]) -> tuple[str, str] | None:
    owner_type = str(value.get("ownerType") or "").strip()
    owner_id = str(value.get("ownerId") or "").strip()
    if owner_type and owner_id:
        return owner_type, owner_id
    return None


def _owner_label(owner: tuple[str, str] | None) -> str:
    if owner is None:
        return "unknown"
    return f"{owner[0]}:{owner[1]}"


def _issue_text(issue: dict[str, Any]) -> str:
    code = str(issue.get("code") or "issue")
    message = str(issue.get("message") or "")
    severity = str(issue.get("severity") or "")
    return f"{severity}:{code}: {message}".strip(": ")
