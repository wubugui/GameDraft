"""Load/save/validate dialogue graph JSON (matches `src/data/types.ts` DialogueGraphFile)."""
from __future__ import annotations

import json
import re
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from tools.editor.shared.project_paths import ProjectPaths

from .dialogue_topology import iter_output_slots


def graphs_dir(project_root: Path) -> Path:
    """图对话 JSON 根目录：``public/assets/dialogues/graphs``。"""
    return ProjectPaths(project_root).dialogues_dir / "graphs"


def list_graph_files(project_root: Path) -> list[Path]:
    d = graphs_dir(project_root)
    if not d.is_dir():
        return []
    return sorted([p for p in d.glob("*.json") if p.is_file()], key=lambda p: p.name.lower())


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict[str, Any]) -> None:
    """先写入同目录 .tmp，再 replace 目标文件，避免写入中断导致原 JSON 截断损坏。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if not text.endswith("\n"):
        text += "\n"
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp_path.open("w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    except OSError:
        try:
            if tmp_path.is_file():
                tmp_path.unlink()
        except OSError:
            pass
        raise
    try:
        tmp_path.replace(path)
    except OSError:
        # 已完整写入 .tmp；replace 失败时保留临时文件便于手工恢复，原 path 未被覆盖
        raise


def write_bytes_atomic(path: Path, data: bytes) -> None:
    """原样写出字节（先写 .tmp 再 replace）。用于"内容未变则原样回写磁盘字节"以保格式零变化。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp_path.open("wb") as f:
            f.write(data)
    except OSError:
        try:
            if tmp_path.is_file():
                tmp_path.unlink()
        except OSError:
            pass
        raise
    tmp_path.replace(path)


def extract_flow_edges(nodes: dict[str, Any]) -> list[tuple[str, str, str]]:
    """Return canvas edges as (source id, target id, label)."""
    edges: list[tuple[str, str, str]] = []
    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        for slot in iter_output_slots(raw):
            if slot.target:
                edges.append((nid, slot.target, slot.label))
    return edges


def extract_flow_edges_detailed(
    nodes: dict[str, Any],
) -> list[tuple[str, str, str, str, int]]:
    """Return canvas edges with output kind and index metadata."""
    edges: list[tuple[str, str, str, str, int]] = []
    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        for slot in iter_output_slots(raw):
            if slot.target:
                edges.append((nid, slot.target, slot.label, slot.kind, slot.index))
    return edges


def nodes_reachable_from_entry(nodes: dict[str, Any], entry: str) -> set[str]:
    """从 entry 沿 next / choice / switch 边 BFS，返回可达节点集（与画布、analyze_node_tags 一致）。"""
    ent = str(entry or "").strip()
    if ent not in nodes:
        return set()
    edges = extract_flow_edges(nodes)
    out_adj: dict[str, list[str]] = defaultdict(list)
    for s, d, _ in edges:
        if d in nodes:
            out_adj[s].append(d)
    reachable: set[str] = set()
    dq = deque([ent])
    reachable.add(ent)
    while dq:
        u = dq.popleft()
        for v in out_adj.get(u, ()):
            if v in nodes and v not in reachable:
                reachable.add(v)
                dq.append(v)
    return reachable


# 层间/层内的额外留白（加在节点自身宽/高之上）——保证不同宽度的节点也不重叠，同时不过度铺开。
_LAYER_GAP = 60.0   # 相邻层水平留白（节点宽已单独计入）
_ROW_GAP = 34.0     # 同层相邻节点垂直留白（节点高已单独计入）


def node_type_label_zh(node_type: Any) -> str:
    """节点类型的中文短标签——画布节点标题与布局尺寸估算共用的唯一来源，避免两处漂移。"""
    if not isinstance(node_type, str):
        return "未知"
    return {
        "line": "对白",
        "runActions": "动作",
        "choice": "选项",
        "switch": "分支",
        "ownerState": "所属实体状态",
        "contextState": "上下文状态",
        "end": "结束",
    }.get(node_type, f"其它({node_type})")


def _estimate_node_size(nid: str, raw: Any) -> tuple[float, float]:
    """无画布时按内容估算节点渲染尺寸（宁可略微高估宽度以免重叠）。与画布 draw_node 近似。"""
    label = node_type_label_zh(raw.get("type") if isinstance(raw, dict) else None)
    summ = node_summary(nid, raw, max_text=24)
    line1 = f"{label} · {nid}"
    line2 = summ

    def _visual_len(s: str) -> float:
        # CJK/全角字符按 ~1.8 个拉丁字符宽计
        total = 0.0
        for ch in s:
            total += 1.8 if ord(ch) > 0x2E7F else 1.0
        return total

    max_units = max(_visual_len(line1), _visual_len(line2), 6.0)
    width = max_units * 9.0 + 56.0   # 每单位≈9px + 左右内边距
    width = min(max(width, 150.0), 460.0)
    return (width, 92.0)


