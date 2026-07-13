#!/usr/bin/env python3
"""refs —「JSON=语言」的 find-all-references(命令行版,零插件)。

    python3 tools/json_lang/refs.py <id> [--json] [--root PATH]

全内容文件(data/scenes/dialogues)三路匹配:
- 值引用   任意字符串值 == <id>
- 键引用   任意对象键 == <id>(spawnPoints / overlay 注册表 / 音频表 / phases…)
- tag 引用 字符串内 [tag:…] 段落里含 <id>(如 [tag:npc:婆子])

并标注该 id 属于哪些 id 宇宙(items/quests/scenes/…)、中文名、疑似定义处。
只读、纯 stdlib;--json 给 agent 用(结构化输出)。查完引用要做迁移/改名/删除,
走 entity_refactor 引擎(agent_docs: entity-refactor-engine),本命令只查不改。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from id_universes import collect_id_universes
else:
    from .id_universes import collect_id_universes

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTENT_GLOBS = (
    "public/assets/data/**/*.json",
    "public/assets/scenes/*.json",
    "public/assets/dialogues/graphs/*.json",
)
_TAG_RE = re.compile(r"\[tag:[^\]]*\]")


@dataclass
class Ref:
    file: str
    pointer: str
    kind: str  # value | key | tag
    context: str
    definition_hint: bool = False


def _context_of(parent, key) -> str:
    """给命中处一行可读上下文:优先父对象的 type/id/name。"""
    if isinstance(parent, dict):
        bits = []
        for k in ("type", "id", "name", "label", "title"):
            v = parent.get(k)
            if isinstance(v, str) and v:
                bits.append(f"{k}={v}")
            if len(bits) >= 2:
                break
        head = " ".join(bits)
        return f"{key}: …({head})" if head else str(key)
    return str(key)


def find_refs(root: Path, target: str, read_text=None) -> list[Ref]:
    """read_text(path)->str 可注入(LSP server 用它让未保存 overlay 参与扫描);缺省读盘。"""
    refs: list[Ref] = []
    read_text = read_text or (lambda p: p.read_text(encoding="utf-8"))

    def walk(node, ptr: str, f: str, parent=None, pkey=None) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                child_ptr = f"{ptr}/{k}"
                if k == target:
                    refs.append(Ref(f, child_ptr, "key", _context_of(node, k),
                                    definition_hint=pkey in ("spawnPoints", "profiles", "bgm",
                                                             "ambient", "sfx", "systemSfx")))
                walk(v, child_ptr, f, node, k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{ptr}/{i}", f, parent, pkey)
        elif isinstance(node, str):
            if node == target:
                # 定义处启发:键名为 id 且不在动作参数里(params/id 是引用不是定义)
                refs.append(Ref(f, ptr, "value", _context_of(parent, pkey),
                                definition_hint=(pkey == "id" and "/params" not in ptr)))
            elif "[tag:" in node and target in node:
                for m in _TAG_RE.finditer(node):
                    if target in m.group(0)[1:-1].split(":"):  # 去掉方括号再按段比对
                        refs.append(Ref(f, ptr, "tag", f"{pkey}: …{m.group(0)}…"))
                        break

    for pattern in CONTENT_GLOBS:
        for fp in sorted(root.glob(pattern)):
            try:
                doc = json.loads(read_text(fp))
            except Exception:
                continue
            walk(doc, "", str(fp.relative_to(root)))
    return refs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("id", help="要查引用的 id / 键名 / tag 段")
    ap.add_argument("--root", type=Path, default=REPO_ROOT)
    ap.add_argument("--json", action="store_true", help="结构化输出(给 agent/脚本)")
    args = ap.parse_args(argv)
    root: Path = args.root

    ud = collect_id_universes(root)
    universes = sorted(name for name, ids in ud.ids.items() if args.id in ids)
    label = next((ud.labels[u][args.id] for u in universes
                  if u in ud.labels and args.id in ud.labels[u]), None)
    refs = find_refs(root, args.id)

    if args.json:
        print(json.dumps({
            "id": args.id, "label": label, "universes": universes,
            "refs": [asdict(r) for r in refs],
        }, ensure_ascii=False, indent=2))
        return 0

    head = f"「{args.id}」"
    if label:
        head += f"({label})"
    if universes:
        head += f"  ∈ 宇宙: {', '.join(universes)}"
    else:
        head += "  (不属于任何已知 id 宇宙——可能是自由文本或未登记)"
    print(head)
    if not refs:
        print("  0 处引用")
        return 0
    by_file: dict[str, list[Ref]] = {}
    for r in refs:
        by_file.setdefault(r.file, []).append(r)
    print(f"  共 {len(refs)} 处,{len(by_file)} 个文件:")
    for f in sorted(by_file):
        print(f"  {f}")
        for r in by_file[f]:
            mark = " ★定义处?" if r.definition_hint else ""
            print(f"    [{r.kind}] {r.pointer}  ({r.context}){mark}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
