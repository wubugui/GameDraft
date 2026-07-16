#!/usr/bin/env python3
"""search —「JSON=语言」的全文子串搜索(命令行版,零插件)。

    python3 tools/json_lang/search.py <query> [--json] [--root PATH] [--limit N]
                                              [--case-sensitive] [--scope data|scenes|dialogues]

全内容文件(data/scenes/dialogues)整树匹配:字符串值、对象键、数字/布尔字面量都参与
子串匹配(默认大小写不敏感;中文无大小写之分不受影响)。每处命中给出:

- pointer   JSON Pointer 位置
- context   父对象一行摘要(优先 type/id/name,与 refs.py 同口径)
- excerpt   命中处片段 + 命中区间(match_start/match_len,UI 高亮用)
- anchors   由外到内的「(容器键, 最近祖先 id)」链——编辑器把命中映射到
            「哪个编辑页的哪个条目」的落点依据。注意:quests.json 等**数组根**
            文件的顶层元素容器键是空串(如 [["", "q_main"]]);容器键有名字的
            是字典字段下的容器(如场景文件的 [["npcs", "npc_x"]])

与 refs.py 的分工:refs 做"精确 id 的引用网",search 做"任意字符串的全文检索";
两者共用 CONTENT_GLOBS 与上下文摘要口径。只读、纯 stdlib;read_text 可注入
(LSP server 用它让未保存 overlay 参与扫描);--json 给 agent/编辑器用。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from refs import CONTENT_GLOBS, REPO_ROOT, _context_of
else:
    from .refs import CONTENT_GLOBS, REPO_ROOT, _context_of

# --scope 简写 → 相对仓库根的路径前缀(也接受任意自定义前缀原样过滤)
SCOPE_PREFIXES = {
    "data": "public/assets/data/",
    "scenes": "public/assets/scenes/",
    "dialogues": "public/assets/dialogues/",
    # 单文件/子目录专项(编辑器筛选器同款)
    "narrative": "public/assets/data/narrative_graphs.json",
    "cutscenes": "public/assets/data/cutscenes/",
}


@dataclass
class Hit:
    file: str
    pointer: str
    kind: str  # value(字符串值) | key(对象键) | scalar(数字/布尔字面量)
    context: str
    excerpt: str
    match_start: int  # excerpt 内命中起始(高亮用)
    match_len: int
    anchors: list = field(default_factory=list)  # [[容器键, 祖先id], ...] 由外到内


@dataclass
class SearchResult:
    hits: list  # list[Hit],最多 limit 条
    total: int  # 全部命中数(可能大于 len(hits))
    files_scanned: int
    failed_files: list  # 解析失败被跳过的文件(半写 overlay/坏 JSON)


def _esc(seg: str) -> str:
    """JSON Pointer 段转义(RFC 6901)。"""
    return str(seg).replace("~", "~0").replace("/", "~1")


def _excerpt_of(text: str, start: int, end: int, pre: int = 30, post: int = 42):
    """取命中处窗口片段;返回 (excerpt, match_start, match_len)。

    控制字符做等长替换(不动偏移),截断处补省略号。"""
    a = max(0, start - pre)
    b = min(len(text), end + post)
    prefix = "…" if a > 0 else ""
    suffix = "…" if b < len(text) else ""
    body = "".join(" " if ch in "\r\n\t" else ch for ch in text[a:b])
    return prefix + body + suffix, start - a + len(prefix), end - start


def find_text(
    root: Path,
    query: str,
    *,
    read_text=None,
    ignore_case: bool = True,
    limit: int = 500,
    scope: str = "",
) -> SearchResult:
    """全内容文件子串搜索。scope 为空搜全部;可传 data/scenes/dialogues 或任意路径前缀。"""
    hits: list[Hit] = []
    failed: list[str] = []
    scanned = 0
    total = 0
    if not query:
        return SearchResult(hits, 0, 0, failed)
    read_text = read_text or (lambda p: p.read_text(encoding="utf-8"))
    rx = re.compile(re.escape(query), re.IGNORECASE if ignore_case else 0)
    prefix = SCOPE_PREFIXES.get(scope, scope or "")

    def add(f: str, ptr: str, kind: str, ctx: str, text: str, m: re.Match, anchors: list) -> None:
        nonlocal total
        total += 1
        if len(hits) >= limit:
            return
        excerpt, ms, ml = _excerpt_of(text, m.start(), m.end())
        hits.append(Hit(f, ptr, kind, ctx, excerpt, ms, ml, [list(a) for a in anchors]))

    def walk(node, ptr: str, f: str, parent, pkey, anchors: list, container: str) -> None:
        if isinstance(node, dict):
            my = anchors
            nid = node.get("id")
            if isinstance(nid, str) and nid:
                my = anchors + [(container, nid)]
            for k, v in node.items():
                child_ptr = f"{ptr}/{_esc(k)}"
                m = rx.search(k)
                if m:
                    add(f, child_ptr, "key", _context_of(node, k), k, m, my)
                walk(v, child_ptr, f, node, k, my, k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                # 列表元素沿用列表自身的容器键(quests/3 的容器仍是 quests)
                walk(v, f"{ptr}/{i}", f, parent, pkey, anchors, container)
        elif isinstance(node, str):
            m = rx.search(node)
            if m:
                add(f, ptr, "value", _context_of(parent, pkey), node, m, anchors)
        elif node is not None and not isinstance(node, str):
            # 数字/布尔按 JSON 字面量参与匹配(搜 "42"/"true" 也能找到)
            text = json.dumps(node)
            m = rx.search(text)
            if m:
                add(f, ptr, "scalar", _context_of(parent, pkey), text, m, anchors)

    for pattern in CONTENT_GLOBS:
        for fp in sorted(root.glob(pattern)):
            rel = str(fp.relative_to(root))
            if prefix and not rel.startswith(prefix):
                continue
            scanned += 1
            try:
                doc = json.loads(read_text(fp))
            except Exception:
                failed.append(rel)
                continue
            walk(doc, "", rel, None, None, [], "")
    return SearchResult(hits, total, scanned, failed)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("query", help="要搜索的任意字符串(台词/物品名/id/路径/数字…)")
    ap.add_argument("--root", type=Path, default=REPO_ROOT)
    ap.add_argument("--json", action="store_true", help="结构化输出(给 agent/脚本)")
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--case-sensitive", action="store_true")
    ap.add_argument("--scope", default="", help="data|scenes|dialogues 或路径前缀,空=全部")
    args = ap.parse_args(argv)

    res = find_text(args.root, args.query, ignore_case=not args.case_sensitive,
                    limit=args.limit, scope=args.scope)
    if args.json:
        print(json.dumps({
            "query": args.query, "total": res.total,
            "truncated": res.total > len(res.hits),
            "filesScanned": res.files_scanned, "failedFiles": res.failed_files,
            "hits": [asdict(h) for h in res.hits],
        }, ensure_ascii=False, indent=2))
        return 0

    by_file: dict[str, list[Hit]] = {}
    for h in res.hits:
        by_file.setdefault(h.file, []).append(h)
    head = f"「{args.query}」共 {res.total} 处命中,{len(by_file)} 个文件"
    if res.total > len(res.hits):
        head += f"(仅列前 {len(res.hits)} 条,--limit 可调)"
    if res.failed_files:
        head += f";{len(res.failed_files)} 个文件解析失败被跳过"
    print(head)
    for f in sorted(by_file):
        print(f"  {f}")
        for h in by_file[f]:
            mark = h.excerpt[:h.match_start] + "【" + \
                h.excerpt[h.match_start:h.match_start + h.match_len] + "】" + \
                h.excerpt[h.match_start + h.match_len:]
            print(f"    {h.pointer}  ({h.kind})  {mark}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