def auto_layout_node_positions(
    nodes: dict[str, Any],
    entry: str,
    *,
    x_spacing: float = 260.0,
    y_spacing: float = 120.0,
    avoid_rects: list[tuple[float, float, float, float]] | None = None,
    node_sizes: dict[str, tuple[float, float]] | None = None,
) -> dict[str, tuple[float, float]]:
    """成熟分层布局：优先用 grandalf 的 Sugiyama（正确分层 + 假节点处理长边 + 顺序最小化交叉 +
    坐标对齐：子节点对齐到父节点、链路拉直），映射为左→右阅读方向（X=层、Y=层内对齐坐标）。
    **按节点真实宽高分配层间/层内间距**（node_sizes 给出画布实测尺寸；否则按内容估算），
    避免宽节点（长对白）在窄层距下横向重叠。grandalf 缺库/异常时回退简单 BFS 分层。
    """
    if not nodes:
        return {}
    pos = _sugiyama_layout(nodes, entry, node_sizes)
    if pos is None:
        pos = _bfs_layered_layout(nodes, entry, x_spacing, y_spacing, node_sizes)
    if avoid_rects:
        from .editor_group_geometry import nudge_node_positions_avoid_rects

        nudge_node_positions_avoid_rects(pos, nodes, avoid_rects)
    return pos


def _sugiyama_layout(
    nodes: dict[str, Any],
    entry: str,
    node_sizes: dict[str, tuple[float, float]] | None,
) -> dict[str, tuple[float, float]] | None:
    """grandalf Sugiyama 布局；任何缺库/异常返回 None 交回退。确定性：所有输入/根均按 id 排序。

    轴映射：grandalf 上→下排（层在 y、层内在 x）。我们要左→右，故读出后交换 (gx,gy)->(X=gy,Y=gx)。
    因此把「节点宽」喂给 grandalf 的 view.h（层方向→我们的 X 间距），「节点高」喂给 view.w（层内→Y）。
    这样 grandalf 直接按真实尺寸分层，输出无需再离散化即层列整齐且不重叠。
    """
    try:
        from grandalf.graphs import Vertex, Edge, Graph
        from grandalf.layouts import SugiyamaLayout
    except Exception:
        return None

    def _dims(nid: str) -> tuple[float, float]:
        if node_sizes and nid in node_sizes:
            w, h = node_sizes[nid]
            return (max(60.0, float(w)), max(40.0, float(h)))
        return _estimate_node_size(nid, nodes.get(nid))

    class _View:
        __slots__ = ("w", "h", "xy")

        def __init__(self, nid: str) -> None:
            nw, nh = _dims(nid)
            self.h = nw + _LAYER_GAP  # 层方向(→我们的 X)：容纳节点宽
            self.w = nh + _ROW_GAP    # 层内(→我们的 Y)：容纳节点高
            self.xy = (0.0, 0.0)

    try:
        node_ids = sorted(nodes.keys(), key=lambda x: (x.lower(), x))  # 固定顺序保确定性
        edges = [
            (s, d)
            for s, d, _ in extract_flow_edges(nodes)
            if s in nodes and d in nodes and s != d
        ]
        verts = {nid: Vertex(nid) for nid in node_ids}
        for nid in node_ids:
            verts[nid].view = _View(nid)
        graph = Graph(
            [verts[nid] for nid in node_ids],
            [Edge(verts[s], verts[d]) for s, d in edges],
        )

        ent = str(entry or "").strip()
        comps: list[dict[str, tuple[float, float]]] = []
        for comp in graph.C:
            comp_ids = sorted(
                (v.data for v in comp.sV if v.data in nodes), key=lambda x: (x.lower(), x)
            )
            roots = [verts[nid] for nid in comp_ids if len(verts[nid].e_in()) == 0]
            if ent in comp_ids:  # 入口优先作根（最左）
                ev = verts[ent]
                roots = [ev] + [r for r in roots if r is not ev]
            if not roots:  # 纯环：取 id 最小者作根，grandalf 自动反转环边
                roots = [verts[comp_ids[0]]]
            sug = SugiyamaLayout(comp)
            sug.init_all(roots=roots)
            sug.draw()
            comps.append(
                {nid: (float(verts[nid].view.xy[0]), float(verts[nid].view.xy[1])) for nid in comp_ids}
            )

        if sum(len(c) for c in comps) != len(nodes):
            return None  # 覆盖不全 → 回退

        # 直接用 grandalf 输出并交换轴（左→右），各连通分量纵向堆叠不重叠。
        pos: dict[str, tuple[float, float]] = {}
        y_cursor = 0.0
        for c in comps:
            xs = [gx for (gx, _gy) in c.values()]
            ys = [gy for (_gx, gy) in c.values()]
            min_gx, min_gy = min(xs), min(ys)
            span_x = max(xs) - min_gx  # grandalf-x 跨度 → 我们的 Y 高度
            for nid, (gx, gy) in c.items():
                pos[nid] = (float(gy - min_gy), float(gx - min_gx + y_cursor))
            y_cursor += span_x + _ROW_GAP * 3  # 连通分量纵向堆叠留白
        return pos
    except Exception:
        return None


