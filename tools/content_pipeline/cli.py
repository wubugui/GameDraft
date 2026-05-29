from __future__ import annotations

import argparse
import csv
import json
import subprocess
import re
import sys
import time
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
AUTHORING = ROOT / "authoring"
ARTIFACT = ROOT / "artifact" / "content_pipeline"

Json = dict[str, Any]


@dataclass
class Diagnostic:
    severity: str
    code: str
    message: str
    file: str = ""
    line: int = 0
    column: int = 0
    suggestion: str = ""

    def to_dict(self) -> Json:
        return {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "source": {"file": self.file, "line": self.line, "column": self.column},
            "suggestion": self.suggestion,
        }

    def format(self) -> str:
        loc = f"{self.file}:{self.line}:{self.column}" if self.file else "<pipeline>"
        return f"{loc}: {self.severity} {self.code} {self.message}"


@dataclass
class BuildContext:
    diagnostics: list[Diagnostic] = field(default_factory=list)
    yaml_locations: dict[str, dict[str, Json]] = field(default_factory=dict)
    source_map: dict[str, Any] = field(default_factory=lambda: {
        "version": 2,
        "sources": {},
        "runtimeToSource": {},
    })
    index: dict[str, Any] = field(default_factory=lambda: {
        "flags": {},
        "signals": {},
        "quests": {},
        "narrativeGraphs": {},
        "narrativeStates": {},
        "dialogueGraphs": {},
        "actions": {},
    })

    def warn(self, code: str, message: str, file: str = "", line: int = 0, column: int = 0, suggestion: str = "") -> None:
        self.diagnostics.append(Diagnostic("warning", code, message, file, line, column, suggestion))

    def error(self, code: str, message: str, file: str = "", line: int = 0, column: int = 0, suggestion: str = "") -> None:
        self.diagnostics.append(Diagnostic("error", code, message, file, line, column, suggestion))

    def source(self, path: Path, loc_path: tuple[Any, ...] = ()) -> Json:
        rel = _rel(path)
        locs = self.yaml_locations.get(rel, {})
        loc = locs.get(_loc_key(loc_path)) or locs.get("")
        return {"file": rel, "line": int(loc.get("line", 1)), "column": int(loc.get("column", 1))}

    def source_id(self, prefix: str, raw: Any, *, source: Json, kind: str) -> str:
        if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"].strip():
            return f"{prefix}.{_slug(raw['id'])}"
        fallback = f"{prefix}._line{int(source.get('line', 1))}_col{int(source.get('column', 1))}"
        self.warn(
            "source_id.implicit",
            f"{kind} missing stable id; generated fallback sourceId {fallback}",
            str(source.get("file", "")),
            int(source.get("line", 0) or 0),
            int(source.get("column", 0) or 0),
            "Add an authoring-only id field to keep trace/source mapping stable after reordering.",
        )
        return fallback

    def add_source_map(self, source_id: str, *, runtime_ref: str, source: Json, kind: str, runtime_path: str = "") -> None:
        self.source_map["sources"][source_id] = {
            "kind": kind,
            "runtimePath": runtime_path,
            **source,
        }
        self.source_map["runtimeToSource"][runtime_ref] = source_id


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except Exception:
        return path.as_posix()


def _loc_key(path: tuple[Any, ...]) -> str:
    return ".".join(str(p) for p in path)


def _slug(value: Any) -> str:
    text = str(value).strip()
    text = re.sub(r"[^0-9A-Za-z_.-]+", "_", text)
    return text.strip("._-") or "unnamed"


def _condition_id(raw: Any) -> str:
    if isinstance(raw, dict) and isinstance(raw.get("id"), str):
        return raw["id"]
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and isinstance(raw[0].get("id"), str):
        return str(raw[0]["id"])
    return ""


def ensure_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    ensure_dir(path)
    path.write_text(text, encoding="utf-8")


# Logical runtime output keys -> their canonical real runtime path (used for ownership lookup).
_DEFAULT_RUNTIME_OUTPUTS = {
    "flagRegistry": "public/assets/data/flag_registry.json",
    "narrativeGraphs": "public/assets/data/narrative_graphs.json",
    "quests": "public/assets/data/quests.json",
    "dialogueGraphs": "public/assets/dialogues/graphs",
}
_DEFAULT_PREVIEW_OUTPUTS = {
    "flagRegistry": "artifact/content_pipeline/runtime_preview/public/assets/data/flag_registry.json",
    "narrativeGraphs": "artifact/content_pipeline/runtime_preview/public/assets/data/narrative_graphs.json",
    "quests": "artifact/content_pipeline/runtime_preview/public/assets/data/quests.json",
    "dialogueGraphs": "artifact/content_pipeline/runtime_preview/public/assets/dialogues/graphs",
}
_DEFAULT_OWNERSHIP = {
    "public/assets/data/flag_registry.json": "legacy_editor",
    "public/assets/data/narrative_graphs.json": "legacy_editor",
    "public/assets/data/quests.json": "legacy_editor",
    "public/assets/dialogues/graphs/*": "legacy_editor",
}


def _default_config() -> Json:
    return {
        "publishRuntime": False,
        "artifactRoot": ARTIFACT,
        "previewRoot": ARTIFACT / "runtime_preview",
        "runtimeOutputs": dict(_DEFAULT_RUNTIME_OUTPUTS),
        "previewOutputs": dict(_DEFAULT_PREVIEW_OUTPUTS),
        "ownership": dict(_DEFAULT_OWNERSHIP),
    }


