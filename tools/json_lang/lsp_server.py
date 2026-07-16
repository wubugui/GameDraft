#!/usr/bin/env python3
"""GameDraft JSON 数据语言 LSP server(纯 stdlib,stdio 传输)。

    python3 tools/json_lang/lsp_server.py

「JSON=语言」的常驻语言大脑:VS Code/Cursor 经薄扩展(vscode-ext/)连接;
将来 PyQt 编辑器的 id 候选/引用扫描也可改为问它(见 README 路线)。

标准 LSP 能力:
- textDocument/definition   光标下的 id → 定义处(items.json 条目/场景文件/图文件…)
- textDocument/references   全项目引用(值/键/[tag:] 三路,复用 refs.py 口径)
- textDocument/hover        id 卡片(中文名/宇宙/定义处/引用数;action 类型出参数表)
- didOpen/didChange/didClose overlay:**未保存的编辑器内容参与一切查询**——
  这是"编辑器可依赖"的地基(编辑器内存态≠磁盘态,大脑必须能看见前者)

自定义方法(gamedraft/* 命名空间,给编辑器接入与 agent 脚本用):
- gamedraft/universes                → {宇宙名: 条数}
- gamedraft/candidates {universe}    → [{id, label}](id 选择器候选源)
- gamedraft/refs {id}                → 结构化引用清单(含精确位置)
- gamedraft/search {query, ignoreCase?, limit?, scope?}
                                     → 全文子串搜索(值/键/数字,含 overlay;
                                       每条命中带 pointer/context/excerpt/anchors/line,
                                       编辑器「全局搜索」对话框的后端)
- gamedraft/status                   → {root, files, overlays, universes}
                                       (编辑器状态栏「LSP 详情」用)

索引口径全部复用既有模块(id_universes/refs/extract),不另立权威。
"""

from __future__ import annotations

import json
import sys
import threading
import time
import urllib.parse
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from extract import extract_language_spec
    from id_universes import UniverseData, collect_id_universes
    from json_locator import JsonLocator
    from refs import CONTENT_GLOBS, find_refs
    from rename import RENAMEABLE_UNIVERSES, plan_rename
    from search import find_text
else:
    from .extract import extract_language_spec
    from .id_universes import UniverseData, collect_id_universes
    from .json_locator import JsonLocator
    from .refs import CONTENT_GLOBS, find_refs
    from .rename import RENAMEABLE_UNIVERSES, plan_rename
    from .search import find_text

REPO_ROOT = Path(__file__).resolve().parents[2]


class _UserError(Exception):
    """面向用户的拒绝理由(LSP error message,编辑器原样弹出)。"""


def _uri_to_path(uri: str) -> Path | None:
    if not uri.startswith("file://"):
        return None
    return Path(urllib.parse.unquote(urllib.parse.urlparse(uri).path))


def _path_to_uri(path: Path) -> str:
    return "file://" + urllib.parse.quote(str(path))