def _bfs_layered_layout(
    nodes: dict[str, Any],
    entry: str,
    x_spacing: float,
    y_spacing: float,
    node_sizes: dict[str, tuple[float, float]] | None = None,
) -> dict[str, tuple[float, float]]:
    """回退：BFS 分层 + 层内按 id 等距。简单但稳，仅在 grandalf 不可用时使用。
    层间距按各层最大节点宽自适应，避免宽节点重叠。"""
    from collections import defaultdict, deque

    def _w(nid: str) -> float:
        if node_sizes and nid in node_sizes:
            return max(60.0, float(node_sizes[nid][0]))
        return _estimate_node_size(nid, nodes.get(nid))[0]

    def _h(nid: str) -> float:
        if node_sizes and nid in node_sizes:
            return max(40.0, float(node_sizes[nid][1]))
        return _estimate_node_size(nid, nodes.get(nid))[1]

    out_adj: dict[str, list[str]] = defaultdict(list)
    in_deg: dict[str, int] = defaultdict(int)
    for s, d, _ in extract_flow_edges(nodes):
        if s in nodes and d in nodes:
            out_adj[s].append(d)
            in_deg[d] += 1
    for nid in nodes:
        in_deg.setdefault(nid, 0)
    ent = str(entry or "").strip()
    if ent in nodes:
        seeds = [ent]
    else:
        roots = sorted((n for n in nodes if in_deg.get(n, 0) == 0), key=lambda x: (x.lower(), x))
        seeds = roots or [sorted(nodes.keys(), key=lambda x: (x.lower(), x))[0]]
    dist: dict[str, int] = {}
    dq = deque()
    for s in seeds:
        if s in nodes and s not in dist:
            dist[s] = 0
            dq.append(s)
    while dq:
        u = dq.popleft()
        for v in out_adj.get(u, ()):
            if v in nodes and v not in dist:
                dist[v] = dist[u] + 1
                dq.append(v)
    max_d = max(dist.values(), default=0)
    layers: dict[int, list[str]] = defaultdict(list)
    for nid in nodes:
        layers[dist[nid] if nid in dist else max_d + 2].append(nid)
    # 每层 X = 前面各层最大宽累加（宽节点把后续层往右推），避免固定层距下重叠。
    # 层内 Y 按各节点真实高度逐个累加（而非固定 y_spacing*i），避免同层高节点竖向重叠。
    pos: dict[str, tuple[float, float]] = {}
    layer_keys = sorted(layers.keys())
    x_cursor = 0.0
    for d in layer_keys:
        members = sorted(layers[d], key=lambda x: (x.lower(), x))
        layer_w = max((_w(nid) for nid in members), default=160.0)
        y_cursor = 0.0
        for nid in members:
            pos[nid] = (x_cursor, y_cursor)
            y_cursor += max(_h(nid), y_spacing) + _ROW_GAP
        x_cursor += layer_w + _LAYER_GAP
    return pos


def _validate_line_beats(nid: str, raw: dict[str, Any], errors: list[str]) -> None:
    lines = raw.get("lines")
    if lines is None:
        return
    if not isinstance(lines, list):
        errors.append(f"节点 {nid}: line.lines 必须是数组")
        return
    if len(lines) == 0:
        errors.append(f"节点 {nid}: line.lines 至少含一条台词")
        return
    for i, beat in enumerate(lines):
        if not isinstance(beat, dict):
            errors.append(f"节点 {nid} lines[{i}] 不是对象")
            continue
        sp = beat.get("speaker")
        if not isinstance(sp, dict):
            errors.append(f"节点 {nid} lines[{i}] 缺少 speaker 对象")


