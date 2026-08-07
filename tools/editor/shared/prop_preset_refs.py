"""挂件预设的引用扫描：谁在用这个 prop id。

改名/删除前必答的三问之一（editor-tools norms 过程义务 4）。没有它，
删掉一个预设就是把引用它的 attachToSocket 静默变成"挂不出东西"——
运行时只 warn 一行，策划要到真机才看得见。

复用 `signal_refactor.CONDITION_SOURCES` 那张"全工程动作/条件容器"登记表，
不再手抄一份容器清单（norms 第 8 条：宁可消灭镜像）。
"""
from __future__ import annotations

from typing import Any, Iterator

from . import signal_refactor as _sig

#: 引用挂件预设的动作参数（目前只有一处；新增时在此补行）
PROP_REF_PARAMS: dict[str, str] = {
    "attachToSocket": "prop",
}


def _walk_prop_actions(node: Any) -> Iterator[tuple[dict[str, Any], str, str]]:
    """深度遍历任意结构，产出 (params, 参数名, 当前值)。"""
    if isinstance(node, dict):
        act_type = node.get("type")
        params = node.get("params")
        if isinstance(act_type, str) and act_type in PROP_REF_PARAMS and isinstance(params, dict):
            pname = PROP_REF_PARAMS[act_type]
            val = params.get(pname)
            if isinstance(val, str) and val.strip():
                yield params, pname, val.strip()
        for v in node.values():
            yield from _walk_prop_actions(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_prop_actions(v)


def _project_nodes(model: Any) -> Iterator[tuple[str, str, Any]]:
    """(来源描述, 脏桶 item_id, 数据节点)——覆盖全工程动作宿主。"""
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        yield f"场景 {sid}", str(sid), scene
    for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            yield f"{bucket} {item_id}" if item_id else str(bucket), str(item_id or ""), node
    narrative = getattr(model, "narrative_graphs", None)
    if narrative:
        yield "叙事图", "", narrative
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is not None:
            yield f"图对话 {gid}", str(gid), doc


def scan_prop_usages(model: Any, prop_id: str) -> list[str]:
    """返回引用该挂件预设的位置描述（去重、已排序）；空表示没人用。"""
    target = (prop_id or "").strip()
    if not target:
        return []
    hits: set[str] = set()
    for where, _item_id, node in _project_nodes(model):
        for _params, _pname, val in _walk_prop_actions(node):
            if val == target:
                hits.add(where)
    return sorted(hits)


def rename_prop_references(model: Any, old: str, new: str) -> int:
    """把全工程对 old 的引用改写成 new，返回改写处数；同时按桶标脏。

    图对话文档走 `signal_refactor` 的暂存通道（它们不在 ProjectModel 里直接持有）。
    """
    o = (old or "").strip()
    n = (new or "").strip()
    if not o or not n or o == n:
        return 0
    import copy

    total = 0
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        count = 0
        for params, pname, val in _walk_prop_actions(scene):
            if val == o:
                params[pname] = n
                count += 1
        if count:
            model.mark_dirty("scene", str(sid))
            total += count
    for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            count = 0
            for params, pname, val in _walk_prop_actions(node):
                if val == o:
                    params[pname] = n
                    count += 1
            if count:
                model.mark_dirty(bucket, item_id if per_item else "")
                total += count
    narrative = getattr(model, "narrative_graphs", None)
    if narrative:
        count = 0
        for params, pname, val in _walk_prop_actions(narrative):
            if val == o:
                params[pname] = n
                count += 1
        if count:
            model.mark_dirty("narrative_graphs")
            total += count
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        working = copy.deepcopy(doc)
        count = 0
        for params, pname, val in _walk_prop_actions(working):
            if val == o:
                params[pname] = n
                count += 1
        if count:
            _sig._stage_dialogue_doc(model, gid, working)
            total += count
    return total