def load_project_config(ctx: BuildContext) -> Json:
    cfg = _default_config()
    path = AUTHORING / "project.yaml"
    if not path.exists():
        ctx.warn("project.missing", "authoring/project.yaml not found; using safe preview defaults")
        return cfg
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        ctx.error("project.parse", f"failed to parse project.yaml: {e}", _rel(path))
        return cfg
    if not isinstance(raw, dict):
        ctx.warn("project.invalid", "project.yaml is not a mapping; using safe defaults", _rel(path))
        return cfg
    if isinstance(raw.get("publishRuntime"), bool):
        cfg["publishRuntime"] = raw["publishRuntime"]
    for key in ("runtimeOutputs", "previewOutputs", "ownership"):
        if isinstance(raw.get(key), dict):
            cfg[key] = {**cfg[key], **{k: v for k, v in raw[key].items() if isinstance(v, str)}}
    return cfg


def owner_for(real_path: str, ownership: dict[str, str]) -> str:
    """Resolve the owner of a runtime path. Unlisted paths default to pipeline-owned."""
    if real_path in ownership:
        return ownership[real_path]
    for pattern, owner in ownership.items():
        if pattern.endswith("/*") and (real_path == pattern[:-2] or real_path.startswith(pattern[:-1])):
            return owner
        if fnmatch(real_path, pattern):
            return owner
    return "pipeline"


def resolve_output_target(cfg: Json, key: str, publish: bool) -> tuple[Path, bool]:
    """Return (absolute_path, published). Publishes to the real runtime path only when
    publish is requested AND the target is not owned by the legacy editor."""
    real = cfg["runtimeOutputs"].get(key, _DEFAULT_RUNTIME_OUTPUTS[key])
    owner = owner_for(real, cfg["ownership"])
    if publish and owner != "legacy_editor":
        return (ROOT / real, True)
    preview = cfg["previewOutputs"].get(key, _DEFAULT_PREVIEW_OUTPUTS[key])
    return (ROOT / preview, False)


def read_csv_rows(path: Path, ctx: BuildContext) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = []
        for i, row in enumerate(reader, start=2):
            clean = {str(k or "").strip(): str(v or "").strip() for k, v in row.items()}
            clean["__file"] = _rel(path)
            clean["__line"] = str(i)
            rows.append(clean)
        return rows


def parse_scalar(raw: str) -> Any:
    s = raw.strip()
    if s == "":
        return None
    if s.lower() in {"true", "yes"}:
        return True
    if s.lower() in {"false", "no"}:
        return False
    if s.lower() in {"null", "none"}:
        return None
    try:
        if re.fullmatch(r"-?\d+", s):
            return int(s)
        if re.fullmatch(r"-?\d+\.\d+", s):
            return float(s)
    except Exception:
        pass
    return s


def parse_simple_yaml(path: Path, ctx: BuildContext) -> Any:
    """Parse YAML and retain source locations for source maps and trace lookup."""
    if not path.exists():
        ctx.error("yaml.missing", f"missing YAML file: {_rel(path)}", _rel(path))
        return {}
    rel = _rel(path)
    text = path.read_text(encoding="utf-8")
    try:
        root_node = yaml.compose(text)
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        ctx.error("yaml.parse", str(e), rel, int(getattr(mark, "line", 0)) + 1, int(getattr(mark, "column", 0)) + 1)
        return {}

    locs: dict[str, Json] = {}

    def remember(loc_path: tuple[Any, ...], node: yaml.Node | None) -> None:
        if node is None:
            return
        locs[_loc_key(loc_path)] = {
            "file": rel,
            "line": int(node.start_mark.line) + 1,
            "column": int(node.start_mark.column) + 1,
        }

    def scalar_key(node: yaml.Node) -> Any:
        if isinstance(node, yaml.ScalarNode):
            return node.value
        return "<complex>"

    def walk(node: yaml.Node | None, loc_path: tuple[Any, ...] = ()) -> None:
        remember(loc_path, node)
        if isinstance(node, yaml.MappingNode):
            for key_node, value_node in node.value:
                key = scalar_key(key_node)
                remember(loc_path + (key,), key_node)
                walk(value_node, loc_path + (key,))
        elif isinstance(node, yaml.SequenceNode):
            for i, item in enumerate(node.value):
                walk(item, loc_path + (i,))

    walk(root_node)
    ctx.yaml_locations[rel] = locs
    return data if data is not None else {}


def normalize_condition(expr: Any) -> Any:
    if expr is None:
        return []
    if isinstance(expr, list):
        return [normalize_condition(x) for x in expr]
    if isinstance(expr, dict):
        return {k: normalize_condition(v) if k in {"all", "any", "not"} else v for k, v in expr.items() if k != "id"}
    return expr


def normalize_action(raw: Any) -> Json:
    if isinstance(raw, dict) and "type" in raw:
        return {"type": str(raw.get("type", "")), "params": raw.get("params") or {}}
    if isinstance(raw, dict) and len(raw) == 1:
        k, v = next(iter(raw.items()))
        if k == "signal":
            return {"type": "emitNarrativeSignal", "params": {"signal": v}}
        if k == "setFlag" and isinstance(v, dict):
            return {"type": "setFlag", "params": v}
        return {"type": str(k), "params": v if isinstance(v, dict) else {"value": v}}
    return {"type": "unknown", "params": {"raw": raw}}


def normalize_next_quests(raw: Any) -> list[Json]:
    if not isinstance(raw, list):
        return []
    out: list[Json] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        edge = {k: v for k, v in item.items() if k != "id"}
        if "conditions" in edge:
            edge["conditions"] = normalize_condition(edge.get("conditions"))
        out.append(edge)
    return out


def index_ref(bucket: dict[str, Any], key: str, role: str, item: Json) -> None:
    if not key:
        return
    rec = bucket.setdefault(key, {"declaredAt": [], "readers": [], "writers": [], "emitters": [], "listeners": []})
    rec.setdefault(role, []).append(item)