def _validate_action_list_for_state_commands(actions: Any, node_id: str, label: str, errors: list[str]) -> None:
    if not isinstance(actions, list):
        return
    for idx, action in enumerate(actions):
        if isinstance(action, dict) and str(action.get("type", "")).strip() == "setNarrativeState":
            errors.append(
                f"节点 {node_id} {label}[{idx}]: setNarrativeState 会绕过 transition/conditions，仅用于调试或修复"
            )


def _validate_owner_context_state_nodes(
    data: dict[str, Any],
    nodes: dict[str, Any],
    errors: list[str],
    warnings: list[str],
    *,
    project_root: Path | None = None,
    project_model: Any | None = None,
) -> None:
    dialogue_id = str(data.get("id", "") or "").strip()
    wrapper_info: dict[str, Any] | None = None
    if project_root is not None and project_model is not None and dialogue_id:
        try:
            from tools.editor.shared.narrative_catalog import resolve_owner_wrapper_states

            wrapper_info = resolve_owner_wrapper_states(project_root, project_model, dialogue_id)
        except Exception:
            wrapper_info = None

    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        t = raw.get("type")
        if t == "runActions":
            _validate_action_list_for_state_commands(raw.get("actions"), nid, "actions", errors)
        elif t == "ownerState":
            if wrapper_info is None:
                warnings.append(f"节点 {nid}: 无法静态确定所属实体 wrapper（缺少项目上下文）")
                continue
            wrappers = wrapper_info.get("wrappers") or []
            if not wrappers:
                msg = str(wrapper_info.get("message", "") or "未找到所属实体 wrapper")
                warnings.append(f"节点 {nid}: 无法静态确定所属实体 wrapper（{msg}）")
                continue
            wrapper_map = {
                str((w or {}).get("graphId", "")).strip(): w
                for w in wrappers
                if isinstance(w, dict) and str((w or {}).get("graphId", "")).strip()
            }
            selected_wrapper = str(raw.get("wrapperGraphId", "") or "").strip()
            target_graph = ""
            known: set[str] = set()
            validate_case_states = True

            if selected_wrapper.startswith("@"):
                # 相对 token（@owner / @scene）运行时解析，无法静态校验 case state
                validate_case_states = False
            elif selected_wrapper:
                target_graph = selected_wrapper
                selected_wrapper_info = wrapper_map.get(selected_wrapper)
                if selected_wrapper_info is not None:
                    known = {
                        str(s).strip()
                        for s in (selected_wrapper_info.get("stateIds") or [])
                        if str(s).strip()
                    }
                else:
                    known_from_catalog: set[str] = set()
                    if project_root is not None:
                        try:
                            from tools.editor.shared.narrative_catalog import graph_info

                            info = graph_info(project_root, selected_wrapper)
                            if info and str(info.get("kind", "")).strip() != "wrapperGraph":
                                errors.append(
                                    f"节点 {nid}: ownerState.wrapperGraphId {selected_wrapper!r} 指向的图不是 wrapperGraph"
                                )
                                validate_case_states = False
                            elif info:
                                known_from_catalog = {
                                    str(s).strip()
                                    for s in (info.get("stateIds") or [])
                                    if str(s).strip()
                                }
                        except Exception:
                            known_from_catalog = set()
                    if known_from_catalog:
                        known = known_from_catalog
                        candidates = ", ".join(sorted(wrapper_map.keys()))
                        warnings.append(
                            f"节点 {nid}: ownerState.wrapperGraphId {selected_wrapper!r} 与当前对话 owner 不一致"
                            f"（候选: {candidates or '无'}）"
                        )
                    elif not any(
                        f"ownerState.wrapperGraphId {selected_wrapper!r} 指向的图不是 wrapperGraph" in err
                        for err in errors
                    ):
                        errors.append(
                            f"节点 {nid}: ownerState.wrapperGraphId {selected_wrapper!r} 指向不存在的 wrapper graph"
                        )
                        validate_case_states = False
            else:
                if len(wrapper_map) > 1:
                    candidates = ", ".join(sorted(wrapper_map.keys()))
                    warnings.append(
                        f"节点 {nid}: ownerState 未设置 wrapperGraphId，当前 owner 绑定多个 wrapper（{candidates}）"
                    )
                if wrapper_info.get("ambiguous"):
                    warnings.append(f"节点 {nid}: 多个 NPC/Hotspot 引用该对话图，ownerState 的 state 需手工确认")
                if len(wrapper_map) == 1:
                    only_wrapper = next(iter(wrapper_map.values()))
                    if isinstance(only_wrapper, dict):
                        target_graph = str(only_wrapper.get("graphId", "")).strip()
                        known = {
                            str(s).strip()
                            for s in (only_wrapper.get("stateIds") or [])
                            if str(s).strip()
                        }
                else:
                    known = {str(s).strip() for s in (wrapper_info.get("stateIds") or []) if str(s).strip()}

            for i, case in enumerate(raw.get("cases") or []):
                if not isinstance(case, dict):
                    continue
                sid = str(case.get("state", "") or "").strip()
                if validate_case_states and sid and sid not in known:
                    graph_id = target_graph or str((wrappers[0] or {}).get("graphId", "?"))
                    errors.append(f"节点 {nid} ownerState case {i}: state {sid!r} 不存在于 wrapper {graph_id}")
        elif t == "contextState":
            gid = str(raw.get("graphId", "") or "").strip()
            if gid.startswith("@"):
                # 相对 token（@owner / @scene）运行时解析，跳过 graphId/state 存在性校验
                continue
            if project_root is None:
                if gid:
                    warnings.append(f"节点 {nid}: 无法校验 contextState graphId（缺少项目上下文）")
                continue
            from tools.editor.shared.narrative_catalog import graph_states, is_context_graph_allowed

            if gid and not is_context_graph_allowed(project_root, gid):
                errors.append(f"节点 {nid}: contextState graphId {gid!r} 不允许读取（不能选择 npc/hotspot wrapper）")
            known = {str(s).strip() for s in graph_states(project_root, gid) if str(s).strip()}
            for i, case in enumerate(raw.get("cases") or []):
                if not isinstance(case, dict):
                    continue
                sid = str(case.get("state", "") or "").strip()
                if sid and known and sid not in known:
                    errors.append(f"节点 {nid} contextState case {i}: state {sid!r} 不存在于图 {gid}")


