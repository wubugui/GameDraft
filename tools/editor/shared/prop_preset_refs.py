"""挂件预设 / 挂件效果块的引用扫描：谁在用这个 id。

改名/删除前必答的三问之一（editor-tools norms 过程义务 4）。没有它，
删掉一个预设就是把引用它的 attachToSocket 静默变成"挂不出东西"——
运行时只 warn 一行，策划要到真机才看得见；条件叶 `{heldProp, prop}` 更糟：恒为假、一行都不 warn。
`{propLevel}`（火把养成）与 `{heldProp, effect}`（效果块的脾气）同样是"恒为假、零报错"那一档。

复用 `signal_refactor.CONDITION_SOURCES` 那张"全工程动作/条件容器"登记表，
不再手抄一份容器清单（norms 第 8 条：宁可消灭镜像）。扫描面只有一份，
两种 id 各带自己的 walker（`Walker`）走同一条路。
"""
from __future__ import annotations

from typing import Any, Callable, Iterator

from . import signal_refactor as _sig

#: 一个 walker：深度遍历任意结构，产出 (容器, 字段名, 当前值)
Walker = Callable[[Any], Iterator[tuple[dict[str, Any], str, str]]]

#: 引用挂件预设的动作参数（新增时在此补行）
PROP_REF_PARAMS: dict[str, str] = {
    "attachToSocket": "prop",
    # 火把养成的升级（玩法清单 A3.7）：prop = 要升级的那根挂件
    "setPropLevel": "prop",
}
#: 引用挂件预设的条件叶：叶子判别键 → 引用字段。条件叶没有 type/params 那层壳，与动作分开登记；
#: 改名不跟它 = 那条条件从此恒为假、零报错。
#: - `{heldProp, prop}`（types.ts HeldPropConditionLeaf）：引用在 `prop` 字段上；
#: - `{propLevel, op?, value}`（PropLevelConditionLeaf）：**判别键自己就是引用**，所以映射到 `propLevel`。
PROP_REF_CONDITION_LEAVES: dict[str, str] = {
    "heldProp": "prop",
    "propLevel": "propLevel",
}


def _walk_prop_actions(node: Any) -> Iterator[tuple[dict[str, Any], str, str]]:
    """深度遍历任意结构，产出 (容器, 字段名, 当前值)：动作的 params，或条件叶子本身。"""
    if isinstance(node, dict):
        fire = node.get("fireProtection")
        props = fire.get("heldPropIds") if isinstance(fire, dict) else None
        if isinstance(props, list):
            for index, prop in enumerate(props):
                if isinstance(prop, str) and prop.strip():
                    yield props, index, prop.strip()
        act_type = node.get("type")
        params = node.get("params")
        if isinstance(act_type, str) and act_type in PROP_REF_PARAMS and isinstance(params, dict):
            pname = PROP_REF_PARAMS[act_type]
            val = params.get(pname)
            if isinstance(val, str) and val.strip():
                yield params, pname, val.strip()
        for leaf_key, field in PROP_REF_CONDITION_LEAVES.items():
            if isinstance(node.get(leaf_key), str):
                val = node.get(field)
                if isinstance(val, str) and val.strip():
                    yield node, field, val.strip()
        for v in node.values():
            yield from _walk_prop_actions(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_prop_actions(v)


#: 引用效果块（`prop_effects.json`）的条件叶：`{heldProp, effect}`。
#: `effect` 写效果块 id **或**它的标签都命中，所以改名改的是"恰好等于旧 id"的那些——
#: 写成标签的本来就不该跟着 id 走（标签由效果块自己的 `tags` 管）。
EFFECT_REF_CONDITION_LEAVES: dict[str, str] = {
    "heldProp": "effect",
}


def _walk_effect_refs(node: Any) -> Iterator[tuple[dict[str, Any], str, str]]:
    """深度遍历任意结构，产出条件叶里引用效果块 id 的 (容器, 字段名, 当前值)。"""
    if isinstance(node, dict):
        for leaf_key, field in EFFECT_REF_CONDITION_LEAVES.items():
            if isinstance(node.get(leaf_key), str):
                val = node.get(field)
                if isinstance(val, str) and val.strip():
                    yield node, field, val.strip()
        for v in node.values():
            yield from _walk_effect_refs(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_effect_refs(v)


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


def _scan_usages(model: Any, target: str, walker: Walker) -> list[str]:
    """返回引用该 id 的位置描述（去重、已排序）；空表示没人用。"""
    if not target:
        return []
    hits: set[str] = set()
    for where, _item_id, node in _project_nodes(model):
        for _params, _pname, val in walker(node):
            if val == target:
                hits.add(where)
    return sorted(hits)


def scan_prop_usages(model: Any, prop_id: str) -> list[str]:
    """谁在用这条挂件预设（`attachToSocket.prop` / `setPropLevel.prop` / 两个条件叶）。"""
    return _scan_usages(model, (prop_id or "").strip(), _walk_prop_actions)


def scan_effect_usages(model: Any, effect_id: str) -> list[str]:
    """谁在用这一块效果（`heldProp` 条件叶的 `effect`）。

    ⚠ 挂件预设里的 `effects` / `levels[*].effects` **不在这条路上**——那是另一张表
    （`prop_presets.json`），由「挂件效果块」页自己扫（它手里就有那张表）。
    """
    return _scan_usages(model, (effect_id or "").strip(), _walk_effect_refs)


def rename_prop_references(model: Any, old: str, new: str) -> int:
    """挂件预设改名：把全工程对 old 的引用改写成 new。"""
    return _rename_references(model, old, new, _walk_prop_actions)


def rename_effect_references(model: Any, old: str, new: str) -> int:
    """效果块改名：把全工程 `heldProp` 条件叶里的 `effect` 改写成 new。

    不跟这一条 = 那些条件从此**恒为假**（运行时一行都不 warn），与挂件预设改名同一个坑。
    """
    return _rename_references(model, old, new, _walk_effect_refs)


def _rename_references(model: Any, old: str, new: str, walker: Walker) -> int:
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
        for params, pname, val in walker(scene):
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
            for params, pname, val in walker(node):
                if val == o:
                    params[pname] = n
                    count += 1
            if count:
                model.mark_dirty(bucket, item_id if per_item else "")
                total += count
    narrative = getattr(model, "narrative_graphs", None)
    if narrative:
        count = 0
        for params, pname, val in walker(narrative):
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
        for params, pname, val in walker(working):
            if val == o:
                params[pname] = n
                count += 1
        if count:
            _sig._stage_dialogue_doc(model, gid, working)
            total += count
    return total