def scan_condition_refs(expr: Any, ctx: BuildContext, loc: Json, mode: str = "readers") -> None:
    if isinstance(expr, list):
        for item in expr:
            scan_condition_refs(item, ctx, loc, mode)
    elif isinstance(expr, dict):
        if isinstance(expr.get("flag"), str):
            index_ref(ctx.index["flags"], expr["flag"], mode, loc)
        if isinstance(expr.get("quest"), str):
            index_ref(ctx.index["quests"], expr["quest"], "readers", loc)
        if isinstance(expr.get("narrative"), str) and isinstance(expr.get("state"), str):
            key = f"{expr['narrative']}.{expr['state']}"
            index_ref(ctx.index["narrativeStates"], key, "readers", loc)
        for k in ("all", "any"):
            if k in expr:
                scan_condition_refs(expr[k], ctx, loc, mode)
        if "not" in expr:
            scan_condition_refs(expr["not"], ctx, loc, mode)


def scan_action_refs(actions: list[Any], ctx: BuildContext, loc_base: Json) -> None:
    for i, raw in enumerate(actions or []):
        action = normalize_action(raw)
        typ = action.get("type", "")
        params = action.get("params") or {}
        loc = {**loc_base, "path": f"{loc_base.get('path','')}.actions[{i}]", "actionType": typ}
        index_ref(ctx.index["actions"], typ, "readers", loc)
        if typ in {"setFlag", "appendFlag"}:
            index_ref(ctx.index["flags"], str(params.get("key", "")), "writers", loc)
        if typ == "emitNarrativeSignal":
            index_ref(ctx.index["signals"], str(params.get("signal", "")), "emitters", loc)
        if typ == "updateQuest":
            qid = str(params.get("id") or params.get("questId") or "")
            index_ref(ctx.index["quests"], qid, "writers", loc)
        if typ == "runActions" and isinstance(params.get("actions"), list):
            scan_action_refs(params["actions"], ctx, loc)


def compile_flags(ctx: BuildContext) -> Json:
    rows = read_csv_rows(AUTHORING / "tables" / "flags.csv", ctx)
    static = []
    seen = set()
    for row in rows:
        key = row.get("key", "")
        typ = row.get("type", "bool") or "bool"
        if not key:
            ctx.error("flag.key.empty", "flag key is required", row.get("__file", ""), int(row.get("__line", "0") or 0), 1)
            continue
        if key in seen:
            ctx.error("flag.duplicate", f"duplicate flag key: {key}", row.get("__file", ""), int(row.get("__line", "0") or 0), 1)
            continue
        seen.add(key)
        static.append({"key": key, "valueType": "float" if typ in {"number", "float"} else typ})
        source = {"file": row.get("__file"), "line": int(row.get("__line", "1") or 1), "column": 1}
        index_ref(ctx.index["flags"], key, "declaredAt", {**source, "owner": row.get("owner"), "meaning": row.get("meaning")})
        ctx.add_source_map(f"flag.{_slug(key)}", runtime_ref=f"flag:{key}", source=source, kind="flag", runtime_path=f"flag_registry.static.{key}")
    return {"static": static, "patterns": [], "runtime": {"warnUnknownInDev": True}}


def load_signals(ctx: BuildContext) -> None:
    rows = read_csv_rows(AUTHORING / "tables" / "signals.csv", ctx)
    for row in rows:
        key = row.get("key", "")
        if not key:
            continue
        source = {"file": row.get("__file"), "line": int(row.get("__line", "1") or 1), "column": 1}
        index_ref(ctx.index["signals"], key, "declaredAt", {**source, "owner": row.get("owner"), "meaning": row.get("meaning")})
        ctx.add_source_map(f"signal.{_slug(key)}", runtime_ref=f"signal:{key}", source=source, kind="signal", runtime_path=f"signals.{key}")