def validate_owner_context_state(
    data: dict[str, Any],
    *,
    project_root: Path | None = None,
    project_model: Any | None = None,
) -> tuple[list[str], list[str]]:
    """仅跑 ownerState/contextState 的 wrapper/state 存在性校验（不含连边/entry 等结构检查）。

    供全量 validate-data 复用：过去这套只在编辑器保存时随 ``validate_graph_tiered`` 触发，
    全量校验漏检，导致 wrapper state 拼错/contextState graphId 非法要打开那张图才暴露。
    返回 (errors, warnings)。
    """
    errors: list[str] = []
    warnings: list[str] = []
    nodes = data.get("nodes")
    if not isinstance(nodes, dict):
        return (errors, warnings)
    _validate_owner_context_state_nodes(
        data,
        nodes,
        errors,
        warnings,
        project_root=project_root,
        project_model=project_model,
    )
    return (errors, warnings)


def validate_graph_tiered(
    data: dict[str, Any],
    *,
    project_root: Path | None = None,
    project_model: Any | None = None,
) -> tuple[list[str], list[str]]:
    """(errors, warnings)：编辑器保存时两者都会提示；errors 更严重，warnings 可确认后仍保存。"""
    errors: list[str] = []
    warnings: list[str] = []
    nodes: dict[str, Any] = data.get("nodes") or {}
    if not isinstance(nodes, dict):
        return (["nodes 必须是对象"], [])

    if not str(data.get("id", "")).strip():
        warnings.append("缺少顶层 id（建议与文件名一致）")

    entry = data.get("entry", "")
    ent = str(entry or "").strip()
    if ent and ent not in nodes:
        errors.append(f"入口 entry 指向不存在的节点: {entry!r}")
    elif not ent and nodes:
        warnings.append(
            "未设置 entry：无法校验「从图入口能否到达全部节点」；运行时也需指定起始节点"
        )

    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            errors.append(f"节点 {nid!r} 不是对象")
            continue
        t = raw.get("type")
        if t not in ("line", "runActions", "choice", "switch", "ownerState", "contextState", "end"):
            errors.append(f"节点 {nid!r} 未知 type: {t!r}")

        if t == "line":
            nx = raw.get("next", "")
            if nx and nx not in nodes:
                errors.append(f"节点 {nid}: next 指向不存在: {nx!r}")
            _validate_line_beats(nid, raw, errors)
        elif t == "runActions":
            nx = raw.get("next", "")
            if nx and nx not in nodes:
                errors.append(f"节点 {nid}: next 指向不存在: {nx!r}")
            acts = raw.get("actions")
            if not isinstance(acts, list):
                errors.append(f"节点 {nid}: runActions.actions 应为数组")
        elif t == "choice":
            opts = raw.get("options")
            if not isinstance(opts, list) or len(opts) == 0:
                errors.append(f"节点 {nid}: choice 至少需要一个选项")
            else:
                seen_opt: set[str] = set()
                for i, opt in enumerate(opts):
                    if not isinstance(opt, dict):
                        errors.append(f"节点 {nid} 选项 {i} 不是对象")
                        continue
                    on = opt.get("next", "")
                    if on and on not in nodes:
                        errors.append(f"节点 {nid} 选项 {i} next 指向不存在: {on!r}")
                    oid = str(opt.get("id", "") or "")
                    if oid and oid in seen_opt:
                        warnings.append(f"节点 {nid}: 选项 id 重复 {oid!r}")
                    if oid:
                        seen_opt.add(oid)
        elif t == "switch":
            cases = raw.get("cases") or []
            if isinstance(cases, list) and len(cases) == 0:
                warnings.append(f"节点 {nid}: switch 无分支 cases，将始终走 defaultNext")
            for i, c in enumerate(cases):
                if not isinstance(c, dict):
                    errors.append(f"节点 {nid} case {i} 不是对象")
                    continue
                cn = c.get("next", "")
                if cn and cn not in nodes:
                    errors.append(f"节点 {nid} case {i} next 指向不存在: {cn!r}")
            dn = raw.get("defaultNext", "")
            if dn and dn not in nodes:
                errors.append(f"节点 {nid}: defaultNext 指向不存在: {dn!r}")
        elif t == "ownerState":
            cases = raw.get("cases") or []
            if not str(raw.get("defaultNext", "") or "").strip():
                errors.append(f"节点 {nid}: ownerState 必须设置 defaultNext")
            for i, c in enumerate(cases):
                if not isinstance(c, dict):
                    errors.append(f"节点 {nid} ownerState case {i} 不是对象")
                    continue
                if not str(c.get("state", "") or "").strip():
                    warnings.append(f"节点 {nid}: ownerState case {i} 的 state 为空")
                cn = str(c.get("next", "") or "")
                if cn and cn not in nodes:
                    errors.append(f"节点 {nid} ownerState case {i} next 指向不存在: {cn!r}")
            dn = str(raw.get("defaultNext", "") or "")
            if dn and dn not in nodes:
                errors.append(f"节点 {nid}: ownerState defaultNext 指向不存在: {dn!r}")
            mn = str(raw.get("missingWrapperNext", "") or "")
            if mn and mn not in nodes:
                errors.append(f"节点 {nid}: ownerState missingWrapperNext 指向不存在: {mn!r}")
        elif t == "contextState":
            if not str(raw.get("graphId", "") or "").strip():
                errors.append(f"节点 {nid}: contextState 必须设置 graphId")
            if not str(raw.get("defaultNext", "") or "").strip():
                errors.append(f"节点 {nid}: contextState 必须设置 defaultNext")
            for i, c in enumerate(raw.get("cases") or []):
                if not isinstance(c, dict):
                    errors.append(f"节点 {nid} contextState case {i} 不是对象")
                    continue
                if not str(c.get("state", "") or "").strip():
                    warnings.append(f"节点 {nid}: contextState case {i} 的 state 为空")
                cn = str(c.get("next", "") or "")
                if cn and cn not in nodes:
                    errors.append(f"节点 {nid} contextState case {i} next 指向不存在: {cn!r}")
            dn = str(raw.get("defaultNext", "") or "")
            if dn and dn not in nodes:
                errors.append(f"节点 {nid}: contextState defaultNext 指向不存在: {dn!r}")
        elif t == "end":
            pass

    _validate_owner_context_state_nodes(
        data,
        nodes,
        errors,
        warnings,
        project_root=project_root,
        project_model=project_model,
    )

    if ent in nodes:
        reachable = nodes_reachable_from_entry(nodes, ent)
        unreachable = sorted(
            (nid for nid in nodes if nid not in reachable),
            key=lambda x: (x.lower(), x),
        )
        if unreachable:
            if len(unreachable) <= 15:
                for u in unreachable:
                    warnings.append(
                        f"节点 {u!r} 无法从入口 entry={ent!r} 沿连线到达（流程孤儿；请调整 entry 或拓扑）"
                    )
            else:
                sample = ", ".join(repr(x) for x in unreachable[:12])
                warnings.append(
                    f"共 {len(unreachable)} 个节点无法从入口 entry={ent!r} 到达（流程孤儿）。"
                    f"示例: {sample}…"
                )

    return (errors, warnings)


