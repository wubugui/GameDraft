"""对话图连边 lint——专抓 schema(单字段)与 validate-data 都不覆盖的缝。

CLAUDE.md 收尾清单明写"校验抓不到、要自己当心的:对话图内部 next 连边";
本模块把它变成机器检查:

- error   悬垂连边:next / defaultNext / cases[].next / missingWrapperNext / entry
          指向 nodes 里不存在的节点(运行时表现为对话戛然而止或静默跳过)
- error   悬垂外部入口:npc.dialogueGraphEntry / hotspot data.entry /
          startDialogueGraph.entry 指向图中不存在的节点(跨文件,谁都不查)
- warning 不可达节点:从图默认 entry + 全部外部入口出发 BFS 走不到的节点
          (改线后遗留的死节点,不影响运行但腐蚀图)

外部入口通道与运行时对齐(InteractionCoordinator):NPC 绑图走
`dialogueGraphId`+`dialogueGraphEntry`;hotspot 与 startDialogueGraph action 走
`graphId`+`entry`——共享图(如 街巷_市井闲谈 一图 18 入口)按此判定可达。
引用键的判定与实证一致:键名为 entry 或以 Next 结尾/等于 next;空串不视为引用。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

_CONTENT_GLOBS = (
    "public/assets/data/**/*.json",
    "public/assets/scenes/*.json",
    "public/assets/dialogues/graphs/*.json",
)


@dataclass
class LintIssue:
    severity: str  # "error" | "warning"
    file: str
    message: str


def _is_ref_key(key: str) -> bool:
    return key == "next" or key == "entry" or key.endswith("Next")


def _collect_refs(node, out: list[tuple[str, str]], ctx: str) -> None:
    """深度收集 (引用键上下文, 目标节点id)。"""
    if isinstance(node, dict):
        for k, v in node.items():
            if _is_ref_key(k) and isinstance(v, str) and v.strip():
                out.append((f"{ctx}.{k}" if ctx else k, v))
            _collect_refs(v, out, f"{ctx}.{k}" if ctx else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _collect_refs(v, out, f"{ctx}[{i}]")


@dataclass
class _ExternalEntry:
    file: str
    context: str
    entry: str


def _collect_external_entries(root: Path) -> dict[str, list[_ExternalEntry]]:
    """全项目收集"进图并指定入口节点"的引用:graphId → 入口列表。
    两种形状:{dialogueGraphId, dialogueGraphEntry}(场景 NPC)与
    {graphId, entry}(hotspot data / startDialogueGraph params)。"""
    out: dict[str, list[_ExternalEntry]] = {}

    def note(gid, entry, f, ctx):
        if isinstance(gid, str) and gid.strip() and isinstance(entry, str) and entry.strip():
            out.setdefault(gid.strip(), []).append(_ExternalEntry(f, ctx, entry.strip()))

    def walk(node, f: str) -> None:
        if isinstance(node, dict):
            note(node.get("dialogueGraphId"), node.get("dialogueGraphEntry"),
                 f, f"npc {node.get('id', '?')}")
            if "graphId" in node:
                note(node.get("graphId"), node.get("entry"), f, "graphId+entry 引用")
            for v in node.values():
                walk(v, f)
        elif isinstance(node, list):
            for v in node:
                walk(v, f)

    for pattern in _CONTENT_GLOBS:
        for fp in root.glob(pattern):
            try:
                walk(json.loads(fp.read_text(encoding="utf-8")), str(fp.relative_to(root)))
            except Exception:
                continue
    return out


def lint_dialogue_graphs(root: Path) -> list[LintIssue]:
    issues: list[LintIssue] = []
    external = _collect_external_entries(root)
    for f in sorted((root / "public/assets/dialogues/graphs").glob("*.json")):
        rel = str(f.relative_to(root))
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except Exception as e:
            issues.append(LintIssue("error", rel, f"不是合法 JSON: {e}"))
            continue
        if not isinstance(doc, dict):
            continue
        nodes = doc.get("nodes")
        if not isinstance(nodes, dict):
            issues.append(LintIssue("error", rel, "缺少 nodes 对象"))
            continue

        # 悬垂连边:全图(含图级 entry/missingWrapperNext 与节点内部)所有引用必须命中节点
        refs: list[tuple[str, str]] = []
        _collect_refs(doc, refs, "")
        for ctx, target in refs:
            if target not in nodes:
                issues.append(LintIssue("error", rel, f"悬垂连边 {ctx} → 不存在的节点 {target!r}"))

        # 可达性:根 = 图级引用(nodes 之外的 entry / *Next)+ 全项目外部入口
        graph_level = {k: v for k, v in doc.items() if k != "nodes"}
        roots: list[tuple[str, str]] = []
        _collect_refs(graph_level, roots, "")
        gid = doc.get("id") if isinstance(doc.get("id"), str) and doc["id"].strip() else f.stem
        for ext in external.get(gid, []):
            if ext.entry in nodes:
                roots.append((f"external:{ext.context}", ext.entry))
            else:
                issues.append(LintIssue(
                    "error", ext.file,
                    f"悬垂外部入口 {ext.context} → 图 {gid!r} 不存在的节点 {ext.entry!r}",
                ))
        edges: dict[str, list[str]] = {}
        for nid, body in nodes.items():
            outgoing: list[tuple[str, str]] = []
            _collect_refs(body, outgoing, nid)
            edges[nid] = [t for _, t in outgoing]

        seen: set[str] = set()
        stack = [t for _, t in roots if t in nodes]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(t for t in edges.get(cur, []) if t in nodes and t not in seen)
        for nid in nodes:
            if nid not in seen:
                issues.append(LintIssue("warning", rel, f"不可达节点 {nid!r}(entry 出发走不到,疑似改线残留)"))
    return issues
