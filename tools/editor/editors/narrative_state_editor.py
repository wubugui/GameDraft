"""Narrative state machine editor wrapper.

The authoring canvas lives in a React Flow web app.  This PySide widget only
embeds that app and exposes the project model through QWebChannel.
"""
from __future__ import annotations

import html
import json
import os
from pathlib import Path
from typing import Any

from PySide6.QtCore import QEventLoop, QObject, Qt, QTimer, QUrl, Slot
from PySide6.QtGui import QContextMenuEvent, QKeySequence, QShortcut
from PySide6.QtWidgets import QLabel, QMessageBox, QVBoxLayout, QWidget, QSizePolicy

try:
    from PySide6.QtWebChannel import QWebChannel
    from PySide6.QtWebEngineWidgets import QWebEngineView

    from ..web_engine_page import QuietWebEnginePage

    class _NarrativeWebView(QWebEngineView):
        """Suppress Chromium / Qt WebEngine right-click menus on the narrative canvas."""

        def __init__(self, parent: QWidget | None = None) -> None:
            super().__init__(parent)
            self.setPage(QuietWebEnginePage(self))

        def contextMenuEvent(self, event: QContextMenuEvent) -> None:
            event.accept()

except ImportError:  # pragma: no cover - depends on local Qt install
    QWebChannel = None  # type: ignore[assignment,misc]
    QWebEngineView = None  # type: ignore[assignment,misc]
    _NarrativeWebView = None  # type: ignore[assignment,misc]

from ..project_model import ProjectModel
from .narrative_anchor_codec import transition_anchor_id


DEFAULT_DRAFT_SIGNAL = "__draft__"
DERIVED_STATE_SIGNAL_PREFIX = "state:"
NARRATIVE_SCHEMA_VERSION = 3
EMPTY_NARRATIVE_GRAPHS = {"schemaVersion": NARRATIVE_SCHEMA_VERSION, "signals": [], "compositions": []}

# Point QWebEngine at a Vite dev server for HMR, e.g. http://127.0.0.1:5174/
NARRATIVE_EDITOR_DEV_URL_ENV = "GAMEDRAFT_NARRATIVE_EDITOR_URL"


def _clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def _state_entered_signal_key(graph_id: str, state_id: str) -> str:
    return f"{DERIVED_STATE_SIGNAL_PREFIX}{graph_id}:{state_id}"


def _parse_derived_state_signal(signal: str) -> tuple[str, str] | None:
    key = str(signal or "").strip()
    if not key.startswith(DERIVED_STATE_SIGNAL_PREFIX):
        return None
    rest = key[len(DERIVED_STATE_SIGNAL_PREFIX):]
    graph_id, sep, state_id = rest.partition(":")
    if sep and graph_id and state_id:
        return graph_id, state_id
    return None


def _state_broadcast_on_enter(state: Any) -> bool:
    return isinstance(state, dict) and state.get("broadcastOnEnter") is True


def _apply_derived_broadcast_auto_mark(data: dict[str, Any]) -> None:
    graph_index = _build_graph_index(data)
    for graph in graph_index.values():
        transitions = graph.get("transitions")
        if not isinstance(transitions, list):
            continue
        for transition in transitions:
            if not isinstance(transition, dict):
                continue
            parsed = _parse_derived_state_signal(str(transition.get("signal", "")).strip())
            if not parsed:
                continue
            source_graph = graph_index.get(parsed[0])
            states = source_graph.get("states") if isinstance(source_graph, dict) else None
            if not isinstance(states, dict):
                continue
            state = states.get(parsed[1])
            if isinstance(state, dict):
                state["broadcastOnEnter"] = True


def _migrate_legacy_signal_key(raw: str) -> str:
    key = str(raw or "").strip()
    if not key:
        return DEFAULT_DRAFT_SIGNAL
    if key == DEFAULT_DRAFT_SIGNAL or key.startswith(DERIVED_STATE_SIGNAL_PREFIX):
        return key
    if key.startswith("external:state:"):
        parts = key.split(":")
        if len(parts) >= 4:
            return _state_entered_signal_key(parts[2], ":".join(parts[3:]))
    if key.startswith("stateEntered:"):
        rest = key[len("stateEntered:"):]
        graph_id, sep, state_id = rest.partition(":")
        if sep:
            return _state_entered_signal_key(graph_id, state_id)
    if key.startswith("external:") and len(key.split(":")) >= 4:
        return key.split(":", 3)[3]
    return key


def _migrate_narrative_signals_v3(data: dict[str, Any]) -> dict[str, Any]:
    out = _clone(data)
    out["schemaVersion"] = NARRATIVE_SCHEMA_VERSION
    signals = out.get("signals")
    if not isinstance(signals, list):
        signals = []
    author: list[dict[str, Any]] = [s for s in signals if isinstance(s, dict)]
    author_ids = {str(s.get("id", "")).strip() for s in author}

    def _ensure_author(sig: str) -> None:
        if not sig or sig == DEFAULT_DRAFT_SIGNAL or sig.startswith(DERIVED_STATE_SIGNAL_PREFIX):
            return
        if sig in author_ids:
            return
        author_ids.add(sig)
        author.append({"id": sig, "label": sig})

    for comp in out.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            for t in main.get("transitions", []) or []:
                if isinstance(t, dict):
                    migrated = _migrate_legacy_signal_key(str(t.get("signal", "")))
                    _ensure_author(migrated)
                    t["signal"] = migrated
        for el in comp.get("elements", []) or []:
            if not isinstance(el, dict):
                continue
            meta = el.get("meta") if isinstance(el.get("meta"), dict) else {}
            emits = meta.get("emits")
            if isinstance(emits, list):
                meta["emits"] = [_migrate_legacy_signal_key(str(x)) for x in emits]
            graph = el.get("graph")
            if isinstance(graph, dict):
                for t in graph.get("transitions", []) or []:
                    if isinstance(t, dict):
                        migrated = _migrate_legacy_signal_key(str(t.get("signal", "")))
                        _ensure_author(migrated)
                        t["signal"] = migrated
    out["signals"] = author
    return out


