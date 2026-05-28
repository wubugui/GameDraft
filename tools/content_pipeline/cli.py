from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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
    source_map: dict[str, Any] = field(default_factory=dict)
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


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except Exception:
        return path.as_posix()


def ensure_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    ensure_dir(path)
    path.write_text(text, encoding="utf-8")


def load_project_config(ctx: BuildContext) -> Json:
    path = AUTHORING / "project.yaml"
    # Keep this deliberately tiny: the pipeline itself uses fixed defaults until a full YAML parser is added.
    if not path.exists():
        ctx.warn("project.missing", "authoring/project.yaml not found; using safe preview defaults")
    return {
        "publishRuntime": False,
        "artifactRoot": ARTIFACT,
        "previewRoot": ARTIFACT / "runtime_preview",
    }


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
    """A small YAML subset parser for authoring examples.

    It supports indentation-based dict/list structures, string scalars, booleans,
    numbers, and inline [] / {} via JSON-compatible syntax. This avoids adding a
    runtime dependency while keeping files readable. Complex production data can
    later switch to PyYAML without changing the compiler contract.
    """
    if not path.exists():
        ctx.error("yaml.missing", f"missing YAML file: {_rel(path)}", _rel(path))
        return {}
    lines = path.read_text(encoding="utf-8").splitlines()
    root: Any = {}
    stack: list[tuple[int, Any]] = [(-1, root)]

    def strip_comment(line: str) -> str:
        in_quote = False
        quote = ""
        out = []
        for ch in line:
            if ch in {'\"', "'"}:
                if not in_quote:
                    in_quote = True; quote = ch
                elif quote == ch:
                    in_quote = False
            if ch == "#" and not in_quote:
                break
            out.append(ch)
        return "".join(out).rstrip()

    for lineno, raw in enumerate(lines, start=1):
        line = strip_comment(raw)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        text = line.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        try:
            if text.startswith("- "):
                item_text = text[2:].strip()
                if not isinstance(parent, list):
                    ctx.error("yaml.list.parent", "list item has non-list parent", _rel(path), lineno, indent + 1)
                    continue
                if ":" in item_text and not item_text.startswith(('"', "'")):
                    key, value = item_text.split(":", 1)
                    item: Json = {key.strip(): parse_scalar(value.strip()) if value.strip() else {}}
                    parent.append(item)
                    if not value.strip():
                        stack.append((indent, item[key.strip()]))
                    else:
                        stack.append((indent, item))
                else:
                    parent.append(parse_scalar(item_text))
                continue
            if ":" not in text:
                ctx.error("yaml.syntax", "expected key: value", _rel(path), lineno, indent + 1)
                continue
            key, value = text.split(":", 1)
            key = key.strip()
            value = value.strip()
            if value == "":
                # Guess container type from the next meaningful line.
                next_is_list = False
                for later in lines[lineno:]:
                    stripped = strip_comment(later).strip()
                    if not stripped:
                        continue
                    next_indent = len(later) - len(later.lstrip(" "))
                    next_is_list = next_indent > indent and stripped.startswith("- ")
                    break
                child: Any = [] if next_is_list else {}
                if isinstance(parent, dict):
                    parent[key] = child
                else:
                    ctx.error("yaml.map.parent", "mapping item has non-map parent", _rel(path), lineno, indent + 1)
                    continue
                stack.append((indent, child))
            else:
                if isinstance(parent, dict):
                    parent[key] = parse_scalar(value)
                else:
                    ctx.error("yaml.map.parent", "mapping item has non-map parent", _rel(path), lineno, indent + 1)
        except Exception as e:
            ctx.error("yaml.parse", f"failed to parse line: {e}", _rel(path), lineno, indent + 1)
    return root


def normalize_condition(expr: Any) -> Any:
    if expr is None:
        return []
    if isinstance(expr, list):
        return [normalize_condition(x) for x in expr]
    if isinstance(expr, dict):
        return {k: normalize_condition(v) if k in {"all", "any", "not"} else v for k, v in expr.items()}
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
        index_ref(ctx.index["flags"], key, "declaredAt", {"file": row.get("__file"), "line": row.get("__line"), "owner": row.get("owner"), "meaning": row.get("meaning")})
    return {"static": static, "patterns": [], "runtime": {"warnUnknownInDev": True}}


def load_signals(ctx: BuildContext) -> None:
    rows = read_csv_rows(AUTHORING / "tables" / "signals.csv", ctx)
    for row in rows:
        key = row.get("key", "")
        if not key:
            continue
        index_ref(ctx.index["signals"], key, "declaredAt", {"file": row.get("__file"), "line": row.get("__line"), "owner": row.get("owner"), "meaning": row.get("meaning")})