def compile_narrative(ctx: BuildContext) -> Json:
    graphs = []
    compositions: list[Json] = []
    seen_graph_ids: set[str] = set()
    for path in sorted((AUTHORING / "narrative").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            ctx.error("narrative.id.missing", "narrative graph id is required", _rel(path), 1, 1)
            continue
        gid = str(data["id"])
        if gid in seen_graph_ids:
            src = ctx.source(path, ("id",))
            ctx.error("narrative.duplicate", f"duplicate narrative graph id: {gid}", src["file"], src["line"], src["column"])
            continue
        seen_graph_ids.add(gid)
        comp_index = len(graphs)
        comp_path = f"narrative_graphs.compositions[{comp_index}].mainGraph"
        ctx.add_source_map(
            f"narrative.{_slug(gid)}",
            runtime_ref=f"narrative:{gid}",
            source=ctx.source(path, ("id",)),
            kind="narrativeGraph",
            runtime_path=comp_path,
        )
        owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
        layout = data.get("layout") if isinstance(data.get("layout"), dict) else {}
        states_src = data.get("states") if isinstance(data.get("states"), dict) else {}
        transitions_src = data.get("transitions") if isinstance(data.get("transitions"), list) else []
        states: Json = {}
        for sid, sdef in states_src.items():
            sdef = sdef if isinstance(sdef, dict) else {}
            out: Json = {"id": sid}
            if sdef.get("label") is not None:
                out["label"] = str(sdef.get("label"))
            pos = layout.get(sid) if isinstance(layout.get(sid), dict) else None
            if pos is not None and (pos.get("x") is not None or pos.get("y") is not None):
                out["meta"] = {"editor": {"x": pos.get("x", 0), "y": pos.get("y", 0)}}
            ctx.add_source_map(
                f"narrative.{_slug(gid)}.state.{_slug(sid)}",
                runtime_ref=f"narrative:{gid}.state:{sid}",
                source=ctx.source(path, ("states", sid)),
                kind="narrativeState",
                runtime_path=f"{comp_path}.states.{sid}",
            )
            if sdef.get("broadcastOnEnter") is not None:
                out["broadcastOnEnter"] = bool(sdef.get("broadcastOnEnter"))
            if isinstance(sdef.get("onEnterActions"), list):
                out["onEnterActions"] = [normalize_action(a) for a in sdef["onEnterActions"]]
                scan_action_refs(sdef["onEnterActions"], ctx, {"file": _rel(path), "symbol": f"narrative:{gid}.state:{sid}", "path": f"states.{sid}.onEnterActions"})
                for i, raw_action in enumerate(sdef["onEnterActions"]):
                    source = ctx.source(path, ("states", sid, "onEnterActions", i))
                    source_id = ctx.source_id(f"narrative.{_slug(gid)}.state.{_slug(sid)}.onEnterAction", raw_action, source=source, kind="action")
                    ctx.add_source_map(
                        source_id,
                        runtime_ref=f"narrative:{gid}.state:{sid}.onEnterActions[{i}]",
                        source=source,
                        kind="action",
                        runtime_path=f"{comp_path}.states.{sid}.onEnterActions[{i}]",
                    )
            if isinstance(sdef.get("onExitActions"), list):
                out["onExitActions"] = [normalize_action(a) for a in sdef["onExitActions"]]
                scan_action_refs(sdef["onExitActions"], ctx, {"file": _rel(path), "symbol": f"narrative:{gid}.state:{sid}", "path": f"states.{sid}.onExitActions"})
                for i, raw_action in enumerate(sdef["onExitActions"]):
                    source = ctx.source(path, ("states", sid, "onExitActions", i))
                    source_id = ctx.source_id(f"narrative.{_slug(gid)}.state.{_slug(sid)}.onExitAction", raw_action, source=source, kind="action")
                    ctx.add_source_map(
                        source_id,
                        runtime_ref=f"narrative:{gid}.state:{sid}.onExitActions[{i}]",
                        source=source,
                        kind="action",
                        runtime_path=f"{comp_path}.states.{sid}.onExitActions[{i}]",
                    )
            states[str(sid)] = out
            index_ref(ctx.index["narrativeStates"], f"{gid}.{sid}", "declaredAt", {"file": _rel(path), "symbol": f"narrative:{gid}.state:{sid}"})
        transitions = []
        for ti, t in enumerate(transitions_src):
            if not isinstance(t, dict):
                continue
            tid = str(t.get("id", ""))
            frm = str(t.get("from", ""))
            to = str(t.get("to", ""))
            if frm and frm not in states:
                ctx.error("narrative.transition.from_missing", f"transition {tid} source state missing: {frm}", _rel(path), 1, 1)
            if to and to not in states:
                ctx.error("narrative.transition.to_missing", f"transition {tid} target state missing: {to}", _rel(path), 1, 1)
            out = {"id": tid, "from": frm, "to": to}
            transition_ref = f"narrative:{gid}.transition:{tid or ti}"
            ctx.add_source_map(
                f"narrative.{_slug(gid)}.transition.{_slug(tid or ti)}",
                runtime_ref=transition_ref,
                source=ctx.source(path, ("transitions", ti)),
                kind="narrativeTransition",
                runtime_path=f"{comp_path}.transitions[{ti}]",
            )
            if t.get("signal") is not None:
                out["signal"] = str(t.get("signal"))
                index_ref(ctx.index["signals"], out["signal"], "listeners", {"file": _rel(path), "symbol": f"narrative:{gid}.transition:{tid}"})
            if t.get("priority") is not None:
                out["priority"] = t.get("priority")
            if isinstance(t.get("conditions"), list):
                out["conditions"] = normalize_condition(t.get("conditions"))
                scan_condition_refs(out["conditions"], ctx, {"file": _rel(path), "symbol": f"narrative:{gid}.transition:{tid}", "path": f"transitions.{tid}.conditions"})
                source = ctx.source(path, ("transitions", ti, "conditions"))
                source_id = ctx.source_id(f"narrative.{_slug(gid)}.transition.{_slug(tid or ti)}.condition", {"id": _condition_id(t.get("conditions"))}, source=source, kind="condition")
                ctx.add_source_map(
                    source_id,
                    runtime_ref=f"{transition_ref}.conditions",
                    source=source,
                    kind="condition",
                    runtime_path=f"{comp_path}.transitions[{ti}].conditions",
                )
            transitions.append(out)
        graph = {
            "id": gid,
            "ownerType": str(owner.get("type", data.get("ownerType", "")) or ""),
            "ownerId": str(owner.get("id", data.get("ownerId", "")) or ""),
            "initialState": str(data.get("initialState", "")),
            "states": states,
            "transitions": transitions,
        }
        graphs.append(graph)
        elements = data.get("elements") if isinstance(data.get("elements"), list) else []
        composition: Json = {"id": gid, "mainGraph": graph, "elements": elements}
        if data.get("label") is not None:
            composition["label"] = str(data.get("label"))
        if data.get("description") is not None:
            composition["description"] = str(data.get("description"))
        compositions.append(composition)
        index_ref(ctx.index["narrativeGraphs"], gid, "declaredAt", {"file": _rel(path), "symbol": f"narrative:{gid}"})
    return {"schemaVersion": 3, "compositions": compositions}


def compile_quests(ctx: BuildContext) -> list[Json]:
    base_rows = {r.get("id", ""): r for r in read_csv_rows(AUTHORING / "tables" / "quests.csv", ctx) if r.get("id")}
    out: list[Json] = []
    seen_quest_ids: set[str] = set()
    for path in sorted((AUTHORING / "quests").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            continue
        qid = str(data["id"])
        if qid in seen_quest_ids:
            src = ctx.source(path, ("id",))
            ctx.error("quest.duplicate", f"duplicate quest id: {qid}", src["file"], src["line"], src["column"])
            continue
        seen_quest_ids.add(qid)
        base = base_rows.get(qid, {})
        ctx.add_source_map(
            f"quest.{_slug(qid)}",
            runtime_ref=f"quest:{qid}",
            source=ctx.source(path, ("id",)),
            kind="quest",
            runtime_path=f"quests.{qid}",
        )
        q = {
            "id": qid,
            "group": base.get("group") or data.get("group") or "default",
            "type": base.get("type") or data.get("type") or "side",
            "title": base.get("title") or data.get("title") or qid,
            "description": base.get("description") or data.get("description") or "",
            "preconditions": normalize_condition(data.get("preconditions") or []),
            "completionConditions": normalize_condition(data.get("completionConditions") or []),
            "acceptActions": [normalize_action(a) for a in data.get("acceptActions") or []],
            "rewards": [normalize_action(a) for a in data.get("rewards") or []],
            "nextQuests": normalize_next_quests(data.get("nextQuests")),
        }
        if base.get("sideType"):
            q["sideType"] = base["sideType"]
        loc = {"file": _rel(path), "symbol": f"quest:{qid}"}
        index_ref(ctx.index["quests"], qid, "declaredAt", loc)
        scan_condition_refs(q["preconditions"], ctx, {**loc, "path": "preconditions"})
        scan_condition_refs(q["completionConditions"], ctx, {**loc, "path": "completionConditions"})
        scan_action_refs(data.get("acceptActions") or [], ctx, {**loc, "path": "acceptActions"})
        scan_action_refs(data.get("rewards") or [], ctx, {**loc, "path": "rewards"})
        if data.get("preconditions") is not None:
            source = ctx.source(path, ("preconditions",))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.preconditions", {"id": "root"}, source=source, kind="condition"),
                runtime_ref=f"quest:{qid}.preconditions",
                source=source,
                kind="condition",
                runtime_path=f"quests.{qid}.preconditions",
            )
        if data.get("completionConditions") is not None:
            source = ctx.source(path, ("completionConditions",))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.completionConditions", {"id": "root"}, source=source, kind="condition"),
                runtime_ref=f"quest:{qid}.completionConditions",
                source=source,
                kind="condition",
                runtime_path=f"quests.{qid}.completionConditions",
            )
        for i, raw_action in enumerate(data.get("acceptActions") or []):
            source = ctx.source(path, ("acceptActions", i))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.acceptAction", raw_action, source=source, kind="action"),
                runtime_ref=f"quest:{qid}.acceptActions[{i}]",
                source=source,
                kind="action",
                runtime_path=f"quests.{qid}.acceptActions[{i}]",
            )
        for i, raw_action in enumerate(data.get("rewards") or []):
            source = ctx.source(path, ("rewards", i))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.reward", raw_action, source=source, kind="action"),
                runtime_ref=f"quest:{qid}.rewards[{i}]",
                source=source,
                kind="action",
                runtime_path=f"quests.{qid}.rewards[{i}]",
            )
        for i, edge in enumerate(data.get("nextQuests") or []):
            if isinstance(edge, dict) and edge.get("conditions") is not None:
                target = str(edge.get("questId", i))
                source = ctx.source(path, ("nextQuests", i, "conditions"))
                ctx.add_source_map(
                    ctx.source_id(f"quest.{_slug(qid)}.nextQuest.{_slug(target)}.conditions", {"id": _condition_id(edge.get("conditions"))}, source=source, kind="condition"),
                    runtime_ref=f"quest:{qid}.nextQuest:{target}.conditions",
                    source=source,
                    kind="condition",
                    runtime_path=f"quests.{qid}.nextQuests[{i}].conditions",
                )
        out.append(q)
    return out