def validate_graph(
    data: dict[str, Any],
    *,
    project_root: Path | None = None,
    project_model: Any | None = None,
) -> list[str]:
    e, w = validate_graph_tiered(data, project_root=project_root, project_model=project_model)
    return e + w


def node_search_haystack(nid: str, raw: Any) -> str:
    """用于搜索：节点 id + 可读文本（小写匹配在调用方）。"""
    parts: list[str] = [nid]
    if not isinstance(raw, dict):
        return " ".join(parts)
    t = raw.get("type")
    if t == "line":
        parts.append(str(raw.get("text", "") or ""))
        parts.append(str(raw.get("textKey", "") or ""))
        lines = raw.get("lines")
        if isinstance(lines, list):
            for beat in lines:
                if isinstance(beat, dict):
                    parts.append(str(beat.get("text", "") or ""))
                    parts.append(str(beat.get("textKey", "") or ""))
    elif t == "choice":
        pl = raw.get("promptLine")
        if isinstance(pl, dict):
            parts.append(str(pl.get("text", "") or ""))
        for opt in raw.get("options") or []:
            if isinstance(opt, dict):
                parts.append(str(opt.get("text", "") or ""))
                parts.append(str(opt.get("id", "") or ""))
                parts.append(str(opt.get("requireFlag", "") or ""))
                parts.append(str(opt.get("ruleHintId", "") or ""))
                parts.append(str(opt.get("disabledClickHint", "") or ""))
    elif t == "runActions":
        try:
            parts.append(json.dumps(raw.get("actions"), ensure_ascii=False))
        except (TypeError, ValueError):
            parts.append(str(raw.get("actions")))
    elif t == "switch":
        for c in raw.get("cases") or []:
            if isinstance(c, dict):
                parts.append(str(c.get("next", "") or ""))
                try:
                    parts.append(json.dumps(c.get("condition"), ensure_ascii=False))
                except (TypeError, ValueError):
                    pass
                try:
                    parts.append(json.dumps(c.get("conditions"), ensure_ascii=False))
                except (TypeError, ValueError):
                    pass
        parts.append(str(raw.get("defaultNext", "") or ""))
    return " ".join(parts)