def _normalize_file(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return _clone(EMPTY_NARRATIVE_GRAPHS)
    out = _clone(value)
    if int(out.get("schemaVersion", 0) or 0) < NARRATIVE_SCHEMA_VERSION:
        out = _migrate_narrative_signals_v3(out)
    out["schemaVersion"] = NARRATIVE_SCHEMA_VERSION
    if not isinstance(out.get("signals"), list):
        out["signals"] = []
    comps = out.get("compositions")
    if not isinstance(comps, list):
        out["compositions"] = []
    _normalize_reactive_triggers(out)
    _apply_derived_broadcast_auto_mark(out)
    return out


def _iter_narrative_graphs(data: dict[str, Any]):
    """Yield every NarrativeGraph dict reachable from the file root."""
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            yield main
        for el in comp.get("elements", []) or []:
            if isinstance(el, dict) and isinstance(el.get("graph"), dict):
                yield el["graph"]


def _normalize_reactive_triggers(data: dict[str, Any]) -> None:
    """Clear trigger values that are not one of the valid reactive modes."""
    for graph in _iter_narrative_graphs(data):
        for transition in graph.get("transitions", []) or []:
            if not isinstance(transition, dict):
                continue
            trigger = transition.get("trigger")
            if trigger not in ("reactive", "reactiveAll", "reactiveAny"):
                transition.pop("trigger", None)


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


def _asset_record(kind: str, ref_id: str, detail: str, root: Any) -> dict[str, Any]:
    return {"kind": kind, "refId": ref_id, "detail": detail, "root": root}


def _visit_narrative_assets(model: ProjectModel) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []

    def add(kind: str, ref_id: object, detail: str, root: Any) -> None:
        assets.append(_asset_record(kind, str(ref_id or "").strip(), detail, root))

    for gid in model.all_dialogue_graph_ids():
        path = model.dialogues_path / "graphs" / f"{gid}.json"
        try:
            add("dialogue", gid, f"dialogue:{gid}", json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            continue
    for sid, scene in model.scenes.items():
        if not isinstance(scene, dict):
            continue
        add("scene", sid, f"scene:{sid}", scene.get("onEnter", []))
        for zone in scene.get("zones", []) or []:
            if not isinstance(zone, dict):
                continue
            zid = str(zone.get("id", "")).strip()
            for ev in ("onEnter", "onStay", "onExit"):
                add("zone", zid, f"zone:{sid}:{zid}:{ev}", zone.get(ev, []))
    for iid, inst in model.water_minigames_instances.items():
        add("minigame", iid, f"minigame:{iid}", inst)
    for iid, inst in model.sugar_wheel_instances.items():
        add("minigame", iid, f"minigame:{iid}", inst)
    for iid, inst in model.paper_craft_instances.items():
        add("minigame", iid, f"minigame:{iid}", inst)
    for quest in model.quests:
        if isinstance(quest, dict):
            qid = str(quest.get("id", "")).strip()
            add("quest", qid, f"quest:{qid}", quest)
    for doc in model.document_reveals:
        if isinstance(doc, dict):
            did = str(doc.get("id", "") or doc.get("documentId", "")).strip()
            add("document", did, f"document:{did}", doc)
    for archive_kind, root in (
        ("archiveCharacter", model.archive_characters),
        ("archiveLore", model.archive_lore),
        ("archiveBook", model.archive_books),
        ("archiveDocument", model.archive_documents),
    ):
        add(archive_kind, "", archive_kind, root)
    for cutscene in model.cutscenes:
        if isinstance(cutscene, dict):
            cid = str(cutscene.get("id", "")).strip()
            add("cutscene", cid, f"cutscene:{cid}", cutscene)
    return assets


def _asset_emit_sources(assets: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for asset in assets:
        _collect_emit_actions(out, asset["detail"], asset["kind"], asset["refId"], asset.get("root"))
    return out


def _asset_state_command_sources(assets: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for asset in assets:
        _collect_state_command_actions(out, asset["detail"], asset["kind"], asset["refId"], asset.get("root"))
    return out


def _asset_condition_sources(assets: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for asset in assets:
        for graph_id, state_id in _walk_narrative_conditions(asset.get("root")):
            out.append({
                "graphId": graph_id,
                "stateId": state_id,
                "kind": asset["kind"],
                "refId": asset["refId"],
                "detail": asset["detail"],
            })
    return out


def _asset_owner_state_sources(assets: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for asset in assets:
        if asset.get("kind") != "dialogue":
            continue
        root = asset.get("root")
        nodes = root.get("nodes") if isinstance(root, dict) else {}
        if not isinstance(nodes, dict):
            continue
        for node_id, node in nodes.items():
            if isinstance(node, dict) and node.get("type") == "ownerState":
                out.append({
                    "dialogueGraphId": str(asset.get("refId", "")).strip(),
                    "nodeId": str(node_id).strip(),
                    "detail": f'{asset.get("detail", "")}:{node_id}',
                })
    return out


def _asset_context_state_sources(assets: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for asset in assets:
        if asset.get("kind") != "dialogue":
            continue
        root = asset.get("root")
        nodes = root.get("nodes") if isinstance(root, dict) else {}
        if not isinstance(nodes, dict):
            continue
        for node_id, node in nodes.items():
            if isinstance(node, dict) and node.get("type") == "contextState":
                out.append({
                    "dialogueGraphId": str(asset.get("refId", "")).strip(),
                    "nodeId": str(node_id).strip(),
                    "graphId": str(node.get("graphId", "")).strip(),
                    "detail": f'{asset.get("detail", "")}:{node_id}',
                })
    return out


def _validation_errors_for_save(data: dict[str, Any], model: ProjectModel) -> list[dict[str, Any]]:
    issues = validate_project_context(data, model)
    return [issue for issue in issues if issue.get("severity") == "error"]


def validate_project_context(data: dict[str, Any], model: ProjectModel) -> list[dict[str, Any]]:
    """Return validation issues that require Python-side project/assets context.

    Structural narrative graph validation is owned by src/core/narrativeGraphValidation.ts.
    """
    return validate_external_state_command_targets(data, model)


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
        normalized = _normalize_file(parsed)
        errors = _validation_errors_for_save(normalized, self._model)
        if errors:
            return f"save blocked: {len(errors)} validation error(s)"
        self._model.narrative_graphs = normalized
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
        issues = validate_project_context(normalized, self._model)
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
            "const setState = api && (api.debugSetNarrativeState || api.setNarrativeState);"
            "if (typeof setState !== 'function') "
            "return {ok:false, reason:'Game dev debug API is not ready'};"
            f"await setState({gid}, {sid});"
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
        self._last_flush_error: str | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)

        if QWebEngineView is None or QWebChannel is None:
            msg = QLabel("QtWebEngine / QtWebChannel is unavailable. The narrative editor web canvas cannot be embedded.")
            msg.setWordWrap(True)
            root.addWidget(msg)
            return

        no_menu = Qt.ContextMenuPolicy.NoContextMenu
        self.setContextMenuPolicy(no_menu)

        self._view = _NarrativeWebView(self)
        self._view.setContextMenuPolicy(no_menu)
        self._view.setMinimumSize(0, 0)
        self._view.setSizePolicy(
            QSizePolicy.Policy.Ignored,
            QSizePolicy.Policy.Ignored,
        )
        self._channel = QWebChannel(self._view.page())
        self._channel.registerObject("narrativeBridge", self._bridge)
        self._view.page().setWebChannel(self._channel)
        root.addWidget(self._view, 1)
        self._load_web_editor()

        save_shortcut = QShortcut(QKeySequence.StandardKey.Save, self)
        save_shortcut.activated.connect(self._toolbar_save)
        reload_shortcut = QShortcut(QKeySequence(Qt.Key.Key_F5), self)
        reload_shortcut.activated.connect(self._toolbar_reload_page)

    def _toolbar_save(self) -> None:
        self.flush_to_model()

    def _toolbar_refresh(self) -> None:
        if self._view is None:
            return
        self._run_editor_js_result(
            "window.__narrativeEditor && window.__narrativeEditor.refresh"
            " ? (window.__narrativeEditor.refresh(), true) : false",
        )

    def _toolbar_reload_page(self) -> None:
        if self._view is None:
            return
        url = _web_editor_load_url()
        if url is not None:
            self._view.load(url)
            return
        self._load_web_editor()

    def pop_flush_error(self) -> str | None:
        message = self._last_flush_error
        self._last_flush_error = None
        return message

    def _read_pending_editor_json(self, attempts: int = 10, wait_ms: int = 180) -> str | None:
        code = "(window.__narrativeEditor && window.__narrativeEditor.getCurrentDataJson()) || null"
        for attempt in range(attempts):
            value = self._run_editor_js_result(code, timeout_ms=2000)
            if isinstance(value, str) and value.strip():
                return value
            if attempt + 1 >= attempts:
                break
            loop = QEventLoop()
            QTimer.singleShot(wait_ms, loop.quit)
            loop.exec()
        return None

    def flush_to_model(self, *, for_save_all: bool = False) -> bool:
        self._last_flush_error = None
        if self._view is None:
            return True
        payload = self._read_pending_editor_json()
        if not isinstance(payload, str) or not payload.strip():
            return True
        try:
            parsed = json.loads(payload)
        except Exception as exc:
            self._last_flush_error = f"叙事编辑器返回了无效 JSON：{exc}"
            if not for_save_all:
                QMessageBox.warning(self, "叙事保存", self._last_flush_error)
            return False
        normalized = _normalize_file(parsed)
        errors = _validation_errors_for_save(normalized, self._model)
        if errors:
            preview = "\n".join(str(e.get("message") or e.get("code")) for e in errors[:8])
            if len(errors) > 8:
                preview += f"\n… 共 {len(errors)} 条"
            self._last_flush_error = f"叙事图校验未通过（{len(errors)} 个错误），无法写入工程：\n{preview}"
            if not for_save_all:
                QMessageBox.warning(self, "叙事保存被拦截", self._last_flush_error)
            return False
        if normalized != _normalize_file(self._model.narrative_graphs):
            self._model.narrative_graphs = normalized
            self._model.mark_dirty("narrative_graphs")
        self._run_editor_js_result(
            "window.__narrativeEditor && window.__narrativeEditor.markSaved"
            " ? (window.__narrativeEditor.markSaved(), true) : false",
        )
        return True

    def confirm_close(self, parent: QWidget) -> bool:
        if self._view is None:
            return True
        dirty = self._run_editor_js_result(
            "window.__narrativeEditor && window.__narrativeEditor.isDirty"
            " ? window.__narrativeEditor.isDirty() : false",
        )
        if dirty is not True:
            return True
        result = QMessageBox.question(
            parent,
            "Unsaved Narrative Changes",
            "Save narrative graph changes before closing this editor?",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if result == QMessageBox.StandardButton.Cancel:
            return False
        if result == QMessageBox.StandardButton.Save:
            return self.flush_to_model()
        self._run_editor_js_result(
            "window.__narrativeEditor && window.__narrativeEditor.markSaved"
            " ? (window.__narrativeEditor.markSaved(), true) : false",
        )
        return True

    def reload_from_model(self) -> None:
        if self._view is not None:
            self._view.reload()

    def _load_web_editor(self) -> None:
        assert self._view is not None
        url = _web_editor_load_url()
        if url is not None:
            self._view.load(url)
            return
        message = (
            "Narrative Web Editor is not built yet. "
            "Run `npm run build:narrative-editor`, then press F5 in this tab (no editor restart needed)."
        )
        self._view.setHtml(_placeholder_html(message))

    def _run_editor_js_result(self, code: str, timeout_ms: int = 5000) -> Any:
        if self._view is None:
            return None
        loop = QEventLoop()
        box: dict[str, Any] = {"done": False, "value": None}

        def finish(value: Any = None) -> None:
            if box["done"]:
                return
            box["done"] = True
            box["value"] = value
            loop.quit()

        self._view.page().runJavaScript(code, finish)
        QTimer.singleShot(timeout_ms, lambda: finish(None))
        loop.exec()
        return box["value"]


def derive_projection(data: dict[str, Any], model: ProjectModel) -> dict[str, Any]:
    trigger_edges: list[dict[str, Any]] = []
    read_edges: list[dict[str, Any]] = []
    state_command_edges: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    warning_seen: set[tuple[str, str, str]] = set()
    seen: set[tuple[str, str, str, str]] = set()
    graph_index = _build_graph_index(data)
    assets = _visit_narrative_assets(model)
    emit_sources = _asset_emit_sources(assets)
    command_sources = _asset_state_command_sources(assets)
    condition_sources = _asset_condition_sources(assets)
    owner_state_sources = _asset_owner_state_sources(assets)
    context_state_sources = _asset_context_state_sources(assets)
    dialogue_owner_refs = _dialogue_owner_refs(model)

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
            for command in _string_list(meta.get("commands")):
                graph_id, state_id = _parse_state_command_ref(command)
                target_node = graph_node.get(f"{graph_id}.{state_id}") or graph_node.get(graph_id)
                if target_node:
                    label = f"{graph_id}.{state_id}" if state_id else graph_id
                    _add_edge(state_command_edges, seen, "stateCommand", source_node, target_node, label, f"{element.get('id')} 强制设状态：绕过状态机因果链 {label}", comp_id, graph_id)
                else:
                    _add_projection_warning(warnings, warning_seen, "projection.command.dangling", f"{element.get('id')}: meta.commands points to unknown narrative state {command}", comp_id, str(element.get("id", "")))

        for source in emit_sources:
            sig = source["signal"]
            for source_node in _source_nodes_for_action(source, elements, warnings, warning_seen, comp_id):
                for target in signal_targets.get(sig, []):
                    _add_edge(trigger_edges, seen, "trigger", source_node, target["node"], sig, source["detail"], comp_id, target.get("graphId", ""), target.get("transitionId", ""))

        for source in command_sources:
            target_node = graph_node.get(f'{source["graphId"]}.{source["stateId"]}') or graph_node.get(source["graphId"])
            for source_node in _source_nodes_for_action(source, elements, warnings, warning_seen, comp_id):
                if not target_node:
                    continue
                label = f'{source["graphId"]}.{source["stateId"]}'
                _add_edge(state_command_edges, seen, "stateCommand", source_node, target_node, label, f'强制设状态：绕过状态机因果链 {source["detail"]}', comp_id, source["graphId"])

        for sig, targets in signal_targets.items():
            derived = _derived_state_source(sig, graph_node, graph_index)
            if derived:
                for target in targets:
                    _add_edge(trigger_edges, seen, "trigger", derived["node"], target["node"], sig, derived["detail"], comp_id, target.get("graphId", ""), target.get("transitionId", ""))
            lifecycle = _lifecycle_source(sig, graph_node)
            if lifecycle:
                for target in targets:
                    _add_edge(trigger_edges, seen, "trigger", lifecycle["node"], target["node"], sig, lifecycle["detail"], comp_id, target.get("graphId", ""), target.get("transitionId", ""))

        for condition in condition_sources:
            source = graph_node.get(condition["graphId"])
            if not source:
                continue
            for target in _source_nodes_for_condition(condition, elements, warnings, warning_seen, comp_id):
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

        for owner_state in owner_state_sources:
            dialogue_id = owner_state["dialogueGraphId"]
            target_elements = [
                element for element in elements
                if str(element.get("kind", "")).strip() == "dialogueBlackbox"
                and str(element.get("refId", "")).strip() == dialogue_id
            ]
            if not target_elements:
                continue
            owner_refs = dialogue_owner_refs.get(dialogue_id, [])
            wrapper_matches = _owner_state_wrapper_matches(elements, owner_refs)
            if not wrapper_matches:
                _add_projection_warning(
                    warnings,
                    warning_seen,
                    "projection.ownerState.unresolved",
                    f"{owner_state['detail']}: OwnerStateNode cannot resolve a unique owner wrapper; bind the dialogue to an entity wrapper or keep meta.reads explicit",
                    comp_id,
                    owner_state["detail"],
                )
                continue
            if len(wrapper_matches) > 1:
                _add_projection_warning(
                    warnings,
                    warning_seen,
                    "projection.ownerState.multiple",
                    f"{owner_state['detail']}: OwnerStateNode matched {len(wrapper_matches)} possible wrappers; projection shows all read edges",
                    comp_id,
                    owner_state["detail"],
                )
            for target_element in target_elements:
                target_node = f"element:{target_element.get('id')}"
                for match in wrapper_matches:
                    source = graph_node.get(match["graphId"])
                    if not source:
                        continue
                    label = f'{match["graphId"]}.activeState'
                    detail = (
                        f'{owner_state["detail"]} OwnerStateNode reads '
                        f'{match["ownerType"]}:{match["ownerId"]} wrapper {match["graphId"]}'
                    )
                    _add_edge(read_edges, seen, "read", source, target_node, label, detail, comp_id, match["graphId"])

        for context_state in context_state_sources:
            dialogue_id = context_state["dialogueGraphId"]
            graph_id = context_state["graphId"]
            target_elements = [
                element for element in elements
                if str(element.get("kind", "")).strip() == "dialogueBlackbox"
                and str(element.get("refId", "")).strip() == dialogue_id
            ]
            if not target_elements or not graph_id:
                continue
            source = graph_node.get(graph_id)
            if not source:
                _add_projection_warning(
                    warnings,
                    warning_seen,
                    "projection.contextState.unresolved",
                    f"{context_state['detail']}: ContextStateNode graphId {graph_id} not found in composition",
                    comp_id,
                    context_state["detail"],
                )
                continue
            for target_element in target_elements:
                target_node = f"element:{target_element.get('id')}"
                label = f"{graph_id}.activeState"
                detail = f'{context_state["detail"]} ContextStateNode reads {graph_id}'
                _add_edge(read_edges, seen, "read", source, target_node, label, detail, comp_id, graph_id)

    return {
        "schemaVersion": 1,
        "triggerEdges": trigger_edges,
        "readEdges": read_edges,
        "stateCommandEdges": state_command_edges,
        "warnings": warnings,
    }


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
        action_types = ["emitNarrativeSignal"]
        action_param_schemas = {
            "emitNarrativeSignal": [["signal", "str"], ["sourceType", "str"], ["sourceId", "str"]],
        }
        action_persistence = {"emitNarrativeSignal": "save"}
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
    """Legacy Python structural validator retained for older direct tests.

    Do not wire this into the Qt bridge or save path; structural validation is owned by
    src/core/narrativeGraphValidation.ts.
    """
    issues: list[dict[str, Any]] = []
    seen_signal_ids: set[str] = set()
    for si, row in enumerate(data.get("signals", []) or []):
        if not isinstance(row, dict):
            continue
        sid = str(row.get("id", "")).strip()
        path = f"signals[{si}].id"
        target = _signal_target(sid, "id") if sid else None
        if not sid:
            _issue(issues, "error", "signal.id.empty", "author signal id is required", path)
            continue
        if sid in seen_signal_ids:
            _issue(issues, "error", "signal.id.duplicate", f"duplicate author signal id: {sid}", path, sid, target)
        seen_signal_ids.add(sid)
        if sid == DEFAULT_DRAFT_SIGNAL or sid.startswith(DERIVED_STATE_SIGNAL_PREFIX):
            _issue(issues, "error", "signal.id.reserved", f"author signal id is reserved: {sid}", path, sid, target)
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
        _check_unique(issues, comp_ids, cid, "composition", f"compositions[{ci}].id", cid, _composition_target(cid, "id") if cid else None)
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            _validate_graph(
                main,
                f"compositions[{ci}].mainGraph",
                issues,
                graph_ids,
                graph_index,
                {"compositionId": cid, "graphId": str(main.get("id", "")).strip()},
            )
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
            el_target = _element_target(cid, eid) if eid else None
            if not eid:
                _issue(issues, "error", "element.id.empty", f"{cid}: element id 不能为空", f"compositions[{ci}].elements[{ei}].id", target=el_target)
            _check_id_delimiter(issues, eid, "element.id.delimiter", f"compositions[{ci}].elements[{ei}].id", eid, _with_field(el_target, "id"))
            kind = str(el.get("kind", "")).strip()
            if kind == "wrapperGraph" and not str(el.get("ownerId", "")).strip():
                _issue(issues, "error", "wrapper.unbound", f"{eid}: wrapper 尚未绑定 ownerId", f"compositions[{ci}].elements[{ei}]", eid, el_target)
            if kind == "wrapperGraph" and str(el.get("ownerType", "")).strip() not in _VALID_WRAPPER_OWNER_TYPES:
                _issue(issues, "warning", "wrapper.ownerType.unsupported", f"{eid}: wrapper ownerType 不受运行时 owner 索引支持", f"compositions[{ci}].elements[{ei}].ownerType", eid, _with_field(el_target, "ownerType"))
            if kind == "scenarioSubgraph" and not (str(el.get("refId", "")).strip() or str(el.get("ownerId", "")).strip()):
                _issue(issues, "warning", "scenario.id.empty", f"{eid}: scenarioId 为空", f"compositions[{ci}].elements[{ei}]", eid, el_target)
            if kind not in ("wrapperGraph", "scenarioSubgraph") and not str(el.get("refId", "")).strip():
                _issue(issues, "warning", "blackbox.ref.empty", f"{eid}: 黑盒 refId 为空", f"compositions[{ci}].elements[{ei}]", eid, _with_field(el_target, "refId"))
            if kind in ("wrapperGraph", "scenarioSubgraph"):
                graph = el.get("graph")
                if isinstance(graph, dict):
                    _validate_graph(
                        graph,
                        f"compositions[{ci}].elements[{ei}].graph",
                        issues,
                        graph_ids,
                        graph_index,
                        {"compositionId": cid, "graphId": str(graph.get("id", "")).strip(), "elementId": eid},
                        kind,
                    )
                else:
                    _issue(issues, "error", "element.graph.missing", f"{eid}: 子图缺少 graph", f"compositions[{ci}].elements[{ei}].graph", eid, el_target)
            meta = el.get("meta") if isinstance(el.get("meta"), dict) else {}
            for key in ("emits", "reads", "commands"):
                if key in meta and not isinstance(meta.get(key), list):
                    _issue(issues, "warning", f"element.meta.{key}", f"{eid}: meta.{key} 应为字符串数组", f"compositions[{ci}].elements[{ei}].meta.{key}", eid, _with_field(el_target, f"meta.{key}"))
            for graph_id in _string_list(meta.get("reads")):
                if graph_id not in graph_index:
                    _issue(issues, "warning", "projection.read.dangling", f"{eid}: reads 指向未知叙事图 {graph_id}", f"compositions[{ci}].elements[{ei}].meta.reads", eid, _with_field(el_target, "meta.reads"))
            for command in _string_list(meta.get("commands")):
                graph_id, state_id = _parse_state_command_ref(command)
                graph = graph_index.get(graph_id)
                states = graph.get("states") if isinstance(graph, dict) and isinstance(graph.get("states"), dict) else {}
                if not graph or (state_id and state_id not in states):
                    _issue(issues, "warning", "projection.command.dangling", f"{eid}: commands points to unknown narrative state {command}", f"compositions[{ci}].elements[{ei}].meta.commands", eid, _with_field(el_target, "meta.commands"))
    _validate_owner_bindings(data, issues)
    _validate_state_command_targets(data, graph_index, issues)
    _validate_broadcast_state_signals(data, issues)
    return issues


def _validate_broadcast_state_signals(data: dict[str, Any], issues: list[dict[str, Any]]) -> None:
    graph_index = _build_graph_index(data)
    listeners: dict[str, list[dict[str, str]]] = {}
    for graph in graph_index.values():
        gid = str(graph.get("id", "")).strip()
        for transition in graph.get("transitions", []) or []:
            if not isinstance(transition, dict):
                continue
            sig = str(transition.get("signal", "")).strip()
            if not sig:
                continue
            listeners.setdefault(sig, []).append({
                "graphId": gid,
                "transitionId": str(transition.get("id", "")).strip(),
                "compositionId": str(graph.get("__compositionId", "")).strip(),
                "elementId": str(graph.get("__elementId", "")).strip(),
            })
    for sig, refs in listeners.items():
        parsed = _parse_derived_state_signal(sig)
        if not parsed:
            continue
        graph_id, state_id = parsed
        source_graph = graph_index.get(graph_id)
        states = source_graph.get("states") if isinstance(source_graph, dict) else None
        state = states.get(state_id) if isinstance(states, dict) else None
        state_path = f"{graph_id}.{state_id}"
        if not isinstance(state, dict):
            for ref in refs:
                ref_target = _transition_target(ref, ref["transitionId"])
                _issue(
                    issues,
                    "error",
                    "state.broadcast.sourceMissing",
                    f'{ref["graphId"]}.{ref["transitionId"]}: derived signal {sig} references missing state',
                    f'{ref["graphId"]}.transitions',
                    ref["transitionId"],
                    ref_target,
                )
            continue
        if not _state_broadcast_on_enter(state):
            for ref in refs:
                ref_target = _transition_target(ref, ref["transitionId"])
                _issue(
                    issues,
                    "error",
                    "state.broadcast.missing",
                    f'{ref["graphId"]}.{ref["transitionId"]}: {sig} requires {state_path} to enable broadcastOnEnter',
                    f"{graph_id}.states.{state_id}.broadcastOnEnter",
                    ref["transitionId"],
                    ref_target,
                )
    listener_keys = set(listeners.keys())
    for graph in graph_index.values():
        gid = str(graph.get("id", "")).strip()
        states = graph.get("states")
        if not isinstance(states, dict):
            continue
        for state_id, state in states.items():
            if not _state_broadcast_on_enter(state):
                continue
            sig = _state_entered_signal_key(gid, str(state_id))
            if sig not in listener_keys:
                state_target = _state_target(
                    {
                        "compositionId": str(graph.get("__compositionId", "")).strip(),
                        "graphId": gid,
                        "elementId": str(graph.get("__elementId", "")).strip(),
                    },
                    str(state_id),
                    "broadcastOnEnter",
                )
                _issue(
                    issues,
                    "warning",
                    "state.broadcast.unused",
                    f"{gid}.{state_id}: broadcastOnEnter is enabled but no transition listens to {sig}",
                    f"{gid}.states.{state_id}.broadcastOnEnter",
                    str(state_id),
                    state_target,
                )


def validate_external_state_command_targets(data: dict[str, Any], model: ProjectModel) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    graph_index = _build_graph_index(data)
    for source in _asset_state_command_sources(_visit_narrative_assets(model)):
        graph_id = str(source.get("graphId", "")).strip()
        state_id = str(source.get("stateId", "")).strip()
        graph = graph_index.get(graph_id, {})
        states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
        detail = str(source.get("detail", "")).strip()
        _issue(issues, "error", "stateCommand.unsafeInContent", f"{detail}: setNarrativeState 会绕过 transition/conditions，仅用于调试或修复", detail)
        if state_id not in states:
            _issue(issues, "error", "stateCommand.target.missing", f"{detail}: setNarrativeState target does not exist: {graph_id}.{state_id}", detail)
            continue
        kind = str(graph.get("__elementKind", "")).strip()
        exits = [str(x).strip() for x in (graph.get("exitStates") if isinstance(graph.get("exitStates"), list) else [])]
        if (kind == "scenarioSubgraph" or str(graph.get("ownerType", "")).strip() == "scenario") and state_id != str(graph.get("entryState", "")).strip() and state_id not in exits:
            _issue(issues, "error", "stateCommand.scenario.internal", f"{detail}: setNarrativeState targets an internal scenario state: {graph_id}.{state_id}", detail)
    return issues


def _validate_graph(
    graph: dict[str, Any],
    path: str,
    issues: list[dict[str, Any]],
    graph_ids: set[str],
    graph_index: dict[str, dict[str, Any]],
    target_ctx: dict[str, str],
    element_kind: str = "",
) -> None:
    gid = str(graph.get("id", "")).strip()
    graph_target = _graph_target(target_ctx, "id")
    _check_unique(issues, graph_ids, gid, "graph", f"{path}.id", gid, graph_target)
    _check_id_delimiter(issues, gid, "graph.id.delimiter", f"{path}.id", gid, graph_target)
    states = graph.get("states")
    if not isinstance(states, dict):
        _issue(issues, "error", "states.shape", f"{gid}: states 须为对象", f"{path}.states", gid, _with_field(graph_target, "states"))
        states = {}
    initial = str(graph.get("initialState", "")).strip()
    if not initial or initial not in states:
        _issue(issues, "error", "initialState.invalid", f"{gid}: initialState 不存在", f"{path}.initialState", gid, _with_field(graph_target, "initialState"))
    if graph.get("projectFlags") is True:
        _issue(issues, "error", "projectFlags.deprecated", f"{gid}: projectFlags 已废弃；请使用显式叙事状态读取", f"{path}.projectFlags", gid, _with_field(graph_target, "projectFlags"))
    if element_kind == "scenarioSubgraph" or str(graph.get("ownerType", "")).strip() == "scenario":
        entry = str(graph.get("entryState", "")).strip()
        exits = graph.get("exitStates")
        if not entry or entry not in states:
            _issue(issues, "error", "scenario.entryState.invalid", f"{gid}: scenario entryState 必须指向已存在 state", f"{path}.entryState", gid, _with_field(graph_target, "entryState"))
        if not isinstance(exits, list) or not [x for x in exits if str(x).strip()]:
            _issue(issues, "error", "scenario.exitStates.empty", f"{gid}: scenario 至少需要一个 exitState", f"{path}.exitStates", gid, _with_field(graph_target, "exitStates"))
        elif any(str(x).strip() not in states for x in exits):
            _issue(issues, "error", "scenario.exitState.invalid", f"{gid}: scenario exitStates 中存在不存在的 state", f"{path}.exitStates", gid, _with_field(graph_target, "exitStates"))
    for sid, state in states.items():
        state_target = _state_target(target_ctx, str(sid))
        _check_id_delimiter(issues, str(sid), "state.id.delimiter", f"{path}.states.{sid}", str(sid), _with_field(state_target, "id"))
        if not isinstance(state, dict):
            _issue(issues, "error", "state.shape", f"{gid}.{sid}: state 须为对象", f"{path}.states.{sid}", str(sid), state_target)
            continue
        declared = str(state.get("id", "")).strip()
        if not declared:
            _issue(issues, "error", "state.id.empty", f"{gid}.{sid}: state.id 不能为空", f"{path}.states.{sid}.id", str(sid), _with_field(state_target, "id"))
        elif declared != str(sid):
            _issue(issues, "warning", "state.id.key.mismatch", f"{gid}.{sid}: state.id differs from record key", f"{path}.states.{sid}.id", str(sid), _with_field(state_target, "id"))
        if str(sid) == initial and isinstance(state.get("onEnterActions"), list) and state.get("onEnterActions"):
            _issue(issues, "error", "initialState.onEnterActions.unsupported", f"{gid}.{sid}: initialState onEnterActions do not run on load", f"{path}.states.{sid}.onEnterActions", str(sid), _with_field(state_target, "onEnterActions"))
        _validate_actions(state.get("onEnterActions"), f"{path}.states.{sid}.onEnterActions", issues, f"{gid}.{sid}", _with_field(state_target, "onEnterActions"))
        _validate_actions(state.get("onExitActions"), f"{path}.states.{sid}.onExitActions", issues, f"{gid}.{sid}", _with_field(state_target, "onExitActions"))
    transitions = graph.get("transitions")
    if not isinstance(transitions, list):
        _issue(issues, "error", "transitions.shape", f"{gid}: transitions 须为数组", f"{path}.transitions", gid, _with_field(graph_target, "transitions"))
        return
    transition_ids: set[str] = set()
    for ti, transition in enumerate(transitions):
        tpath = f"{path}.transitions[{ti}]"
        if not isinstance(transition, dict):
            _issue(issues, "error", "transition.shape", f"{gid}: transition {ti + 1} 须为对象", tpath, gid, _with_field(graph_target, "transitions"))
            continue
        tid = str(transition.get("id", "")).strip()
        transition_target = _transition_target(target_ctx, tid)
        _check_unique(issues, transition_ids, tid, "transition", f"{tpath}.id", tid, _with_field(transition_target, "id"))
        _check_id_delimiter(issues, tid, "transition.id.delimiter", f"{tpath}.id", tid, _with_field(transition_target, "id"))
        if isinstance(transition.get("from"), dict) or isinstance(transition.get("to"), dict):
            _issue(issues, "error", "transition.crossGraphEndpoint.unsupported", f"{gid}.{tid}: transition.from/to 必须是本图 stateId，跨图关系请使用 signal/lifecycle trigger", tpath, tid, transition_target)
            continue
        from_ep = _resolve_endpoint(transition.get("from"), gid)
        to_ep = _resolve_endpoint(transition.get("to"), gid)
        if from_ep["stateId"] not in states:
            _issue(issues, "error", "transition.from.missing", f"{gid}.{tid}: from state 不存在", f"{tpath}.from", tid, _with_field(transition_target, "from"))
        if to_ep["stateId"] not in states:
            _issue(issues, "error", "transition.to.missing", f"{gid}.{tid}: to state 不存在", f"{tpath}.to", tid, _with_field(transition_target, "to"))
        sig = str(transition.get("signal", "")).strip() or DEFAULT_DRAFT_SIGNAL
        if sig.startswith("external:") or sig.startswith("stateEntered:"):
            _issue(issues, "error", "transition.signal.legacyFormat", f"{gid}.{tid}: legacy signal format", f"{tpath}.signal", tid, _with_field(transition_target, "signal"))
        elif sig == DEFAULT_DRAFT_SIGNAL:
            _issue(issues, "warning", "transition.signal.draft", f"{gid}.{tid}: transition still uses draft signal {DEFAULT_DRAFT_SIGNAL}", f"{tpath}.signal", f"{gid}.{tid}", _with_field(transition_target, "signal"))
        _validate_lifecycle_signal_scope(gid, tid, sig, tpath, issues, _with_field(transition_target, "signal"))
        _validate_reactive_trigger(transition, tpath, issues, _with_field(transition_target, "trigger"))
        _validate_conditions(transition.get("conditions"), f"{tpath}.conditions", issues, f"{gid}.{tid}", graph_index, _with_field(transition_target, "conditions"))


_VALID_WRAPPER_OWNER_TYPES = {"npc", "hotspot", "zone", "quest", "dialogue", "minigame", "cutscene", "scenario", "system"}


def _build_graph_index(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        cid = str(comp.get("id", "")).strip()
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            gid = str(main.get("id", "")).strip()
            if gid:
                indexed = dict(main)
                indexed["__compositionId"] = cid
                out[gid] = indexed
        for el in comp.get("elements", []) or []:
            if not isinstance(el, dict):
                continue
            graph = el.get("graph")
            if isinstance(graph, dict):
                gid = str(graph.get("id", "")).strip()
                if gid:
                    indexed = dict(graph)
                    indexed["__compositionId"] = cid
                    indexed["__elementId"] = str(el.get("id", "")).strip()
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


def _validate_lifecycle_signal_scope(owner_graph_id: str, transition_id: str, signal: str, path: str, issues: list[dict[str, Any]], target: dict[str, Any] | None = None) -> None:
    lifecycle = _parse_lifecycle_signal(signal)
    if lifecycle and lifecycle[0] == owner_graph_id:
        _issue(
            issues,
            "error",
            "lifecycle.sameGraph.unsupported",
            f"{owner_graph_id}.{transition_id}: lifecycle signals are cross-graph notifications; use onEnterActions/onExitActions locally",
            f"{path}.signal",
            transition_id,
            target,
        )


def _parse_lifecycle_signal(signal: str) -> tuple[str, str] | None:
    for prefix in ("stateEntered:", "stateExited:"):
        if signal.startswith(prefix):
            rest = signal[len(prefix):]
            graph_id, sep, state_id = rest.partition(":")
            if sep and graph_id and state_id:
                return graph_id, state_id
    return None


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
            indexed_graph = graph_index.get(gid, graph)
            state_ctx = {
                "compositionId": str(indexed_graph.get("__compositionId", "")).strip(),
                "graphId": gid,
                "elementId": str(indexed_graph.get("__elementId", "")).strip(),
            }
            states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
            for sid, state in states.items():
                if not isinstance(state, dict):
                    continue
                state_target = _state_target(state_ctx, str(sid))
                for list_name in ("onEnterActions", "onExitActions"):
                    actions = state.get(list_name)
                    if not isinstance(actions, list):
                        continue
                    for idx, action in enumerate(actions):
                        if not isinstance(action, dict) or action.get("type") != "setNarrativeState":
                            continue
                        _issue(issues, "error", "stateCommand.unsafeInContent", f"{gid}.{sid}: setNarrativeState 会绕过 transition/conditions，仅用于调试或修复", f"{gid}.{sid}.{list_name}[{idx}]", f"{gid}.{sid}", _with_field(state_target, list_name))
                        params = action.get("params") if isinstance(action.get("params"), dict) else {}
                        target_gid = str(params.get("graphId", "")).strip()
                        target_sid = str(params.get("stateId", "")).strip()
                        target_graph = graph_index.get(target_gid, {})
                        target_states = target_graph.get("states") if isinstance(target_graph.get("states"), dict) else {}
                        if target_sid not in target_states:
                            _issue(issues, "error", "stateCommand.target.missing", f"{gid}.{sid}: setNarrativeState target does not exist: {target_gid}.{target_sid}", f"{gid}.{sid}.{list_name}[{idx}]", gid, _with_field(state_target, list_name))
                            continue
                        target_kind = str(target_graph.get("__elementKind", "")).strip()
                        exits = [str(x).strip() for x in (target_graph.get("exitStates") if isinstance(target_graph.get("exitStates"), list) else [])]
                        if (target_kind == "scenarioSubgraph" or str(target_graph.get("ownerType", "")).strip() == "scenario") and target_sid != str(target_graph.get("entryState", "")).strip() and target_sid not in exits:
                            _issue(issues, "error", "stateCommand.scenario.internal", f"{gid}.{sid}: setNarrativeState targets an internal scenario state: {target_gid}.{target_sid}", f"{gid}.{sid}.{list_name}[{idx}]", gid, _with_field(state_target, list_name))


def _validate_owner_bindings(data: dict[str, Any], issues: list[dict[str, Any]]) -> None:
    by_owner: dict[str, list[str]] = {}
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
            owner_type = str(graph.get("ownerType", "")).strip()
            owner_id = str(graph.get("ownerId", "")).strip()
            gid = str(graph.get("id", "")).strip()
            if owner_type and owner_id and gid:
                by_owner.setdefault(f"{owner_type}:{owner_id}", []).append(gid)
    for key, graph_ids in by_owner.items():
        if len(graph_ids) > 1:
            _issue(issues, "error", "owner.wrapper.duplicate", f"{key}: 多个 wrapper graph 绑定同一 owner ({', '.join(graph_ids)})", item_id=key)


def _validate_actions(raw: Any, path: str, issues: list[dict[str, Any]], owner: str) -> None:
    if raw is None:
        return
    if not isinstance(raw, list):
        _issue(issues, "warning", "actions.shape", f"{owner}: Actions 应为数组", path, owner)
        return
    for i, action in enumerate(raw):
        if not isinstance(action, dict) or not str(action.get("type", "")).strip():
            _issue(issues, "warning", "action.shape", f"{owner}: action {i + 1} 缺少 type", f"{path}[{i}]", owner)


_VALID_REACTIVE_TRIGGERS = frozenset({"signal", "reactive", "reactiveAll", "reactiveAny"})


def _validate_reactive_trigger(
    transition: dict[str, Any],
    path: str,
    issues: list[dict[str, Any]],
    target: dict[str, Any] | None = None,
) -> None:
    trigger = str(transition.get("trigger", "signal")).strip()
    if trigger not in _VALID_REACTIVE_TRIGGERS:
        _issue(
            issues, "error", "transition.trigger.invalid",
            f"{transition.get('id', '?')}: trigger must be signal/reactive/reactiveAll/reactiveAny, got '{trigger}'",
            f"{path}.trigger", transition.get("id"), target,
        )
        return
    if trigger in ("reactive", "reactiveAll", "reactiveAny"):
        conditions = transition.get("conditions")
        if not isinstance(conditions, list) or not conditions:
            _issue(
                issues, "error", "transition.reactive.noConditions",
                f"{transition.get('id', '?')}: reactive transition (trigger={trigger}) requires at least one condition",
                f"{path}.conditions", transition.get("id"), target,
            )
        sig = str(transition.get("signal", "")).strip()
        if sig and sig != DEFAULT_DRAFT_SIGNAL:
            _issue(
                issues, "warning", "transition.reactive.signalIgnored",
                f"{transition.get('id', '?')}: reactive transition ignores signal field; signal '{sig}' will never be used",
                f"{path}.signal", transition.get("id"), target,
            )


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


def _validate_actions(raw: Any, path: str, issues: list[dict[str, Any]], owner: str, target: dict[str, Any] | None = None) -> None:  # type: ignore[no-redef]
    if raw is None:
        return
    if not isinstance(raw, list):
        _issue(issues, "error", "actions.shape", f"{owner}: actions must be an array", path, owner, target)
        return
    for i, action in enumerate(raw):
        if not isinstance(action, dict) or not str(action.get("type", "")).strip():
            _issue(issues, "error", "action.shape", f"{owner}: action {i + 1} is missing type", f"{path}[{i}]", owner, target)
            continue
        _validate_action_def(action, f"{path}[{i}]", issues, owner, target)


def _validate_action_def(action: dict[str, Any], path: str, issues: list[dict[str, Any]], owner: str, target: dict[str, Any] | None = None) -> None:
    try:
        from ..shared.action_editor import ACTION_TYPES, _PARAM_SCHEMAS
        allowed = {str(x) for x in ACTION_TYPES}
        schemas = {str(k): [(str(n), str(t)) for n, t in v] for k, v in _PARAM_SCHEMAS.items()}
    except Exception:
        allowed = {"emitNarrativeSignal"}
        schemas = {
            "emitNarrativeSignal": [("signal", "str"), ("sourceType", "str"), ("sourceId", "str")],
        }
    action_type = str(action.get("type", "")).strip()
    if action_type not in allowed:
        _issue(issues, "error", "action.type.unknown", f"{owner}: unknown action type {action_type}", f"{path}.type", owner, target)
        return
    params = action.get("params") if isinstance(action.get("params"), dict) else {}
    required = schemas.get(action_type, [])
    if action_type == "emitNarrativeSignal":
        required = [("signal", "str")]
    for name, _kind in required:
        value = params.get(name)
        if value is None or (isinstance(value, str) and not value.strip()):
            _issue(issues, "error", "action.param.missing", f"{owner}: {action_type} missing params.{name}", f"{path}.params.{name}", owner, target)
    if action_type in ("runActions", "addDelayedEvent") and "actions" in params:
        _validate_actions(params.get("actions"), f"{path}.params.actions", issues, owner, target)
    elif action_type == "chooseAction":
        options = params.get("options")
        if options is not None and not isinstance(options, list):
            _issue(issues, "error", "action.container.shape", f"{owner}: chooseAction params.options must be an array", f"{path}.params.options", owner, target)
        for idx, option in enumerate(options if isinstance(options, list) else []):
            if isinstance(option, dict) and "actions" in option:
                _validate_actions(option.get("actions"), f"{path}.params.options[{idx}].actions", issues, owner, target)
    elif action_type == "randomBranch":
        for key in ("aboveActions", "belowActions"):
            if key in params:
                _validate_actions(params.get(key), f"{path}.params.{key}", issues, owner, target)
    elif action_type == "enableRuleOffers":
        slots = params.get("slots")
        if slots is not None and not isinstance(slots, list):
            _issue(issues, "error", "action.container.shape", f"{owner}: enableRuleOffers params.slots must be an array", f"{path}.params.slots", owner, target)
        for idx, slot in enumerate(slots if isinstance(slots, list) else []):
            if isinstance(slot, dict) and "resultActions" in slot:
                _validate_actions(slot.get("resultActions"), f"{path}.params.slots[{idx}].resultActions", issues, owner, target)


def _validate_conditions(
    raw: Any,
    path: str,
    issues: list[dict[str, Any]],
    owner: str,
    graph_index: dict[str, dict[str, Any]] | None = None,
    target: dict[str, Any] | None = None,
) -> None:  # type: ignore[no-redef]
    if raw is None:
        return
    if not isinstance(raw, list):
        _issue(issues, "error", "conditions.shape", f"{owner}: conditions must be an array", path, owner, target)
        return
    for i, expr in enumerate(raw):
        _validate_condition_expr(expr, f"{path}[{i}]", issues, owner, graph_index or {}, target)


def _is_condition_shape(expr: Any) -> bool:  # type: ignore[no-redef]
    if not isinstance(expr, dict):
        return False
    if isinstance(expr.get("all"), list):
        return all(_is_condition_shape(x) for x in expr["all"])
    if isinstance(expr.get("any"), list):
        return all(_is_condition_shape(x) for x in expr["any"])
    if "not" in expr:
        return _is_condition_shape(expr["not"])
    if isinstance(expr.get("narrative"), str):
        return isinstance(expr.get("state"), str) and bool(str(expr.get("state")).strip())
    if isinstance(expr.get("flag"), str):
        return True
    if isinstance(expr.get("quest"), str):
        return isinstance(expr.get("questStatus"), str) or isinstance(expr.get("status"), str)
    if isinstance(expr.get("scenario"), str):
        return isinstance(expr.get("phase"), str) and isinstance(expr.get("status"), str)
    if isinstance(expr.get("scenarioLine"), str):
        return isinstance(expr.get("lineStatus"), str)
    return False


def _validate_condition_expr(
    expr: Any,
    path: str,
    issues: list[dict[str, Any]],
    owner: str,
    graph_index: dict[str, dict[str, Any]],
    target: dict[str, Any] | None = None,
) -> bool:
    if not isinstance(expr, dict):
        _issue(issues, "error", "condition.shape", f"{owner}: condition has an unknown shape", path, owner, target)
        return False
    if isinstance(expr.get("all"), list):
        return all(_validate_condition_expr(x, f"{path}.all[{i}]", issues, owner, graph_index, target) for i, x in enumerate(expr["all"]))
    if isinstance(expr.get("any"), list):
        return all(_validate_condition_expr(x, f"{path}.any[{i}]", issues, owner, graph_index, target) for i, x in enumerate(expr["any"]))
    if "not" in expr:
        return _validate_condition_expr(expr["not"], f"{path}.not", issues, owner, graph_index, target)
    if isinstance(expr.get("narrative"), str):
        graph_id = str(expr.get("narrative", "")).strip()
        state_id = str(expr.get("state", "")).strip() if isinstance(expr.get("state"), str) else ""
        if not state_id:
            _issue(issues, "error", "condition.shape", f"{owner}: narrative condition requires state", path, owner, target)
            return False
        graph = graph_index.get(graph_id)
        if not graph:
            _issue(issues, "error", "condition.narrative.graphMissing", f"{owner}: narrative graph does not exist: {graph_id}", f"{path}.narrative", owner, target)
            return False
        states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
        if state_id not in states:
            _issue(issues, "error", "condition.narrative.stateMissing", f"{owner}: narrative state does not exist: {graph_id}.{state_id}", f"{path}.state", owner, target)
            return False
        return True
    if _is_condition_shape(expr):
        return True
    _issue(issues, "error", "condition.shape", f"{owner}: condition has an unknown shape", path, owner, target)
    return False


def _check_unique(
    issues: list[dict[str, Any]],
    seen: set[str],
    value: str,
    label: str,
    path: str,
    item_id: str | None = None,
    target: dict[str, Any] | None = None,
) -> None:
    if not value:
        _issue(issues, "error", f"{label}.empty", f"{label} id 不能为空", path, item_id, target)
        return
    if value in seen:
        _issue(issues, "error", f"{label}.duplicate", f"{label} id 重复：{value}", path, item_id or value, target)
    seen.add(value)


def _check_id_delimiter(issues: list[dict[str, Any]], value: str, code: str, path: str, item_id: str | None = None, target: dict[str, Any] | None = None) -> None:
    if ":" in value or "|" in value:
        _issue(issues, "error", code, f"{value}: id cannot contain ':' or '|'", path, item_id or value, target)


def _issue(
    issues: list[dict[str, Any]],
    severity: str,
    code: str,
    message: str,
    path: str | None = None,
    item_id: str | None = None,
    target: dict[str, Any] | None = None,
) -> None:
    out = {"severity": severity, "code": code, "message": message}
    if path:
        out["path"] = path
    if item_id:
        out["itemId"] = item_id
    if target:
        out["target"] = _compact_target(target)
    issues.append(out)


def _compact_target(target: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in target.items() if v is not None and v != ""}


def _with_field(target: dict[str, Any] | None, field: str) -> dict[str, Any] | None:
    if not target:
        return None
    out = dict(target)
    out["field"] = field
    return out


def _composition_target(composition_id: str, field: str | None = None) -> dict[str, Any]:
    return _compact_target({"kind": "composition", "compositionId": composition_id, "field": field})


def _graph_target(ctx: dict[str, str], field: str | None = None) -> dict[str, Any]:
    return _compact_target({"kind": "graph", "compositionId": ctx.get("compositionId", ""), "graphId": ctx.get("graphId", ""), "elementId": ctx.get("elementId", ""), "field": field})


def _element_target(composition_id: str, element_id: str, field: str | None = None) -> dict[str, Any]:
    return _compact_target({"kind": "element", "compositionId": composition_id, "elementId": element_id, "field": field})


def _state_target(ctx: dict[str, str], state_id: str, field: str | None = None) -> dict[str, Any]:
    return _compact_target({"kind": "state", "compositionId": ctx.get("compositionId", ""), "graphId": ctx.get("graphId", ""), "elementId": ctx.get("elementId", ""), "stateId": state_id, "field": field})


def _transition_target(ctx: dict[str, str], transition_id: str, field: str | None = None) -> dict[str, Any]:
    return _compact_target({"kind": "transition", "compositionId": ctx.get("compositionId", ""), "graphId": ctx.get("graphId", ""), "elementId": ctx.get("elementId", ""), "transitionId": transition_id, "field": field})


def _signal_target(signal_id: str, field: str | None = None) -> dict[str, Any]:
    return _compact_target({"kind": "signal", "signalId": signal_id, "field": field})


def _find_main_window(obj: QObject) -> QObject | None:
    win: QObject | None = obj
    while win is not None and not hasattr(win, "_game_play_window"):
        win = win.parent()
    return win


def _web_editor_index() -> Path:
    return Path(__file__).resolve().parents[2] / "narrative_editor_web" / "dist" / "index.html"


def _web_editor_load_url() -> QUrl | None:
    dev_url = os.environ.get(NARRATIVE_EDITOR_DEV_URL_ENV, "").strip()
    if dev_url:
        return QUrl(dev_url)
    index = _web_editor_index()
    if index.is_file():
        return QUrl.fromLocalFile(str(index))
    return None


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


def _add_projection_warning(
    warnings: list[dict[str, Any]],
    seen: set[tuple[str, str, str]],
    code: str,
    message: str,
    composition_id: str = "",
    detail: str = "",
) -> None:
    key = (code, composition_id, message)
    if key in seen:
        return
    seen.add(key)
    warning = {"severity": "warning", "code": code, "message": message}
    if composition_id:
        warning["compositionId"] = composition_id
    if detail:
        warning["detail"] = detail
    warnings.append(warning)


def _parse_state_command_ref(raw: str) -> tuple[str, str]:
    value = str(raw or "").strip()
    if "." in value:
        graph_id, state_id = value.split(".", 1)
        return graph_id.strip(), state_id.strip()
    if ":" in value:
        graph_id, state_id = value.split(":", 1)
        return graph_id.strip(), state_id.strip()
    return value, ""


def _iter_action_signal_sources(model: ProjectModel) -> list[dict[str, str]]:
    return _asset_emit_sources(_visit_narrative_assets(model))


def _iter_state_command_sources(model: ProjectModel) -> list[dict[str, str]]:
    return _asset_state_command_sources(_visit_narrative_assets(model))


def _collect_emit_actions(out: list[dict[str, str]], detail: str, kind: str, ref_id: str, obj: Any) -> None:
    for action in _walk_actions(obj):
        if action.get("type") != "emitNarrativeSignal":
            continue
        params = action.get("params") if isinstance(action.get("params"), dict) else {}
        signal = str(params.get("signal", "")).strip()
        if not signal:
            continue
        source_type = str(params.get("sourceType", "")).strip()
        source_id = str(params.get("sourceId", "")).strip()
        meta = f" ({source_type}:{source_id})" if source_type and source_id else ""
        out.append({
            "signal": signal,
            "kind": kind,
            "refId": ref_id,
            "detail": f"{detail}{meta}",
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


def _source_nodes_for_action(
    source: dict[str, str],
    elements: list[dict[str, Any]],
    warnings: list[dict[str, Any]] | None = None,
    warning_seen: set[tuple[str, str, str]] | None = None,
    composition_id: str = "",
) -> list[str]:
    explicit: list[str] = []
    signal = source.get("signal", "")
    if signal:
        for e in elements:
            meta = e.get("meta") if isinstance(e.get("meta"), dict) else {}
            if signal in _string_list(meta.get("emits")):
                explicit.append(f"element:{e.get('id')}")
    if explicit:
        return _dedupe_source_nodes(explicit, source, warnings, warning_seen, composition_id, explicit=True)
    out: list[str] = []
    kind = source.get("kind")
    ref_id = source.get("refId")
    for e in elements:
        if _element_matches_asset_ref(e, str(kind or ""), str(ref_id or "")):
            out.append(f"element:{e.get('id')}")
    return _dedupe_source_nodes(out, source, warnings, warning_seen, composition_id, explicit=False)


def _element_matches_asset_ref(element: dict[str, Any], kind: str, ref_id: str) -> bool:
    ek = str(element.get("kind", ""))
    er = str(element.get("refId", "")).strip()
    owner_type = str(element.get("ownerType", "")).strip()
    owner_id = str(element.get("ownerId", "")).strip()
    if kind == "dialogue" and ek == "dialogueBlackbox" and er == ref_id:
        return True
    if kind == "minigame" and ek == "minigameBlackbox" and er == ref_id:
        return True
    if kind == "cutscene" and ek == "cutsceneBlackbox" and er == ref_id:
        return True
    if kind == "zone" and ek == "zoneBlackbox" and (er.endswith(f":{ref_id}") or er == ref_id):
        return True
    if kind == "quest" and owner_type == "quest" and (owner_id == ref_id or er == ref_id):
        return True
    if kind == "document" and owner_type in ("document", "archiveDocument") and (owner_id == ref_id or er == ref_id):
        return True
    if kind.startswith("archive") and (owner_type == kind or ek == kind) and (not ref_id or owner_id == ref_id or er == ref_id):
        return True
    return False


def _dialogue_owner_refs(model: ProjectModel) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    seen: set[tuple[str, str, str, str]] = set()

    def add(dialogue_id: str, owner_type: str, owner_id: str, detail: str) -> None:
        dialogue_id = str(dialogue_id or "").strip()
        owner_type = str(owner_type or "").strip()
        owner_id = str(owner_id or "").strip()
        if not dialogue_id or not owner_type or not owner_id:
            return
        key = (dialogue_id, owner_type, owner_id, detail)
        if key in seen:
            return
        seen.add(key)
        out.setdefault(dialogue_id, []).append({
            "ownerType": owner_type,
            "ownerId": owner_id,
            "detail": detail,
        })

    for scene_id, scene in model.scenes.items():
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs", []) or []:
            if not isinstance(npc, dict):
                continue
            dialogue_id = str(npc.get("dialogueGraphId", "")).strip()
            npc_id = str(npc.get("id", "")).strip()
            if dialogue_id and npc_id:
                add(dialogue_id, "npc", npc_id, f"npc:{scene_id}:{npc_id}")
                add(dialogue_id, "npc", f"{scene_id}:{npc_id}", f"npc:{scene_id}:{npc_id}")
        for hotspot in scene.get("hotspots", []) or []:
            if not isinstance(hotspot, dict):
                continue
            data = hotspot.get("data") if isinstance(hotspot.get("data"), dict) else {}
            dialogue_id = str(data.get("graphId", "")).strip()
            hotspot_id = str(hotspot.get("id", "")).strip()
            if dialogue_id and hotspot_id:
                add(dialogue_id, "hotspot", hotspot_id, f"hotspot:{scene_id}:{hotspot_id}")
                add(dialogue_id, "hotspot", f"{scene_id}:{hotspot_id}", f"hotspot:{scene_id}:{hotspot_id}")
    return out


def _owner_state_wrapper_matches(
    elements: list[dict[str, Any]],
    owner_refs: list[dict[str, str]],
) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for element in elements:
        if str(element.get("kind", "")).strip() != "wrapperGraph":
            continue
        graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
        graph_id = str(graph.get("id", "")).strip()
        if not graph_id:
            continue
        owner_type = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
        owner_id = str(element.get("ownerId") or graph.get("ownerId") or "").strip()
        if not owner_type or not owner_id:
            continue
        for ref in owner_refs:
            if owner_type != ref.get("ownerType") or owner_id != ref.get("ownerId"):
                continue
            key = (graph_id, owner_type, owner_id)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "graphId": graph_id,
                "ownerType": owner_type,
                "ownerId": owner_id,
            })
    return out


def _dedupe_source_nodes(
    nodes: list[str],
    source: dict[str, str],
    warnings: list[dict[str, Any]] | None,
    warning_seen: set[tuple[str, str, str]] | None,
    composition_id: str,
    explicit: bool,
) -> list[str]:
    out = list(dict.fromkeys(x for x in nodes if x))
    if out and warnings is not None and warning_seen is not None and not explicit:
        _add_projection_warning(
            warnings,
            warning_seen,
            "projection.fallback.source",
            f"{source.get('detail', '')}: using asset ref fallback; declare meta.emits/meta.commands/meta.reads for stable projection wiring",
            composition_id,
            source.get("detail", ""),
        )
    if len(out) > 1 and warnings is not None and warning_seen is not None:
        _add_projection_warning(
            warnings,
            warning_seen,
            "projection.source.ambiguous",
            f"{source.get('detail', '')}: asset ref matched {len(out)} elements; emitted fan-in edges",
            composition_id,
            source.get("detail", ""),
        )
    return out


def _source_node_for_action(source: dict[str, str], elements: list[dict[str, Any]]) -> str:
    nodes = _source_nodes_for_action(source, elements)
    return nodes[0] if nodes else ""


def _derived_state_source(
    signal: str,
    graph_node: dict[str, str],
    graph_index: dict[str, dict[str, Any]],
) -> dict[str, str] | None:
    parsed = _parse_derived_state_signal(signal)
    if not parsed:
        return None
    graph_id, state_id = parsed
    graph = graph_index.get(graph_id)
    states = graph.get("states") if isinstance(graph, dict) else None
    state = states.get(state_id) if isinstance(states, dict) else None
    if not _state_broadcast_on_enter(state):
        return None
    node = graph_node.get(f"{graph_id}.{state_id}") or graph_node.get(graph_id)
    if not node:
        return None
    return {"node": node, "detail": signal}


def _lifecycle_source(signal: str, graph_node: dict[str, str]) -> dict[str, str] | None:
    if signal.startswith(DERIVED_STATE_SIGNAL_PREFIX):
        rest = signal[len(DERIVED_STATE_SIGNAL_PREFIX):]
        graph_id, _, state_id = rest.partition(":")
        node = graph_node.get(f"{graph_id}.{state_id}") or graph_node.get(graph_id)
        if node:
            return {"node": node, "detail": signal}
    for prefix in ("stateEntered:", "stateExited:"):
        if signal.startswith(prefix):
            rest = signal[len(prefix):]
            graph_id, _, state_id = rest.partition(":")
            node = graph_node.get(f"{graph_id}.{state_id}") or graph_node.get(graph_id)
            if node:
                return {"node": node, "detail": signal}
    return None


def _source_nodes_for_condition(
    condition: dict[str, str],
    elements: list[dict[str, Any]],
    warnings: list[dict[str, Any]] | None = None,
    warning_seen: set[tuple[str, str, str]] | None = None,
    composition_id: str = "",
) -> list[str]:
    out: list[str] = []
    kind = condition.get("kind")
    ref_id = condition.get("refId")
    for e in elements:
        if _element_matches_asset_ref(e, str(kind or ""), str(ref_id or "")):
            node = f"element:{e.get('id')}"
            out.append(node)
    return _dedupe_source_nodes(out, condition, warnings, warning_seen, composition_id, explicit=False)


def _iter_condition_sources(model: ProjectModel) -> list[dict[str, str]]:
    return _asset_condition_sources(_visit_narrative_assets(model))


def _source_node_for_condition(condition: dict[str, str], elements: list[dict[str, Any]]) -> str:
    nodes = _source_nodes_for_condition(condition, elements)
    return nodes[0] if nodes else ""


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
    return transition_anchor_id(graph_id, transition_id)


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(x).strip() for x in value if str(x).strip()]


def _split_scene_ref(ref_id: str) -> tuple[str, str]:
    if ":" not in ref_id:
        return "", ref_id
    scene_id, entity_id = ref_id.split(":", 1)
    return scene_id, entity_id