class Server:
    def __init__(self):
        self.root = REPO_ROOT
        self.overlays: dict[str, str] = {}          # 绝对路径 str → 未保存全文
        self.locators: dict[str, tuple[object, JsonLocator]] = {}  # path → (版本键, locator)
        self._ud: UniverseData | None = None
        self._ud_stamp: tuple | None = None
        self._spec = None
        self._refs_cache: dict[str, list] = {}
        self._def_index: dict[str, list] | None = None

    # ---------- 文本视图(overlay 优先) ----------

    def read_text(self, path: Path) -> str:
        return self.overlays.get(str(path)) or path.read_text(encoding="utf-8")

    def locator(self, path: Path) -> JsonLocator | None:
        key = str(path)
        version: object
        if key in self.overlays:
            version = hash(self.overlays[key])
        else:
            try:
                version = path.stat().st_mtime_ns
            except OSError:
                return None
        cached = self.locators.get(key)
        if cached and cached[0] == version:
            return cached[1]
        try:
            loc = JsonLocator(self.read_text(path))
        except Exception:
            return None  # 半写/非法 JSON:该文件暂不可导航
        self.locators[key] = (version, loc)
        return loc

    # ---------- 索引(磁盘指纹变化或 overlay 变动时重建) ----------

    def _data_stamp(self) -> tuple:
        stamps = []
        for pattern in CONTENT_GLOBS:
            for p in self.root.glob(pattern):
                try:
                    stamps.append((str(p), p.stat().st_mtime_ns))
                except OSError:
                    pass
        return (tuple(sorted(stamps)), tuple(sorted((k, hash(v)) for k, v in self.overlays.items())))

    def ud(self) -> UniverseData:
        stamp = self._data_stamp()
        if self._ud is None or stamp != self._ud_stamp:
            # overlay 感知:未保存的新定义(新物品/新图)也进宇宙与候选
            self._ud = collect_id_universes(self.root, read_text=self.read_text)
            self._ud_stamp = stamp
            self._refs_cache.clear()
            self._def_index = None
        return self._ud

    def def_index(self) -> dict[str, list]:
        """id → 定义处 (file, pointer) 列表;单遍全扫建索引(workspace/symbol 与
        definition 的快路径,避免逐 id 全项目扫描)。口径与 refs.py 定义处启发一致。"""
        self.ud()  # 触发失效检查
        if self._def_index is not None:
            return self._def_index
        index: dict[str, list] = {}
        key_def_parents = {"spawnPoints", "profiles", "bgm", "ambient", "sfx", "systemSfx"}

        def walk(node, ptr: str, f: str, pkey=None) -> None:
            if isinstance(node, dict):
                for k, v in node.items():
                    if pkey in key_def_parents and isinstance(k, str) and k.strip():
                        index.setdefault(k, []).append((f, f"{ptr}/{k}"))
                    walk(v, f"{ptr}/{k}", f, k)
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, f"{ptr}/{i}", f, pkey)
            elif isinstance(node, str) and pkey == "id" and "/params" not in ptr and node.strip():
                index.setdefault(node, []).append((f, ptr))

        for pattern in CONTENT_GLOBS:
            for fp in sorted(self.root.glob(pattern)):
                try:
                    doc = json.loads(self.read_text(fp))
                except Exception:
                    continue
                walk(doc, "", str(fp.relative_to(self.root)))
        self._def_index = index
        return index

    def spec(self):
        if self._spec is None:
            try:
                self._spec = extract_language_spec(self.root)
            except Exception:
                self._spec = False  # 权威源解析失败:hover 降级,不影响导航
        return self._spec or None

    def refs_of(self, target: str) -> list:
        self.ud()  # 触发指纹检查/缓存失效
        if target not in self._refs_cache:
            self._refs_cache[target] = find_refs(self.root, target, read_text=self.read_text)
        return self._refs_cache[target]

    # ---------- 查询 ----------

    def _token_at(self, uri: str, position: dict):
        path = _uri_to_path(uri)
        if path is None:
            return None, None
        loc = self.locator(path)
        if loc is None:
            return None, None
        return loc.token_at(position["line"], position["character"]), path

    def _locations(self, refs) -> list[dict]:
        out = []
        for r in refs:
            path = self.root / r.file
            loc = self.locator(path)
            rng = loc.range_of_pointer(r.pointer) if loc else None
            if rng is None:
                continue
            (sl, sc), (el, ec) = rng
            out.append({
                "uri": _path_to_uri(path),
                "range": {"start": {"line": sl, "character": sc},
                          "end": {"line": el, "character": ec}},
            })
        return out

    def definition(self, params: dict):
        tok, _ = self._token_at(params["textDocument"]["uri"], params["position"])
        if tok is None or not tok.text.strip():
            return None
        entries = self.def_index().get(tok.text)
        if entries:
            return self._locations_of_pointers(entries) or None
        refs = [r for r in self.refs_of(tok.text) if r.definition_hint]
        return self._locations(refs) or None

    def _locations_of_pointers(self, entries: list) -> list[dict]:
        out = []
        for file, pointer in entries:
            path = self.root / file
            loc = self.locator(path)
            rng = loc.range_of_pointer(pointer) if loc else None
            if rng is None:
                continue
            (sl, sc), (el, ec) = rng
            out.append({
                "uri": _path_to_uri(path),
                "range": {"start": {"line": sl, "character": sc},
                          "end": {"line": el, "character": ec}},
            })
        return out

    def workspace_symbol(self, params: dict):
        query = str((params or {}).get("query", "")).strip().lower()
        ud = self.ud()
        index = self.def_index()
        # 标签反查表:中文名也能搜(Cmd+T 打「铜钱」找 copper_coins)
        label_of: dict[str, str] = {}
        universes_of: dict[str, list[str]] = {}
        for uname, ids in ud.ids.items():
            labs = ud.labels.get(uname, {})
            for i in ids:
                universes_of.setdefault(i, []).append(uname)
                if i in labs and i not in label_of:
                    label_of[i] = labs[i]
        out = []
        for ident, entries in index.items():
            label = label_of.get(ident, "")
            if query and query not in ident.lower() and query not in label.lower():
                continue
            locs = self._locations_of_pointers(entries[:1])
            if not locs:
                continue
            name = f"{ident}{'  ' + label if label else ''}"
            out.append({
                "name": name,
                "kind": 14,  # Constant
                "containerName": ", ".join(universes_of.get(ident, [])),
                "location": locs[0],
            })
            if len(out) >= 60:
                break
        return out

    def references(self, params: dict):
        tok, _ = self._token_at(params["textDocument"]["uri"], params["position"])
        if tok is None or not tok.text.strip():
            return None
        return self._locations(self.refs_of(tok.text)) or None

    def hover(self, params: dict):
        tok, _ = self._token_at(params["textDocument"]["uri"], params["position"])
        if tok is None or not tok.text.strip():
            return None
        target = tok.text
        ud = self.ud()
        lines: list[str] = []

        spec = self.spec()
        if spec and target in set(spec.action_types) | set(spec.param_manifest):
            m = spec.param_manifest.get(target)
            lines.append(f"**action `{target}`**")
            if m:
                lines.append(f"- 必填: {', '.join(m['required']) or '无'}")
                if m.get("optional"):
                    lines.append(f"- 可选: {', '.join(m['optional'])}")
            if target in spec.debug_only_action_types:
                lines.append("- ⚠ DEBUG_ONLY(内容里出现按未知类型拦)")
            if target in spec.legacy_action_types:
                lines.append("- ⚠ legacy(新内容勿用)")

        universes = sorted(name for name, ids in ud.ids.items() if target in ids)
        if universes:
            label = next((ud.labels[u][target] for u in universes
                          if u in ud.labels and target in ud.labels[u]), None)
            head = f"**「{target}」**" + (f" {label}" if label else "")
            lines.append(head)
            lines.append(f"- 宇宙: {', '.join(universes)}")
            refs = self.refs_of(target)
            defs = sorted({r.file for r in refs if r.definition_hint})
            if defs:
                lines.append(f"- 定义: {', '.join(defs)}")
            lines.append(f"- 引用: {len(refs)} 处(Shift+F12 查看)")
        elif not lines:
            refs = self.refs_of(target)
            if refs:
                lines.append(f"**「{target}」**(未登记任何 id 宇宙)")
                lines.append(f"- 全项目出现 {len(refs)} 处")
        if not lines:
            return None
        return {"contents": {"kind": "markdown", "value": "\n".join(lines)}}

    def prepare_rename(self, params: dict):
        tok, _ = self._token_at(params["textDocument"]["uri"], params["position"])
        if tok is None or not tok.text.strip():
            raise _UserError("光标下没有可改名的字符串")
        universes = {n for n, ids in self.ud().ids.items() if tok.text in ids}
        if not universes:
            raise _UserError(f"「{tok.text}」不属于任何已知 id 宇宙")
        # 预检交给 plan_rename 的白名单逻辑(用一个必不撞车的占位新名)
        probe = plan_rename(self.root, self.ud(), tok.text, tok.text + "__probe__",
                            read_text=self.read_text, locator_of=self.locator)
        if not probe.ok:
            raise _UserError(probe.message)
        loc = self.locator(_uri_to_path(params["textDocument"]["uri"]))
        (sl, sc), (el, ec) = loc.pos(tok.start), loc.pos(tok.end)
        return {"range": {"start": {"line": sl, "character": sc},
                          "end": {"line": el, "character": ec}},
                "placeholder": tok.text}

    def rename(self, params: dict):
        tok, _ = self._token_at(params["textDocument"]["uri"], params["position"])
        if tok is None or not tok.text.strip():
            raise _UserError("光标下没有可改名的字符串")
        outcome = plan_rename(self.root, self.ud(), tok.text, params.get("newName", ""),
                              read_text=self.read_text, locator_of=self.locator)
        if not outcome.ok:
            raise _UserError(outcome.message)
        changes: dict[str, list] = {}
        for file, edits in outcome.edits.items():
            path = self.root / file
            loc = self.locator(path)
            if loc is None:
                raise _UserError(f"{file} 定位失败,整体放弃")
            text_edits = []
            for start, end, new_text in edits:
                (sl, sc), (el, ec) = loc.pos(start), loc.pos(end)
                text_edits.append({
                    "range": {"start": {"line": sl, "character": sc},
                              "end": {"line": el, "character": ec}},
                    "newText": new_text,
                })
            changes[_path_to_uri(path)] = text_edits
        print(f"[lsp] rename 「{tok.text}」→「{params.get('newName')}」: {outcome.message}",
              file=sys.stderr, flush=True)
        return {"changes": changes}

    # ---------- gamedraft/* ----------

    def gd_universes(self, _params):
        return {name: len(ids) for name, ids in sorted(self.ud().ids.items())}

    def gd_candidates(self, params: dict):
        ud = self.ud()
        name = (params or {}).get("universe", "")
        ids = ud.ids.get(name)
        if ids is None:
            return {"error": f"未知宇宙 {name!r}", "known": sorted(ud.ids)}
        labels = ud.labels.get(name, {})
        return [{"id": i, "label": labels.get(i)} for i in sorted(set(ids))]

    def gd_search(self, params: dict):
        """全文子串搜索(编辑器全局搜索的后端);overlay 优先,故实时反映未保存编辑。"""
        query = str((params or {}).get("query", "") or "")
        if not query:
            return {"query": "", "total": 0, "truncated": False,
                    "filesScanned": 0, "failedFiles": [], "hits": []}
        ignore_case = (params or {}).get("ignoreCase", True) is not False
        try:
            limit = max(1, min(int((params or {}).get("limit", 500)), 2000))
        except (TypeError, ValueError):
            limit = 500
        scope = str((params or {}).get("scope", "") or "")
        res = find_text(self.root, query, read_text=self.read_text,
                        ignore_case=ignore_case, limit=limit, scope=scope)
        hits = []
        for h in res.hits:
            entry = {"file": h.file, "pointer": h.pointer, "kind": h.kind,
                     "context": h.context, "excerpt": h.excerpt,
                     "matchStart": h.match_start, "matchLen": h.match_len,
                     "anchors": h.anchors}
            loc = self.locator(self.root / h.file)
            rng = loc.range_of_pointer(h.pointer) if loc else None
            if rng:
                entry["line"] = rng[0][0] + 1  # 1 基,给人看
            hits.append(entry)
        return {"query": query, "total": res.total,
                "truncated": res.total > len(res.hits),
                "filesScanned": res.files_scanned,
                "failedFiles": res.failed_files, "hits": hits}

    def gd_status(self, _params):
        """server 自述(编辑器状态栏「LSP 详情」用):索引范围与 overlay 规模。"""
        ud = self.ud()
        files = 0
        for pattern in CONTENT_GLOBS:
            files += sum(1 for _ in self.root.glob(pattern))
        return {"root": str(self.root), "files": files,
                "overlays": len(self.overlays),
                "universes": {n: len(ids) for n, ids in sorted(ud.ids.items())}}

    def gd_refs(self, params: dict):
        target = (params or {}).get("id", "")
        refs = self.refs_of(target)
        out = []
        for r in refs:
            entry = {"file": r.file, "pointer": r.pointer, "kind": r.kind,
                     "context": r.context, "definitionHint": r.definition_hint}
            loc = self.locator(self.root / r.file)
            rng = loc.range_of_pointer(r.pointer) if loc else None
            if rng:
                entry["range"] = {"start": {"line": rng[0][0], "character": rng[0][1]},
                                  "end": {"line": rng[1][0], "character": rng[1][1]}}
            out.append(entry)
        ud = self.ud()
        return {"id": target,
                "universes": sorted(n for n, ids in ud.ids.items() if target in ids),
                "refs": out}