def node_summary(nid: str, raw: Any, max_text: int = 30) -> str:
    """节点的一行人类可读摘要，用于列表和画布显示。"""
    _ = nid
    if not isinstance(raw, dict):
        return ""
    t = raw.get("type")
    if t == "line":
        lines = raw.get("lines")
        if isinstance(lines, list) and lines and isinstance(lines[0], dict):
            beat = lines[0]
        else:
            beat = raw
        sp = beat.get("speaker") or {}
        kind = sp.get("kind", "?") if isinstance(sp, dict) else "?"
        if kind == "literal" and isinstance(sp, dict):
            kind_label = sp.get("name") or "旁白"
        else:
            kind_label = {
                "player": "玩家",
                "npc": "NPC",
                "literal": "旁白",
                "sceneNpc": "场景NPC",
            }.get(kind, kind)
        tx = str(beat.get("text", "") or "").replace("\n", " ").strip()
        if len(tx) > max_text:
            tx = tx[: max_text - 1] + "..."
        return f'{kind_label}: "{tx}"' if tx else str(kind_label)
    if t == "choice":
        opts = raw.get("options") or []
        n = len(opts) if isinstance(opts, list) else 0
        first = ""
        pl = raw.get("promptLine")
        if isinstance(pl, dict):
            prompt_txt = str(pl.get("text", "") or "").strip()
            if prompt_txt:
                first = prompt_txt
                if len(first) > 20:
                    first = first[:19] + "..."
        if not first and n and isinstance(opts[0], dict):
            first = str(opts[0].get("text", "") or "").strip()
            if len(first) > 20:
                first = first[:19] + "..."
        return f"{n}个选项: {first}" if first else f"{n}个选项"
    if t == "runActions":
        acts = raw.get("actions") or []
        if not isinstance(acts, list):
            acts = []
        n = len(acts)
        if n == 1 and isinstance(acts[0], dict):
            atype = str(acts[0].get("type", "?"))
            param_hint = _action_param_hint(acts[0])
            return f"{atype}: {param_hint}" if param_hint else atype
        types = [str(a.get("type", "?")) for a in acts[:2] if isinstance(a, dict)]
        suffix = "..." if n > 2 else ""
        return f"{n}动作: {', '.join(types)}{suffix}" if types else f"{n}动作"
    if t == "switch":
        cases = raw.get("cases") or []
        if not isinstance(cases, list):
            cases = []
        n = len(cases)
        hint = _switch_case_hint(cases[0]) if n and isinstance(cases[0], dict) else ""
        suffix = "..." if n > 1 else ""
        return f"{n}分支: {hint}{suffix}" if hint else f"{n}分支"
    if t == "ownerState":
        cases = raw.get("cases") or []
        if not isinstance(cases, list):
            cases = []
        states = [str(c.get("state", "") or "").strip() for c in cases if isinstance(c, dict)]
        states = [s for s in states if s]
        if states:
            preview = ", ".join(states[:3])
            if len(states) > 3:
                preview += "..."
            return f"实体状态→{preview}"
        return "实体状态分支"
    if t == "contextState":
        gid = str(raw.get("graphId", "") or "").strip()
        cases = raw.get("cases") or []
        n = len(cases) if isinstance(cases, list) else 0
        return f"上下文 {gid or '?'} ({n}分支)"
    if t == "end":
        return "结束"
    return ""