def normalize_speaker(speaker: Any) -> Json:
    if isinstance(speaker, str):
        kind = "npc" if speaker == "npc" else "player" if speaker == "player" else "literal"
        return {"kind": kind, "name": speaker}
    if isinstance(speaker, dict):
        return speaker
    return {"kind": "literal", "name": "旁白"}


KNOWN_DIALOGUE_NODE_TYPES = frozenset({"line", "choice", "switch", "runActions", "end", "ownerState"})


def compile_dialogues(ctx: BuildContext) -> dict[str, Json]:
    graphs: dict[str, Json] = {}
    seen_dialogue_ids: set[str] = set()
    for path in sorted((AUTHORING / "dialogues").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            continue
        gid = str(data["id"])
        if gid in seen_dialogue_ids:
            src = ctx.source(path, ("id",))
            ctx.error("dialogue.duplicate", f"duplicate dialogue graph id: {gid}", src["file"], src["line"], src["column"])
            continue
        seen_dialogue_ids.add(gid)
        ctx.add_source_map(
            f"dialogue.{_slug(gid)}",
            runtime_ref=f"dialogue:{gid}",
            source=ctx.source(path, ("id",)),
            kind="dialogueGraph",
            runtime_path=f"dialogues/graphs/{gid}.json",
        )
        nodes = data.get("nodes") if isinstance(data.get("nodes"), dict) else {}
        out_nodes: Json = {}
        for nid, node in nodes.items():
            node = node if isinstance(node, dict) else {}
            explicit_type = node.get("type")
            ntype = str(explicit_type or ("end" if node.get("end") else "line"))
            node_ref = f"dialogue:{gid}.node:{nid}"
            ctx.add_source_map(
                f"dialogue.{_slug(gid)}.node.{_slug(nid)}",
                runtime_ref=node_ref,
                source=ctx.source(path, ("nodes", nid)),
                kind="dialogueNode",
                runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}",
            )
            if ntype == "runActions":
                out_nodes[nid] = {"type": "runActions", "actions": [normalize_action(a) for a in node.get("actions") or []], "next": str(node.get("next", ""))}
                scan_action_refs(node.get("actions") or [], ctx, {"file": _rel(path), "symbol": f"dialogue:{gid}.node:{nid}", "path": f"nodes.{nid}.actions"})
                for i, raw_action in enumerate(node.get("actions") or []):
                    source = ctx.source(path, ("nodes", nid, "actions", i))
                    ctx.add_source_map(
                        ctx.source_id(f"dialogue.{_slug(gid)}.node.{_slug(nid)}.action", raw_action, source=source, kind="action"),
                        runtime_ref=f"{node_ref}.actions[{i}]",
                        source=source,
                        kind="action",
                        runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}.actions[{i}]",
                    )
            elif ntype == "choice":
                out_nodes[nid] = {"type": "choice", "options": node.get("options") or []}
                if node.get("promptLine"):
                    out_nodes[nid]["promptLine"] = node["promptLine"]
                for oi, opt in enumerate(node.get("options") or []):
                    if isinstance(opt, dict) and opt.get("requireCondition"):
                        scan_condition_refs(opt["requireCondition"], ctx, {"file": _rel(path), "symbol": f"dialogue:{gid}.node:{nid}.option:{opt.get('id','')}"})
                        source = ctx.source(path, ("nodes", nid, "options", oi, "requireCondition"))
                        ctx.add_source_map(
                            ctx.source_id(f"dialogue.{_slug(gid)}.node.{_slug(nid)}.option.{_slug(opt.get('id', oi))}.requireCondition", opt.get("requireCondition"), source=source, kind="condition"),
                            runtime_ref=f"{node_ref}.option:{opt.get('id', oi)}.requireCondition",
                            source=source,
                            kind="condition",
                            runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}.options[{oi}].requireCondition",
                        )
            elif ntype == "switch":
                out_nodes[nid] = {"type": "switch", "cases": node.get("cases") or [], "defaultNext": str(node.get("defaultNext", ""))}
                for ci, case in enumerate(node.get("cases") or []):
                    if isinstance(case, dict):
                        scan_condition_refs(case.get("condition") or case.get("conditions"), ctx, {"file": _rel(path), "symbol": f"dialogue:{gid}.node:{nid}.switch"})
                        source = ctx.source(path, ("nodes", nid, "cases", ci, "condition"))
                        ctx.add_source_map(
                            ctx.source_id(f"dialogue.{_slug(gid)}.node.{_slug(nid)}.case", case, source=source, kind="condition"),
                            runtime_ref=f"{node_ref}.case[{ci}].condition",
                            source=source,
                            kind="condition",
                            runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}.cases[{ci}].condition",
                        )
            elif ntype == "ownerState":
                on: Json = {"type": "ownerState", "cases": node.get("cases") or []}
                if node.get("wrapperGraphId") is not None:
                    on["wrapperGraphId"] = str(node.get("wrapperGraphId"))
                if node.get("defaultNext") is not None:
                    on["defaultNext"] = str(node.get("defaultNext"))
                if node.get("missingWrapperNext") is not None:
                    on["missingWrapperNext"] = str(node.get("missingWrapperNext"))
                out_nodes[nid] = on
            elif ntype == "end":
                out_nodes[nid] = {"type": "end"}
            elif ntype == "line":
                speaker = normalize_speaker(node.get("speaker"))
                line_out: Json = {"type": "line", "speaker": speaker, "next": str(node.get("next", ""))}
                raw_lines = node.get("lines")
                if isinstance(raw_lines, list) and raw_lines:
                    beats: list[Json] = []
                    first_text = ""
                    for ln in raw_lines:
                        if not isinstance(ln, dict):
                            continue
                        text = str(ln.get("text", ""))
                        beats.append({"speaker": normalize_speaker(ln.get("speaker")), "text": text})
                        if not first_text:
                            first_text = text
                    line_out["lines"] = beats
                    line_out["text"] = str(node.get("text", first_text))
                else:
                    line_out["text"] = str(node.get("text", ""))
                out_nodes[nid] = line_out
            else:
                # Unknown explicit node type: do NOT silently downgrade to a line.
                src = ctx.source(path, ("nodes", nid))
                ctx.error(
                    "dialogue.node.unknownType",
                    f"unknown dialogue node type '{ntype}' in graph {gid} node {nid}; emitted as passthrough",
                    src["file"], src["line"], src["column"],
                    "Add an emitter for this node type, or use a supported type (line/choice/switch/runActions/ownerState/end).",
                )
                out_nodes[nid] = {k: v for k, v in node.items() if k != "id"}
        graph = {"schemaVersion": 1, "id": gid, "entry": str(data.get("entry", "start")), "nodes": out_nodes}
        if data.get("preconditions"):
            graph["preconditions"] = normalize_condition(data.get("preconditions"))
        graphs[gid] = graph
        index_ref(ctx.index["dialogueGraphs"], gid, "declaredAt", {"file": _rel(path), "symbol": f"dialogue:{gid}"})
    return graphs


