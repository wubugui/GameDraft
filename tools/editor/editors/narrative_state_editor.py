"""Narrative state machine editor wrapper.

The authoring canvas lives in a React Flow web app.  This PySide widget only
embeds that app and exposes the project model through QWebChannel.
"""
from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QUrl, Slot
from PySide6.QtWidgets import QLabel, QVBoxLayout, QWidget

try:
    from PySide6.QtWebChannel import QWebChannel
    from PySide6.QtWebEngineWidgets import QWebEngineView
except ImportError:  # pragma: no cover - depends on local Qt install
    QWebChannel = None  # type: ignore[assignment,misc]
    QWebEngineView = None  # type: ignore[assignment,misc]

from ..project_model import ProjectModel


EMPTY_NARRATIVE_GRAPHS = {"schemaVersion": 2, "compositions": []}


def _clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def _normalize_file(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return _clone(EMPTY_NARRATIVE_GRAPHS)
    out = _clone(value)
    out["schemaVersion"] = 2
    comps = out.get("compositions")
    if not isinstance(comps, list):
        out["compositions"] = []
    return out


def _walk_actions(obj: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if isinstance(obj, dict):
        if isinstance(obj.get("type"), str) and isinstance(obj.get("params"), dict):
            out.append(obj)
        for v in obj.values():
            out.extend(_walk_actions(v))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(_walk_actions(v))
    return out


def _walk_narrative_conditions(obj: Any) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if isinstance(obj, dict):
        graph_id = obj.get("narrative")
        state_id = obj.get("state")
        if graph_id is not None:
            out.append((str(graph_id), str(state_id or "")))
        for v in obj.values():
            out.extend(_walk_narrative_conditions(v))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(_walk_narrative_conditions(v))
    return out


class NarrativeEditorBridge(QObject):
    """Bridge object exposed to the React Flow editor through QWebChannel."""

    def __init__(self, model: ProjectModel, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._model = model

    @Slot(result=str)
    def getData(self) -> str:  # noqa: N802 - Qt slot name
        return json.dumps(_normalize_file(self._model.narrative_graphs), ensure_ascii=False)

    @Slot(str, result=str)
    def saveData(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return f"invalid json: {exc}"
        if not isinstance(parsed, dict):
            return "invalid narrative data: root must be an object"
        self._model.narrative_graphs = _normalize_file(parsed)
        self._model.mark_dirty("narrative_graphs")
        return "saved to ProjectModel"

    @Slot(str, result=str)
    def getProjection(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        try:
            parsed = json.loads(payload or "{}")
        except Exception:
            parsed = self._model.narrative_graphs
        result = derive_projection(_normalize_file(parsed), self._model)
        return json.dumps(result, ensure_ascii=False)

    @Slot(result=str)
    def getAuthoringCatalog(self) -> str:  # noqa: N802 - Qt slot name
        return json.dumps(authoring_catalog(self._model), ensure_ascii=False)

    @Slot(str, result=str)
    def validateData(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps([{
                "severity": "error",
                "code": "json.invalid",
                "message": f"JSON 无法解析：{exc}",
            }], ensure_ascii=False)
        normalized = _normalize_file(parsed)
        issues = validate_narrative_graphs(normalized)
        issues.extend(validate_external_state_command_targets(normalized, self._model))
        return json.dumps(issues, ensure_ascii=False)

    @Slot(result=str)
    def getRuntimeSnapshot(self) -> str:  # noqa: N802 - Qt slot name
        return json.dumps(self._run_game_js_result(
            "(() => {"
            "const api = window.__gameDevAPI;"
            "if (!api || typeof api.getNarrativeDebugSnapshot !== 'function') "
            "return {ok:false, reason:'Game dev API is not ready'};"
            "return {ok:true, snapshot:api.getNarrativeDebugSnapshot()};"
            "})()",
        ), ensure_ascii=False)

    @Slot(str, result=str)
    def emitRuntimeSignal(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid signal payload: {exc}"}, ensure_ascii=False)
        js_payload = json.dumps(parsed, ensure_ascii=False)
        return json.dumps(self._run_game_js_result(
            "(async () => {"
            "const api = window.__gameDevAPI;"
            "if (!api || typeof api.emitNarrativeSignal !== 'function') "
            "return {ok:false, reason:'Game dev API is not ready'};"
            f"await api.emitNarrativeSignal({js_payload});"
            "return {ok:true, snapshot:api.getNarrativeDebugSnapshot ? api.getNarrativeDebugSnapshot() : null};"
            "})()",
        ), ensure_ascii=False)

    @Slot(str, str, result=str)
    def setRuntimeNarrativeState(self, graph_id: str, state_id: str) -> str:  # noqa: N802 - Qt slot name
        gid = json.dumps((graph_id or "").strip(), ensure_ascii=False)
        sid = json.dumps((state_id or "").strip(), ensure_ascii=False)
        return json.dumps(self._run_game_js_result(
            "(async () => {"
            "const api = window.__gameDevAPI;"
            "if (!api || typeof api.setNarrativeState !== 'function') "
            "return {ok:false, reason:'Game dev API is not ready'};"
            f"await api.setNarrativeState({gid}, {sid});"
            "return {ok:true, snapshot:api.getNarrativeDebugSnapshot ? api.getNarrativeDebugSnapshot() : null};"
            "})()",
        ), ensure_ascii=False)

    @Slot(str, str, result=str)
    def editActions(self, label: str, payload: str) -> str:  # noqa: N802 - Qt slot name
        try:
            parsed = json.loads(payload or "[]")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid actions payload: {exc}"}, ensure_ascii=False)
        if not isinstance(parsed, list):
            return json.dumps({"ok": False, "reason": "actions payload must be a list"}, ensure_ascii=False)

        try:
            from PySide6.QtWidgets import QDialog, QDialogButtonBox
            from ..shared.action_editor import ActionEditor
        except Exception as exc:  # pragma: no cover - depends on full editor imports
            return json.dumps({"ok": False, "reason": f"ActionEditor is unavailable: {exc}"}, ensure_ascii=False)

        parent = self.parent() if isinstance(self.parent(), QWidget) else None
        dialog = QDialog(parent)
        title = (label or "Actions").strip() or "Actions"
        dialog.setWindowTitle(title)
        dialog.resize(860, 720)

        layout = QVBoxLayout(dialog)
        editor = ActionEditor(title, dialog)
        editor.set_project_context(self._model, None)
        editor.set_data([a for a in parsed if isinstance(a, dict)])
        layout.addWidget(editor, 1)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            dialog,
        )
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)

        if dialog.exec() != QDialog.DialogCode.Accepted:
            return json.dumps({"ok": False, "reason": "cancelled"}, ensure_ascii=False)
        return json.dumps({"ok": True, "actions": editor.to_list()}, ensure_ascii=False)

    @Slot(str, str)
    def navigate(self, kind: str, ref_id: str) -> None:
        kind = (kind or "").strip()
        ref_id = (ref_id or "").strip()
        if not kind or not ref_id:
            return
        win = self.parent()
        while win is not None and not hasattr(win, "navigate_to_dialogue_graph"):
            win = win.parent()
        if win is None:
            return
        if kind == "dialogue" and hasattr(win, "navigate_to_dialogue_graph"):
            win.navigate_to_dialogue_graph(ref_id)
        elif kind == "scenario" and hasattr(win, "navigate_to_scenario_catalog"):
            win.navigate_to_scenario_catalog(ref_id)
        elif hasattr(win, "_on_navigate_to_source"):
            if kind == "quest":
                win._on_navigate_to_source("quest", ref_id, "")
            elif kind == "sceneEntity":
                scene_id, source_id = _split_scene_ref(ref_id)
                win._on_navigate_to_source("scene_zone", source_id or ref_id, scene_id)

    def _run_game_js_result(self, code: str) -> dict[str, Any]:
        win = _find_main_window(self)
        game = getattr(win, "_game_play_window", None) if win is not None else None
        if game is None or not getattr(game, "is_available", lambda: False)():
            return {"ok": False, "reason": "Game window is not running"}
        run_js_result = getattr(game, "run_js_result", None)
        if not callable(run_js_result):
            return {"ok": False, "reason": "Game window does not support JS return values"}
        try:
            value = run_js_result(code)
        except Exception as exc:
            return {"ok": False, "reason": f"runtime JS failed: {exc}"}
        if isinstance(value, dict):
            return value
        return {"ok": False, "reason": "Runtime returned an empty result"}


class NarrativeStateEditor(QWidget):
    """PySide shell for the Web narrative composition editor."""

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._bridge = NarrativeEditorBridge(model, self)
        self._channel = None
        self._view = None

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        if QWebEngineView is None or QWebChannel is None:
            msg = QLabel("QtWebEngine / QtWebChannel is unavailable. The narrative editor web canvas cannot be embedded.")
            msg.setWordWrap(True)
            root.addWidget(msg)
            return

        self._view = QWebEngineView(self)
        self._channel = QWebChannel(self._view.page())
        self._channel.registerObject("narrativeBridge", self._bridge)
        self._view.page().setWebChannel(self._channel)
        root.addWidget(self._view, 1)
        self._load_web_editor()

    def flush_to_model(self) -> bool:
        return True

    def confirm_close(self, _parent: QWidget) -> bool:
        return True

    def reload_from_model(self) -> None:
        if self._view is not None:
            self._view.reload()

    def _load_web_editor(self) -> None:
        assert self._view is not None
        index = _web_editor_index()
        if index.is_file():
            self._view.load(QUrl.fromLocalFile(str(index)))
            return
        message = (
            "Narrative Web Editor is not built yet. "
            "Run `npm run build:narrative-editor` and reopen this tab."
        )
        self._view.setHtml(_placeholder_html(message))


def derive_projection(data: dict[str, Any], model: ProjectModel) -> dict[str, list[dict[str, Any]]]:
    trigger_edges: list[dict[str, Any]] = []
    read_edges: list[dict[str, Any]] = []
    state_command_edges: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()

    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id", "")).strip()
        main_graph = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
        elements = [e for e in comp.get("elements", []) or [] if isinstance(e, dict)]
        graph_node = _graph_node_index(main_graph, elements)
        signal_targets = _transition_targets(main_graph, elements)

        for element in elements:
            source_node = f"element:{element.get('id')}"
            meta = element.get("meta") if isinstance(element.get("meta"), dict) else {}
            for sig in _string_list(meta.get("emits")):
                for target in signal_targets.get(sig, []):
                    _add_edge(trigger_edges, seen, "trigger", source_node, target["node"], sig, target["detail"], comp_id, target.get("graphId", ""), target.get("transitionId", ""))
            for graph_id in _string_list(meta.get("reads")):
                source = graph_node.get(graph_id)
                if source:
                    _add_edge(read_edges, seen, "read", source, source_node, graph_id, f"{element.get('id')} reads {graph_id}", comp_id, graph_id)

        for source in _iter_action_signal_sources(model):
            sig = source["signal"]
            source_node = _source_node_for_action(source, elements)
            if not source_node:
                continue
            for target in signal_targets.get(sig, []):
                _add_edge(trigger_edges, seen, "trigger", source_node, target["node"], sig, source["detail"], comp_id, target.get("graphId", ""), target.get("transitionId", ""))

        for source in _iter_state_command_sources(model):
            source_node = _source_node_for_action(source, elements)
            target_node = graph_node.get(f'{source["graphId"]}.{source["stateId"]}') or graph_node.get(source["graphId"])
            if source_node and target_node:
                label = f'{source["graphId"]}.{source["stateId"]}'
                _add_edge(state_command_edges, seen, "stateCommand", source_node, target_node, label, source["detail"], comp_id, source["graphId"])

        for sig, targets in signal_targets.items():
            lifecycle = _lifecycle_source(sig, graph_node)
            if lifecycle:
                for target in targets:
                    _add_edge(trigger_edges, seen, "trigger", lifecycle["node"], target["node"], sig, lifecycle["detail"], comp_id, target.get("graphId", ""), target.get("transitionId", ""))

        for condition in _iter_condition_sources(model):
            source = graph_node.get(condition["graphId"])
            target = _source_node_for_condition(condition, elements)
            if source and target:
                label = condition["graphId"]
                if condition["stateId"]:
                    label = f'{label}.{condition["stateId"]}'
                _add_edge(read_edges, seen, "read", source, target, label, condition["detail"], comp_id, condition["graphId"])

        for target in _all_transition_condition_targets(main_graph, elements):
            for graph_id, state_id in target["conditions"]:
                source = graph_node.get(graph_id)
                if source:
                    label = f"{graph_id}.{state_id}" if state_id else graph_id
                    _add_edge(read_edges, seen, "read", source, target["node"], label, target["detail"], comp_id, graph_id, target.get("transitionId", ""))

    return {"triggerEdges": trigger_edges, "readEdges": read_edges, "stateCommandEdges": state_command_edges}


def authoring_catalog(model: ProjectModel) -> dict[str, Any]:
    try:
        from ..shared.action_editor import ACTION_TYPES, ACTION_PERSISTENCE, _PARAM_SCHEMAS
        action_types = [str(x) for x in ACTION_TYPES]
        action_param_schemas = {
            str(k): [[str(name), str(kind)] for name, kind in v]
            for k, v in _PARAM_SCHEMAS.items()
        }
        action_persistence = {str(k): str(v) for k, v in ACTION_PERSISTENCE.items()}
    except Exception:
        action_types = ["emitNarrativeSignal", "setNarrativeState"]
        action_param_schemas = {
            "emitNarrativeSignal": [["sourceType", "str"], ["sourceId", "str"], ["signal", "str"]],
            "setNarrativeState": [["graphId", "str"], ["stateId", "str"]],
        }
        action_persistence = {"emitNarrativeSignal": "save", "setNarrativeState": "save"}
    minigame_ids = [
        *[x[0] for x in model.all_water_minigame_ids()],
        *[x[0] for x in model.all_sugar_wheel_minigame_ids()],
        *[x[0] for x in model.all_paper_craft_minigame_ids()],
    ]
    scene_refs: list[str] = []
    zone_refs: list[str] = []
    for sid, scene in sorted(model.scenes.items()):
        if not isinstance(scene, dict):
            continue
        for key in ("npcs", "hotspots", "zones"):
            arr = scene.get(key)
            if not isinstance(arr, list):
                continue
            for e in arr:
                if not isinstance(e, dict):
                    continue
                eid = str(e.get("id", "")).strip()
                if not eid:
                    continue
                ref = f"{sid}:{eid}"
                scene_refs.append(ref)
                scene_refs.append(eid)
                if key == "zones":
                    zone_refs.append(ref)
                    zone_refs.append(eid)
    return {
        "dialogueGraphIds": model.all_dialogue_graph_ids(),
        "scenarioIds": model.scenario_ids_ordered(),
        "questIds": [x[0] for x in model.all_quest_ids()],
        "sceneEntityRefs": sorted(set(scene_refs)),
        "zoneRefs": sorted(set(zone_refs)),
        "minigameIds": sorted(set(minigame_ids)),
        "cutsceneIds": [x[0] for x in model.all_cutscene_ids()],
        "graphIds": model.narrative_graph_ids_ordered(),
        "actionTypes": action_types,
        "actionParamSchemas": action_param_schemas,
        "actionPersistence": action_persistence,
    }


def validate_narrative_graphs(data: dict[str, Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    comp_ids: set[str] = set()
    graph_ids: set[str] = set()
    graph_index = _build_graph_index(data)
    comps = data.get("compositions")
    if not isinstance(comps, list):
        return [{"severity": "error", "code": "compositions.shape", "message": "compositions 须为数组"}]
    for ci, comp in enumerate(comps):
        if not isinstance(comp, dict):
            _issue(issues, "error", "composition.shape", f"compositions[{ci}] 须为对象", f"compositions[{ci}]")
            continue
        cid = str(comp.get("id", "")).strip()
        _check_unique(issues, comp_ids, cid, "composition", f"compositions[{ci}].id")
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            _validate_graph(main, f"compositions[{ci}].mainGraph", issues, graph_ids, graph_index)
        else:
            _issue(issues, "error", "mainGraph.missing", f"{cid or ci}: 缺少 mainGraph", f"compositions[{ci}].mainGraph")
        elements = comp.get("elements")
        if not isinstance(elements, list):
            continue
        for ei, el in enumerate(elements):
            if not isinstance(el, dict):
                _issue(issues, "error", "element.shape", f"{cid}: element {ei + 1} 须为对象", f"compositions[{ci}].elements[{ei}]")
                continue
            eid = str(el.get("id", "")).strip()
            if not eid:
                _issue(issues, "error", "element.id.empty", f"{cid}: element id 不能为空", f"compositions[{ci}].elements[{ei}].id")
            kind = str(el.get("kind", "")).strip()
            if kind == "wrapperGraph" and not str(el.get("ownerId", "")).strip():
                _issue(issues, "warning", "wrapper.unbound", f"{eid}: wrapper 尚未绑定 ownerId", f"compositions[{ci}].elements[{ei}]", eid)
            if kind == "wrapperGraph" and str(el.get("ownerType", "")).strip() not in _VALID_WRAPPER_OWNER_TYPES:
                _issue(issues, "warning", "wrapper.ownerType.unsupported", f"{eid}: wrapper ownerType 不受运行时 owner 索引支持", f"compositions[{ci}].elements[{ei}].ownerType", eid)
            if kind == "scenarioSubgraph" and not (str(el.get("refId", "")).strip() or str(el.get("ownerId", "")).strip()):
                _issue(issues, "warning", "scenario.id.empty", f"{eid}: scenarioId 为空", f"compositions[{ci}].elements[{ei}]", eid)
            if kind not in ("wrapperGraph", "scenarioSubgraph") and not str(el.get("refId", "")).strip():
                _issue(issues, "warning", "blackbox.ref.empty", f"{eid}: 黑盒 refId 为空", f"compositions[{ci}].elements[{ei}]", eid)
            if kind in ("wrapperGraph", "scenarioSubgraph"):
                graph = el.get("graph")
                if isinstance(graph, dict):
                    _validate_graph(graph, f"compositions[{ci}].elements[{ei}].graph", issues, graph_ids, graph_index, kind)
                else:
                    _issue(issues, "error", "element.graph.missing", f"{eid}: 子图缺少 graph", f"compositions[{ci}].elements[{ei}].graph", eid)
            meta = el.get("meta") if isinstance(el.get("meta"), dict) else {}
            for key in ("emits", "reads"):
                if key in meta and not isinstance(meta.get(key), list):
                    _issue(issues, "warning", f"element.meta.{key}", f"{eid}: meta.{key} 应为字符串数组", f"compositions[{ci}].elements[{ei}].meta.{key}", eid)
            for graph_id in _string_list(meta.get("reads")):
                if graph_id not in graph_index:
                    _issue(issues, "warning", "projection.read.dangling", f"{eid}: reads 指向未知叙事图 {graph_id}", f"compositions[{ci}].elements[{ei}].meta.reads", eid)
    _validate_state_command_targets(data, graph_index, issues)
    return issues


def validate_external_state_command_targets(data: dict[str, Any], model: ProjectModel) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    graph_index = _build_graph_index(data)
    for source in _iter_state_command_sources(model):
        graph_id = str(source.get("graphId", "")).strip()
        state_id = str(source.get("stateId", "")).strip()
        graph = graph_index.get(graph_id, {})
        states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
        detail = str(source.get("detail", "")).strip()
        if state_id not in states:
            _issue(issues, "warning", "stateCommand.target.missing", f"{detail}: setNarrativeState 目标不存在 {graph_id}.{state_id}", detail)
            continue
        kind = str(graph.get("__elementKind", "")).strip()
        exits = [str(x).strip() for x in (graph.get("exitStates") if isinstance(graph.get("exitStates"), list) else [])]
        if (kind == "scenarioSubgraph" or str(graph.get("ownerType", "")).strip() == "scenario") and state_id != str(graph.get("entryState", "")).strip() and state_id not in exits:
            _issue(issues, "warning", "stateCommand.scenario.internal", f"{detail}: setNarrativeState 指向 scenario 内部状态 {graph_id}.{state_id}", detail)
    return issues


def _validate_graph(
    graph: dict[str, Any],
    path: str,
    issues: list[dict[str, Any]],
    graph_ids: set[str],
    graph_index: dict[str, dict[str, Any]],
    element_kind: str = "",
) -> None:
    gid = str(graph.get("id", "")).strip()
    _check_unique(issues, graph_ids, gid, "graph", f"{path}.id")
    states = graph.get("states")
    if not isinstance(states, dict):
        _issue(issues, "error", "states.shape", f"{gid}: states 须为对象", f"{path}.states", gid)
        states = {}
    initial = str(graph.get("initialState", "")).strip()
    if not initial or initial not in states:
        _issue(issues, "error", "initialState.invalid", f"{gid}: initialState 不存在", f"{path}.initialState", gid)
    if element_kind == "scenarioSubgraph" or str(graph.get("ownerType", "")).strip() == "scenario":
        entry = str(graph.get("entryState", "")).strip()
        exits = graph.get("exitStates")
        if not entry or entry not in states:
            _issue(issues, "error", "scenario.entryState.invalid", f"{gid}: scenario entryState 必须指向已存在 state", f"{path}.entryState", gid)
        if not isinstance(exits, list) or not [x for x in exits if str(x).strip()]:
            _issue(issues, "error", "scenario.exitStates.empty", f"{gid}: scenario 至少需要一个 exitState", f"{path}.exitStates", gid)
        elif any(str(x).strip() not in states for x in exits):
            _issue(issues, "error", "scenario.exitState.invalid", f"{gid}: scenario exitStates 中存在不存在的 state", f"{path}.exitStates", gid)
    for sid, state in states.items():
        if not isinstance(state, dict):
            _issue(issues, "error", "state.shape", f"{gid}.{sid}: state 须为对象", f"{path}.states.{sid}", str(sid))
            continue
        declared = str(state.get("id", "")).strip()
        if not declared:
            _issue(issues, "error", "state.id.empty", f"{gid}.{sid}: state.id 不能为空", f"{path}.states.{sid}.id", str(sid))
        elif declared != str(sid):
            _issue(issues, "warning", "state.id.keyMismatch", f"{gid}.{sid}: state.id 与键名不一致", f"{path}.states.{sid}.id", str(sid))
        _validate_actions(state.get("onEnterActions"), f"{path}.states.{sid}.onEnterActions", issues, f"{gid}.{sid}")
        _validate_actions(state.get("onExitActions"), f"{path}.states.{sid}.onExitActions", issues, f"{gid}.{sid}")
    transitions = graph.get("transitions")
    if not isinstance(transitions, list):
        _issue(issues, "error", "transitions.shape", f"{gid}: transitions 须为数组", f"{path}.transitions", gid)
        return
    transition_ids: set[str] = set()
    for ti, transition in enumerate(transitions):
        tpath = f"{path}.transitions[{ti}]"
        if not isinstance(transition, dict):
            _issue(issues, "error", "transition.shape", f"{gid}: transition {ti + 1} 须为对象", tpath, gid)
            continue
        tid = str(transition.get("id", "")).strip()
        _check_unique(issues, transition_ids, tid, "transition", f"{tpath}.id", tid)
        from_ep = _resolve_endpoint(transition.get("from"), gid)
        to_ep = _resolve_endpoint(transition.get("to"), gid)
        from_graph = graph_index.get(from_ep["graphId"], {})
        to_graph = graph_index.get(to_ep["graphId"], {})
        from_states = from_graph.get("states") if isinstance(from_graph.get("states"), dict) else {}
        to_states = to_graph.get("states") if isinstance(to_graph.get("states"), dict) else {}
        if from_ep["stateId"] not in from_states:
            _issue(issues, "error", "transition.from.missing", f"{gid}.{tid}: from state 不存在", f"{tpath}.from", tid)
        if to_ep["stateId"] not in to_states:
            _issue(issues, "error", "transition.to.missing", f"{gid}.{tid}: to state 不存在", f"{tpath}.to", tid)
        if from_ep["graphId"] != gid:
            _issue(issues, "error", "transition.owner.mismatch", f"{gid}.{tid}: transition 必须存放在 from 所属图 {from_ep['graphId']}", tpath, tid)
        _validate_cross_graph_boundary(graph_index, gid, tid, from_ep, to_ep, tpath, issues)
        if not str(transition.get("signal", "")).strip():
            _issue(issues, "error", "transition.signal.empty", f"{gid}.{tid}: signal 不能为空", f"{tpath}.signal", tid)
        _validate_conditions(transition.get("conditions"), f"{tpath}.conditions", issues, f"{gid}.{tid}")


_VALID_WRAPPER_OWNER_TYPES = {"npc", "hotspot", "zone", "quest", "dialogue", "minigame", "cutscene", "scenario", "system"}


def _build_graph_index(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            gid = str(main.get("id", "")).strip()
            if gid:
                out[gid] = main
        for el in comp.get("elements", []) or []:
            if not isinstance(el, dict):
                continue
            graph = el.get("graph")
            if isinstance(graph, dict):
                gid = str(graph.get("id", "")).strip()
                if gid:
                    indexed = dict(graph)
                    indexed["__elementKind"] = str(el.get("kind", "")).strip()
                    out[gid] = indexed
    return out


def _resolve_endpoint(raw: Any, owner_graph_id: str) -> dict[str, str]:
    if isinstance(raw, dict):
        return {
            "graphId": str(raw.get("graphId", "")).strip(),
            "stateId": str(raw.get("stateId", "")).strip(),
        }
    return {"graphId": owner_graph_id, "stateId": str(raw or "").strip()}


def _validate_cross_graph_boundary(
    graph_index: dict[str, dict[str, Any]],
    owner_graph_id: str,
    transition_id: str,
    from_ep: dict[str, str],
    to_ep: dict[str, str],
    path: str,
    issues: list[dict[str, Any]],
) -> None:
    if from_ep["graphId"] == to_ep["graphId"]:
        return
    from_graph = graph_index.get(from_ep["graphId"], {})
    to_graph = graph_index.get(to_ep["graphId"], {})
    from_kind = str(from_graph.get("__elementKind", "")).strip()
    to_kind = str(to_graph.get("__elementKind", "")).strip()
    if from_kind == "wrapperGraph" or to_kind == "wrapperGraph":
        _issue(issues, "error", "transition.wrapper.crossGraph", f"{owner_graph_id}.{transition_id}: wrapper graph 不能直接跨图连线", path, transition_id)
        return
    if (to_kind == "scenarioSubgraph" or str(to_graph.get("ownerType", "")).strip() == "scenario") and to_ep["stateId"] != str(to_graph.get("entryState", "")).strip():
        _issue(issues, "error", "scenario.boundary.entry", f"{owner_graph_id}.{transition_id}: 外部只能连接到 scenario entryState", f"{path}.to", transition_id)
    exits = [str(x).strip() for x in (from_graph.get("exitStates") if isinstance(from_graph.get("exitStates"), list) else [])]
    if (from_kind == "scenarioSubgraph" or str(from_graph.get("ownerType", "")).strip() == "scenario") and from_ep["stateId"] not in exits:
        _issue(issues, "error", "scenario.boundary.exit", f"{owner_graph_id}.{transition_id}: scenario 只能从 exitStates 连到外部", f"{path}.from", transition_id)


def _validate_state_command_targets(data: dict[str, Any], graph_index: dict[str, dict[str, Any]], issues: list[dict[str, Any]]) -> None:
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        graphs: list[dict[str, Any]] = []
        if isinstance(comp.get("mainGraph"), dict):
            graphs.append(comp["mainGraph"])
        for el in comp.get("elements", []) or []:
            if isinstance(el, dict) and isinstance(el.get("graph"), dict):
                graphs.append(el["graph"])
        for graph in graphs:
            gid = str(graph.get("id", "")).strip()
            states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
            for sid, state in states.items():
                if not isinstance(state, dict):
                    continue
                for list_name in ("onEnterActions", "onExitActions"):
                    actions = state.get(list_name)
                    if not isinstance(actions, list):
                        continue
                    for idx, action in enumerate(actions):
                        if not isinstance(action, dict) or action.get("type") != "setNarrativeState":
                            continue
                        params = action.get("params") if isinstance(action.get("params"), dict) else {}
                        target_gid = str(params.get("graphId", "")).strip()
                        target_sid = str(params.get("stateId", "")).strip()
                        target_graph = graph_index.get(target_gid, {})
                        target_states = target_graph.get("states") if isinstance(target_graph.get("states"), dict) else {}
                        if target_sid not in target_states:
                            _issue(issues, "warning", "stateCommand.target.missing", f"{gid}.{sid}: setNarrativeState 目标不存在 {target_gid}.{target_sid}", f"{gid}.{sid}.{list_name}[{idx}]", gid)
                            continue
                        target_kind = str(target_graph.get("__elementKind", "")).strip()
                        exits = [str(x).strip() for x in (target_graph.get("exitStates") if isinstance(target_graph.get("exitStates"), list) else [])]
                        if (target_kind == "scenarioSubgraph" or str(target_graph.get("ownerType", "")).strip() == "scenario") and target_sid != str(target_graph.get("entryState", "")).strip() and target_sid not in exits:
                            _issue(issues, "warning", "stateCommand.scenario.internal", f"{gid}.{sid}: setNarrativeState 指向 scenario 内部状态 {target_gid}.{target_sid}", f"{gid}.{sid}.{list_name}[{idx}]", gid)


def _validate_actions(raw: Any, path: str, issues: list[dict[str, Any]], owner: str) -> None:
    if raw is None:
        return
    if not isinstance(raw, list):
        _issue(issues, "warning", "actions.shape", f"{owner}: Actions 应为数组", path, owner)
        return
    for i, action in enumerate(raw):
        if not isinstance(action, dict) or not str(action.get("type", "")).strip():
            _issue(issues, "warning", "action.shape", f"{owner}: action {i + 1} 缺少 type", f"{path}[{i}]", owner)


def _validate_conditions(raw: Any, path: str, issues: list[dict[str, Any]], owner: str) -> None:
    if raw is None:
        return
    if not isinstance(raw, list):
        _issue(issues, "warning", "conditions.shape", f"{owner}: conditions 应为数组", path, owner)
        return
    for i, expr in enumerate(raw):
        if not _is_condition_shape(expr):
            _issue(issues, "warning", "condition.shape", f"{owner}: condition {i + 1} 形状未知", f"{path}[{i}]", owner)


def _is_condition_shape(expr: Any) -> bool:
    if not isinstance(expr, dict):
        return False
    if isinstance(expr.get("all"), list):
        return all(_is_condition_shape(x) for x in expr["all"])
    if isinstance(expr.get("any"), list):
        return all(_is_condition_shape(x) for x in expr["any"])
    if "not" in expr:
        return _is_condition_shape(expr["not"])
    return any(isinstance(expr.get(k), str) for k in ("narrative", "flag", "quest", "scenario", "scenarioLine"))


def _check_unique(
    issues: list[dict[str, Any]],
    seen: set[str],
    value: str,
    label: str,
    path: str,
    item_id: str | None = None,
) -> None:
    if not value:
        _issue(issues, "error", f"{label}.empty", f"{label} id 不能为空", path, item_id)
        return
    if value in seen:
        _issue(issues, "error", f"{label}.duplicate", f"{label} id 重复：{value}", path, item_id or value)
    seen.add(value)


def _issue(
    issues: list[dict[str, Any]],
    severity: str,
    code: str,
    message: str,
    path: str | None = None,
    item_id: str | None = None,
) -> None:
    out = {"severity": severity, "code": code, "message": message}
    if path:
        out["path"] = path
    if item_id:
        out["itemId"] = item_id
    issues.append(out)


def _find_main_window(obj: QObject) -> QObject | None:
    win: QObject | None = obj
    while win is not None and not hasattr(win, "_game_play_window"):
        win = win.parent()
    return win


def _web_editor_index() -> Path:
    return Path(__file__).resolve().parents[2] / "narrative_editor_web" / "dist" / "index.html"


def _placeholder_html(message: str) -> str:
    safe = html.escape(message)
    return (
        "<!doctype html><html><meta charset='utf-8'><body "
        "style='margin:0;height:100vh;display:flex;align-items:center;justify-content:center;"
        "background:#191b1f;color:#c9d3dc;font:15px system-ui,sans-serif'>"
        f"<p>{safe}</p></body></html>"
    )


def _graph_node_index(main_graph: dict[str, Any], elements: list[dict[str, Any]]) -> dict[str, str]:
    out: dict[str, str] = {}
    gid = str(main_graph.get("id", "")).strip()
    if gid:
        out[gid] = f"graph:{gid}"
        for sid in (main_graph.get("states") or {}).keys():
            out[f"{gid}.{sid}"] = f"state:{sid}"
    for e in elements:
        graph = e.get("graph") if isinstance(e.get("graph"), dict) else None
        if graph:
            gid = str(graph.get("id", "")).strip()
            if gid:
                out[gid] = f"element:{e.get('id')}"
                for sid in (graph.get("states") or {}).keys():
                    out[f"{gid}.{sid}"] = f"subgraph:{e.get('id')}:state:{sid}"
    return out


def _transition_targets(main_graph: dict[str, Any], elements: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    gid = str(main_graph.get("id", "")).strip()
    for t in main_graph.get("transitions", []) or []:
        if not isinstance(t, dict):
            continue
        sig = str(t.get("signal", "")).strip()
        tid = str(t.get("id", "")).strip()
        if sig and tid:
            out.setdefault(sig, []).append({"node": _transition_anchor(gid, tid), "detail": f"{gid}.{tid}", "graphId": gid, "transitionId": tid})
    for e in elements:
        graph = e.get("graph") if isinstance(e.get("graph"), dict) else None
        if not graph:
            continue
        gid = str(graph.get("id", "")).strip()
        for t in graph.get("transitions", []) or []:
            if not isinstance(t, dict):
                continue
            sig = str(t.get("signal", "")).strip()
            tid = str(t.get("id", "")).strip()
            if sig and tid:
                out.setdefault(sig, []).append({"node": _transition_anchor(gid, tid), "detail": f"{gid}.{tid}", "graphId": gid, "transitionId": tid})
    return out


def _add_edge(
    bucket: list[dict[str, Any]],
    seen: set[tuple[str, str, str, str]],
    kind: str,
    source: str,
    target: str,
    label: str,
    detail: str,
    composition_id: str = "",
    graph_id: str = "",
    transition_id: str = "",
) -> None:
    if not source or not target or source == target:
        return
    key = (kind, source, target, label)
    if key in seen:
        return
    seen.add(key)
    edge = {
        "id": f"{kind}:{len(seen)}",
        "kind": kind,
        "source": source,
        "target": target,
        "label": label,
        "detail": detail,
        "readonly": True,
    }
    if composition_id:
        edge["compositionId"] = composition_id
    if graph_id:
        edge["graphId"] = graph_id
    if transition_id:
        edge["transitionId"] = transition_id
    bucket.append(edge)


def _iter_action_signal_sources(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for gid in model.all_dialogue_graph_ids():
        path = model.dialogues_path / "graphs" / f"{gid}.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        _collect_emit_actions(out, f"dialogue:{gid}", "dialogue", gid, data)
    for sid, scene in model.scenes.items():
        for zone in scene.get("zones", []) or []:
            if not isinstance(zone, dict):
                continue
            zid = str(zone.get("id", "")).strip()
            for ev in ("onEnter", "onStay", "onExit"):
                _collect_emit_actions(out, f"zone:{sid}:{zid}:{ev}", "zone", zid, zone.get(ev, []))
        _collect_emit_actions(out, f"scene:{sid}", "scene", sid, scene.get("onEnter", []))
    for iid, inst in model.water_minigames_instances.items():
        _collect_emit_actions(out, f"minigame:{iid}", "minigame", iid, inst)
    for quest in model.quests:
        if isinstance(quest, dict):
            qid = str(quest.get("id", "")).strip()
            _collect_emit_actions(out, f"quest:{qid}", "quest", qid, quest)
    return out


def _iter_state_command_sources(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for gid in model.all_dialogue_graph_ids():
        path = model.dialogues_path / "graphs" / f"{gid}.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        _collect_state_command_actions(out, f"dialogue:{gid}", "dialogue", gid, data)
    for sid, scene in model.scenes.items():
        for zone in scene.get("zones", []) or []:
            if not isinstance(zone, dict):
                continue
            zid = str(zone.get("id", "")).strip()
            for ev in ("onEnter", "onStay", "onExit"):
                _collect_state_command_actions(out, f"zone:{sid}:{zid}:{ev}", "zone", zid, zone.get(ev, []))
        _collect_state_command_actions(out, f"scene:{sid}", "scene", sid, scene.get("onEnter", []))
    for iid, inst in model.water_minigames_instances.items():
        _collect_state_command_actions(out, f"minigame:{iid}", "minigame", iid, inst)
    for quest in model.quests:
        if isinstance(quest, dict):
            qid = str(quest.get("id", "")).strip()
            _collect_state_command_actions(out, f"quest:{qid}", "quest", qid, quest)
    return out


def _collect_emit_actions(out: list[dict[str, str]], detail: str, kind: str, ref_id: str, obj: Any) -> None:
    for action in _walk_actions(obj):
        if action.get("type") != "emitNarrativeSignal":
            continue
        params = action.get("params") if isinstance(action.get("params"), dict) else {}
        source_type = str(params.get("sourceType", "")).strip()
        source_id = str(params.get("sourceId", "")).strip()
        signal = str(params.get("signal", "")).strip()
        if not source_type or not source_id or not signal:
            continue
        out.append({
            "signal": f"external:{source_type}:{source_id}:{signal}",
            "kind": kind,
            "refId": ref_id,
            "detail": detail,
        })


def _collect_state_command_actions(out: list[dict[str, str]], detail: str, kind: str, ref_id: str, obj: Any) -> None:
    for action in _walk_actions(obj):
        if action.get("type") != "setNarrativeState":
            continue
        params = action.get("params") if isinstance(action.get("params"), dict) else {}
        graph_id = str(params.get("graphId", "")).strip()
        state_id = str(params.get("stateId", "")).strip()
        if not graph_id or not state_id:
            continue
        out.append({
            "graphId": graph_id,
            "stateId": state_id,
            "kind": kind,
            "refId": ref_id,
            "detail": detail,
        })


def _source_node_for_action(source: dict[str, str], elements: list[dict[str, Any]]) -> str:
    signal = source.get("signal", "")
    if signal:
        for e in elements:
            meta = e.get("meta") if isinstance(e.get("meta"), dict) else {}
            if signal in _string_list(meta.get("emits")):
                return f"element:{e.get('id')}"
    kind = source.get("kind")
    ref_id = source.get("refId")
    for e in elements:
        ek = str(e.get("kind", ""))
        er = str(e.get("refId", "")).strip()
        if kind == "dialogue" and ek == "dialogueBlackbox" and er == ref_id:
            return f"element:{e.get('id')}"
        if kind == "minigame" and ek == "minigameBlackbox" and er == ref_id:
            return f"element:{e.get('id')}"
        if kind == "zone" and ek == "zoneBlackbox" and (er.endswith(f":{ref_id}") or er == ref_id):
            return f"element:{e.get('id')}"
    return ""


def _lifecycle_source(signal: str, graph_node: dict[str, str]) -> dict[str, str] | None:
    for prefix in ("stateEntered:", "stateExited:"):
        if signal.startswith(prefix):
            rest = signal[len(prefix):]
            graph_id, _, state_id = rest.partition(":")
            node = graph_node.get(f"{graph_id}.{state_id}") or graph_node.get(graph_id)
            if node:
                return {"node": node, "detail": signal}
    return None


def _iter_condition_sources(model: ProjectModel) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for gid in model.all_dialogue_graph_ids():
        path = model.dialogues_path / "graphs" / f"{gid}.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for graph_id, state_id in _walk_narrative_conditions(data):
            out.append({"graphId": graph_id, "stateId": state_id, "kind": "dialogue", "refId": gid, "detail": f"dialogue:{gid}"})
    for quest in model.quests:
        if not isinstance(quest, dict):
            continue
        qid = str(quest.get("id", "")).strip()
        for graph_id, state_id in _walk_narrative_conditions(quest):
            out.append({"graphId": graph_id, "stateId": state_id, "kind": "quest", "refId": qid, "detail": f"quest:{qid}"})
    return out


def _source_node_for_condition(condition: dict[str, str], elements: list[dict[str, Any]]) -> str:
    kind = condition.get("kind")
    ref_id = condition.get("refId")
    for e in elements:
        ek = str(e.get("kind", ""))
        if kind == "dialogue" and ek == "dialogueBlackbox" and str(e.get("refId", "")).strip() == ref_id:
            return f"element:{e.get('id')}"
        if kind == "quest" and e.get("ownerType") == "quest" and str(e.get("ownerId", "")).strip() == ref_id:
            return f"element:{e.get('id')}"
    return ""


def _all_transition_condition_targets(main_graph: dict[str, Any], elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    gid = str(main_graph.get("id", "")).strip()
    for t in main_graph.get("transitions", []) or []:
        if isinstance(t, dict):
            conds = _walk_narrative_conditions(t.get("conditions", []))
            if conds:
                tid = str(t.get("id", "")).strip()
                out.append({"node": _transition_anchor(gid, tid), "conditions": conds, "detail": f"{gid}.{tid}", "graphId": gid, "transitionId": tid})
    for e in elements:
        graph = e.get("graph") if isinstance(e.get("graph"), dict) else None
        if not graph:
            continue
        gid = str(graph.get("id", "")).strip()
        for t in graph.get("transitions", []) or []:
            if isinstance(t, dict):
                conds = _walk_narrative_conditions(t.get("conditions", []))
                if conds:
                    tid = str(t.get("id", "")).strip()
                    out.append({"node": _transition_anchor(gid, tid), "conditions": conds, "detail": f"{gid}.{tid}", "graphId": gid, "transitionId": tid})
    return out


def _transition_anchor(graph_id: str, transition_id: str) -> str:
    return f"transition-anchor:{graph_id}:{transition_id}"


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(x).strip() for x in value if str(x).strip()]


def _split_scene_ref(ref_id: str) -> tuple[str, str]:
    if ":" not in ref_id:
        return "", ref_id
    scene_id, entity_id = ref_id.split(":", 1)
    return scene_id, entity_id