# --------------------------------------------------------------------------- #
# JSON-RPC over stdio
# --------------------------------------------------------------------------- #

def _read_message(stdin) -> dict | None:
    headers: dict[str, str] = {}
    while True:
        line = stdin.readline()
        if not line:
            return None
        line = line.decode("ascii", "replace").strip()
        if not line:
            break
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    length = int(headers.get("content-length", 0))
    if length <= 0:
        return None
    return json.loads(stdin.read(length).decode("utf-8"))


def _write_message(stdout, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    stdout.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    stdout.write(body)
    stdout.flush()


def _schema_refresh_loop(server: "Server", stop: threading.Event) -> None:
    """watch 并入 LSP:server 存活期间盯磁盘数据,变化后重产 out/ 的 schema
    (与 build.py --watch 同职责;extension 在跑时无需再挂独立 watch 进程)。
    独立 import build 模块状态,不与请求处理共享可变数据,无需加锁。"""
    try:
        import build as build_mod
    except ImportError:
        from . import build as build_mod  # type: ignore[no-redef]
    last: tuple | None = None
    while not stop.wait(2.0):
        try:
            stamps = []
            for pattern in CONTENT_GLOBS:
                for p in server.root.glob(pattern):
                    try:
                        stamps.append((str(p), p.stat().st_mtime_ns))
                    except OSError:
                        pass
            cur = tuple(sorted(stamps))
            if cur != last:
                last = cur
                build_mod._rebuild(server.root)
                print(f"[lsp] {time.strftime('%H:%M:%S')} schema 已刷新", file=sys.stderr, flush=True)
        except Exception as e:  # 半写/权威源变形:保留上一版,下轮重试
            print(f"[lsp] schema 刷新失败(下轮重试): {e}", file=sys.stderr, flush=True)


def main() -> int:
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    server = Server()
    shutdown = False
    stop_refresh = threading.Event()
    threading.Thread(target=_schema_refresh_loop, args=(server, stop_refresh), daemon=True).start()

    def respond(msg_id, result=None, error=None):
        payload: dict = {"jsonrpc": "2.0", "id": msg_id}
        if error is not None:
            payload["error"] = error
        else:
            payload["result"] = result
        _write_message(stdout, payload)

    while True:
        msg = _read_message(stdin)
        if msg is None:
            return 0
        method = msg.get("method", "")
        params = msg.get("params") or {}
        msg_id = msg.get("id")

        try:
            if method == "initialize":
                root_uri = params.get("rootUri") or ""
                path = _uri_to_path(root_uri) if root_uri else None
                if path and (path / "tools/json_lang").is_dir():
                    server.root = path
                respond(msg_id, {
                    "capabilities": {
                        "textDocumentSync": {"openClose": True, "change": 1},  # 1=Full
                        "definitionProvider": True,
                        "referencesProvider": True,
                        "hoverProvider": True,
                        "workspaceSymbolProvider": True,
                        "renameProvider": {"prepareProvider": True},
                    },
                    "serverInfo": {"name": "gamedraft-json-lang", "version": "0.1"},
                })
            elif method == "initialized":
                pass
            elif method == "shutdown":
                shutdown = True
                respond(msg_id, None)
            elif method == "exit":
                stop_refresh.set()
                return 0 if shutdown else 1
            elif method == "textDocument/didOpen":
                doc = params["textDocument"]
                p = _uri_to_path(doc["uri"])
                if p:
                    server.overlays[str(p)] = doc["text"]
                    server._refs_cache.clear()
            elif method == "textDocument/didChange":
                p = _uri_to_path(params["textDocument"]["uri"])
                changes = params.get("contentChanges") or []
                if p and changes:
                    server.overlays[str(p)] = changes[-1]["text"]  # Full sync
                    server._refs_cache.clear()
            elif method == "textDocument/didClose":
                p = _uri_to_path(params["textDocument"]["uri"])
                if p:
                    server.overlays.pop(str(p), None)
                    server._refs_cache.clear()
            elif method == "textDocument/definition":
                respond(msg_id, server.definition(params))
            elif method == "textDocument/references":
                respond(msg_id, server.references(params))
            elif method == "textDocument/hover":
                respond(msg_id, server.hover(params))
            elif method == "workspace/symbol":
                respond(msg_id, server.workspace_symbol(params))
            elif method == "textDocument/prepareRename":
                respond(msg_id, server.prepare_rename(params))
            elif method == "textDocument/rename":
                respond(msg_id, server.rename(params))
            elif method == "gamedraft/universes":
                respond(msg_id, server.gd_universes(params))
            elif method == "gamedraft/candidates":
                respond(msg_id, server.gd_candidates(params))
            elif method == "gamedraft/refs":
                respond(msg_id, server.gd_refs(params))
            elif method == "gamedraft/search":
                respond(msg_id, server.gd_search(params))
            elif method == "gamedraft/status":
                respond(msg_id, server.gd_status(params))
            elif msg_id is not None:
                respond(msg_id, error={"code": -32601, "message": f"未实现: {method}"})
        except _UserError as e:  # 面向用户的拒绝理由,编辑器弹出原文
            if msg_id is not None:
                respond(msg_id, error={"code": -32803, "message": str(e)})  # RequestFailed
        except Exception as e:  # 单请求失败不拖垮 server
            if msg_id is not None:
                respond(msg_id, error={"code": -32603, "message": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    sys.exit(main())