def render_narrative_mermaid(narrative: Json) -> dict[str, str]:
    rendered: dict[str, str] = {}
    for comp in narrative.get("compositions", []):
        g = comp.get("mainGraph") or {}
        gid = g.get("id", "graph")
        lines = ["stateDiagram-v2", f"  [*] --> {g.get('initialState','')}"]
        for t in g.get("transitions", []):
            label = t.get("signal") or t.get("trigger") or t.get("id")
            cond = t.get("conditions")
            if cond:
                label = f"{label} [cond]"
            lines.append(f"  {t.get('from','')} --> {t.get('to','')}: {label}")
        rendered[str(gid)] = "\n".join(lines) + "\n"
    return rendered


def validate_refs(ctx: BuildContext) -> None:
    for key, rec in ctx.index.get("flags", {}).items():
        if not rec.get("declaredAt"):
            ctx.warn("flag.undeclared", f"flag used but not declared: {key}")
        if rec.get("readers") and not rec.get("writers"):
            ctx.warn("flag.no_writer", f"flag has readers but no writer: {key}")
    for key, rec in ctx.index.get("signals", {}).items():
        if not rec.get("declaredAt"):
            ctx.warn("signal.undeclared", f"signal used but not declared: {key}")
        if rec.get("emitters") and not rec.get("listeners"):
            ctx.warn("signal.no_listener", f"signal has emitters but no listeners: {key}")
        if rec.get("listeners") and not rec.get("emitters"):
            ctx.warn("signal.no_emitter", f"signal has listeners but no emitters: {key}")


