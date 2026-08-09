"""图对话静态分析（不可达、死路等），仅编辑器。"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from .graph_document import extract_flow_edges, nodes_reachable_from_entry


def analyze_node_tags(data: dict[str, Any]) -> dict[str, str]:
    """node_id -> 'warn'（不可达或无出边非 end）。"""
    nodes = data.get("nodes") or {}
    entry = str(data.get("entry", "") or "")
    edges = extract_flow_edges(nodes)
    out_adj: dict[str, list[str]] = defaultdict(list)
    for s, d, _ in edges:
        if d in nodes:
            out_adj[s].append(d)

    reachable = nodes_reachable_from_entry(nodes, entry)

    tags: dict[str, str] = {}
    for nid in nodes:
        if nid not in reachable:
            tags[nid] = "warn"

    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        if raw.get("type") == "end":
            continue
        if not out_adj.get(nid):
            tags[nid] = "warn"

    return tags


def extract_narrative_refs(data: dict[str, Any]) -> dict[str, Any]:
    """图内引用的 scenarioId（meta + 条件叶子）及嵌套 graphId（runActions 等），供编辑器分析。"""
    scenario_ids: set[str] = set()
    graph_ids: set[str] = set()
    meta = data.get("meta")
    if isinstance(meta, dict):
        ms = str(meta.get("scenarioId") or "").strip()
        if ms:
            scenario_ids.add(ms)

    def walk_expr(expr: Any) -> None:
        if not isinstance(expr, dict):
            return
        if "all" in expr and isinstance(expr["all"], list):
            for x in expr["all"]:
                walk_expr(x)
            return
        if "any" in expr and isinstance(expr["any"], list):
            for x in expr["any"]:
                walk_expr(x)
            return
        if "not" in expr:
            walk_expr(expr.get("not"))
            return
        sc = expr.get("scenario")
        if isinstance(sc, str) and sc.strip():
            scenario_ids.add(sc.strip())

    pre = data.get("preconditions")
    if isinstance(pre, list):
        for p in pre:
            walk_expr(p)

    nodes = data.get("nodes")
    if isinstance(nodes, dict):
        for _nid, raw in nodes.items():
            if not isinstance(raw, dict):
                continue
            if raw.get("type") == "switch":
                for case in raw.get("cases") or []:
                    if not isinstance(case, dict):
                        continue
                    c = case.get("condition")
                    if c is not None:
                        walk_expr(c)
                    for atom in case.get("conditions") or []:
                        walk_expr(atom)
            if raw.get("type") == "choice":
                for opt in raw.get("options") or []:
                    if isinstance(opt, dict) and opt.get("requireCondition") is not None:
                        walk_expr(opt.get("requireCondition"))
            if raw.get("type") == "runActions":
                for act in raw.get("actions") or []:
                    if not isinstance(act, dict):
                        continue
                    if act.get("type") == "startDialogueGraph":
                        p = act.get("params") or {}
                        gid = str(p.get("graphId") or "").strip()
                        if gid:
                            graph_ids.add(gid)

    return {
        "scenarioIds": sorted(scenario_ids),
        "graphIds": sorted(graph_ids),
    }


def collect_emitted_signals(data: dict[str, Any]) -> set[str]:
    """本图所有 emitNarrativeSignal 动作喷出的信号名（递归任意嵌套：runActions / switch case actions /
    chooseAction 等容器都扫得到，避免漏掉藏在嵌套里的 emit）。"""
    signals: set[str] = set()

    def walk(o: Any) -> None:
        if isinstance(o, dict):
            if o.get("type") == "emitNarrativeSignal":
                sig = str((o.get("params") or {}).get("signal") or "").strip()
                if sig:
                    signals.add(sig)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data.get("nodes") or {})
    return signals


# 私有信号（`signals[].scope == 'private'`）在发射端的一句话交代。
# 发射端才是它唯一会出事的地方：私有信号按**发射方 owner** 定向投递，缺 owner 上下文
# 是 fail-loud 丢弃（`signal.private.noOwner`，error），**绝不回落成全局广播**——
# 回落会让一条共用信号名一次推倒全部同类实体，正是这个机制要避免的事。
# 真相源：src/core/NarrativeStateManager.ts + agent_docs/runtime/mechanisms/private-narrative-signal.md
PRIVATE_SIGNAL_SCOPE = "private"
PRIVATE_SIGNAL_MARK = "🔒 私有"
PRIVATE_SIGNAL_TOOLTIP = (
    "私有：只投递给发射方实体自己的 wrapper 图；"
    "本图若挂在无实体上下文的容器上，这条发射会被丢弃"
)


def collect_private_signal_ids(narrative_graphs: Any) -> set[str]:
    """narrative_graphs.signals 里标了 `scope: 'private'` 的信号名。

    只认注册表这一处（与运行时投递判据、校验器 `validatePrivateSignalListeners` 同源）：
    私有与全局同一命名空间、不得重名，所以按名字查就够，不必也不该按用法反推。
    """
    out: set[str] = set()
    if not isinstance(narrative_graphs, dict):
        return out
    rows = narrative_graphs.get("signals")
    # fail-safe 不 fail-open：半截数据（`{"signals": 5}`）读不出来就当没有。
    # `x or []` 只挡得住 None/空，遇到标量会当场 TypeError，整块检查器白屏。
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        sid = str(row.get("id") or "").strip()
        if sid and str(row.get("scope") or "").strip() == PRIVATE_SIGNAL_SCOPE:
            out.add(sid)
    return out


def build_narrative_signal_owners(narrative_graphs: Any) -> dict[str, str]:
    """signal 名 -> 监听它的叙事图 id（供对话图「叙事归属」按信号自动推导）。

    扫所有编排的 mainGraph + 元素子图的 transitions。忽略 `__draft__` 占位与 `state:*` 派生广播
    （后者是叙事图之间的状态握手，不是对话喷的原始信号）。首个监听者胜出；若多图监听同一信号，
    优先归到 `scenario_*` 剧情图而非 `wrap_*` 包装子图。"""
    owners: dict[str, str] = {}
    if not isinstance(narrative_graphs, dict):
        return owners

    def consider(sig: str, gid: str) -> None:
        sig = sig.strip()
        if not sig or sig == "__draft__" or sig.startswith("state:"):
            return
        cur = owners.get(sig)
        if cur is None:
            owners[sig] = gid
        elif gid.startswith("scenario_") and not cur.startswith("scenario_"):
            owners[sig] = gid

    for comp in narrative_graphs.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        graphs = [comp.get("mainGraph")]
        graphs += [e.get("graph") for e in (comp.get("elements") or []) if isinstance(e, dict)]
        for g in graphs:
            if not isinstance(g, dict):
                continue
            gid = str(g.get("id") or "").strip()
            if not gid:
                continue
            for t in g.get("transitions") or []:
                if isinstance(t, dict) and isinstance(t.get("signal"), str):
                    consider(t["signal"], gid)
    return owners


def build_graph_package_map(narrative_graphs: Any) -> dict[str, str]:
    """叙事图 id -> 章节包 id（编译期规则：composition.package 盖整组；element.package 覆盖单元素）。
    无标者不入表（= 常驻/无章节）。供对话图归属从 owner 图卷到其所属章节。"""
    out: dict[str, str] = {}
    if not isinstance(narrative_graphs, dict):
        return out
    for comp in narrative_graphs.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        comp_pkg = str(comp.get("package") or "").strip() or None
        mg = comp.get("mainGraph")
        if isinstance(mg, dict) and str(mg.get("id") or "").strip() and comp_pkg:
            out[str(mg["id"]).strip()] = comp_pkg
        for el in comp.get("elements") or []:
            if not isinstance(el, dict):
                continue
            g = el.get("graph")
            if not isinstance(g, dict):
                continue
            gid = str(g.get("id") or "").strip()
            if not gid:
                continue
            el_pkg = str(el.get("package") or "").strip() or comp_pkg
            if el_pkg:
                out[gid] = el_pkg
    return out


def derive_dialogue_owner(data: dict[str, Any], signal_owners: dict[str, str]) -> str:
    """对话图的叙事归属 = 它喷的信号里第一个有叙事图监听的那个信号的 owner。
    喷了没人听 / 纯闲聊不喷信号 -> 返回 ''（未归属，正确行为）。多信号时优先 `scenario_*` owner。"""
    emitted = collect_emitted_signals(data)
    if not emitted:
        return ""
    best = ""
    for sig in sorted(emitted):
        owner = signal_owners.get(sig)
        if not owner:
            continue
        if owner.startswith("scenario_"):
            return owner
        if not best:
            best = owner
    return best