def compile_narrative(ctx: BuildContext) -> Json:
    graphs = []
    for path in sorted((AUTHORING / "narrative").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            ctx.error("narrative.id.missing", "narrative graph id is required", _rel(path), 1, 1)
            continue
        gid = str(data["id"])
        owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
        states_src = data.get("states") if isinstance(data.get("states"), dict) else {}
        transitions_src = data.get("transitions") if isinstance(data.get("transitions"), list) else []
        states: Json = {}
        for sid, sdef in states_src.items():
            sdef = sdef if isinstance(sdef, dict) else {}
            out: Json = {"id": sid}
            if sdef.get("broadcastOnEnter") is not None:
                out["broadcastOnEnter"] = bool(sdef.get("broadcastOnEnter"))
            if isinstance(sdef.get("onEnterActions"), list):
                out["onEnterActions"] = [normalize_action(a) for a in sdef["onEnterActions"]]
                scan_action_refs(sdef["onEnterActions"], ctx, {"file": _rel(path), "symbol": f"narrative:{gid}.state:{sid}", "path": f"states.{sid}.onEnterActions"})
            if isinstance(sdef.get("onExitActions"), list):
                out["onExitActions"] = [normalize_action(a) for a in sdef["onExitActions"]]
                scan_action_refs(sdef["onExitActions"], ctx, {"file": _rel(path), "symbol": f"narrative:{gid}.state:{sid}", "path": f"states.{sid}.onExitActions"})
            states[str(sid)] = out
            index_ref(ctx.index["narrativeStates"], f"{gid}.{sid}", "declaredAt", {"file": _rel(path), "symbol": f"narrative:{gid}.state:{sid}"})
        transitions = []
        for t in transitions_src:
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
            if t.get("signal") is not None:
                out["signal"] = str(t.get("signal"))
                index_ref(ctx.index["signals"], out["signal"], "listeners", {"file": _rel(path), "symbol": f"narrative:{gid}.transition:{tid}"})
            if t.get("priority") is not None:
                out["priority"] = t.get("priority")
            if isinstance(t.get("conditions"), list):
                out["conditions"] = normalize_condition(t.get("conditions"))
                scan_condition_refs(out["conditions"], ctx, {"file": _rel(path), "symbol": f"narrative:{gid}.transition:{tid}", "path": f"transitions.{tid}.conditions"})
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
        index_ref(ctx.index["narrativeGraphs"], gid, "declaredAt", {"file": _rel(path), "symbol": f"narrative:{gid}"})
    return {"schemaVersion": 3, "compositions": [{"id": g["id"], "mainGraph": g, "elements": []} for g in graphs]}


def compile_quests(ctx: BuildContext) -> list[Json]:
    base_rows = {r.get("id", ""): r for r in read_csv_rows(AUTHORING / "tables" / "quests.csv", ctx) if r.get("id")}
    out: list[Json] = []
    for path in sorted((AUTHORING / "quests").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            continue
        qid = str(data["id"])
        base = base_rows.get(qid, {})
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
            "nextQuests": data.get("nextQuests") or [],
        }
        if base.get("sideType"):
            q["sideType"] = base["sideType"]
        loc = {"file": _rel(path), "symbol": f"quest:{qid}"}
        index_ref(ctx.index["quests"], qid, "declaredAt", loc)
        scan_condition_refs(q["preconditions"], ctx, {**loc, "path": "preconditions"})
        scan_condition_refs(q["completionConditions"], ctx, {**loc, "path": "completionConditions"})
        scan_action_refs(data.get("acceptActions") or [], ctx, {**loc, "path": "acceptActions"})
        scan_action_refs(data.get("rewards") or [], ctx, {**loc, "path": "rewards"})
        out.append(q)
    return out


def compile_dialogues(ctx: BuildContext) -> dict[str, Json]:
    graphs: dict[str, Json] = {}
    for path in sorted((AUTHORING / "dialogues").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            continue
        gid = str(data["id"])
        nodes = data.get("nodes") if isinstance(data.get("nodes"), dict) else {}
        out_nodes: Json = {}
        for nid, node in nodes.items():
            node = node if isinstance(node, dict) else {}
            ntype = str(node.get("type") or ("end" if node.get("end") else "line"))
            if ntype == "runActions":
                out_nodes[nid] = {"type": "runActions", "actions": [normalize_action(a) for a in node.get("actions") or []], "next": str(node.get("next", ""))}
                scan_action_refs(node.get("actions") or [], ctx, {"file": _rel(path), "symbol": f"dialogue:{gid}.node:{nid}", "path": f"nodes.{nid}.actions"})
            elif ntype == "choice":
                out_nodes[nid] = {"type": "choice", "options": node.get("options") or []}
                if node.get("promptLine"):
                    out_nodes[nid]["promptLine"] = node["promptLine"]
                for opt in node.get("options") or []:
                    if isinstance(opt, dict) and opt.get("requireCondition"):
                        scan_condition_refs(opt["requireCondition"], ctx, {"file": _rel(path), "symbol": f"dialogue:{gid}.node:{nid}.option:{opt.get('id','')}"})
            elif ntype == "switch":
                out_nodes[nid] = {"type": "switch", "cases": node.get("cases") or [], "defaultNext": str(node.get("defaultNext", ""))}
                for case in node.get("cases") or []:
                    if isinstance(case, dict):
                        scan_condition_refs(case.get("condition") or case.get("conditions"), ctx, {"file": _rel(path), "symbol": f"dialogue:{gid}.node:{nid}.switch"})
            elif ntype == "end":
                out_nodes[nid] = {"type": "end"}
            else:
                speaker = node.get("speaker") or {"kind": "literal", "name": "旁白"}
                if isinstance(speaker, str):
                    speaker = {"kind": "npc" if speaker == "npc" else "player" if speaker == "player" else "literal", "name": speaker}
                out_nodes[nid] = {"type": "line", "speaker": speaker, "text": str(node.get("text", "")), "next": str(node.get("next", ""))}
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


def build_all() -> tuple[BuildContext, dict[str, Any]]:
    ctx = BuildContext()
    load_project_config(ctx)
    load_signals(ctx)
    flags = compile_flags(ctx)
    narrative = compile_narrative(ctx)
    quests = compile_quests(ctx)
    dialogues = compile_dialogues(ctx)
    validate_refs(ctx)

    preview = ARTIFACT / "runtime_preview"
    write_json(preview / "public/assets/data/flag_registry.json", flags)
    write_json(preview / "public/assets/data/narrative_graphs.json", narrative)
    write_json(preview / "public/assets/data/quests.json", quests)
    for gid, graph in dialogues.items():
        write_json(preview / "public/assets/dialogues/graphs" / f"{gid}.json", graph)

    for gid, text in render_narrative_mermaid(narrative).items():
        write_text(ARTIFACT / "rendered_graphs/narrative" / f"{gid}.mmd", text)

    write_json(ARTIFACT / "content_index.json", ctx.index)
    write_json(ARTIFACT / "source_map.json", ctx.source_map)
    report = ["# Content Pipeline Report", "", f"Diagnostics: {len(ctx.diagnostics)}", ""]
    for d in ctx.diagnostics:
        report.append(f"- **{d.severity}** `{d.code}` {d.message}")
    write_text(ARTIFACT / "content_report.md", "\n".join(report) + "\n")
    write_json(ARTIFACT / "diagnostics.json", [d.to_dict() for d in ctx.diagnostics])
    return ctx, {"flags": flags, "narrative": narrative, "quests": quests, "dialogues": dialogues}


def simulate(path: str | None = None) -> int:
    ctx, data = build_all()
    result = {"ok": not any(d.severity == "error" for d in ctx.diagnostics), "diagnostics": [d.to_dict() for d in ctx.diagnostics], "summary": {"narrativeGraphs": len(data["narrative"].get("compositions", [])), "quests": len(data["quests"]), "dialogues": len(data["dialogues"])}}
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
    for name in ("build", "validate", "index", "render"):
        sub.add_parser(name)
    sim = sub.add_parser("simulate")
    sim.add_argument("case", nargs="?")
    nf = sub.add_parser("new")
    nf.add_argument("kind", choices=["narrative", "quest", "dialogue"])
    nf.add_argument("id")
    nf.add_argument("--owner")
    sub.add_parser("watch")
    args = parser.parse_args(argv)
    if args.cmd in {"build", "validate", "index", "render", None}:
        ctx, _ = build_all()
        for d in ctx.diagnostics:
            print(d.format())
        return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0
    if args.cmd == "simulate":
        return simulate(args.case)
    if args.cmd == "new":
        return new_file(args.kind, args.id, args.owner)
    if args.cmd == "watch":
        return watch()
    parser.print_help()
    return 2