def load_json_file(path: str | None) -> Any:
    if not path:
        return {}
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    return json.loads(p.read_text(encoding="utf-8-sig"))


def state_file_for_runner(case_path: str | None) -> Path:
    if case_path:
        p = Path(case_path)
        return p if p.is_absolute() else ROOT / p
    p = ARTIFACT / "empty_state.json"
    write_json(p, {"flags": {}, "quests": {}, "scenarios": {}, "scenarioLines": {}, "narrative": {}, "literals": {}})
    return p


def run_explain_runtime(case_path: str | None = None, *, echo: bool = True) -> Json:
    state_path = state_file_for_runner(case_path)
    out_path = ARTIFACT / "condition_explain.json"
    tsx = ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
    cmd = [
        str(tsx),
        "tools/content_pipeline/explain_runtime.ts",
        str(ARTIFACT / "runtime_preview"),
        str(state_path),
        str(ARTIFACT / "source_map.json"),
        str(out_path),
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if echo and proc.stdout.strip():
        print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr, file=sys.stderr)
        raise RuntimeError(f"runtime explain failed with exit code {proc.returncode}")
    return load_json_file(str(out_path))


def explain(case_path: str | None = None) -> int:
    ctx, _ = build_all()
    try:
        out = run_explain_runtime(case_path)
    except RuntimeError:
        return 1
    out["ok"] = out.get("ok") is True and not any(d.severity == "error" for d in ctx.diagnostics)
    out["diagnostics"] = [d.to_dict() for d in ctx.diagnostics]
    write_json(ARTIFACT / "condition_explain.json", out)
    return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0


def resolve_trace_ref(event: Json, source_map: Json) -> str | None:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    runtime_ref = payload.get("runtimeRef")
    if isinstance(runtime_ref, str) and runtime_ref:
        return runtime_ref
    typ = event.get("type")
    phase = event.get("phase")
    if typ == "dialogue":
        graph_id = payload.get("graphId")
        node_id = payload.get("nodeId") or payload.get("currentNodeId")
        if graph_id and node_id:
            return f"dialogue:{graph_id}.node:{node_id}"
        if graph_id:
            return f"dialogue:{graph_id}"
    if typ == "narrative" and payload.get("graphId"):
        graph_id = payload.get("graphId")
        to_state = payload.get("to")
        if phase == "change" and to_state:
            return f"narrative:{graph_id}.state:{to_state}"
        return f"narrative:{graph_id}"
    if typ == "quest" and payload.get("questId"):
        return f"quest:{payload['questId']}"
    return None


def trace_resolve(path: str) -> int:
    ctx, _ = build_all()
    trace = load_json_file(path)
    events = trace.get("events") if isinstance(trace, dict) else trace
    if not isinstance(events, list):
        print("trace file must be an event array or {\"events\": [...]}", file=sys.stderr)
        return 2
    resolved = []
    for event in events:
        if not isinstance(event, dict):
            continue
        ref = resolve_trace_ref(event, ctx.source_map)
        source_id = ctx.source_map.get("runtimeToSource", {}).get(ref or "")
        source = ctx.source_map.get("sources", {}).get(source_id or "")
        resolved.append({**event, "runtimeRef": ref, "sourceId": source_id, "source": source})
    out = {"events": resolved}
    write_json(ARTIFACT / "runtime_trace/resolved_trace.json", out)
    for item in resolved:
        src = item.get("source") or {}
        where = f"{src.get('file')}:{src.get('line')}:{src.get('column')}" if src else "<unmapped>"
        print(f"#{item.get('id', '?')} [{item.get('type')}:{item.get('phase', '')}] {item.get('label', '')} -> {where}")
    return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0


# Artifact categories a command may choose to emit.
#   preview    -> compiled runtime JSON (to preview path, or real path when published)
#   render     -> mermaid graph renders
#   index      -> content_index.json
#   sourcemap  -> source_map.json / runtime_debug_map.json
#   report     -> content_report.md / diagnostics.json
EMIT_ALL = frozenset({"preview", "render", "index", "sourcemap", "report"})


