"""全项目叙事信号重构引擎（改名 / 删除）。

只改 ProjectModel 内存数据并标脏，**零磁盘写入**——落盘仍走主编辑器 Save All
（两阶段暂存）。对话图不常驻 ProjectModel 内存，改动暂存进
``model.pending_dialogue_graph_edits``（脏桶 ``dialogue_graph_edits``），随
Save All 覆写原文件（区别于 ``dialogue_stubs`` 的只写新文件）。

撤销语义：
- 改名的撤销 = 反向改名（同引擎再跑一遍 new→old，幂等、不怕后续编辑）；
- 删除的撤销 = 执行期记录的精确反向编辑（见 ``delete_signal`` 返回的 reverse_ops，
  按记录逆序回放即可复原，路径级操作与后续无关编辑可组合）。

信号引用面共五类通道（与 narrative_catalog.emitted_signal_ids 的扫描口径一致）：
narrative_graphs（注册表 / transition 监听 / 图内 state 动作发射 / blackbox meta.emits）
+ 对话图（磁盘文件，深度遍历 emitNarrativeSignal）+ 内容资产 action 树（scenes/quests/
cutscenes/pressure_holds/…内存集合）。narrative_templates 刻意不扫：模板走
``{{taskId}}__`` 占位符命名空间，运行时永不加载。
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Iterator

_DERIVED_PREFIX = "state:"
_DRAFT_SIGNAL = "__draft__"

# 内容资产内存集合 → (脏桶名, 是否按 item 标脏)。与 narrative_catalog._EMIT_SOURCE_ATTRS
# 同源；新增可发射信号的数据域时两处一起加（有 parity 测试锁定）。
EMIT_SOURCE_BUCKETS: dict[str, tuple[str, bool]] = {
    "scenes": ("scene", True),
    "quests": ("quest", False),
    "encounters": ("encounter", False),
    "cutscenes": ("cutscene", False),
    "pressure_holds": ("pressure_holds", False),
    "signal_cues": ("signal_cues", False),
    "archive_characters": ("archive", False),
    "archive_books": ("archive", False),
    "archive_documents": ("archive", False),
    "water_minigames_instances": ("water_minigames", False),
    "sugar_wheel_instances": ("sugar_wheel", False),
    "paper_craft_instances": ("paper_craft", False),
}


class SignalRefactorError(ValueError):
    """重构前置校验失败（id 冲突 / 不存在 / 保留名等），不产生任何修改。"""


# 条件叶子 {narrative, state} 与 setNarrativeState 动作可出现的集合，比发射面更广
# （地图节点可见性、图鉴解锁、物品动态描述等）。attr 缺失时 getattr 兜 None 自动跳过。
CONDITION_EXTRA_SOURCES: dict[str, tuple[str, bool]] = {
    "map_nodes": ("map", False),
    "quest_groups": ("questGroup", False),
    "items": ("item", False),
    "rules": ("rules", False),
    "shops": ("shop", False),
    "archive_lore": ("archive", False),
    "document_reveals": ("document_reveals", False),
    "smell_profiles": ("smell_profiles", False),
    "game_config": ("config", False),
}
CONDITION_SOURCES: dict[str, tuple[str, bool]] = {**EMIT_SOURCE_BUCKETS, **CONDITION_EXTRA_SOURCES}


# --------------------------------------------------------------------------- #
# 遍历基元
# --------------------------------------------------------------------------- #

def _iter_graphs(narrative: Any) -> Iterator[dict[str, Any]]:
    if not isinstance(narrative, dict):
        return
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            yield main
        for el in comp.get("elements") or []:
            if isinstance(el, dict) and isinstance(el.get("graph"), dict):
                yield el["graph"]
    for graph in narrative.get("graphs") or []:  # legacy 顶层图
        if isinstance(graph, dict):
            yield graph


def _derived_signal_keys(narrative: Any) -> set[str]:
    out: set[str] = set()
    for graph in _iter_graphs(narrative):
        gid = str(graph.get("id") or "").strip()
        states = graph.get("states")
        if not gid or not isinstance(states, dict):
            continue
        for sid, state in states.items():
            if isinstance(state, dict) and state.get("broadcastOnEnter") is True:
                out.add(f"{_DERIVED_PREFIX}{gid}:{sid}")
    return out


def _iter_collection(root: Any) -> Iterator[tuple[str, Any]]:
    """把 dict / list 集合统一成 (item_id, node) 迭代（用于 usage 归属与 per-item 标脏）。"""
    if isinstance(root, dict):
        for key, value in root.items():
            yield str(key), value
    elif isinstance(root, list):
        for idx, row in enumerate(root):
            item_id = ""
            if isinstance(row, dict):
                item_id = str(row.get("id") or "").strip()
            yield item_id or f"[{idx}]", row


def _count_emit_refs(node: Any, signal_id: str) -> int:
    count = 0
    if isinstance(node, dict):
        if str(node.get("type") or "").strip() == "emitNarrativeSignal":
            params = node.get("params")
            if isinstance(params, dict) and str(params.get("signal") or "").strip() == signal_id:
                count += 1
        for value in node.values():
            count += _count_emit_refs(value, signal_id)
    elif isinstance(node, list):
        for child in node:
            count += _count_emit_refs(child, signal_id)
    return count


def _replace_emit_refs(node: Any, old_id: str, new_id: str) -> int:
    count = 0
    if isinstance(node, dict):
        if str(node.get("type") or "").strip() == "emitNarrativeSignal":
            params = node.get("params")
            if isinstance(params, dict) and str(params.get("signal") or "").strip() == old_id:
                params["signal"] = new_id
                count += 1
        for value in node.values():
            count += _replace_emit_refs(value, old_id, new_id)
    elif isinstance(node, list):
        for child in node:
            count += _replace_emit_refs(child, old_id, new_id)
    return count


def _remove_emit_actions(node: Any, signal_id: str, path: list[Any], removed: list[dict[str, Any]]) -> None:
    """从任意嵌套结构里摘除匹配的 emitNarrativeSignal 动作（只摘 list 里的成员——动作
    永远住在动作列表里；dict 值位置的 emit 结构不摘、只可能出现在非法数据里）。
    removed 按摘除顺序记录 {path, index, action}，撤销时**逆序**回放 insert 即可复原。"""
    if isinstance(node, dict):
        for key, value in node.items():
            _remove_emit_actions(value, signal_id, [*path, key], removed)
    elif isinstance(node, list):
        idx = 0
        while idx < len(node):
            child = node[idx]
            is_match = (
                isinstance(child, dict)
                and str(child.get("type") or "").strip() == "emitNarrativeSignal"
                and isinstance(child.get("params"), dict)
                and str(child["params"].get("signal") or "").strip() == signal_id
            )
            if is_match:
                removed.append({"path": list(path), "index": idx, "action": node.pop(idx)})
                continue  # 同位新成员，不前进
            _remove_emit_actions(child, signal_id, [*path, idx], removed)
            idx += 1


def _path_get(root: Any, path: list[Any]) -> Any:
    node = root
    for step in path:
        node = node[step]
    return node


# --------------------------------------------------------------------------- #
# 对话图文件面（磁盘 + 暂存）
# --------------------------------------------------------------------------- #

def _dialogue_graph_ids(model: Any) -> list[str]:
    ids: set[str] = set()
    dialogues_path = getattr(model, "dialogues_path", None)
    if dialogues_path is not None:
        graphs_dir = Path(dialogues_path) / "graphs"
        if graphs_dir.is_dir():
            ids.update(p.stem for p in graphs_dir.glob("*.json"))
    ids.update(getattr(model, "pending_dialogue_graph_edits", {}).keys())
    ids.update(getattr(model, "pending_dialogue_stubs", {}).keys())
    return sorted(ids)


def _load_dialogue_doc(model: Any, gid: str) -> dict[str, Any] | None:
    """按暂存优先级取对话图文档：既有文件的暂存编辑 > 模板盖章的新桩 > 磁盘。"""
    pending_edits = getattr(model, "pending_dialogue_graph_edits", {})
    if gid in pending_edits and isinstance(pending_edits[gid], dict):
        return pending_edits[gid]
    stubs = getattr(model, "pending_dialogue_stubs", {})
    if gid in stubs and isinstance(stubs[gid], dict):
        return stubs[gid]
    dialogues_path = getattr(model, "dialogues_path", None)
    if dialogues_path is None:
        return None
    path = Path(dialogues_path) / "graphs" / f"{gid}.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _stage_dialogue_doc(model: Any, gid: str, doc: dict[str, Any]) -> str:
    """把改过的对话图文档放回正确的暂存面并标脏；返回实际用的脏桶名。"""
    stubs = getattr(model, "pending_dialogue_stubs", {})
    if gid in stubs:
        stubs[gid] = doc
        model.mark_dirty("dialogue_stubs")
        return "dialogue_stubs"
    model.pending_dialogue_graph_edits[gid] = doc
    model.mark_dirty("dialogue_graph_edits")
    return "dialogue_graph_edits"


# --------------------------------------------------------------------------- #
# 扫描（scan）
# --------------------------------------------------------------------------- #

def scan_signal_usages(model: Any, signal_id: str) -> dict[str, Any]:
    """列出一个作者信号的全项目使用点（重构预览用），不做任何修改。"""
    sid = str(signal_id or "").strip()
    narrative = getattr(model, "narrative_graphs", None) or {}

    registry_index = -1
    for idx, row in enumerate(narrative.get("signals") or []):
        if isinstance(row, dict) and str(row.get("id") or "").strip() == sid:
            registry_index = idx
            break

    listeners: list[dict[str, str]] = []
    action_emits = 0
    for graph in _iter_graphs(narrative):
        gid = str(graph.get("id") or "").strip()
        for tr in graph.get("transitions") or []:
            if isinstance(tr, dict) and str(tr.get("signal") or "").strip() == sid:
                listeners.append({"graphId": gid, "transitionId": str(tr.get("id") or "")})
        states = graph.get("states")
        if isinstance(states, dict):
            action_emits += _count_emit_refs(states, sid)

    meta_emits: list[dict[str, str]] = []
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            if not isinstance(el, dict):
                continue
            emits = (el.get("meta") or {}).get("emits") if isinstance(el.get("meta"), dict) else None
            if isinstance(emits, list) and any(str(s) == sid for s in emits):
                meta_emits.append({"compositionId": str(comp.get("id") or ""), "elementId": str(el.get("id") or "")})

    dialogues: list[dict[str, Any]] = []
    for gid in _dialogue_graph_ids(model):
        doc = _load_dialogue_doc(model, gid)
        if doc is None:
            continue
        count = _count_emit_refs(doc, sid)
        if count:
            dialogues.append({"graphId": gid, "count": count})

    assets: list[dict[str, Any]] = []
    for attr, (bucket, _per_item) in EMIT_SOURCE_BUCKETS.items():
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _iter_collection(root):
            count = _count_emit_refs(node, sid)
            if count:
                assets.append({"bucket": bucket, "attr": attr, "itemId": item_id, "count": count})

    total = (
        len(listeners)
        + action_emits
        + len(meta_emits)
        + sum(d["count"] for d in dialogues)
        + sum(a["count"] for a in assets)
    )
    return {
        "signalId": sid,
        "registryIndex": registry_index,
        "listeners": listeners,
        "actionEmits": action_emits,
        "metaEmits": meta_emits,
        "dialogues": dialogues,
        "assets": assets,
        "totalRefs": total,
    }


# --------------------------------------------------------------------------- #
# 改名（rename）
# --------------------------------------------------------------------------- #

def _validate_rename_ids(model: Any, old_id: str, new_id: str) -> None:
    narrative = getattr(model, "narrative_graphs", None) or {}
    if not old_id or not new_id:
        raise SignalRefactorError("信号 id 不能为空")
    if old_id == new_id:
        raise SignalRefactorError("新旧 id 相同")
    if new_id == _DRAFT_SIGNAL or new_id.startswith(_DERIVED_PREFIX):
        raise SignalRefactorError(f"非法信号 id：{new_id!r}（保留名 / 派生信号命名空间）")
    rows = narrative.get("signals") or []
    if not any(isinstance(r, dict) and str(r.get("id") or "").strip() == old_id for r in rows):
        raise SignalRefactorError(f"信号 {old_id!r} 不在注册表（signals）里，只有作者信号可重构")
    if any(isinstance(r, dict) and str(r.get("id") or "").strip() == new_id for r in rows):
        raise SignalRefactorError(f"信号 {new_id!r} 已存在")
    if new_id in _derived_signal_keys(narrative):
        raise SignalRefactorError(f"信号 {new_id!r} 与派生广播信号撞名")


def rename_signal(model: Any, old_id: str, new_id: str) -> dict[str, Any]:
    """全项目级联改名；返回逐通道计数摘要。任何校验失败在修改前抛 SignalRefactorError。"""
    old = str(old_id or "").strip()
    new = str(new_id or "").strip()
    _validate_rename_ids(model, old, new)

    narrative = model.narrative_graphs
    summary: dict[str, Any] = {"op": "rename", "oldId": old, "newId": new}

    # 1) narrative_graphs：注册表 / transition / 图内动作 / meta.emits
    for row in narrative.get("signals") or []:
        if isinstance(row, dict) and str(row.get("id") or "").strip() == old:
            row["id"] = new
    transitions = 0
    for graph in _iter_graphs(narrative):
        for tr in graph.get("transitions") or []:
            if isinstance(tr, dict) and str(tr.get("signal") or "").strip() == old:
                tr["signal"] = new
                transitions += 1
    action_emits = 0
    for graph in _iter_graphs(narrative):
        states = graph.get("states")
        if isinstance(states, dict):
            action_emits += _replace_emit_refs(states, old, new)
    meta_emits = 0
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            if not isinstance(el, dict) or not isinstance(el.get("meta"), dict):
                continue
            emits = el["meta"].get("emits")
            if isinstance(emits, list):
                for i, s in enumerate(emits):
                    if str(s) == old:
                        emits[i] = new
                        meta_emits += 1
    model.mark_dirty("narrative_graphs")
    summary["narrative"] = {"transitions": transitions, "actionEmits": action_emits, "metaEmits": meta_emits}

    # 2) 内容资产内存集合
    asset_hits: list[dict[str, Any]] = []
    for attr, (bucket, per_item) in EMIT_SOURCE_BUCKETS.items():
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _iter_collection(root):
            count = _replace_emit_refs(node, old, new)
            if not count:
                continue
            asset_hits.append({"bucket": bucket, "itemId": item_id, "count": count})
            model.mark_dirty(bucket, item_id if per_item else "")
    summary["assets"] = asset_hits

    # 3) 对话图（磁盘 → 暂存编辑面）
    dialogue_hits: list[dict[str, Any]] = []
    for gid in _dialogue_graph_ids(model):
        doc = _load_dialogue_doc(model, gid)
        if doc is None:
            continue
        working = copy.deepcopy(doc)
        count = _replace_emit_refs(working, old, new)
        if not count:
            continue
        bucket = _stage_dialogue_doc(model, gid, working)
        dialogue_hits.append({"graphId": gid, "count": count, "bucket": bucket})
    summary["dialogues"] = dialogue_hits
    return summary


# --------------------------------------------------------------------------- #
# 删除（delete）——记录精确反向编辑供撤销
# --------------------------------------------------------------------------- #

def delete_signal(model: Any, signal_id: str, force: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """删除作者信号。

    无引用：只删注册表行。有引用且 force=True：监听 transition 置 ``__draft__``、
    发射动作从动作列表摘除、meta.emits 摘除，注册表行删除。返回 (summary, reverse_ops)，
    reverse_ops 逆序回放（undo_delete）即可精确复原。
    """
    sid = str(signal_id or "").strip()
    usages = scan_signal_usages(model, sid)
    if usages["registryIndex"] < 0:
        raise SignalRefactorError(f"信号 {sid!r} 不在注册表（signals）里")
    refs = usages["totalRefs"]
    if refs and not force:
        raise SignalRefactorError(f"信号 {sid!r} 仍有 {refs} 处引用；确认走强制清理（force）才可删除")

    narrative = model.narrative_graphs
    reverse_ops: list[dict[str, Any]] = []
    summary: dict[str, Any] = {"op": "delete", "signalId": sid, "cleaned": refs}

    # 1) 监听 transition → __draft__
    for graph in _iter_graphs(narrative):
        gid = str(graph.get("id") or "").strip()
        for tr in graph.get("transitions") or []:
            if isinstance(tr, dict) and str(tr.get("signal") or "").strip() == sid:
                tr["signal"] = _DRAFT_SIGNAL
                reverse_ops.append({
                    "kind": "transitionSignal", "graphId": gid,
                    "transitionId": str(tr.get("id") or ""), "signal": sid,
                })

    # 2) 图内发射动作摘除
    for graph in _iter_graphs(narrative):
        states = graph.get("states")
        if isinstance(states, dict):
            removed: list[dict[str, Any]] = []
            _remove_emit_actions(states, sid, [], removed)
            for rec in removed:
                reverse_ops.append({
                    "kind": "actionInsert", "target": "narrativeStates",
                    "graphId": str(graph.get("id") or ""), **rec,
                })

    # 3) meta.emits 摘除（整表快照复原）
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            if not isinstance(el, dict) or not isinstance(el.get("meta"), dict):
                continue
            emits = el["meta"].get("emits")
            if isinstance(emits, list) and any(str(s) == sid for s in emits):
                reverse_ops.append({
                    "kind": "metaEmits", "compositionId": str(comp.get("id") or ""),
                    "elementId": str(el.get("id") or ""), "emits": list(emits),
                })
                el["meta"]["emits"] = [s for s in emits if str(s) != sid]

    # 4) 注册表行删除
    rows = narrative.get("signals") or []
    idx = usages["registryIndex"]
    reverse_ops.append({"kind": "registry", "index": idx, "row": copy.deepcopy(rows[idx])})
    del rows[idx]
    model.mark_dirty("narrative_graphs")

    # 5) 内容资产发射动作摘除
    for attr, (bucket, per_item) in EMIT_SOURCE_BUCKETS.items():
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _iter_collection(root):
            removed = []
            _remove_emit_actions(node, sid, [], removed)
            if not removed:
                continue
            model.mark_dirty(bucket, item_id if per_item else "")
            for rec in removed:
                reverse_ops.append({
                    "kind": "actionInsert", "target": "asset", "attr": attr,
                    "bucket": bucket, "itemId": item_id, "perItem": per_item, **rec,
                })

    # 6) 对话图：整文档快照复原（对话图不在别处被本会话编辑，整档回滚最稳）
    for gid in _dialogue_graph_ids(model):
        doc = _load_dialogue_doc(model, gid)
        if doc is None or not _count_emit_refs(doc, sid):
            continue
        pending_edits = getattr(model, "pending_dialogue_graph_edits", {})
        stubs = getattr(model, "pending_dialogue_stubs", {})
        prev_state = (
            {"surface": "edits", "doc": copy.deepcopy(pending_edits[gid])} if gid in pending_edits
            else {"surface": "stubs", "doc": copy.deepcopy(stubs[gid])} if gid in stubs
            else {"surface": "disk"}
        )
        working = copy.deepcopy(doc)
        removed = []
        _remove_emit_actions(working, sid, [], removed)
        _stage_dialogue_doc(model, gid, working)
        reverse_ops.append({"kind": "dialogueDoc", "graphId": gid, "prev": prev_state})

    return summary, reverse_ops


# --------------------------------------------------------------------------- #
# 条件叶子 / setNarrativeState 的跨文件走访（状态名 / 图 id 重构共用）
# --------------------------------------------------------------------------- #

def _walk_narrative_refs(node: Any, visit) -> int:
    """深度遍历任意结构，对 {narrative:str, state:str} 条件叶子与
    type=='setNarrativeState' 的动作调用 visit(kind, obj)，返回 visit 命中计数之和。
    visit 返回 1 表示命中（计数/已替换），0 表示不匹配。"""
    count = 0
    if isinstance(node, dict):
        if isinstance(node.get("narrative"), str) and isinstance(node.get("state"), str):
            count += visit("leaf", node)
        if str(node.get("type") or "").strip() == "setNarrativeState":
            params = node.get("params")
            if isinstance(params, dict):
                count += visit("setState", params)
        for value in node.values():
            count += _walk_narrative_refs(value, visit)
    elif isinstance(node, list):
        for child in node:
            count += _walk_narrative_refs(child, visit)
    return count


def _state_ref_visitor(gid: str, sid: str, new_sid: str | None):
    """sid 引用的计数/替换 visitor（new_sid=None 只计数）。narrative 字段必须精确等于
    图 id 才算命中；@owner/@scene 相对 token 静态解析不了，刻意不动（扫描单独报出）。"""
    def visit(kind: str, obj: dict[str, Any]) -> int:
        if kind == "leaf":
            if str(obj.get("narrative") or "").strip() == gid and str(obj.get("state") or "").strip() == sid:
                if new_sid is not None:
                    obj["state"] = new_sid
                return 1
        else:  # setState params
            if str(obj.get("graphId") or "").strip() == gid and str(obj.get("stateId") or "").strip() == sid:
                if new_sid is not None:
                    obj["stateId"] = new_sid
                return 1
        return 0
    return visit


def _graph_ref_visitor(gid: str, new_gid: str | None):
    def visit(kind: str, obj: dict[str, Any]) -> int:
        key = "narrative" if kind == "leaf" else "graphId"
        if str(obj.get(key) or "").strip() == gid:
            if new_gid is not None:
                obj[key] = new_gid
            return 1
        return 0
    return visit


def _apply_over_sources(model: Any, visitor) -> list[dict[str, Any]]:
    """把 visitor 跑遍 narrative 之外的全部内容集合与对话图（含暂存面），返回命中清单并标脏。"""
    hits: list[dict[str, Any]] = []
    for attr, (bucket, per_item) in CONDITION_SOURCES.items():
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _iter_collection(root):
            count = _walk_narrative_refs(node, visitor)
            if not count:
                continue
            hits.append({"bucket": bucket, "itemId": item_id, "count": count})
            model.mark_dirty(bucket, item_id if per_item else "")
    for gid_dlg in _dialogue_graph_ids(model):
        doc = _load_dialogue_doc(model, gid_dlg)
        if doc is None:
            continue
        working = copy.deepcopy(doc)
        count = _walk_narrative_refs(working, visitor)
        if not count:
            continue
        bucket = _stage_dialogue_doc(model, gid_dlg, working)
        hits.append({"bucket": bucket, "itemId": gid_dlg, "count": count})
    return hits


def _count_over_sources(model: Any, visitor) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for attr, (bucket, _per_item) in CONDITION_SOURCES.items():
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _iter_collection(root):
            count = _walk_narrative_refs(node, visitor)
            if count:
                hits.append({"bucket": bucket, "itemId": item_id, "count": count})
    for gid_dlg in _dialogue_graph_ids(model):
        doc = _load_dialogue_doc(model, gid_dlg)
        if doc is not None:
            count = _walk_narrative_refs(doc, visitor)
            if count:
                hits.append({"bucket": "dialogue", "itemId": gid_dlg, "count": count})
    return hits


def _migrations_snapshot(model: Any) -> Any:
    mig = (model.narrative_graphs or {}).get("migrations")
    return copy.deepcopy(mig) if mig is not None else None


def _restore_migrations(model: Any, snapshot: Any) -> None:
    narrative = model.narrative_graphs
    if snapshot is None:
        narrative.pop("migrations", None)
    else:
        narrative["migrations"] = copy.deepcopy(snapshot)


def _drop_identity(mapping: dict[str, str]) -> None:
    for key in [k for k, v in mapping.items() if k == v]:
        del mapping[key]


# --------------------------------------------------------------------------- #
# 状态名重构（rename_state）
# --------------------------------------------------------------------------- #

def scan_state_usages(model: Any, graph_id: str, state_id: str) -> dict[str, Any]:
    gid, sid = str(graph_id or "").strip(), str(state_id or "").strip()
    narrative = getattr(model, "narrative_graphs", None) or {}
    derived_key = f"{_DERIVED_PREFIX}{gid}:{sid}"
    internal = 0
    derived_listeners: list[dict[str, str]] = []
    for graph in _iter_graphs(narrative):
        g_id = str(graph.get("id") or "").strip()
        for tr in graph.get("transitions") or []:
            if not isinstance(tr, dict):
                continue
            if str(tr.get("signal") or "").strip() == derived_key:
                derived_listeners.append({"graphId": g_id, "transitionId": str(tr.get("id") or "")})
            if g_id == gid and (str(tr.get("from") or "") == sid or str(tr.get("to") or "") == sid):
                internal += 1
    narrative_conditions = _walk_narrative_refs(narrative, _state_ref_visitor(gid, sid, None))
    external = _count_over_sources(model, _state_ref_visitor(gid, sid, None))
    total = internal + len(derived_listeners) + narrative_conditions + sum(h["count"] for h in external)
    return {
        "graphId": gid, "stateId": sid,
        "internalEndpoints": internal,
        "derivedListeners": derived_listeners,
        "narrativeConditions": narrative_conditions,
        "external": external,
        "totalRefs": total,
    }


def rename_state(
    model: Any, graph_id: str, old_state: str, new_state: str, *, update_migrations: bool = True,
) -> dict[str, Any]:
    """全项目级联改状态名，自动登记存档迁移映射（migrations.states，撤销时由日志恢复快照）。"""
    gid = str(graph_id or "").strip()
    old = str(old_state or "").strip()
    new = str(new_state or "").strip()
    narrative = model.narrative_graphs
    target = next((g for g in _iter_graphs(narrative) if str(g.get("id") or "").strip() == gid), None)
    if target is None:
        raise SignalRefactorError(f"叙事图 {gid!r} 不存在")
    states = target.get("states")
    if not isinstance(states, dict) or old not in states:
        raise SignalRefactorError(f"图 {gid!r} 没有状态 {old!r}")
    if not new or new == old:
        raise SignalRefactorError("新状态名为空或与旧名相同")
    if new in states:
        raise SignalRefactorError(f"图 {gid!r} 已有状态 {new!r}")

    # 图内：states 键序保真重建 + state.id + initialState/entryState/exitStates + 端点
    rebuilt: dict[str, Any] = {}
    for key, value in states.items():
        if key == old:
            if isinstance(value, dict) and "id" in value:
                value["id"] = new
            rebuilt[new] = value
        else:
            rebuilt[key] = value
    target["states"] = rebuilt
    if target.get("initialState") == old:
        target["initialState"] = new
    if target.get("entryState") == old:
        target["entryState"] = new
    if isinstance(target.get("exitStates"), list):
        target["exitStates"] = [new if s == old else s for s in target["exitStates"]]
    endpoints = 0
    for tr in target.get("transitions") or []:
        if not isinstance(tr, dict):
            continue
        if tr.get("from") == old:
            tr["from"] = new
            endpoints += 1
        if tr.get("to") == old:
            tr["to"] = new
            endpoints += 1

    # 派生广播信号监听（全部图）
    old_key, new_key = f"{_DERIVED_PREFIX}{gid}:{old}", f"{_DERIVED_PREFIX}{gid}:{new}"
    derived = 0
    for graph in _iter_graphs(narrative):
        for tr in graph.get("transitions") or []:
            if isinstance(tr, dict) and str(tr.get("signal") or "").strip() == old_key:
                tr["signal"] = new_key
                derived += 1

    # 条件叶子 / setNarrativeState（narrative 自身 + 全部内容集合 + 对话图）
    narrative_refs = _walk_narrative_refs(narrative, _state_ref_visitor(gid, old, new))
    external = _apply_over_sources(model, _state_ref_visitor(gid, old, new))

    if update_migrations:
        mig = narrative.setdefault("migrations", {}).setdefault("states", {}).setdefault(gid, {})
        for key, value in list(mig.items()):
            if value == old:
                mig[key] = new
        mig[old] = new
        _drop_identity(mig)
    model.mark_dirty("narrative_graphs")
    return {
        "op": "renameState", "graphId": gid, "oldStateId": old, "newStateId": new,
        "internalEndpoints": endpoints, "derivedListeners": derived,
        "narrativeConditions": narrative_refs, "external": external,
    }


# --------------------------------------------------------------------------- #
# 图 id 重构（rename_graph）
# --------------------------------------------------------------------------- #

def scan_graph_usages(model: Any, graph_id: str) -> dict[str, Any]:
    gid = str(graph_id or "").strip()
    narrative = getattr(model, "narrative_graphs", None) or {}
    prefix = f"{_DERIVED_PREFIX}{gid}:"
    derived = 0
    reads = 0
    for graph in _iter_graphs(narrative):
        for tr in graph.get("transitions") or []:
            if isinstance(tr, dict) and str(tr.get("signal") or "").strip().startswith(prefix):
                derived += 1
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            meta = el.get("meta") if isinstance(el, dict) else None
            if isinstance(meta, dict) and isinstance(meta.get("reads"), list):
                reads += sum(1 for r in meta["reads"] if str(r) == gid)
    narrative_conditions = _walk_narrative_refs(narrative, _graph_ref_visitor(gid, None))
    external = _count_over_sources(model, _graph_ref_visitor(gid, None))
    total = derived + reads + narrative_conditions + sum(h["count"] for h in external)
    return {
        "graphId": gid, "derivedListeners": derived, "metaReads": reads,
        "narrativeConditions": narrative_conditions, "external": external, "totalRefs": total,
    }


def rename_graph(model: Any, old_graph_id: str, new_graph_id: str, *, update_migrations: bool = True) -> dict[str, Any]:
    """全项目级联改叙事图 id，自动登记存档迁移映射（migrations.graphs + states 外层键跟随）。"""
    old = str(old_graph_id or "").strip()
    new = str(new_graph_id or "").strip()
    narrative = model.narrative_graphs
    targets = [g for g in _iter_graphs(narrative) if str(g.get("id") or "").strip() == old]
    if not targets:
        raise SignalRefactorError(f"叙事图 {old!r} 不存在")
    if not new or new == old:
        raise SignalRefactorError("新图 id 为空或与旧 id 相同")
    if any(str(g.get("id") or "").strip() == new for g in _iter_graphs(narrative)):
        raise SignalRefactorError(f"叙事图 id {new!r} 已存在")

    for graph in targets:
        graph["id"] = new
        # flow 图常以自身 id 作 owner 绑定；精确等值才跟随，其它 owner 类型（npc/hotspot…）不动
        if str(graph.get("ownerType") or "") == "flow" and str(graph.get("ownerId") or "") == old:
            graph["ownerId"] = new

    prefix_old = f"{_DERIVED_PREFIX}{old}:"
    derived = 0
    for graph in _iter_graphs(narrative):
        for tr in graph.get("transitions") or []:
            if not isinstance(tr, dict):
                continue
            sig = str(tr.get("signal") or "").strip()
            if sig.startswith(prefix_old):
                tr["signal"] = f"{_DERIVED_PREFIX}{new}:{sig[len(prefix_old):]}"
                derived += 1
    reads = 0
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            meta = el.get("meta") if isinstance(el, dict) else None
            if isinstance(meta, dict) and isinstance(meta.get("reads"), list):
                for i, r in enumerate(meta["reads"]):
                    if str(r) == old:
                        meta["reads"][i] = new
                        reads += 1

    narrative_refs = _walk_narrative_refs(narrative, _graph_ref_visitor(old, new))
    external = _apply_over_sources(model, _graph_ref_visitor(old, new))

    if update_migrations:
        mig_root = narrative.setdefault("migrations", {})
        graphs_map = mig_root.setdefault("graphs", {})
        for key, value in list(graphs_map.items()):
            if value == old:
                graphs_map[key] = new
        graphs_map[old] = new
        _drop_identity(graphs_map)
        states_map = mig_root.get("states")
        if isinstance(states_map, dict) and old in states_map:
            states_map[new] = states_map.pop(old)
    model.mark_dirty("narrative_graphs")
    return {
        "op": "renameGraph", "oldGraphId": old, "newGraphId": new,
        "derivedListeners": derived, "metaReads": reads,
        "narrativeConditions": narrative_refs, "external": external,
    }


# --------------------------------------------------------------------------- #
# 共享撤销日志（挂在 ProjectModel 上：web 桥与 PyQt 信号管理器同一份）
# --------------------------------------------------------------------------- #

JOURNAL_ATTR = "narrative_refactor_journal"
_JOURNAL_CAP = 20


def push_journal(model: Any, entry: dict[str, Any]) -> int:
    journal = getattr(model, JOURNAL_ATTR, None)
    if journal is None:
        journal = []
        setattr(model, JOURNAL_ATTR, journal)
    journal.append(entry)
    del journal[:-_JOURNAL_CAP]
    return len(journal)


def journal_size(model: Any) -> int:
    return len(getattr(model, JOURNAL_ATTR, None) or [])


def undo_last(model: Any) -> dict[str, Any]:
    """撤销最近一次重构。改名类=反向改名（migrations 恢复执行前快照）；删除=反向编辑回放。"""
    journal = getattr(model, JOURNAL_ATTR, None) or []
    if not journal:
        return {"ok": False, "reason": "没有可撤销的重构操作"}
    entry = journal[-1]
    op = entry.get("op")
    try:
        if op == "rename":
            rename_signal(model, entry["newId"], entry["oldId"])
            desc = f"已撤销信号改名 {entry['oldId']} → {entry['newId']}"
        elif op == "delete":
            undo_delete(model, entry.get("reverseOps") or [])
            desc = f"已撤销信号删除 {entry['signalId']}"
        elif op == "renameState":
            rename_state(model, entry["graphId"], entry["newStateId"], entry["oldStateId"], update_migrations=False)
            _restore_migrations(model, entry.get("migrationsSnapshot"))
            desc = f"已撤销状态改名 {entry['graphId']}.{entry['oldStateId']} → {entry['newStateId']}"
        elif op == "renameGraph":
            rename_graph(model, entry["newGraphId"], entry["oldGraphId"], update_migrations=False)
            _restore_migrations(model, entry.get("migrationsSnapshot"))
            desc = f"已撤销图改名 {entry['oldGraphId']} → {entry['newGraphId']}"
        else:
            return {"ok": False, "reason": f"未知重构操作 {op!r}"}
    except SignalRefactorError as exc:
        return {"ok": False, "reason": f"撤销失败（数据已变化）：{exc}"}
    except Exception as exc:  # noqa: BLE001 - 撤销边界统一软失败
        return {"ok": False, "reason": f"撤销失败：{exc}"}
    journal.pop()
    return {"ok": True, "description": desc, "journalSize": len(journal)}


def undo_delete(model: Any, reverse_ops: list[dict[str, Any]]) -> None:
    """逆序回放 delete_signal 的反向编辑，精确复原（含重新标脏）。"""
    narrative = model.narrative_graphs
    graphs_by_id = {str(g.get("id") or "").strip(): g for g in _iter_graphs(narrative)}
    narrative_touched = False
    for op in reversed(reverse_ops):
        kind = op.get("kind")
        if kind == "registry":
            rows = narrative.setdefault("signals", [])
            rows.insert(min(int(op["index"]), len(rows)), copy.deepcopy(op["row"]))
            narrative_touched = True
        elif kind == "transitionSignal":
            graph = graphs_by_id.get(op["graphId"])
            for tr in (graph or {}).get("transitions") or []:
                if isinstance(tr, dict) and str(tr.get("id") or "") == op["transitionId"]:
                    tr["signal"] = op["signal"]
            narrative_touched = True
        elif kind == "metaEmits":
            for comp in narrative.get("compositions") or []:
                if not isinstance(comp, dict) or str(comp.get("id") or "") != op["compositionId"]:
                    continue
                for el in comp.get("elements") or []:
                    if isinstance(el, dict) and str(el.get("id") or "") == op["elementId"] and isinstance(el.get("meta"), dict):
                        el["meta"]["emits"] = list(op["emits"])
            narrative_touched = True
        elif kind == "actionInsert":
            if op.get("target") == "narrativeStates":
                graph = graphs_by_id.get(op["graphId"])
                root = (graph or {}).get("states")
                narrative_touched = True
            else:
                collection = getattr(model, op["attr"], None)
                root = None
                for item_id, node in _iter_collection(collection):
                    if item_id == op["itemId"]:
                        root = node
                        break
                if root is not None:
                    model.mark_dirty(op["bucket"], op["itemId"] if op.get("perItem") else "")
            if root is not None:
                container = _path_get(root, op["path"])
                if isinstance(container, list):
                    container.insert(min(int(op["index"]), len(container)), copy.deepcopy(op["action"]))
        elif kind == "dialogueDoc":
            gid = op["graphId"]
            prev = op.get("prev") or {}
            surface = prev.get("surface")
            pending_edits = getattr(model, "pending_dialogue_graph_edits", {})
            stubs = getattr(model, "pending_dialogue_stubs", {})
            if surface == "edits":
                pending_edits[gid] = copy.deepcopy(prev["doc"])
                model.mark_dirty("dialogue_graph_edits")
            elif surface == "stubs":
                stubs[gid] = copy.deepcopy(prev["doc"])
                model.mark_dirty("dialogue_stubs")
            else:  # 原本只在磁盘：撤掉暂存编辑即回到磁盘原文
                pending_edits.pop(gid, None)
    if narrative_touched:
        model.mark_dirty("narrative_graphs")
