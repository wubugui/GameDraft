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

from PySide6.QtCore import QEventLoop, QObject, QProcess, Qt, QTimer, QUrl, Slot
from PySide6.QtGui import QContextMenuEvent
from PySide6.QtWidgets import (
    QFrame, QHBoxLayout, QLabel, QMessageBox, QPushButton,
    QVBoxLayout, QWidget, QSizePolicy,
)

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
from .. import theme
from ..shared.dialog_geometry import remember_dialog_geometry
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


def _coerce_schema_version(raw: Any) -> int:
    """垃圾 schemaVersion（非数值字符串/对象）按 0 处理走迁移，绝不抛——
    saveData 的 Qt slot 抛异常会返回空串，被网页 `result || 'saved'` 误判为保存成功。"""
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


def _normalize_file(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return _clone(EMPTY_NARRATIVE_GRAPHS)
    out = _clone(value)
    if _coerce_schema_version(out.get("schemaVersion", 0)) < NARRATIVE_SCHEMA_VERSION:
        out = _migrate_narrative_signals_v3(out)
    out["schemaVersion"] = NARRATIVE_SCHEMA_VERSION
    if not isinstance(out.get("signals"), list):
        out["signals"] = []
    comps = out.get("compositions")
    if not isinstance(comps, list):
        out["compositions"] = []
    _normalize_reactive_triggers(out)
    # 注意：这里刻意没有 broadcastOnEnter 的 auto-mark。2026-07-16 拍板"编辑器不代写数据"
    # 已在 web 侧删除同款逻辑（editorModel normalizeFile），Python 侧必须对齐——
    # 监听了未广播状态的数据由校验 state.broadcast.missing（error）交用户在状态面板手勾。
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
    issues = validate_narrative_graphs(data) + validate_project_context(data, model)
    return [issue for issue in issues if issue.get("severity") == "error"]


def validate_project_context(data: dict[str, Any], model: ProjectModel) -> list[dict[str, Any]]:
    """Return validation issues that require Python-side project/assets context.

    Structural narrative graph validation is owned by src/core/narrativeGraphValidation.ts.
    """
    return validate_external_state_command_targets(data, model) + _validate_active_plane_refs(data, model)


def _validate_active_plane_refs(data: dict[str, Any], model: ProjectModel) -> list[dict[str, Any]]:
    """activePlane 引用存在性（与 TS 权威 state.activePlane.unknown 同口径，error）。

    TS 侧由网页把 planes.json 目录喂给 validateNarrativeGraphData(opts.planeIds)；
    agent/脚本直写 ProjectModel 只经本兜底——缺这道检查会把坏位面接线落盘，
    运行时 PlaneReconciler 静默降级、玩法坏而无声（2026-07-17 审查 P-F4）。
    planes.json 缺失/为空时跳过（与 TS 不传 planeIds 即跳过同语义）。
    """
    try:
        plane_ids = {pid for pid, _ in model.all_plane_ids()}
    except Exception:
        return []
    if not plane_ids:
        return []
    issues: list[dict[str, Any]] = []
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        cid = str(comp.get("id", "")).strip()
        candidates: list[tuple[str, dict[str, Any]]] = []
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            candidates.append(("", main))
        for el in comp.get("elements", []) or []:
            if isinstance(el, dict) and isinstance(el.get("graph"), dict):
                candidates.append((str(el.get("id", "")).strip(), el["graph"]))
        for element_id, graph in candidates:
            gid = str(graph.get("id", "")).strip()
            states = graph.get("states")
            if not isinstance(states, dict):
                continue
            for sid, state in states.items():
                if not isinstance(state, dict):
                    continue
                active_plane = state.get("activePlane")
                if not isinstance(active_plane, str) or not active_plane.strip():
                    continue  # 形状问题由 _validate_graph 报 state.activePlane.invalid
                if active_plane.strip() not in plane_ids:
                    target: dict[str, Any] = {"kind": "state", "compositionId": cid, "graphId": gid, "stateId": str(sid), "field": "activePlane"}
                    if element_id:
                        target["elementId"] = element_id
                    issues.append({
                        "severity": "error",
                        "code": "state.activePlane.unknown",
                        "message": f"{gid}.{sid}: activePlane 引用不存在的位面: {active_plane.strip()}",
                        "path": f"{gid}.states.{sid}.activePlane",
                        "itemId": str(sid),
                        "target": target,
                    })
    return issues


class _NarrativeDraftProxy:
    """只读扫描代理：narrative_graphs 用传入的画布草稿，其余属性委托真实模型。

    用于重构「预览计数」按当前画布草稿计（复核 P3）——扫描是只读的，绝不能因预览就把
    草稿并进真实 model.narrative_graphs 并标脏（那会污染保存路径）。scan_* 只读取属性，
    不调用 mark_dirty，故委托安全。
    """

    def __init__(self, base: ProjectModel, narrative: dict[str, Any]) -> None:
        object.__setattr__(self, "_base", base)
        object.__setattr__(self, "narrative_graphs", narrative)

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_base"), name)


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
        try:
            normalized = _normalize_file(parsed)
            errors = _validation_errors_for_save(normalized, self._model)
        except Exception as exc:  # fail-safe 不 fail-open：Qt slot 抛异常会返回空串，
            # 而网页 `result || 'saved'` 会把空串当保存成功（实际模型未更新）。
            return f"save blocked: internal error: {exc}"
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
    def get_task_index(self, composition_id: str) -> str:  # noqa: N802 - shared bridge contract name
        """「任务总线」交叉引用（单 composition）。名字由冻结契约固定，web 侧 loadTaskIndex 直调。"""
        from ..shared.narrative_catalog import build_task_index

        return json.dumps(
            build_task_index(self._model, (composition_id or "").strip()),
            ensure_ascii=False,
        )

    # --------------------------------------------------------------------- #
    # 信号重构（改名 / 删除）：全项目级联，零磁盘写入，落盘只经主编辑器 Save All。
    # --------------------------------------------------------------------- #
    def _scan_model_with_optional_draft(self, arg: str) -> tuple[ProjectModel, dict[str, Any]]:
        """扫描入参解析：arg 可能是裸 id（老格式）或 JSON `{..., data}`（带当前画布草稿）。

        带 data 时（重构预览计数并入画布现状，复核 P3）在临时模型上扫，绝不改真实模型
        （扫描是只读预览，不得因预览就把草稿并进 narrative_graphs 并标脏）。返回
        (要扫的 model, 解析出的额外参数 dict)。data 非法/缺省时回落真实模型。
        """
        text = str(arg or "")
        stripped = text.strip()
        if stripped.startswith("{"):
            try:
                req = json.loads(stripped)
            except Exception:
                req = None
            if isinstance(req, dict):
                data = req.get("data")
                if isinstance(data, dict):
                    return _NarrativeDraftProxy(self._model, _normalize_file(data)), req
                return self._model, req
        return self._model, {"__raw__": text}

    @Slot(str, result=str)
    def scanSignalUsages(self, signal_id: str) -> str:  # noqa: N802 - Qt slot name
        """一个作者信号的全项目使用点清单（重构预览），只读不改。

        入参兼容裸 signalId 与 JSON `{signalId, data}`（data=当前画布草稿，复核 P3）。
        """
        from ..shared.signal_refactor import scan_signal_usages

        try:
            model, req = self._scan_model_with_optional_draft(signal_id)
            sid = req.get("signalId") if "signalId" in req else req.get("__raw__", signal_id)
            usages = scan_signal_usages(model, str(sid or ""))
            return json.dumps({"ok": True, "usages": usages}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 - 桥边界统一转 JSON 错误
            return json.dumps({"ok": False, "reason": str(exc)}, ensure_ascii=False)

    @Slot(str, str, result=str)
    def scanStateUsages(self, graph_id: str, state_id: str) -> str:  # noqa: N802 - Qt slot name
        from ..shared.signal_refactor import scan_state_usages

        try:
            model, req = self._scan_model_with_optional_draft(graph_id)
            gid = req.get("graphId") if "graphId" in req else req.get("__raw__", graph_id)
            sid = req.get("stateId", state_id)
            return json.dumps({"ok": True, "usages": scan_state_usages(model, str(gid or ""), str(sid or ""))}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 - 桥边界统一转 JSON 错误
            return json.dumps({"ok": False, "reason": str(exc)}, ensure_ascii=False)

    @Slot(str, result=str)
    def scanGraphUsages(self, graph_id: str) -> str:  # noqa: N802 - Qt slot name
        from ..shared.signal_refactor import scan_graph_usages

        try:
            model, req = self._scan_model_with_optional_draft(graph_id)
            gid = req.get("graphId") if "graphId" in req else req.get("__raw__", graph_id)
            return json.dumps({"ok": True, "usages": scan_graph_usages(model, str(gid or ""))}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 - 桥边界统一转 JSON 错误
            return json.dumps({"ok": False, "reason": str(exc)}, ensure_ascii=False)

    @Slot(str, result=str)
    def applySignalRefactor(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        """执行叙事重构。payload.op ∈ {rename, delete, renameState, renameGraph} + 各自参数 + data。

        data 是网页当前文档：先走与 saveData 相同的校验+暂存（让重构作用在最新画布上），
        再跑共享引擎级联全项目引用（状态/图改名自动登记存档 migrations）。全程只改
        ProjectModel 内存并标脏，落盘只经主编辑器 Save All；撤销见 undoSignalRefactor
        （撤销日志挂在 ProjectModel 上，与 PyQt 信号管理器共用一份）。
        """
        from ..shared.signal_refactor import (
            SignalRefactorError,
            _migrations_snapshot,
            delete_signal,
            push_journal,
            rename_graph,
            rename_signal,
            rename_state,
        )

        try:
            req = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid json: {exc}"}, ensure_ascii=False)
        if not isinstance(req, dict):
            return json.dumps({"ok": False, "reason": "payload must be an object"}, ensure_ascii=False)

        data = req.get("data")
        if isinstance(data, dict):
            normalized = _normalize_file(data)
            errors = _validation_errors_for_save(normalized, self._model)
            if errors:
                return json.dumps(
                    {"ok": False, "reason": f"save blocked: {len(errors)} validation error(s)（先解决校验错误再重构）"},
                    ensure_ascii=False,
                )
            self._model.narrative_graphs = normalized
            self._model.mark_dirty("narrative_graphs")

        op = str(req.get("op") or "").strip()
        try:
            if op == "rename":
                summary = rename_signal(self._model, str(req.get("oldId") or ""), str(req.get("newId") or ""))
                journal_entry = {"op": "rename", "oldId": summary["oldId"], "newId": summary["newId"], "summary": summary}
            elif op == "delete":
                summary, reverse_ops = delete_signal(
                    self._model, str(req.get("signalId") or ""), force=bool(req.get("force")),
                )
                journal_entry = {"op": "delete", "signalId": summary["signalId"], "summary": summary, "reverseOps": reverse_ops}
            elif op == "renameState":
                snapshot = _migrations_snapshot(self._model)
                summary = rename_state(
                    self._model, str(req.get("graphId") or ""),
                    str(req.get("oldStateId") or ""), str(req.get("newStateId") or ""),
                )
                journal_entry = {**{k: summary[k] for k in ("op", "graphId", "oldStateId", "newStateId")},
                                 "summary": summary, "migrationsSnapshot": snapshot}
            elif op == "renameGraph":
                snapshot = _migrations_snapshot(self._model)
                summary = rename_graph(
                    self._model, str(req.get("oldGraphId") or ""), str(req.get("newGraphId") or ""),
                )
                journal_entry = {**{k: summary[k] for k in ("op", "oldGraphId", "newGraphId")},
                                 "summary": summary, "migrationsSnapshot": snapshot}
            else:
                return json.dumps({"ok": False, "reason": f"unknown op: {op!r}"}, ensure_ascii=False)
        except SignalRefactorError as exc:
            return json.dumps({"ok": False, "reason": str(exc)}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 - 桥边界统一转 JSON 错误
            return json.dumps({"ok": False, "reason": f"refactor failed: {exc}"}, ensure_ascii=False)

        size = push_journal(self._model, journal_entry)
        return json.dumps(
            {
                "ok": True,
                "summary": summary,
                "narrative": _normalize_file(self._model.narrative_graphs),
                "journalSize": size,
            },
            ensure_ascii=False,
        )

    @Slot(result=str)
    def undoSignalRefactor(self) -> str:  # noqa: N802 - Qt slot name
        """撤销最近一次叙事重构（共享日志：web 与 PyQt 信号管理器同一份）。"""
        from ..shared.signal_refactor import undo_last

        result = undo_last(self._model)
        if result.get("ok"):
            result["narrative"] = _normalize_file(self._model.narrative_graphs)
        return json.dumps(result, ensure_ascii=False)

    @Slot(result=str)
    def getRefactorJournalSize(self) -> str:  # noqa: N802 - Qt slot name
        """当前重构撤销日志长度：页面（重）加载后据此恢复「撤销重构(n)」入口（复核 P3）。

        日志挂在 ProjectModel 上、跨 web 页面加载存活，此前重载即丢失撤销入口。
        """
        from ..shared.signal_refactor import journal_size

        try:
            return json.dumps({"ok": True, "size": journal_size(self._model)}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 - 桥边界统一转 JSON 错误
            return json.dumps({"ok": False, "size": 0, "reason": str(exc)}, ensure_ascii=False)

    # --------------------------------------------------------------------- #
    # 叙事状态机模板（archetype）：编辑器专用，运行时永不加载。
    # --------------------------------------------------------------------- #
    @Slot(result=str)
    def getTemplates(self) -> str:  # noqa: N802 - Qt slot name
        """当前工程的模板注册表（归一后 {schemaVersion, templates:[...]}）。"""
        from ..shared.narrative_templates import normalize_templates_file

        return json.dumps(normalize_templates_file(self._model.narrative_templates), ensure_ascii=False)

    @Slot(str, result=str)
    def saveTemplates(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        """整表覆盖保存模板（校验通过则并入 model + 标脏 narrative_templates）。"""
        from ..shared.narrative_templates import normalize_templates_file, validate_templates_file

        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid json: {exc}"}, ensure_ascii=False)
        # 先对归一化前的原始输入校验：撞名检测（template.id.duplicate）设计上必须扫原始输入，
        # 归一化会先去重——旧写法"先归一后校验"使重复模板 id 永远查不出、第二份静默丢失还返回 ok。
        errors = [i for i in validate_templates_file(parsed) if i.get("severity") == "error"]
        if errors:
            preview = "; ".join(str(e.get("message")) for e in errors[:4])
            return json.dumps({"ok": False, "reason": f"{len(errors)} 条错误：{preview}", "errors": errors}, ensure_ascii=False)
        normalized = normalize_templates_file(parsed)
        self._model.narrative_templates = normalized
        self._model.mark_dirty("narrative_templates")
        return json.dumps({"ok": True, "templates": normalized}, ensure_ascii=False)

    # --------------------------------------------------------------------- #
    # 「整理分组」标签：编辑器专用，运行时永不加载，绝不进 narrative_graphs.json。
    # 与 wrapper 子图那个进 JSON、驱动运行时校验的 category「分类备注」字段完全无关。
    # --------------------------------------------------------------------- #
    @Slot(result=str)
    def getCategories(self) -> str:  # noqa: N802 - Qt slot name
        """当前工程的整理分组注册表（归一后 {schemaVersion, compositions, subgraphs}）。"""
        from ..shared.narrative_categories import normalize_categories_file

        return json.dumps(normalize_categories_file(self._model.narrative_categories), ensure_ascii=False)

    @Slot(str, result=str)
    def saveCategories(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        """整表覆盖保存整理分组（归一后并入 model + 标脏 narrative_categories，不落盘）。"""
        from ..shared.narrative_categories import normalize_categories_file

        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid json: {exc}"}, ensure_ascii=False)
        normalized = normalize_categories_file(parsed)
        self._model.narrative_categories = normalized
        self._model.mark_dirty("narrative_categories")
        return json.dumps({"ok": True, "categories": normalized}, ensure_ascii=False)

    # --------------------------------------------------------------------- #
    # 编辑器专用 sidecar（UI 偏好 / 画布分组框）：运行时永不加载、与游戏数据无关，
    # 故**不经 Save All / mark_dirty，改动即立即落盘**（见 debug-ui-persistence 范式：
    # 编辑器 UI 状态走工程文件、禁 localStorage-only；对齐图对话 dialogue_flow_layout.json 先例）。
    # --------------------------------------------------------------------- #
    def _read_editor_sidecar(self, filename: str) -> str:
        """读 editor_data/<filename>；无工程/文件缺失/读失败一律返回空对象串。"""
        if getattr(self._model, "project_path", None) is None:
            return "{}"
        path = self._model.editor_data_path / filename
        if not path.is_file():
            return "{}"
        try:
            return path.read_text(encoding="utf-8")
        except Exception:
            return "{}"

    def _write_editor_sidecar(self, filename: str, payload: str, root_desc: str) -> str:
        """整表覆盖写 editor_data/<filename> 并立即落盘；返回 {ok,...} JSON 串。"""
        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid json: {exc}"}, ensure_ascii=False)
        if not isinstance(parsed, dict):
            return json.dumps({"ok": False, "reason": f"{root_desc} root must be an object"}, ensure_ascii=False)
        if getattr(self._model, "project_path", None) is None:
            return json.dumps({"ok": False, "reason": "no project open"}, ensure_ascii=False)
        path = self._model.editor_data_path / filename
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            text = json.dumps(parsed, ensure_ascii=False, indent=2) + "\n"
            path.write_text(text, encoding="utf-8")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"write failed: {exc}"}, ensure_ascii=False)
        return json.dumps({"ok": True}, ensure_ascii=False)

    @Slot(result=str)
    def getEditorPreferences(self) -> str:  # noqa: N802 - Qt slot name
        """读当前工程的叙事编辑器 UI 偏好；无工程/文件缺失时返回空对象。"""
        return self._read_editor_sidecar("narrative_editor_preferences.json")

    @Slot(str, result=str)
    def saveEditorPreferences(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        """整表覆盖保存 UI 偏好并**立即写盘**（apply 即固化，重启不丢）。"""
        return self._write_editor_sidecar("narrative_editor_preferences.json", payload, "preferences")

    @Slot(result=str)
    def getCanvasGroups(self) -> str:  # noqa: N802 - Qt slot name
        """读当前工程的叙事画布分组框注册表；无工程/文件缺失时返回空对象。"""
        return self._read_editor_sidecar("narrative_canvas_groups.json")

    @Slot(str, result=str)
    def saveCanvasGroups(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        """整表覆盖保存画布分组框并**立即写盘**（重启不丢；归一化由 web 侧负责）。"""
        return self._write_editor_sidecar("narrative_canvas_groups.json", payload, "canvas groups")

    @Slot(str, result=str)
    def getQuest(self, quest_id: str) -> str:  # noqa: N802 - Qt slot name
        """按 id 取一条 quest 的 JSON（供「从现成作曲创建模板」把镜像 quest 一起参数化）。"""
        qid = (quest_id or "").strip()
        for q in self._model.quests if isinstance(self._model.quests, list) else []:
            if isinstance(q, dict) and str(q.get("id") or "").strip() == qid:
                return json.dumps({"ok": True, "quest": q}, ensure_ascii=False)
        return json.dumps({"ok": False, "reason": f"任务「{qid}」不存在"}, ensure_ascii=False)

    @Slot(str, result=str)
    def extractTemplate(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        """从一张现成作曲反抽出模板对象（不落盘；web 侧拿去并入模板表再 saveTemplates）。

        payload = {composition, params:[{name,type,label,sample,required,default,note}],
                   templateId, label?, description?, signals?, quest?, dialogueStubs?}
        """
        from ..shared.narrative_templates import extract_template, validate_template

        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid json: {exc}"}, ensure_ascii=False)
        composition = parsed.get("composition")
        if not isinstance(composition, dict) or not composition:
            return json.dumps({"ok": False, "reason": "缺少 composition"}, ensure_ascii=False)
        template_id = str(parsed.get("templateId") or "").strip()
        if not template_id:
            return json.dumps({"ok": False, "reason": "缺少 templateId"}, ensure_ascii=False)
        try:
            tpl = extract_template(
                composition,
                parsed.get("params") or [],
                template_id=template_id,
                label=str(parsed.get("label") or ""),
                description=str(parsed.get("description") or ""),
                signals=parsed.get("signals"),
                quest=parsed.get("quest"),
                dialogue_stubs=parsed.get("dialogueStubs"),
            )
        except Exception as exc:  # pragma: no cover - defensive
            return json.dumps({"ok": False, "reason": f"抽取失败：{exc}"}, ensure_ascii=False)
        return json.dumps({"ok": True, "template": tpl, "issues": validate_template(tpl)}, ensure_ascii=False)

    @Slot(str, result=str)
    def stampTemplate(self, payload: str) -> str:  # noqa: N802 - Qt slot name
        """盖章：模板 + 参数值 → 真作曲(并入传入的 narrative 并回传) + 镜像 quest(写 model) + 可选对话桩(写盘)。

        payload = {templateId, values:{...}, currentNarrative:{...},
                   generateDialogueStubs:bool, dryRun:bool}
        dryRun：只回 preview，不产生任何副作用。
        """
        from ..shared.narrative_templates import normalize_templates_file, stamp_template

        try:
            parsed = json.loads(payload or "{}")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid json: {exc}"}, ensure_ascii=False)

        template_id = str(parsed.get("templateId") or "").strip()
        values = parsed.get("values") if isinstance(parsed.get("values"), dict) else {}
        dry_run = bool(parsed.get("dryRun"))
        gen_stubs = bool(parsed.get("generateDialogueStubs"))
        current = parsed.get("currentNarrative")
        if not isinstance(current, dict):
            current = _normalize_file(self._model.narrative_graphs)

        templates = normalize_templates_file(self._model.narrative_templates)["templates"]
        tpl = next((t for t in templates if t.get("id") == template_id), None)
        if tpl is None:
            return json.dumps({"ok": False, "reason": f"模板「{template_id}」不存在"}, ensure_ascii=False)

        existing_comp = {
            str(c.get("id") or "").strip()
            for c in (current.get("compositions") or [])
            if isinstance(c, dict)
        }
        existing_comp.discard("")
        existing_quest = {q[0] for q in self._model.all_quest_ids()}
        existing_dlg = set(self._model.all_dialogue_graph_ids())
        # 既有信号 = 当前草稿的作者信号注册表。模板声明的新信号与之重名 = error（禁止：
        # 两单任务共用一个信号会互相串线推进）。注意不能拿「全项目实际发出集」查重——
        # 策划先手写好本单对话（已 emit 本单信号）再盖章是合法流程，不能误伤。
        existing_sig = {
            str(s.get("id") or "").strip()
            for s in (current.get("signals") or [])
            if isinstance(s, dict)
        }
        existing_sig.discard("")

        result = stamp_template(
            tpl, values,
            existing_composition_ids=existing_comp,
            existing_quest_ids=existing_quest,
            existing_dialogue_ids=existing_dlg,
            existing_signal_ids=existing_sig,
            generate_dialogue_stubs=gen_stubs,
        )
        if not result.get("ok"):
            return json.dumps({
                "ok": False,
                "reason": "；".join(str(e.get("message")) for e in result.get("errors", [])[:4]) or "盖章失败",
                "errors": result.get("errors", []),
                "warnings": result.get("warnings", []),
            }, ensure_ascii=False)

        preview = {
            "compositionId": result["compositionId"],
            "questId": result.get("questId", ""),
            "signals": [s.get("id") for s in result.get("signals", [])],
            "dialogueStubs": [
                {"id": s["id"], "emitSignal": s.get("emitSignal", ""), "exists": s.get("exists", False)}
                for s in result.get("dialogueStubs", [])
            ],
            "requiredEntities": result.get("requiredEntities", []),
            "warnings": result.get("warnings", []),
        }
        if dry_run:
            return json.dumps({"ok": True, "dryRun": True, "preview": preview}, ensure_ascii=False)

        # ---- 确认盖章：先构造并校验合并后的 narrative（有错则零副作用回滚） ----
        merged = _clone(current)
        merged.setdefault("compositions", [])
        if not isinstance(merged["compositions"], list):
            merged["compositions"] = []
        merged["compositions"].append(result["composition"])
        merged.setdefault("signals", [])
        if not isinstance(merged["signals"], list):
            merged["signals"] = []
        have_sig = {s.get("id") for s in merged["signals"] if isinstance(s, dict)}
        for sig in result.get("signals", []):
            if isinstance(sig, dict) and sig.get("id") not in have_sig:
                merged["signals"].append(sig)
                have_sig.add(sig.get("id"))

        merged_norm = _normalize_file(merged)
        nerrors = _validation_errors_for_save(merged_norm, self._model)
        if nerrors:
            preview_msg = "; ".join(str(e.get("message") or e.get("code")) for e in nerrors[:4])
            return json.dumps({
                "ok": False,
                "reason": f"合并后作曲校验失败（未写入任何文件）：{preview_msg}",
                "errors": nerrors,
            }, ensure_ascii=False)

        # ---- 全有全无：三样产物一并暂存进 ProjectModel，此刻零磁盘写入 ----
        # 主编辑器 Save All 一次性落盘（作曲+信号 → narrative_graphs.json；镜像任务 →
        # quests.json；对话桩 → dialogues/graphs/）。中途放弃/崩溃 = 三样都不存在，无孤儿。
        # 注意脏键：save_all 认的是 "quest"（单数），标错键 = Save All 不写文件却清脏标记，
        # 暂存内容无声丢失（历史 bug，勿回退）。
        self._model.narrative_graphs = merged_norm
        self._model.mark_dirty("narrative_graphs")

        quest_staged = False
        quest_obj = result.get("quest")
        if isinstance(quest_obj, dict) and result.get("questId"):
            if not isinstance(self._model.quests, list):
                self._model.quests = []
            self._model.quests.append(quest_obj)
            self._model.mark_dirty("quest")
            quest_staged = True

        stubs_staged: list[str] = []
        stub_skipped: list[str] = []
        if gen_stubs:
            graphs_dir = self._model.dialogues_path / "graphs"
            for stub in result.get("dialogueStubs", []):
                gid = str(stub.get("id") or "").strip()
                if not gid:
                    continue
                if stub.get("exists") or (graphs_dir / f"{gid}.json").exists():
                    stub_skipped.append(gid)
                    continue
                self._model.pending_dialogue_stubs[gid] = stub.get("graph") or {}
                stubs_staged.append(gid)
            if stubs_staged:
                self._model.mark_dirty("dialogue_stubs")

        return json.dumps({
            "ok": True,
            "dryRun": False,
            "narrative": merged_norm,
            "summary": {
                "compositionId": result["compositionId"],
                "questId": result.get("questId", ""),
                "questStaged": quest_staged,
                "signals": [s.get("id") for s in result.get("signals", [])],
                "stubsStaged": stubs_staged,
                "stubsSkipped": stub_skipped,
                "requiredEntities": result.get("requiredEntities", []),
                "warnings": result.get("warnings", []),
            },
        }, ensure_ascii=False)

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
        issues = validate_narrative_graphs(normalized) + validate_project_context(normalized, self._model)
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
        dialog.resize(820, 640)  # 略缩以适配 13"，并记忆几何

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
        remember_dialog_geometry(dialog, "narrative_action_editor")

        if dialog.exec() != QDialog.DialogCode.Accepted:
            return json.dumps({"ok": False, "reason": "cancelled"}, ensure_ascii=False)
        return json.dumps({"ok": True, "actions": editor.to_list()}, ensure_ascii=False)

    @Slot(str, str, result=str)
    def editConditions(self, label: str, payload: str) -> str:  # noqa: N802 - Qt slot name
        """Open the shared native ConditionEditor (all leaf types + all/any/not) and return the edited list.

        Mirrors editActions: lets planners author flag/quest/scenario/scenarioLine/narrative conditions
        with proper pickers instead of hand-editing JSON. transition.conditions may be a list or a single
        object; both are accepted and a list is returned (the canonical on-disk shape).
        """
        try:
            parsed = json.loads(payload or "[]")
        except Exception as exc:
            return json.dumps({"ok": False, "reason": f"invalid conditions payload: {exc}"}, ensure_ascii=False)
        if isinstance(parsed, dict):
            parsed = [parsed]
        if not isinstance(parsed, list):
            return json.dumps({"ok": False, "reason": "conditions payload must be a list or object"}, ensure_ascii=False)

        try:
            from PySide6.QtWidgets import QDialog, QDialogButtonBox
            from ..shared.condition_editor import ConditionEditor
        except Exception as exc:  # pragma: no cover - depends on full editor imports
            return json.dumps({"ok": False, "reason": f"ConditionEditor is unavailable: {exc}"}, ensure_ascii=False)

        parent = self.parent() if isinstance(self.parent(), QWidget) else None
        dialog = QDialog(parent)
        title = (label or "Conditions").strip() or "Conditions"
        dialog.setWindowTitle(title)
        dialog.resize(820, 640)

        layout = QVBoxLayout(dialog)
        editor = ConditionEditor(title, dialog)
        editor.set_flag_pattern_context(self._model, None)
        editor.set_data([c for c in parsed if isinstance(c, dict)])
        layout.addWidget(editor, 1)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            dialog,
        )
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)
        remember_dialog_geometry(dialog, "narrative_condition_editor")

        if dialog.exec() != QDialog.DialogCode.Accepted:
            return json.dumps({"ok": False, "reason": "cancelled"}, ensure_ascii=False)
        return json.dumps({"ok": True, "conditions": editor.to_list()}, ensure_ascii=False)

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
        # plane 非 wrapper owner 类型（不入 WRAPPER_OWNER_NAVIGATION，见其覆盖不变量测试），
        # 它是 state.activePlane 的跳转目标，独立分支路由到「位面」页。
        if kind == "plane":
            if hasattr(win, "navigate_to_plane"):
                win.navigate_to_plane(ref_id)
            return
        route = WRAPPER_OWNER_NAVIGATION.get(kind)
        if route is None:
            return
        if route == "dialogue" and hasattr(win, "navigate_to_dialogue_graph"):
            win.navigate_to_dialogue_graph(ref_id)
        elif route == "scenario" and hasattr(win, "navigate_to_scenario_catalog"):
            win.navigate_to_scenario_catalog(ref_id)
        elif route == "minigame" and hasattr(win, "navigate_to_minigame"):
            win.navigate_to_minigame(ref_id)
        elif route == "cutscene" and hasattr(win, "navigate_to_cutscene"):
            win.navigate_to_cutscene(ref_id)
        elif hasattr(win, "_on_navigate_to_source"):
            if route == "quest":
                win._on_navigate_to_source("quest", ref_id, "")
            elif route == "scene":
                win._on_navigate_to_source("scene", ref_id, "")
            elif route in _SCENE_OWNER_SOURCE_TYPES:
                scene_id, source_id = _split_scene_ref(ref_id)
                source_type = _SCENE_OWNER_SOURCE_TYPES[route]
                win._on_navigate_to_source(source_type, source_id or ref_id, scene_id)

    def _run_game_js_result(self, code: str) -> dict[str, Any]:
        win = _find_main_window(self)
        game = getattr(win, "_game_play_window", None) if win is not None else None
        if game is None or not getattr(game, "is_available", lambda: False)():
            return {"ok": False, "reason": "Game window is not running"}
        run_js_result = getattr(game, "run_js_result", None)
        if not callable(run_js_result):
            return {"ok": False, "reason": "Game window does not support JS return values"}
        token = os.urandom(8).hex()
        token_js = json.dumps(token)
        wrapped = (
            "(() => {"
            f"const token = {token_js};"
            "const store = window.__narrativeEditorRuntimeResults || (window.__narrativeEditorRuntimeResults = {});"
            "const pack = (value) => {"
            "try { return JSON.stringify(value ?? null); }"
            "catch (err) { return JSON.stringify({ok:false, reason:'Runtime result is not JSON serializable: ' + String((err && (err.message || err)) || err)}); }"
            "};"
            "try {"
            f"Promise.resolve({code}).then("
            "value => { store[token] = {done:true, json:pack(value)}; },"
            "err => { store[token] = {done:true, json:pack({ok:false, reason:String((err && (err.stack || err.message)) || err)})}; }"
            ");"
            "} catch (err) {"
            "store[token] = {done:true, json:pack({ok:false, reason:String((err && (err.stack || err.message)) || err)})};"
            "}"
            "return JSON.stringify({ok:true, token});"
            "})()"
        )
        poll = (
            "(() => {"
            "const store = window.__narrativeEditorRuntimeResults || {};"
            f"const entry = store[{token_js}];"
            "if (!entry) return JSON.stringify({done:false});"
            f"delete store[{token_js}];"
            "return JSON.stringify(entry);"
            "})()"
        )
        try:
            initial_raw = run_js_result(wrapped)
        except Exception as exc:
            return {"ok": False, "reason": f"runtime JS failed: {exc}"}
        if not isinstance(initial_raw, str):
            return {"ok": False, "reason": "Runtime did not return a JSON start token"}
        try:
            initial = json.loads(initial_raw)
        except Exception as exc:
            return {"ok": False, "reason": f"Runtime returned invalid start token: {exc}"}
        if not isinstance(initial, dict) or not initial.get("ok"):
            return {"ok": False, "reason": "Runtime did not start JS result capture"}
        for _ in range(60):
            try:
                polled_raw = run_js_result(poll, 250)
            except TypeError:
                polled_raw = run_js_result(poll)
            except Exception as exc:
                return {"ok": False, "reason": f"runtime JS poll failed: {exc}"}
            if not isinstance(polled_raw, str):
                return {"ok": False, "reason": "Runtime returned an empty poll result"}
            try:
                polled = json.loads(polled_raw)
            except Exception as exc:
                return {"ok": False, "reason": f"Runtime returned invalid poll JSON: {exc}"}
            if isinstance(polled, dict) and polled.get("done"):
                raw = polled.get("json")
                if not isinstance(raw, str) or not raw:
                    return {"ok": False, "reason": "Runtime returned an empty result"}
                try:
                    value = json.loads(raw)
                except Exception as exc:
                    return {"ok": False, "reason": f"Runtime returned invalid JSON: {exc}"}
                if isinstance(value, dict):
                    return value
                return {"ok": False, "reason": "Runtime returned a non-object result"}
            loop = QEventLoop()
            QTimer.singleShot(50, loop.quit)
            loop.exec()
        return {"ok": False, "reason": "Runtime JS timed out"}


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
        self._view.loadFinished.connect(self._on_web_load_finished)
        self._view.setMinimumSize(0, 0)
        self._view.setSizePolicy(
            QSizePolicy.Policy.Ignored,
            QSizePolicy.Policy.Ignored,
        )
        self._channel = QWebChannel(self._view.page())
        self._channel.registerObject("narrativeBridge", self._bridge)
        self._view.page().setWebChannel(self._channel)
        self._rebuild_proc: QProcess | None = None
        self._loaded_dist_mtime: float | None = None
        self._build_staleness_banner(root)
        root.addWidget(self._view, 1)
        self._load_web_editor()
        self._refresh_staleness_banner()

    def _build_staleness_banner(self, root: QVBoxLayout) -> None:
        """顶部"网页构建过期"横幅：dist 比源码旧时显眼提示 + 一键重建。"""
        bar = QFrame(self)
        bar.setObjectName("narrativeStaleBanner")
        bar.setStyleSheet(
            "QFrame#narrativeStaleBanner { background-color: #b35309; }"
            "QFrame#narrativeStaleBanner QLabel { color: #fff7ed; }"
        )
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(10, 5, 8, 5)
        lay.setSpacing(8)
        self._staleness_label = QLabel("", bar)
        self._staleness_label.setWordWrap(True)
        lay.addWidget(self._staleness_label, 1)
        self._rebuild_btn = QPushButton("重建并刷新", bar)
        self._rebuild_btn.setToolTip(f"运行 {_WEB_REBUILD_CMD} 并重新载入网页")
        self._rebuild_btn.clicked.connect(self._rebuild_web_bundle)
        lay.addWidget(self._rebuild_btn)
        self._reload_btn = QPushButton("刷新页面", bar)
        self._reload_btn.setToolTip("当前页面是旧 bundle，点此加载磁盘上最新构建")
        self._reload_btn.clicked.connect(self._reload_web_page)
        lay.addWidget(self._reload_btn)
        recheck = QPushButton("重新检查", bar)
        recheck.setToolTip("外部重建后点此刷新过期状态")
        recheck.clicked.connect(self._refresh_staleness_banner)
        lay.addWidget(recheck)
        self._staleness_banner = bar
        bar.setVisible(False)
        root.addWidget(bar)

    def _refresh_staleness_banner(self) -> None:
        banner = getattr(self, "_staleness_banner", None)
        if banner is None:
            return
        # A) dist 比源码旧：改了 src 没重建 → 提示重建。
        stale, message = web_build_staleness()
        if stale:
            self._staleness_label.setText("⚠ " + message)
            self._rebuild_btn.setVisible(True)
            self._reload_btn.setVisible(False)
            banner.setVisible(True)
            return
        # B) dist 已比"当前已加载页面"新：外部/终端重建过但本页还是旧 bundle → 提示刷新页面。
        dev = bool(os.environ.get(NARRATIVE_EDITOR_DEV_URL_ENV, "").strip())
        cur = _current_dist_mtime()
        loaded = self._loaded_dist_mtime
        if not dev and cur is not None and loaded is not None and cur > loaded:
            self._staleness_label.setText(
                "⚠ 网页已重建，但当前页面仍是旧 bundle（新功能/修复不会出现）。点「刷新页面」加载最新。"
            )
            self._rebuild_btn.setVisible(False)
            self._reload_btn.setVisible(True)
            banner.setVisible(True)
            return
        banner.setVisible(False)

    def _flush_web_draft_before_reload(self) -> bool:
        """重载/重建页面前把 Web 侧未保存草稿写进工程模型（复核 P1-08）。

        重载会整页丢弃 Web 编辑器状态，未 flush 的草稿=静默消失。flush 失败
        （校验不过等）时明确询问是否丢弃草稿；取消则中止重载。
        """
        if not self._web_editor_is_dirty():
            return True
        if self.flush_to_model(for_save_all=True):
            return True
        r = QMessageBox.question(
            self, "叙事草稿无法保存",
            f"{self._last_flush_error or '未知原因'}\n\n仍要重载页面并丢弃当前草稿吗？",
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
        )
        return r == QMessageBox.StandardButton.Discard

    def _reload_web_page(self) -> None:
        if not self._flush_web_draft_before_reload():
            return
        self._toolbar_reload_page()
        self._refresh_staleness_banner()

    def _rebuild_web_bundle(self) -> None:
        """一键重建网页 bundle 并自动重载（经登录 shell，GUI 启动也能找到 npm）。"""
        if self._rebuild_proc is not None:
            return
        # 重建完成会自动重载页面：先把当前草稿收进模型，防止构建期间的编辑被
        # 成功路径的自动 reload 丢掉（复核 P1-08）。
        if not self._flush_web_draft_before_reload():
            return
        self._rebuild_btn.setEnabled(False)
        self._rebuild_btn.setText("重建中…")
        program, args = _rebuild_shell_invocation()
        proc = QProcess(self)
        proc.setWorkingDirectory(str(_repo_root()))
        proc.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        proc.setProgram(program)
        proc.setArguments(args)
        proc.finished.connect(self._on_rebuild_finished)
        proc.errorOccurred.connect(self._on_rebuild_error)
        self._rebuild_proc = proc
        proc.start()

    def _reset_rebuild_button(self) -> None:
        self._rebuild_btn.setEnabled(True)
        self._rebuild_btn.setText("重建并刷新")

    def _on_rebuild_error(self, error) -> None:
        # 仅处理"起不来"（如 shell 缺失）；起来后才出的错交给 finished，避免双弹框。
        if error != QProcess.ProcessError.FailedToStart:
            return
        self._rebuild_proc = None
        self._reset_rebuild_button()
        QMessageBox.warning(
            self, "重建失败",
            f"无法启动重建命令。请在项目根目录手动运行：\n\n{_WEB_REBUILD_CMD}",
        )

    def _on_rebuild_finished(self, code: int, _status) -> None:
        proc = self._rebuild_proc
        self._rebuild_proc = None
        self._reset_rebuild_button()
        if code == 0:
            # 构建期间用户可能又编辑了：重载前再收一次草稿；用户取消则不自动重载，
            # 横幅保持可见，稍后可手动点「刷新页面」。
            if not self._flush_web_draft_before_reload():
                self._refresh_staleness_banner()
                return
            self._toolbar_reload_page()  # 载入新 hash 的 bundle
            self._refresh_staleness_banner()  # 不再过期 → 横幅自动隐藏
            return
        detail = ""
        if proc is not None:
            detail = bytes(proc.readAllStandardOutput()).decode("utf-8", "replace")[-1500:]
        QMessageBox.warning(
            self, "重建失败",
            f"{_WEB_REBUILD_CMD} 失败（退出码 {code}）：\n\n{detail}",
        )

    def _apply_web_font_tokens(self) -> None:
        if self._view is None:
            return
        payload = json.dumps(theme.web_font_css_tokens(), ensure_ascii=True)
        self._view.page().runJavaScript(
            "(function(tokens){const root=document.documentElement;"
            "if(!root)return false;"
            "for(const [key,value] of Object.entries(tokens)){root.style.setProperty(key,value);}"
            f"return true;}})({payload})",
        )

    def _on_web_load_finished(self, ok: bool) -> None:
        if ok:
            self._apply_web_font_tokens()

    def on_editor_theme_changed(self, _theme_id: str) -> None:
        self._apply_web_font_tokens()

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        self._refresh_staleness_banner()
        # 切到本页时顺手保鲜:dist 变新且无草稿 → 静默载入最新页面(有草稿只亮黄条)
        self._auto_reload_if_stale()

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
            self._loaded_dist_mtime = _current_dist_mtime()
            self._view.load(url)
            return
        self._load_web_editor()

    def _auto_reload_if_stale(self) -> bool:
        """dist 比已加载页面新、且 Web 侧无未保存草稿时,静默重载最新页面。

        目的:堵"重建了网页 bundle 但编辑器进程还载着旧页,跳转/新功能落不下去"
        这族问题。有草稿绝不自动动(交给顶栏黄条和手动「刷新页面」,
        不在导航路径上弹任何窗)。返回是否触发了重载。"""
        if self._view is None:
            return False
        try:
            if bool(os.environ.get(NARRATIVE_EDITOR_DEV_URL_ENV, "").strip()):
                return False  # dev server 模式自带热更,不掺和
            cur = _current_dist_mtime()
            loaded = self._loaded_dist_mtime
            if cur is None or loaded is None or cur <= loaded:
                return False
            # fail-safe（复核 P2）：只有「确定干净」才自动重载。脏或脏态未知（JS 超时/
            # 页面未就绪）一律不动——交给顶栏黄条与手动「刷新页面」，绝不在导航路径上
            # 悄悄丢草稿。
            if self._web_editor_dirty_state() is not False:
                return False
        except Exception:
            return False
        self._toolbar_reload_page()
        self._refresh_staleness_banner()
        return True

    @staticmethod
    def _focus_state_js(gid: str, sid: str) -> str:
        return (
            "window.__narrativeEditor && window.__narrativeEditor.focusState"
            f" ? window.__narrativeEditor.focusState({json.dumps(gid, ensure_ascii=False)},"
            f" {json.dumps(sid, ensure_ascii=False)}) : false"
        )

    def focus_state(self, graph_id: str, state_id: str) -> bool:
        """外部跳转入口（全局搜索/位面面板 hub 等）：让 web 编辑器切编排并聚焦指定状态。

        自带两层兜底:dist 过期且无草稿时先自动重载最新页面;页面尚未就绪
        (刚重载/首次加载中)则转入非阻塞延迟重试,就绪即定位。返回 False 仅当
        参数无效/视图缺失;已转入重试的返回 True(尽力而为,失败打日志)。"""
        gid = str(graph_id or "").strip()
        sid = str(state_id or "").strip()
        if not gid or not sid or self._view is None:
            return False
        reloading = self._auto_reload_if_stale()
        if not reloading:
            ready = self._run_editor_js_result(
                "!!(window.__narrativeEditor && window.__narrativeEditor.focusState)")
            if ready is True:
                return self._run_editor_js_result(self._focus_state_js(gid, sid)) is True
        self._schedule_focus_state_retry(gid, sid, tries=25)
        return True

    def _schedule_focus_state_retry(self, gid: str, sid: str, tries: int) -> None:
        """页面加载期间的定位重试(每 400ms,一次成败即止;全程不阻塞 UI)。"""
        def attempt(left: int) -> None:
            try:
                ready = self._run_editor_js_result(
                    "!!(window.__narrativeEditor && window.__narrativeEditor.focusState)",
                    timeout_ms=800,
                )
                if ready is True:
                    if self._run_editor_js_result(self._focus_state_js(gid, sid)) is not True:
                        print(f"[narrative] 页面就绪但未定位 {gid}.{sid}(图/状态不存在?)", flush=True)
                    return
            except Exception:
                pass
            if left > 0:
                QTimer.singleShot(400, lambda: attempt(left - 1))
            else:
                print(f"[narrative] 定位 {gid}.{sid} 超时:web 页面迟迟未就绪", flush=True)

        QTimer.singleShot(400, lambda: attempt(tries))

    def pop_flush_error(self) -> str | None:
        message = self._last_flush_error
        self._last_flush_error = None
        return message

    # 一次读回 web 编辑器状态：区分「正常有 API」「页面崩溃/白屏但留有草稿」「未加载」
    # 三态（复核 P1-07）。崩溃后 __narrativeEditor 被卸载清掉，但 __narrativeEditorLastDraft
    # 与 __narrativeEditorCrashed 刻意存活，据此不再把崩溃误判为「无内容、保存成功」。
    _READ_EDITOR_STATE_JS = (
        "(function(){"
        "var api=window.__narrativeEditor;"
        "var draft=window.__narrativeEditorLastDraft;"
        "var out={"
        "hasApi:!!(api&&api.getCurrentDataJson),"
        "crashed:window.__narrativeEditorCrashed===true,"
        "hasDraft:(typeof draft==='string'&&draft.length>0)"
        "};"
        "if(out.hasApi){try{out.json=api.getCurrentDataJson();}catch(e){out.error=String(e);}}"
        "else if(out.hasDraft){out.draft=draft;}"
        "return JSON.stringify(out);"
        "})()"
    )

    def _read_editor_state(self, attempts: int = 3, wait_ms: int = 150) -> dict[str, Any] | None:
        """读回 web 编辑器状态。至多 attempts 次短重试（此前 10×2s≈22s 假死，复核 P1-07）。

        返回 dict（含 hasApi/crashed/hasDraft/json/draft）或 None（视图缺失/始终取不到）。
        """
        for attempt in range(attempts):
            raw = self._run_editor_js_result(self._READ_EDITOR_STATE_JS, timeout_ms=800)
            if isinstance(raw, str) and raw.strip():
                try:
                    parsed = json.loads(raw)
                except Exception:
                    parsed = None
                if isinstance(parsed, dict):
                    # 已就绪（有 API 或已崩溃留稿）即返回；否则继续短重试等待首帧。
                    if parsed.get("hasApi") or parsed.get("crashed") or parsed.get("hasDraft"):
                        return parsed
                    last = parsed
                else:
                    last = None
            else:
                last = None
            if attempt + 1 >= attempts:
                return last
            loop = QEventLoop()
            QTimer.singleShot(wait_ms, loop.quit)
            loop.exec()
        return None

    def flush_to_model(self, *, for_save_all: bool = False) -> bool:
        self._last_flush_error = None
        if self._view is None:
            return True
        state = self._read_editor_state()
        payload = state.get("json") if isinstance(state, dict) else None
        if not isinstance(payload, str) or not payload.strip():
            # 取不到当前文档：必须区分「页面崩溃/白屏（有草稿或崩溃标志）」与「页面未
            # 加载/无内容」。前者绝不能返回 True 伪成功——否则 Save All 静默漏掉叙事草稿、
            # confirm_close 判无脏放行（复核 P1-07）。后者（离屏未渲染/从未编辑）无内容
            # 可 flush，放行不拦。
            if state is None:
                # J 修复（对抗组 V3）：_read_editor_state 整体返回 None——JS 引擎彻底卡死，
                # 既非 crashed、也无 lastDraft，连一个可判读的状态 dict 都取不回。此前落到
                # 下方 `return True` 伪成功，Save All 会「成功」却漏掉叙事草稿。这条路径同样
                # fail-safe：返回 False + 可读原因，让 Save All 记为该面板失败、confirm_close
                # 按脏询问，绝不静默放行。（区别于「state 能读到、确实无内容」的合法放行路径）
                self._last_flush_error = (
                    "叙事编辑器无响应，本次保存未包含叙事改动，请重试。"
                    "（可到叙事状态机页点顶栏「刷新页面」重载后再保存）"
                )
                if not for_save_all:
                    QMessageBox.warning(self, "叙事保存失败", self._last_flush_error)
                return False
            if isinstance(state, dict) and (state.get("crashed") or state.get("hasDraft")):
                self._last_flush_error = (
                    "叙事编辑器页面已崩溃或白屏，无法读回当前草稿——本次未写入叙事图数据。"
                    "请到叙事状态机页查看崩溃页并「复制草稿 JSON」备份，或点顶栏「刷新页面」"
                    "重载后重试；重载会回到工程模型里的最新暂存内容。"
                    "（最近草稿也保存在网页 window.__narrativeEditorLastDraft）"
                )
                if not for_save_all:
                    QMessageBox.warning(self, "叙事保存失败", self._last_flush_error)
                return False
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

    def _web_editor_dirty_state(self) -> bool | None:
        """web 侧脏态三态：True 脏 / False 干净 / None 未知（JS 超时取不到）。

        未知按 fail-safe 处理（复核 P2）：确认关闭当脏询问、自动重载一律不动。
        """
        if self._view is None:
            return False
        result = self._run_editor_js_result(
            "window.__narrativeEditor && window.__narrativeEditor.isDirty"
            " ? window.__narrativeEditor.isDirty() : false",
        )
        if result is True:
            return True
        if result is False:
            return False
        return None

    def _web_editor_is_dirty(self) -> bool:
        return self._web_editor_dirty_state() is True

    def confirm_close(self, parent: QWidget) -> bool:
        if self._view is None:
            return True
        # fail-safe（复核 P2）：脏态未知（页面刚重载/JS 超时）也按脏询问，不静默放行丢草稿。
        if self._web_editor_dirty_state() is False:
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
        # Discard：重载页面把内容真正回滚到模型当前值。只调 markSaved 清 dirty 标志
        # 不够——flush_to_model 走的是内容 diff，被放弃的编辑仍会被随后的统一 flush
        # 重新提交进模型（复核 P1-01）。
        self._toolbar_reload_page()
        return True

    def reload_from_model(self) -> None:
        if self._view is not None:
            self._view.reload()

    def _load_web_editor(self) -> None:
        assert self._view is not None
        url = _web_editor_load_url()
        if url is not None:
            self._loaded_dist_mtime = _current_dist_mtime()
            self._view.load(url)
            return
        # F5 在纯浏览器里=整页刷新、在主编辑器里=运行游戏，都不会加载新 bundle：文案改中文
        # 并指向顶栏「重建并刷新」一键路径（复核 P2）。
        message = (
            "叙事编辑器网页尚未构建（dist 缺失）。点顶栏橙色横幅里的「重建并刷新」按钮"
            "一键构建并载入；或在项目根目录运行 " + _WEB_REBUILD_CMD + " 后点「刷新页面」。"
            "（无需重启编辑器）"
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
        from ..shared.action_editor import CONTENT_ACTION_TYPES, ACTION_PERSISTENCE, _PARAM_SCHEMAS
        action_types = [str(x) for x in CONTENT_ACTION_TYPES]
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
    scene_npc_refs: list[str] = []
    scene_hotspot_refs: list[str] = []
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
                if key == "npcs":
                    scene_npc_refs.append(ref)
                    scene_npc_refs.append(eid)
                elif key == "hotspots":
                    scene_hotspot_refs.append(ref)
                    scene_hotspot_refs.append(eid)
                elif key == "zones":
                    zone_refs.append(ref)
                    zone_refs.append(eid)
    from ..shared.narrative_catalog import emitted_signal_ids, plane_membership_counts
    return {
        "dialogueGraphIds": model.all_dialogue_graph_ids(),
        "scenarioIds": model.scenario_ids_ordered(),
        "sceneIds": model.all_scene_ids(),
        "questIds": [x[0] for x in model.all_quest_ids()],
        "sceneEntityRefs": sorted(set(scene_refs)),
        "sceneNpcRefs": sorted(set(scene_npc_refs)),
        "sceneHotspotRefs": sorted(set(scene_hotspot_refs)),
        "zoneRefs": sorted(set(zone_refs)),
        "minigameIds": sorted(set(minigame_ids)),
        "cutsceneIds": [x[0] for x in model.all_cutscene_ids()],
        # 状态节点 activePlane 下拉候选（planes.json；文件缺失时为空列表）
        "planeIds": [pid for pid, _ in model.all_plane_ids()],
        "graphIds": model.narrative_graph_ids_ordered(),
        "actionTypes": action_types,
        "actionParamSchemas": action_param_schemas,
        "actionPersistence": action_persistence,
        # 稳定引用字段（web 侧任务问题检查器消费，见 TaskBusPanel issues）：
        # planeMembership = 每个位面被多少场景实体（planes 字段含它）归属 → 空位面判据。
        # planeExclusive = 世界模型为 exclusive（独立世界型）的位面 id 集（沿 extends 链解析）
        #   → 空位面文案分流：exclusive 空位面 = 空世界强提示。
        # emittedSignals = 全项目「实际发出」的信号集（不含 blackbox meta.emits 声明）→ 悬空信号判据。
        "planeMembership": plane_membership_counts(model),
        "planeExclusive": [
            pid for pid, _ in model.all_plane_ids()
            if model.plane_membership(pid) == "exclusive"
        ],
        "emittedSignals": emitted_signal_ids(model),
    }


def validate_narrative_graphs(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Python structural validator: a coarse save-path backstop and the basis for direct unit tests.

    The canonical, deeper validator is ``src/core/narrativeGraphValidation.ts``, which the web
    editor runs live (in-editor) before every save. This Python pass is intentionally wired into
    the Qt bridge (``validateData``) and the save path (``_validation_errors_for_save`` →
    ``saveData`` / ``ProjectModel.save_all``) as a second line of defense so structurally invalid
    graphs can never reach disk. It is deliberately kept a subset of the TS checks so the two
    never contradict — do not add stricter/divergent rules here; extend the TS validator instead.
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
            # 空 ownerType 与 TS 权威同口径跳过（ts 侧 `el.ownerType &&` 短路）——Python 兜底不得多报幻影 warning。
            _owner_type = str(el.get("ownerType", "")).strip()
            if kind == "wrapperGraph" and _owner_type and _owner_type not in _VALID_WRAPPER_OWNER_TYPES:
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
                elif kind == "wrapperGraph":
                    # TS 权威只对 wrapperGraph 报 graph 缺失（wrapper.graph.missing）；
                    # scenarioSubgraph 缺 graph TS 无 issue——Python 兜底不得更严。
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
        # activePlane 形状校验与 TS 权威（state.activePlane.invalid，error）对齐；
        # 位面 id 存在性检查需要 planes.json 目录，见 validate_project_context 的 unknown 检查。
        if "activePlane" in state:
            active_plane = state.get("activePlane")
            if not isinstance(active_plane, str) or not active_plane.strip():
                _issue(issues, "error", "state.activePlane.invalid", f"{gid}.{sid}: activePlane 必须是非空字符串", f"{path}.states.{sid}.activePlane", str(sid), _with_field(state_target, "activePlane"))
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
            # reactive* 迁移不消费 signal 字段,__draft__ 是钦定占位——豁免,
            # 只对信号型迁移报"未完工接线"(与 TS 权威 narrativeGraphValidation 同步,2026-07-13)。
            _trigger = str(transition.get("trigger", "signal")).strip()
            if _trigger not in ("reactive", "reactiveAll", "reactiveAny"):
                _issue(issues, "warning", "transition.signal.draft", f"{gid}.{tid}: transition still uses draft signal {DEFAULT_DRAFT_SIGNAL}", f"{tpath}.signal", f"{gid}.{tid}", _with_field(transition_target, "signal"))
        _validate_lifecycle_signal_scope(gid, tid, sig, tpath, issues, _with_field(transition_target, "signal"))
        _validate_reactive_trigger(transition, tpath, issues, _with_field(transition_target, "trigger"))
        _validate_conditions(transition.get("conditions"), f"{tpath}.conditions", issues, f"{gid}.{tid}", graph_index, _with_field(transition_target, "conditions"))


WRAPPER_OWNER_CATALOG_KEYS = {
    "npc": "sceneNpcRefs",
    "hotspot": "sceneHotspotRefs",
    "zone": "zoneRefs",
    "quest": "questIds",
    "dialogue": "dialogueGraphIds",
    "minigame": "minigameIds",
    "cutscene": "cutsceneIds",
    "scenario": "scenarioIds",
    "scene": "sceneIds",
}
WRAPPER_OWNER_NAVIGATION = {
    "npc": "npc",
    "hotspot": "hotspot",
    "zone": "zone",
    "quest": "quest",
    "dialogue": "dialogue",
    "minigame": "minigame",
    "cutscene": "cutscene",
    "scenario": "scenario",
    "scene": "scene",
}
_SCENE_OWNER_SOURCE_TYPES = {
    "npc": "scene_npc",
    "hotspot": "scene_hotspot",
    "zone": "scene_zone",
}
_NON_NAVIGABLE_WRAPPER_OWNER_TYPES = {"system"}
_VALID_WRAPPER_OWNER_TYPES = set(WRAPPER_OWNER_CATALOG_KEYS) | _NON_NAVIGABLE_WRAPPER_OWNER_TYPES


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
    by_owner: dict[str, list[dict[str, str]]] = {}
    for comp in data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements", []) or []:
            if not isinstance(el, dict) or str(el.get("kind", "")).strip() != "wrapperGraph":
                continue
            graph = el.get("graph") if isinstance(el.get("graph"), dict) else {}
            owner_type = str(graph.get("ownerType", "")).strip()
            owner_id = str(graph.get("ownerId", "")).strip()
            gid = str(graph.get("id", "")).strip()
            if owner_type and owner_id and gid:
                by_owner.setdefault(f"{owner_type}:{owner_id}", []).append({
                    "graphId": gid,
                    "category": str(graph.get("category", "") or "").strip(),
                })
    for key, wrappers in by_owner.items():
        if len(wrappers) <= 1:
            continue
        graph_ids = [entry["graphId"] for entry in wrappers]
        _issue(issues, "warning", "owner.wrapper.multi", f"{key}: 多个 wrapper graph 绑定同一 owner ({', '.join(graph_ids)})", item_id=key)
        missing_category_ids = [entry["graphId"] for entry in wrappers if not entry["category"]]
        if missing_category_ids:
            _issue(
                issues,
                "warning",
                "owner.wrapper.category.missing",
                f"{key}: 多 wrapper 应填写 category 以区分用途（缺少：{', '.join(missing_category_ids)}）",
                item_id=key,
            )
        by_category: dict[str, list[str]] = {}
        for entry in wrappers:
            category = entry["category"]
            if category:
                by_category.setdefault(category, []).append(entry["graphId"])
        for category, ids in by_category.items():
            if len(ids) > 1:
                _issue(
                    issues,
                    "warning",
                    "owner.wrapper.category.duplicate",
                    f"{key}: wrapper category {category!r} 被多个 graph 使用（{', '.join(ids)}）",
                    item_id=key,
                )


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


def _validate_actions(raw: Any, path: str, issues: list[dict[str, Any]], owner: str, target: dict[str, Any] | None = None) -> None:
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
        from ..shared.action_editor import ACTION_TYPES
        allowed = {str(x) for x in ACTION_TYPES}
    except Exception:
        allowed = {"emitNarrativeSignal"}
    action_type = str(action.get("type", "")).strip()
    if action_type not in allowed:
        _issue(issues, "error", "action.type.unknown", f"{owner}: unknown action type {action_type}", f"{path}.type", owner, target)
        return
    params = action.get("params") if isinstance(action.get("params"), dict) else {}
    # 必填集从 TS 权威 actionParamManifest.ts 解析（审查 P1-10 系统修）：历史写法把
    # _PARAM_SCHEMAS（GUI 控件清单）整表当必填，比 TS 权威严 25 处、拦死合法最小形态。
    # 红线：Python 兜底 ⊆ TS 权威。解析失败 fail-open——只校验类型存在、不做必填拦截
    # （validate-data 门与 TS 权威校验兜真错）。parity 由 test_narrative_required_params 锁定。
    try:
        from ..shared.narrative_required_params import load_required_params
        manifest = load_required_params()
    except Exception:
        manifest = None
    entry = manifest.get(action_type) if manifest is not None else None
    if entry is not None:
        required, non_empty = entry
        for name in required:
            value = params.get(name)
            missing = name not in params or value is None
            if not missing and name in non_empty and isinstance(value, str) and not value.strip():
                missing = True
            if missing:
                _issue(issues, "error", "action.param.missing", f"{owner}: {action_type} missing params.{name}", f"{path}.params.{name}", owner, target)
    # 保留前缀信号不可作为发射参数（与 TS 权威 action.signal.reserved 同码同级）：
    # state:* 是运行时派生广播、__draft__ 是占位符——内容伪造会直推里程碑/被运行时拒发。
    if action_type == "emitNarrativeSignal":
        sig = params.get("signal")
        sig_text = sig.strip() if isinstance(sig, str) else ""
        if sig_text and (sig_text == DEFAULT_DRAFT_SIGNAL or sig_text.startswith(DERIVED_STATE_SIGNAL_PREFIX)):
            _issue(
                issues,
                "error",
                "action.signal.reserved",
                f"{owner}: emitNarrativeSignal 不可发射保留信号 {sig_text!r}（state:* 由运行时派生广播；__draft__ 是占位符）",
                f"{path}.params.signal",
                owner,
                target,
            )
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
) -> None:
    if raw is None:
        return
    if not isinstance(raw, list):
        _issue(issues, "error", "conditions.shape", f"{owner}: conditions must be an array", path, owner, target)
        return
    for i, expr in enumerate(raw):
        _validate_condition_expr(expr, f"{path}[{i}]", issues, owner, graph_index or {}, target)


def _is_condition_shape(expr: Any) -> bool:
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
    # quest/scenario/scenarioLine 缺伴随字段（status 等）时 TS 权威静默容忍（求值 false 但不报 issue）——
    # Python 兜底不得更严（红线），键存在即认形状；plane 是第 6 类合法叶子（TS 仅拦空串），
    # 旧实现漏掉它导致 plane 条件保存必被拦（2026-07-17 审查 P-F1）。
    if isinstance(expr.get("quest"), str):
        return True
    if isinstance(expr.get("scenario"), str):
        return True
    if isinstance(expr.get("scenarioLine"), str):
        return True
    if isinstance(expr.get("plane"), str):
        return bool(expr["plane"].strip())
    # 叙事活计计数叶（S1 v2）：narrativeCount 需数值 value（活计当前态用普通 narrative 叶）。
    if isinstance(expr.get("narrativeCount"), str):
        return isinstance(expr.get("value"), (int, float)) and not isinstance(expr.get("value"), bool)
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
        # 相对 token（@owner / @scene）在运行时解析，跳过静态 graphId/state 存在性检查——
        # 与权威校验器 narrativeGraphValidation.ts 一致（validateConditionExpr 中
        # graphId.startsWith('@') 即跳过）。否则 Python 兜底比 TS 更严，
        # 会把运行时/TS 都认可的合法条件拦在保存路径外（saveData / save_all）。
        if graph_id.startswith("@"):
            return True
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


def _web_editor_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "narrative_editor_web"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _web_editor_index() -> Path:
    return _web_editor_dir() / "dist" / "index.html"


_WEB_REBUILD_CMD = "npm run build:narrative-editor"


def _current_dist_mtime() -> float | None:
    """当前磁盘上 dist/index.html 的 mtime（缺失/出错为 None）。"""
    idx = _web_editor_index()
    try:
        return idx.stat().st_mtime if idx.is_file() else None
    except OSError:
        return None


def _rebuild_shell_invocation() -> tuple[str, list[str]]:
    """经登录 shell 跑重建命令：`$SHELL -lc 'cd <root> && npm run …'`。

    `-l` 会加载用户 profile（.zprofile/.bash_profile 等），从而拿到 nvm/homebrew 的 PATH——
    这样即便编辑器从 Finder/Dock 等 GUI 启动（PATH 精简、`which npm` 找不到）也能跑起来。
    """
    import shlex
    shell = os.environ.get("SHELL") or "/bin/zsh"
    cmd = f"cd {shlex.quote(str(_repo_root()))} && {_WEB_REBUILD_CMD}"
    return shell, ["-lc", cmd]


def web_build_staleness(web_dir: Path | None = None) -> tuple[bool, str]:
    """返回 (网页构建是否过期, 提示文案)。

    dist/index.html 比 src 任一源文件旧 ⇒ 编辑器仍在跑旧产物（改了源码没重建）。
    dev server 模式（设了 env URL）始终读源码，永不过期。web_dir 仅供测试注入。
    """
    if os.environ.get(NARRATIVE_EDITOR_DEV_URL_ENV, "").strip():
        return False, ""
    wd = web_dir or _web_editor_dir()
    index = wd / "dist" / "index.html"
    if not index.is_file():
        return True, f"叙事编辑器网页尚未构建（dist 缺失）。运行 {_WEB_REBUILD_CMD} 后重开本页。"
    try:
        dist_mtime = index.stat().st_mtime
    except OSError:
        return False, ""
    src_dir = wd / "src"
    newest = 0.0
    newest_name = ""
    candidates: list[Path] = list(src_dir.rglob("*")) if src_dir.is_dir() else []
    cfg = wd / "vite.config.ts"
    if cfg.is_file():
        candidates.append(cfg)
    for p in candidates:
        try:
            if not p.is_file():
                continue
            mt = p.stat().st_mtime
        except OSError:
            continue
        if mt > newest:
            newest, newest_name = mt, p.name
    if newest > dist_mtime:
        return True, (
            f"网页源码（{newest_name}）比已构建的 dist 新——编辑器仍在跑旧产物，"
            f"新功能/修复不会出现。点「重建并刷新」或运行 {_WEB_REBUILD_CMD}，完成后重开本页。"
        )
    return False, ""


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
    fallback_px = theme.css_font_px(theme.FONT_ROLE_PROMINENT, theme.DEFAULT_FONT_PX)
    return (
        "<!doctype html><html><meta charset='utf-8'><body "
        "style='margin:0;height:100vh;display:flex;align-items:center;justify-content:center;"
        "background:#191b1f;color:#c9d3dc;"
        f"font-size:var(--editor-host-font-prominent,{fallback_px});"
        "font-family:system-ui,sans-serif'>"
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