def build_all(*, publish: bool = False, emit: frozenset[str] | set[str] | None = None) -> tuple[BuildContext, dict[str, Any]]:
    selected = EMIT_ALL if emit is None else frozenset(emit)
    ctx = BuildContext()
    cfg = load_project_config(ctx)
    load_signals(ctx)
    flags = compile_flags(ctx)
    narrative = compile_narrative(ctx)
    quests = compile_quests(ctx)
    dialogues = compile_dialogues(ctx)
    validate_refs(ctx)

    published: list[str] = []
    if "preview" in selected:
        for key, payload in (("flagRegistry", flags), ("narrativeGraphs", narrative), ("quests", quests)):
            target, did_publish = resolve_output_target(cfg, key, publish)
            write_json(target, payload)
            if did_publish:
                published.append(_rel(target))
        dialogue_dir, dlg_published = resolve_output_target(cfg, "dialogueGraphs", publish)
        for gid, graph in dialogues.items():
            write_json(dialogue_dir / f"{gid}.json", graph)
            if dlg_published:
                published.append(_rel(dialogue_dir / f"{gid}.json"))

    if "render" in selected:
        for gid, text in render_narrative_mermaid(narrative).items():
            write_text(ARTIFACT / "rendered_graphs/narrative" / f"{gid}.mmd", text)

    if "index" in selected:
        write_json(ARTIFACT / "content_index.json", ctx.index)

    if "sourcemap" in selected:
        write_json(ARTIFACT / "source_map.json", ctx.source_map)
        write_json(ARTIFACT / "runtime_debug_map.json", ctx.source_map)

    if "report" in selected:
        report = ["# Content Pipeline Report", "", f"Diagnostics: {len(ctx.diagnostics)}", ""]
        for d in ctx.diagnostics:
            report.append(f"- **{d.severity}** `{d.code}` {d.message}")
        write_text(ARTIFACT / "content_report.md", "\n".join(report) + "\n")
        write_json(ARTIFACT / "diagnostics.json", [d.to_dict() for d in ctx.diagnostics])

    return ctx, {
        "flags": flags,
        "narrative": narrative,
        "quests": quests,
        "dialogues": dialogues,
        "published": published,
        "config": cfg,
    }


def simulate(path: str | None = None) -> int:
    ctx, data = build_all()
    try:
        explain_result = run_explain_runtime(path, echo=False)
    except RuntimeError:
        explain_result = {"conditions": []}
    result = {
        "ok": not any(d.severity == "error" for d in ctx.diagnostics),
        "diagnostics": [d.to_dict() for d in ctx.diagnostics],
        "summary": {
            "narrativeGraphs": len(data["narrative"].get("compositions", [])),
            "quests": len(data["quests"]),
            "dialogues": len(data["dialogues"]),
        },
        "conditions": explain_result.get("conditions", []),
    }
    write_json(ARTIFACT / "simulation_result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0


def new_file(kind: str, ident: str, owner: str | None = None) -> int:
    if kind == "narrative":
        owner_type, _, owner_id = (owner or "system:").partition(":")
        path = AUTHORING / "narrative" / f"{ident}.yaml"
        text = f"id: {ident}\nkind: narrativeGraph\nowner:\n  type: {owner_type or 'system'}\n  id: {owner_id or ident}\ninitialState: start\nstates:\n  start:\n    label: 起始\ntransitions: []\n"
    elif kind == "quest":
        path = AUTHORING / "quests" / f"{ident}.yaml"
        text = f"id: {ident}\npreconditions: []\ncompletionConditions: []\nacceptActions: []\nrewards: []\nnextQuests: []\n"
    elif kind == "dialogue":
        path = AUTHORING / "dialogues" / f"{ident}.yaml"
        text = f"id: {ident}\nkind: dialogueGraph\nentry: start\nnodes:\n  start:\n    type: line\n    speaker:\n      kind: literal\n      name: 旁白\n    text: ''\n    next: end\n  end:\n    type: end\n"
    else:
        print(f"unknown kind: {kind}", file=sys.stderr)
        return 2
    if path.exists():
        print(f"exists: {_rel(path)}", file=sys.stderr)
        return 1
    write_text(path, text)
    print(f"created {_rel(path)}")
    return 0


def watch() -> int:
    print("content pipeline watch started; press Ctrl+C to stop")
    last = 0.0
    while True:
        newest = max((p.stat().st_mtime for p in AUTHORING.glob("**/*") if p.is_file()), default=0.0)
        if newest > last:
            last = newest
            ctx, _ = build_all()
            print(f"built with {len(ctx.diagnostics)} diagnostics")
        time.sleep(1.0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="content_pipeline")
    sub = parser.add_subparsers(dest="cmd")
    build_parser = sub.add_parser("build")
    build_parser.add_argument(
        "--publish",
        action="store_true",
        help="write pipeline-owned outputs to real runtime paths (legacy_editor-owned files are never published)",
    )
    for name in ("validate", "index", "render"):
        sub.add_parser(name)
    sim = sub.add_parser("simulate")
    sim.add_argument("case", nargs="?")
    exp = sub.add_parser("explain")
    exp.add_argument("case", nargs="?")
    tr = sub.add_parser("trace-resolve")
    tr.add_argument("trace")
    nf = sub.add_parser("new")
    nf.add_argument("kind", choices=["narrative", "quest", "dialogue"])
    nf.add_argument("id")
    nf.add_argument("--owner")
    sub.add_parser("watch")
    args = parser.parse_args(argv)
    if args.cmd in {"build", "validate", "index", "render", None}:
        if args.cmd == "validate":
            emit: frozenset[str] = frozenset()  # compile + diagnose only, no artifacts
        elif args.cmd == "index":
            emit = frozenset({"index"})
        elif args.cmd == "render":
            emit = frozenset({"render"})
        else:  # build / default
            emit = EMIT_ALL
        publish = bool(getattr(args, "publish", False))
        ctx, data = build_all(publish=publish, emit=emit)
        for d in ctx.diagnostics:
            print(d.format())
        for path in data.get("published", []):
            print(f"published -> {path}")
        return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0
    if args.cmd == "simulate":
        return simulate(args.case)
    if args.cmd == "explain":
        return explain(args.case)
    if args.cmd == "trace-resolve":
        return trace_resolve(args.trace)
    if args.cmd == "new":
        return new_file(args.kind, args.id, args.owner)
    if args.cmd == "watch":
        return watch()
    parser.print_help()
    return 2
