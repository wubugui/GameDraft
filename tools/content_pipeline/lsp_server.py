from __future__ import annotations

"""Small stdio LSP server for GameDraft authoring files.

It intentionally depends only on the content pipeline compiler and stdlib. The
VS Code extension can start this process through vscode-languageclient without
adding Python package requirements to the project bootstrap.
"""

import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from tools.content_pipeline import cli

Json = dict[str, Any]

ROOT = cli.ROOT
DOCUMENTS: dict[str, str] = {}
SHUTDOWN = False


def uri_to_path(uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        return Path(uri)
    path = unquote(parsed.path)
    if re.match(r"^/[A-Za-z]:/", path):
        path = path[1:]
    return Path(path)


def path_to_uri(path: Path) -> str:
    return path.resolve().as_uri()


def rel_file(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except Exception:
        return path.as_posix()


def read_message() -> Json | None:
    headers: dict[str, str] = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        text = line.decode("ascii", errors="replace").strip()
        if ":" in text:
            key, value = text.split(":", 1)
            headers[key.lower()] = value.strip()
    length = int(headers.get("content-length", "0") or "0")
    if length <= 0:
        return None
    raw = sys.stdin.buffer.read(length)
    return json.loads(raw.decode("utf-8"))


def send(payload: Json) -> None:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(data)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def respond(msg_id: Any, result: Any = None, error: Json | None = None) -> None:
    payload: Json = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    send(payload)


def notify(method: str, params: Json) -> None:
    send({"jsonrpc": "2.0", "method": method, "params": params})


_GENERATED_PATHS: set[str] = set()


def build_context() -> cli.BuildContext:
    global _GENERATED_PATHS
    overrides: dict[str, str] = {}
    for uri, text in DOCUMENTS.items():
        rel = rel_file(uri_to_path(uri))
        if rel:
            overrides[rel] = text
    ctx, data = cli.build_all(emit=frozenset(), document_overrides=overrides)
    _GENERATED_PATHS = set(data.get("generatedPaths", []))
    return ctx


def is_generated_file(uri: str) -> bool:
    rel = rel_file(uri_to_path(uri))
    if not rel:
        return False
    for gp in _GENERATED_PATHS:
        if rel == gp or rel.startswith(gp.rstrip("/") + "/"):
            return True
    return "artifact/content_pipeline" in rel


def source_index(ctx: cli.BuildContext) -> cli.BuildContext:
    return ctx


def lsp_range(line: int | None, column: int | None) -> Json:
    ln = max(0, int(line or 1) - 1)
    col = max(0, int(column or 1) - 1)
    return {"start": {"line": ln, "character": col}, "end": {"line": ln, "character": col + 1}}


def lsp_symbol_range(line: int | None, column: int | None, length: int = 1) -> Json:
    ln = max(0, int(line or 1) - 1)
    col = max(0, int(column or 1) - 1)
    return {"start": {"line": ln, "character": col}, "end": {"line": ln, "character": col + max(1, length)}}


def diagnostic_to_lsp(diag: cli.Diagnostic) -> Json:
    severity = 1 if diag.severity == "error" else 2 if diag.severity == "warning" else 3
    return {
        "range": lsp_range(diag.line, diag.column),
        "severity": severity,
        "code": diag.code,
        "source": "GameDraft content",
        "message": diag.message if not diag.suggestion else f"{diag.message}\n{diag.suggestion}",
    }


def publish_diagnostics(ctx: cli.BuildContext) -> None:
    by_file: dict[str, list[Json]] = {}
    for diag in ctx.diagnostics:
        if not diag.file:
            continue
        by_file.setdefault(diag.file, []).append(diagnostic_to_lsp(diag))
    known_files = set(by_file)
    for uri in DOCUMENTS:
        path = uri_to_path(uri)
        rel = rel_file(path)
        known_files.add(rel)
    for rel in known_files:
        notify("textDocument/publishDiagnostics", {
            "uri": path_to_uri(ROOT / rel),
            "diagnostics": by_file.get(rel, []),
        })


WORD_RE = re.compile(r"[A-Za-z0-9_.:\-\u4e00-\u9fff]+")


def document_text(uri: str) -> str:
    if uri in DOCUMENTS:
        return DOCUMENTS[uri]
    path = uri_to_path(uri)
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def line_at(text: str, line: int) -> str:
    lines = text.splitlines()
    return lines[line] if 0 <= line < len(lines) else ""


def word_at(text: str, line: int, character: int) -> str:
    row = line_at(text, line)
    for match in WORD_RE.finditer(row):
        if match.start() <= character <= match.end():
            return match.group(0)
    return ""


def key_context(text: str, line: int, character: int) -> str:
    prefix = line_at(text, line)[:character]
    match = re.search(r"([A-Za-z0-9_.-]+)\s*:\s*[\"']?[^\"']*$", prefix)
    return match.group(1) if match else ""


def nearby_graph_id(text: str, line: int) -> str:
    rows = text.splitlines()
    for idx in range(line, max(-1, line - 30), -1):
        if 0 <= idx < len(rows):
            match = re.search(r"\b(?:graphId|wrapperGraphId|narrative)\s*:\s*[\"']?([^\"'\s#]+)", rows[idx])
            if match:
                return match.group(1).strip()
    return ""


def bucket_keys(index: Json, bucket: str) -> list[str]:
    raw = index.get(bucket)
    return sorted(raw.keys()) if isinstance(raw, dict) else []


def scene_ids() -> list[str]:
    scene_dir = ROOT / "public/assets/scenes"
    if not scene_dir.is_dir():
        return []
    out: list[str] = []
    for path in sorted(scene_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            out.append(str(data.get("id") or path.stem))
        except Exception:
            out.append(path.stem)
    return out


def completion_items(labels: list[str], kind: int, detail: str) -> list[Json]:
    return [{"label": label, "kind": kind, "detail": detail, "insertText": label} for label in labels]


_ACTION_TYPE_NAMES = sorted(cli.ACTION_PARAM_TYPES.keys())
_DIALOGUE_NODE_TYPES = ["line", "choice", "switch", "runActions", "ownerState", "contextState", "end"]


def nearby_action_type(text: str, line: int) -> str:
    rows = text.splitlines()
    for idx in range(line, max(-1, line - 15), -1):
        if 0 <= idx < len(rows):
            match = re.search(r"\btype\s*:\s*[\"']?([A-Za-z][A-Za-z0-9_]+)", rows[idx])
            if match and match.group(1) in cli.ACTION_PARAM_TYPES:
                return match.group(1)
    return ""


def is_in_action_context(text: str, line: int) -> bool:
    rows = text.splitlines()
    for idx in range(line, max(-1, line - 20), -1):
        if 0 <= idx < len(rows):
            row = rows[idx]
            if re.search(r"^\s*actions\s*:", row) or re.search(r"^\s*-\s+type\s*:", row):
                return True
            if re.search(r"^\s*nodes\s*:", row):
                return False
    return False


def provide_completion(params: Json) -> Json:
    ctx = build_context()
    index = ctx.index
    doc = params.get("textDocument") or {}
    pos = params.get("position") or {}
    text = document_text(str(doc.get("uri", "")))
    line = int(pos.get("line", 0) or 0)
    character = int(pos.get("character", 0) or 0)
    key = key_context(text, line, character)
    if key in {"flag", "key"}:
        items = completion_items(bucket_keys(index, "flags"), 6, "flag")
    elif key == "signal":
        items = completion_items(bucket_keys(index, "signals"), 23, "signal")
    elif key in {"quest", "questId"}:
        items = completion_items(bucket_keys(index, "quests"), 12, "quest")
    elif key in {"graphId", "wrapperGraphId", "narrative"}:
        items = completion_items(bucket_keys(index, "narrativeGraphs"), 7, "narrative graph")
        items += completion_items(bucket_keys(index, "dialogueGraphs"), 8, "dialogue graph")
    elif key == "stateId":
        graph_id = nearby_graph_id(text, line)
        labels = bucket_keys(index, "narrativeStates")
        if graph_id:
            prefix = f"{graph_id}."
            labels = [x[len(prefix):] for x in labels if x.startswith(prefix)]
        items = completion_items(labels, 20, "narrative state")
    elif key == "state":
        graph_id = nearby_graph_id(text, line)
        labels = bucket_keys(index, "narrativeStates")
        if graph_id:
            prefix = f"{graph_id}."
            labels = [x[len(prefix):] for x in labels if x.startswith(prefix)]
        items = completion_items(labels, 20, "narrative state")
    elif key in {"scene", "sceneId", "targetScene"}:
        items = completion_items(scene_ids(), 17, "scene")
    elif key in {"scenarioId"}:
        items = completion_items(bucket_keys(index, "scenarios"), 12, "scenario")
    elif key == "type":
        if is_in_action_context(text, line):
            items = completion_items(_ACTION_TYPE_NAMES, 14, "action type")
        else:
            items = completion_items(_DIALOGUE_NODE_TYPES, 14, "dialogue node type")
    elif key == "params":
        action_type = nearby_action_type(text, line)
        if action_type:
            param_names = sorted(cli.ACTION_PARAM_TYPES.get(action_type, {}).keys())
            items = completion_items(param_names, 5, f"{action_type} param")
        else:
            items = []
    else:
        # inside action params: try to complete field names from the enclosing action type
        action_type = nearby_action_type(text, line)
        if action_type and key:
            param_schema = cli.ACTION_PARAM_TYPES.get(action_type, {})
            if key in param_schema:
                expected = param_schema[key]
                if expected == "str":
                    items = []
                elif expected == "bool":
                    items = completion_items(["true", "false"], 17, "bool")
                else:
                    items = []
            else:
                items = []
        else:
            items = []
    return {"isIncomplete": False, "items": items}


def find_record(ctx: cli.BuildContext, word: str) -> tuple[str, str, Json] | None:
    for bucket, raw in ctx.index.items():
        if isinstance(raw, dict) and word in raw:
            rec = raw[word]
            if isinstance(rec, dict):
                return bucket, word, rec
    return None


def declared_at(rec: Json) -> Json | None:
    items = rec.get("declaredAt")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and item.get("file"):
                return item
    return None


def provide_hover(params: Json) -> Json | None:
    doc = params.get("textDocument") or {}
    uri = str(doc.get("uri", ""))
    if is_generated_file(uri):
        return {"contents": {"kind": "markdown", "value": "⚠️ **Generated file** — do not hand-edit.\n\nModify `authoring/` sources and rebuild instead."}}
    ctx = build_context()
    pos = params.get("position") or {}
    text = document_text(uri)
    word = word_at(text, int(pos.get("line", 0) or 0), int(pos.get("character", 0) or 0))
    found = find_record(ctx, word)
    if not found:
        return None
    bucket, ident, rec = found
    decl = declared_at(rec)
    lines = [f"**{ident}**", "", f"kind: `{bucket}`"]
    if decl:
        lines.append(f"declared: `{decl.get('file')}:{decl.get('line', 1)}`")
        owner_type = decl.get("ownerType")
        owner_id = decl.get("ownerId")
        if owner_type or owner_id:
            lines.append(f"owner: `{owner_type}:{owner_id}`")
    for role in ("readers", "writers", "emitters", "listeners"):
        values = rec.get(role)
        if isinstance(values, list) and values:
            lines.append(f"{role}: {len(values)}")
    return {"contents": {"kind": "markdown", "value": "\n".join(lines)}}


def location_from_item(item: Json) -> Json | None:
    rel = item.get("file")
    if not isinstance(rel, str) or not rel:
        return None
    return {"uri": path_to_uri(ROOT / rel), "range": lsp_range(int(item.get("line", 1) or 1), int(item.get("column", 1) or 1))}


def location_range_from_item(item: Json, length: int = 1) -> Json | None:
    rel = item.get("file")
    if not isinstance(rel, str) or not rel:
        return None
    return {"uri": path_to_uri(ROOT / rel), "range": lsp_symbol_range(int(item.get("line", 1) or 1), int(item.get("column", 1) or 1), length)}


def provide_definition(params: Json) -> Json | None:
    ctx = build_context()
    doc = params.get("textDocument") or {}
    pos = params.get("position") or {}
    text = document_text(str(doc.get("uri", "")))
    word = word_at(text, int(pos.get("line", 0) or 0), int(pos.get("character", 0) or 0))
    found = find_record(ctx, word)
    if not found:
        return None
    decl = declared_at(found[2])
    return location_from_item(decl) if decl else None


def provide_references(params: Json) -> list[Json]:
    ctx = build_context()
    doc = params.get("textDocument") or {}
    pos = params.get("position") or {}
    text = document_text(str(doc.get("uri", "")))
    word = word_at(text, int(pos.get("line", 0) or 0), int(pos.get("character", 0) or 0))
    found = find_record(ctx, word)
    if not found:
        return []
    rec = found[2]
    out: list[Json] = []
    for role in ("declaredAt", "readers", "writers", "emitters", "listeners"):
        values = rec.get(role)
        if not isinstance(values, list):
            continue
        for item in values:
            if isinstance(item, dict):
                loc = location_from_item(item)
                if loc:
                    out.append(loc)
    return out


SYMBOL_KIND_BY_BUCKET = {
    "flags": 13,
    "signals": 23,
    "quests": 5,
    "narrativeGraphs": 5,
    "narrativeStates": 22,
    "dialogueGraphs": 5,
    "dialogueNodes": 12,
    "actions": 12,
    "conditions": 12,
    "scenarios": 5,
    "sceneRefs": 5,
}


def symbol_decl_items(ctx: cli.BuildContext) -> list[Json]:
    out: list[Json] = []
    for bucket, raw in ctx.index.items():
        if not isinstance(raw, dict):
            continue
        for ident, rec in raw.items():
            if not isinstance(rec, dict):
                continue
            decl = declared_at(rec)
            if not decl:
                continue
            out.append({"bucket": bucket, "id": ident, "decl": decl})
    return out


def provide_document_symbols(params: Json) -> list[Json]:
    ctx = build_context()
    uri = str((params.get("textDocument") or {}).get("uri", ""))
    rel = rel_file(uri_to_path(uri))
    symbols: list[Json] = []
    for item in symbol_decl_items(ctx):
        decl = item["decl"]
        if decl.get("file") != rel:
            continue
        ident = str(item["id"])
        rng = lsp_symbol_range(int(decl.get("line", 1) or 1), int(decl.get("column", 1) or 1), len(ident))
        symbols.append({
            "name": ident,
            "kind": SYMBOL_KIND_BY_BUCKET.get(str(item["bucket"]), 13),
            "range": rng,
            "selectionRange": rng,
            "detail": str(item["bucket"]),
        })
    return symbols


def provide_workspace_symbols(params: Json) -> list[Json]:
    ctx = build_context()
    query = str(params.get("query", "")).lower()
    symbols: list[Json] = []
    for item in symbol_decl_items(ctx):
        ident = str(item["id"])
        if query and query not in ident.lower():
            continue
        decl = item["decl"]
        loc = location_range_from_item(decl, len(ident))
        if not loc:
            continue
        symbols.append({
            "name": ident,
            "kind": SYMBOL_KIND_BY_BUCKET.get(str(item["bucket"]), 13),
            "containerName": str(item["bucket"]),
            "location": loc,
        })
    return symbols[:200]


def provide_rename(params: Json) -> Json | None:
    ctx = build_context()
    doc = params.get("textDocument") or {}
    pos = params.get("position") or {}
    new_name = str(params.get("newName", "")).strip()
    if not new_name:
        return None
    text = document_text(str(doc.get("uri", "")))
    word = word_at(text, int(pos.get("line", 0) or 0), int(pos.get("character", 0) or 0))
    found = find_record(ctx, word)
    if not found:
        return None
    changes: dict[str, list[Json]] = {}
    rec = found[2]
    for role in ("declaredAt", "readers", "writers", "emitters", "listeners"):
        values = rec.get(role)
        if not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict):
                continue
            loc = location_range_from_item(item, len(word))
            if not loc:
                continue
            changes.setdefault(loc["uri"], []).append({"range": loc["range"], "newText": new_name})
    return {"changes": changes} if changes else None


_UNDECLARED_TABLE_FILES: dict[str, str] = {
    "flag.undeclared": "authoring/tables/flags.csv",
    "signal.undeclared": "authoring/tables/signals.csv",
    "quest.undeclared": "authoring/tables/quests.csv",
}
_UNDECLARED_DIR_FILES: dict[str, str] = {
    "dialogueGraph.undeclared": "authoring/dialogues",
    "narrativeGraph.undeclared": "authoring/narrative",
}


def provide_code_actions(params: Json) -> list[Json]:
    actions: list[Json] = []
    for diag in params.get("context", {}).get("diagnostics", []) or []:
        code = diag.get("code")
        message = str(diag.get("message", ""))
        if code in _UNDECLARED_TABLE_FILES:
            table_path = _UNDECLARED_TABLE_FILES[code]
            actions.append({
                "title": f"Open {table_path} to declare missing {code.split('.')[0]}",
                "kind": "quickfix",
                "diagnostics": [diag],
                "command": {
                    "title": f"Open {table_path}",
                    "command": "gamedraftAuthoring.openFile",
                    "arguments": [table_path],
                },
            })
        elif code in _UNDECLARED_DIR_FILES:
            dir_path = _UNDECLARED_DIR_FILES[code]
            actions.append({
                "title": f"Open {dir_path}/ to add missing {code.split('.')[0]}",
                "kind": "quickfix",
                "diagnostics": [diag],
                "command": {
                    "title": f"Open {dir_path}",
                    "command": "gamedraftAuthoring.openFile",
                    "arguments": [dir_path],
                },
            })
        if code in {"action.param.required", "action.param.type", "action.type.unknown"}:
            actions.append({
                "title": "Show action schema reference",
                "kind": "quickfix",
                "diagnostics": [diag],
                "command": {
                    "title": "Show action schema",
                    "command": "gamedraftAuthoring.showActionSchema",
                    "arguments": [message],
                },
            })
        if code == "dialogue.ownerState.defaultMissing":
            actions.append({
                "title": "Add defaultNext to ownerState node",
                "kind": "quickfix",
                "diagnostics": [diag],
                "command": {
                    "title": "Add defaultNext",
                    "command": "gamedraftAuthoring.openContentIndex",
                    "arguments": [],
                },
            })
    return actions


SEMANTIC_TOKEN_TYPES = ["variable", "event", "class", "enumMember", "function", "property"]
SEMANTIC_TOKEN_BUCKET_TYPE = {
    "flags": 0,
    "signals": 1,
    "narrativeGraphs": 2,
    "dialogueGraphs": 2,
    "quests": 2,
    "narrativeStates": 3,
    "actions": 4,
    "conditions": 5,
}


def provide_semantic_tokens(params: Json) -> Json:
    ctx = build_context()
    uri = str((params.get("textDocument") or {}).get("uri", ""))
    text = document_text(uri)
    known: dict[str, int] = {}
    for bucket, raw in ctx.index.items():
        token_type = SEMANTIC_TOKEN_BUCKET_TYPE.get(bucket)
        if token_type is None or not isinstance(raw, dict):
            continue
        for ident in raw.keys():
            known[str(ident)] = token_type
    entries: list[tuple[int, int, int, int, int]] = []
    for line_no, row in enumerate(text.splitlines()):
        for match in WORD_RE.finditer(row):
            token_type = known.get(match.group(0))
            if token_type is None:
                continue
            entries.append((line_no, match.start(), len(match.group(0)), token_type, 0))
    data: list[int] = []
    last_line = 0
    last_start = 0
    for line_no, start, length, token_type, modifiers in entries:
        delta_line = line_no - last_line
        delta_start = start - last_start if delta_line == 0 else start
        data.extend([delta_line, delta_start, length, token_type, modifiers])
        last_line = line_no
        last_start = start
    return {"data": data}


_GENERATED_FILE_DIAG: Json = {
    "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}},
    "severity": 2,
    "code": "ownership.generatedFile",
    "source": "GameDraft content",
    "message": "This file is pipeline-generated. Do not hand-edit — modify authoring/ sources and rebuild instead.",
}


def handle_notification(method: str, params: Json) -> None:
    if method == "textDocument/didOpen":
        doc = params.get("textDocument") or {}
        uri = str(doc.get("uri", ""))
        text = str(doc.get("text", ""))
        if uri:
            DOCUMENTS[uri] = text
        ctx = build_context()
        if uri and is_generated_file(uri):
            notify("textDocument/publishDiagnostics", {"uri": uri, "diagnostics": [_GENERATED_FILE_DIAG]})
        else:
            publish_diagnostics(ctx)
    elif method == "textDocument/didChange":
        doc = params.get("textDocument") or {}
        uri = str(doc.get("uri", ""))
        changes = params.get("contentChanges")
        if uri and isinstance(changes, list) and changes:
            text = changes[-1].get("text") if isinstance(changes[-1], dict) else None
            if isinstance(text, str):
                DOCUMENTS[uri] = text
        publish_diagnostics(build_context())
    elif method == "textDocument/didSave":
        publish_diagnostics(build_context())


def handle_request(method: str, params: Json) -> Any:
    if method == "initialize":
        return {
            "capabilities": {
                "textDocumentSync": 1,
                "completionProvider": {"triggerCharacters": [".", ":", "\"", "'"]},
                "hoverProvider": True,
                "definitionProvider": True,
                "referencesProvider": True,
                "renameProvider": True,
                "codeActionProvider": True,
                "documentSymbolProvider": True,
                "workspaceSymbolProvider": True,
                "semanticTokensProvider": {
                    "legend": {"tokenTypes": SEMANTIC_TOKEN_TYPES, "tokenModifiers": []},
                    "full": True,
                },
            },
            "serverInfo": {"name": "GameDraft Authoring LSP", "version": "0.1.0"},
        }
    if method == "shutdown":
        global SHUTDOWN
        SHUTDOWN = True
        return None
    if method == "textDocument/completion":
        return provide_completion(params)
    if method == "textDocument/hover":
        return provide_hover(params)
    if method == "textDocument/definition":
        return provide_definition(params)
    if method == "textDocument/references":
        return provide_references(params)
    if method == "textDocument/documentSymbol":
        return provide_document_symbols(params)
    if method == "workspace/symbol":
        return provide_workspace_symbols(params)
    if method == "textDocument/rename":
        return provide_rename(params)
    if method == "textDocument/codeAction":
        return provide_code_actions(params)
    if method == "textDocument/semanticTokens/full":
        return provide_semantic_tokens(params)
    return None


def main() -> int:
    while True:
        msg = read_message()
        if msg is None:
            return 0
        method = msg.get("method")
        if method == "exit":
            return 0 if SHUTDOWN else 1
        if "id" in msg:
            try:
                respond(msg.get("id"), handle_request(str(method), msg.get("params") or {}))
            except Exception as e:
                respond(msg.get("id"), error={"code": -32603, "message": str(e)})
        elif isinstance(method, str):
            try:
                handle_notification(method, msg.get("params") or {})
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