def _action_param_hint(action: dict) -> str:
    """从单条 ActionDef 中提取最有辨识度的参数值作为摘要后缀。"""
    p = action.get("params")
    if not isinstance(p, dict):
        return ""
    for key in (
        "key",
        "flag",
        "amount",
        "target",
        "scenarioId",
        "documentId",
        "itemId",
        "questId",
        "text",
    ):
        v = p.get(key)
        if v is not None and str(v).strip():
            s = str(v).strip()
            return s[:20] + "..." if len(s) > 20 else s
    return ""


def _switch_case_hint(case: dict) -> str:
    """从 switch 的第一个 case 提取条件关键字。"""
    conds = case.get("conditions")
    if isinstance(conds, list) and conds and isinstance(conds[0], dict):
        c0 = conds[0]
        if "flag" in c0:
            f = str(c0.get("flag", "")).strip()
            if not f:
                return "flag?"
            return f"flag {f[:18]}..." if len(f) > 18 else f"flag {f}"
        if "scenario" in c0:
            s = str(c0.get("scenario", "")).strip()
            ph = str(c0.get("phase", "")).strip()
            label = f"{s}/{ph}" if ph else s
            return label[:22] + "..." if len(label) > 22 else label
        if "quest" in c0:
            return f"quest {str(c0.get('quest', '')).strip()}"
        if "questId" in c0:
            qid = str(c0.get("questId", "")).strip()
            return f"quest {qid}" if qid else "quest?"
    cond = case.get("condition")
    if isinstance(cond, dict) and cond:
        if any(k in cond for k in ("any", "all", "not")):
            return "条件表达式"
        if "flag" in cond:
            f = str(cond.get("flag", "")).strip()
            return f"flag {f[:18]}..." if len(f) > 18 else f"flag {f}" if f else "flag?"
        if "scenario" in cond:
            s = str(cond.get("scenario", "")).strip()
            ph = str(cond.get("phase", "")).strip()
            label = f"{s}/{ph}" if ph else s
            return label[:22] + "..." if len(label) > 22 else label
        return "条件表达式"
    return ""


_SAFE_ID_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def suggest_next_id(nodes: dict[str, Any], prefix: str = "n") -> str:
    max_n = 0
    for k in nodes:
        m = re.match(r"^" + re.escape(prefix) + r"_(\d+)$", k)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"{prefix}_{max_n + 1}"


def default_node(node_type: str, nodes: dict[str, Any]) -> dict[str, Any]:
    """Create a new node dict for the given type. 新建默认不连接任何 next，由策划手动连线。"""
    _ = nodes

    if node_type == "line":
        return {
            "type": "line",
            "speaker": {"kind": "player"},
            "text": "",
            "next": "",
        }
    if node_type == "runActions":
        return {"type": "runActions", "actions": [], "next": ""}
    if node_type == "choice":
        return {
            "type": "choice",
            "options": [
                {"id": "a", "text": "选项甲", "next": ""},
            ],
        }
    if node_type == "switch":
        return {
            "type": "switch",
            "cases": [],
            "defaultNext": "",
        }
    if node_type == "ownerState":
        return {
            "type": "ownerState",
            "wrapperGraphId": "",
            "cases": [],
            "defaultNext": "",
            "missingWrapperNext": "",
        }
    if node_type == "contextState":
        return {
            "type": "contextState",
            "graphId": "",
            "cases": [],
            "defaultNext": "",
        }
    if node_type == "end":
        return {"type": "end"}
    raise ValueError(node_type)
