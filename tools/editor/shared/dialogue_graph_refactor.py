"""对话图资产的全项目引用扫描与暂存重构。

本模块与 ``entity_refactor`` / ``signal_refactor`` 同一契约：重命名只修改
``ProjectModel`` 内存并标记脏桶，文件写入与旧文件删除统一交给
``ProjectModel.save_all`` 的两阶段交易。任一前置校验/重写失败都恢复内存
快照与原脏态，不留「新图+旧引用」或「旧图被删+内存尚在」的半状态。

入站引用面（扫描与 rename 共用同一走访器）：
- 场景 NPC ``dialogueGraphId/dialogueGraphEntry``；
- 热点 ``data.graphId/entry`` 与兼容形状 ``dialogueGraphId/dialogueGraphEntry``；
- 全部可保存内容域及对话图内的 ``startDialogueGraph.params.graphId/entry``；
- ``scenarios[].dialogueGraphIds``；
- 叙事编排 ``dialogueBlackbox.refId``。

删除采 fail-safe：任何外部入站引用存在时拒绝，并返回可定位清单；
无引用时也只记入 ``pending_dialogue_graph_deletes``，不立即 unlink。
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from .dialogue_graph_refs import dialogue_graph_document, dialogue_graph_ids


class DialogueGraphRefactorError(ValueError):
    """对话图重构被拒绝；异常抛出时模型和磁盘均未改变。"""

    def __init__(self, message: str, *, usages: list[dict[str, Any]] | None = None):
        super().__init__(message)
        self.usages = list(usages or [])


# ProjectModel 中可能容纳 Action 树的业务数据面。对话图文件另行扫描。
# 第三列表示是否按 dict 成员 id 增量标脏（场景单独处理）。
_ACTION_SOURCE_BUCKETS: tuple[tuple[str, str], ...] = (
    ("game_config", "config"),
    ("items", "item"),
    ("quests", "quest"),
    ("quest_groups", "questGroup"),
    ("encounters", "encounter"),
    ("rules_data", "rules"),
    ("shops", "shop"),
    ("map_nodes", "map"),
    ("cutscenes", "cutscene"),
    ("archive_characters", "archive"),
    ("archive_lore", "archive"),
    ("archive_books", "archive"),
    ("archive_documents", "archive"),
    ("scenarios_catalog", "scenarios"),
    ("narrative_graphs", "narrative_graphs"),
    ("narrative_packages", "narrative_packages"),
    ("document_reveals", "document_reveals"),
    ("smell_profiles", "smell_profiles"),
    ("pressure_holds", "pressure_holds"),
    ("signal_cues", "signal_cues"),
    ("planes", "planes"),
    ("water_minigames_instances", "water_minigames"),
    ("sugar_wheel_instances", "sugar_wheel"),
    ("paper_craft_instances", "paper_craft"),
    # 该新域只在 ProjectModel 已登记对应脏桶时参与重写，防止
    # 扫到后无法经统一保存出口落盘。
    ("object_examine_instances", "object_examine"),
)


def _walk_start_dialogue_actions(
    node: Any,
    path: str,
    graph_id: str,
    visit: Callable[[dict[str, Any], str], None],
) -> None:
    if isinstance(node, dict):
        if str(node.get("type") or "").strip() == "startDialogueGraph":
            params = node.get("params")
            if isinstance(params, dict) and str(params.get("graphId") or "").strip() == graph_id:
                visit(params, f"{path}.params.graphId")
        for key, value in node.items():
            _walk_start_dialogue_actions(value, f"{path}.{key}", graph_id, visit)
    elif isinstance(node, list):
        for idx, value in enumerate(node):
            _walk_start_dialogue_actions(value, f"{path}[{idx}]", graph_id, visit)


def _append_usage(
    out: list[dict[str, Any]], *, kind: str, owner: str, path: str,
    entry: object = "", source_graph_id: str = "",
) -> None:
    hit: dict[str, Any] = {"kind": kind, "owner": owner, "path": path}
    ent = str(entry or "").strip()
    if ent:
        hit["entry"] = ent
    if source_graph_id:
        hit["sourceGraphId"] = source_graph_id
    out.append(hit)


def _scan_scene_usages(model: Any, gid: str, out: list[dict[str, Any]]) -> None:
    scenes = getattr(model, "scenes", None)
    if not isinstance(scenes, dict):
        return
    for sid, scene in scenes.items():
        if not isinstance(scene, dict):
            continue
        for ni, npc in enumerate(scene.get("npcs") or []):
            if not isinstance(npc, dict):
                continue
            if str(npc.get("dialogueGraphId") or "").strip() == gid:
                _append_usage(
                    out, kind="npc", owner=f"scene:{sid}/npc:{npc.get('id') or ni}",
                    path=f"scenes[{sid}].npcs[{ni}].dialogueGraphId",
                    entry=npc.get("dialogueGraphEntry"),
                )
        for hi, hotspot in enumerate(scene.get("hotspots") or []):
            if not isinstance(hotspot, dict):
                continue
            data = hotspot.get("data")
            if not isinstance(data, dict):
                continue
            howner = f"scene:{sid}/hotspot:{hotspot.get('id') or hi}"
            for graph_key, entry_key in (
                ("graphId", "entry"),
                ("dialogueGraphId", "dialogueGraphEntry"),
            ):
                if str(data.get(graph_key) or "").strip() == gid:
                    _append_usage(
                        out, kind="hotspot", owner=howner,
                        path=f"scenes[{sid}].hotspots[{hi}].data.{graph_key}",
                        entry=data.get(entry_key),
                    )
        _walk_start_dialogue_actions(
            scene, f"scenes[{sid}]", gid,
            lambda params, path, sid=sid: _append_usage(
                out, kind="action", owner=f"scene:{sid}", path=path,
                entry=params.get("entry"),
            ),
        )


def _scan_scenario_usages(model: Any, gid: str, out: list[dict[str, Any]]) -> None:
    catalog = getattr(model, "scenarios_catalog", None)
    rows = catalog.get("scenarios") if isinstance(catalog, dict) else None
    for si, row in enumerate(rows or []):
        if not isinstance(row, dict):
            continue
        for gi, value in enumerate(row.get("dialogueGraphIds") or []):
            if str(value or "").strip() == gid:
                _append_usage(
                    out, kind="scenario", owner=f"scenario:{row.get('id') or si}",
                    path=f"scenarios[{si}].dialogueGraphIds[{gi}]",
                )


def _scan_narrative_blackboxes(model: Any, gid: str, out: list[dict[str, Any]]) -> None:
    narrative = getattr(model, "narrative_graphs", None)
    comps = narrative.get("compositions") if isinstance(narrative, dict) else None
    for ci, comp in enumerate(comps or []):
        if not isinstance(comp, dict):
            continue
        for ei, element in enumerate(comp.get("elements") or []):
            if not isinstance(element, dict):
                continue
            if element.get("kind") == "dialogueBlackbox" \
                    and str(element.get("refId") or "").strip() == gid:
                _append_usage(
                    out, kind="narrative", owner=f"composition:{comp.get('id') or ci}",
                    path=f"narrative_graphs.compositions[{ci}].elements[{ei}].refId",
                )


def _iter_action_sources(
    model: Any, *, include_unwritable: bool = False,
) -> Iterator[tuple[str, str, Any, bool]]:
    known = set(getattr(model, "KNOWN_DIRTY_BUCKETS", ()))
    for attr, bucket in _ACTION_SOURCE_BUCKETS:
        writable = bucket in known
        if not writable and not include_unwritable:
            continue
        root = getattr(model, attr, None)
        if root is not None:
            yield attr, bucket, root, writable


def scan_dialogue_graph_usages(
    model: Any, graph_id: str, *, include_self_graph: bool = False,
) -> list[dict[str, Any]]:
    """返回引用 ``graph_id`` 的全项目入站位置（只读，稳定顺序）。

    ``include_self_graph=False`` 会忽略待删图自身内的递归跳转；它随源图
    一起消失，不是删除后的悬垂入站引用。
    """
    gid = str(graph_id or "").strip()
    if not gid:
        return []
    out: list[dict[str, Any]] = []
    _scan_scene_usages(model, gid, out)
    _scan_scenario_usages(model, gid, out)
    _scan_narrative_blackboxes(model, gid, out)

    # scenes/scenarios/narrative 已上面扫过 Action，这里跳过它们避免重复报告。
    explicit_attrs = {"scenes", "scenarios_catalog", "narrative_graphs"}
    for attr, _bucket, root, writable in _iter_action_sources(model, include_unwritable=True):
        if attr in explicit_attrs:
            continue
        _walk_start_dialogue_actions(
            root, attr, gid,
            lambda params, path, attr=attr, writable=writable: _append_usage(
                out, kind="action" if writable else "action-unwritable",
                owner=attr, path=path, entry=params.get("entry"),
            ),
        )
    # narrative/scenarios 内的 Action 也必须扫（上面只扫了它们的显式引用）。
    for attr in ("scenarios_catalog", "narrative_graphs"):
        root = getattr(model, attr, None)
        if root is None:
            continue
        _walk_start_dialogue_actions(
            root, attr, gid,
            lambda params, path, attr=attr: _append_usage(
                out, kind="action", owner=attr, path=path, entry=params.get("entry"),
            ),
        )

    for source_gid in dialogue_graph_ids(model):
        if source_gid == gid and not include_self_graph:
            continue
        doc = dialogue_graph_document(model, source_gid)
        if not isinstance(doc, dict):
            continue
        _walk_start_dialogue_actions(
            doc, f"dialogueGraphs[{source_gid}]", gid,
            lambda params, path, source_gid=source_gid: _append_usage(
                out, kind="dialogue", owner=f"dialogue:{source_gid}", path=path,
                entry=params.get("entry"), source_graph_id=source_gid,
            ),
        )
    return out


def format_dialogue_graph_usages(usages: list[dict[str, Any]], *, limit: int = 40) -> str:
    if not usages:
        return "无入站引用"
    lines: list[str] = []
    for hit in usages[:limit]:
        suffix = f"（entry={hit['entry']}）" if hit.get("entry") else ""
        lines.append(f"· {hit.get('owner')}: {hit.get('path')}{suffix}")
    if len(usages) > limit:
        lines.append(f"… 共 {len(usages)} 处，仅显示前 {limit} 处")
    return "\n".join(lines)


_TX_ATTRS = tuple(dict.fromkeys(
    ["scenes", "scenarios_catalog", "narrative_graphs", *[a for a, _b in _ACTION_SOURCE_BUCKETS]]
))


@contextmanager
def _transactional(model: Any) -> Iterator[None]:
    attrs: dict[str, Any] = {}
    for attr in _TX_ATTRS:
        if hasattr(model, attr):
            attrs[attr] = copy.deepcopy(getattr(model, attr))
    pending_attrs = (
        "pending_dialogue_stubs",
        "pending_dialogue_graph_edits",
        "pending_dialogue_graph_deletes",
    )
    pending = {
        attr: copy.deepcopy(getattr(model, attr))
        for attr in pending_attrs if hasattr(model, attr)
    }
    dirty = copy.deepcopy(getattr(model, "_dirty", set()))
    dirty_scene_ids = copy.deepcopy(getattr(model, "_dirty_scene_ids", set()))
    dirty_scenes_all = bool(getattr(model, "_dirty_scenes_all", False))
    try:
        yield
    except Exception:
        for attr, snap in attrs.items():
            setattr(model, attr, snap)
        for attr, snap in pending.items():
            setattr(model, attr, snap)
        if hasattr(model, "_dirty"):
            model._dirty = dirty
        if hasattr(model, "_dirty_scene_ids"):
            model._dirty_scene_ids = dirty_scene_ids
        if hasattr(model, "_dirty_scenes_all"):
            model._dirty_scenes_all = dirty_scenes_all
        # 异常若发生在 mark_dirty 之后，信号观察者也要看到恢复后真实脏态。
        signal = getattr(model, "dirty_changed", None)
        if signal is not None:
            try:
                signal.emit(bool(dirty))
            except Exception:
                pass
        raise


def _replace_scene_refs(model: Any, old: str, new: str) -> set[str]:
    changed_scenes: set[str] = set()
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        changed = False
        for npc in scene.get("npcs") or []:
            if isinstance(npc, dict) and str(npc.get("dialogueGraphId") or "").strip() == old:
                npc["dialogueGraphId"] = new
                changed = True
        for hotspot in scene.get("hotspots") or []:
            data = hotspot.get("data") if isinstance(hotspot, dict) else None
            if not isinstance(data, dict):
                continue
            for graph_key in ("graphId", "dialogueGraphId"):
                if str(data.get(graph_key) or "").strip() == old:
                    data[graph_key] = new
                    changed = True
        before = [False]

        def replace_action(params: dict[str, Any], _path: str) -> None:
            params["graphId"] = new
            before[0] = True

        _walk_start_dialogue_actions(scene, f"scenes[{sid}]", old, replace_action)
        if changed or before[0]:
            changed_scenes.add(str(sid))
    return changed_scenes


def _replace_scenario_refs(model: Any, old: str, new: str) -> bool:
    changed = False
    catalog = getattr(model, "scenarios_catalog", None)
    rows = catalog.get("scenarios") if isinstance(catalog, dict) else None
    for row in rows or []:
        if not isinstance(row, dict) or not isinstance(row.get("dialogueGraphIds"), list):
            continue
        old_arr = row["dialogueGraphIds"]
        arr: list[Any] = []
        seen: set[str] = set()
        for value in old_arr:
            repl = new if str(value or "").strip() == old else value
            key = str(repl)
            if key in seen:
                changed = True
                continue
            seen.add(key)
            arr.append(repl)
        if arr != old_arr:
            row["dialogueGraphIds"] = arr
            changed = True
    return changed


def _relink_scenario_from_graph_meta(model: Any, gid: str, source: dict[str, Any]) -> bool:
    """对齐图 ``meta.scenarioId`` 派生索引；用于「改归属后立即改名」的组合路径。"""
    catalog = getattr(model, "scenarios_catalog", None)
    rows = catalog.get("scenarios") if isinstance(catalog, dict) else None
    if not isinstance(rows, list):
        return False
    meta = source.get("meta") if isinstance(source.get("meta"), dict) else {}
    target_sid = str(meta.get("scenarioId") or "").strip()
    before = copy.deepcopy([row.get("dialogueGraphIds") if isinstance(row, dict) else None for row in rows])
    for row in rows:
        if not isinstance(row, dict):
            continue
        arr = row.get("dialogueGraphIds")
        if isinstance(arr, list):
            kept = [value for value in arr if str(value or "").strip() != gid]
            if kept:
                row["dialogueGraphIds"] = kept
            else:
                row.pop("dialogueGraphIds", None)
    if target_sid:
        for row in rows:
            if not isinstance(row, dict) or str(row.get("id") or "").strip() != target_sid:
                continue
            arr = row.get("dialogueGraphIds")
            vals = list(arr) if isinstance(arr, list) else []
            if gid not in [str(v or "").strip() for v in vals]:
                vals.append(gid)
            row["dialogueGraphIds"] = vals
            break
    after = [row.get("dialogueGraphIds") if isinstance(row, dict) else None for row in rows]
    return before != after


def _replace_narrative_refs(model: Any, old: str, new: str) -> bool:
    changed = False
    narrative = getattr(model, "narrative_graphs", None)
    comps = narrative.get("compositions") if isinstance(narrative, dict) else None
    for comp in comps or []:
        if not isinstance(comp, dict):
            continue
        for element in comp.get("elements") or []:
            if isinstance(element, dict) and element.get("kind") == "dialogueBlackbox" \
                    and str(element.get("refId") or "").strip() == old:
                element["refId"] = new
                changed = True
    return changed


def _replace_actions_in_source(root: Any, old: str, new: str) -> bool:
    changed = [False]

    def replace(params: dict[str, Any], _path: str) -> None:
        params["graphId"] = new
        changed[0] = True

    _walk_start_dialogue_actions(root, "root", old, replace)
    return changed[0]


def _graph_exists_on_disk(model: Any, gid: str) -> bool:
    dialogues_path = getattr(model, "dialogues_path", None)
    return bool(dialogues_path is not None and (Path(dialogues_path) / "graphs" / f"{gid}.json").is_file())


def _ensure_graph_file_baseline(model: Any, gid: str) -> None:
    """让 MainWindow 的外部修改检测覆盖暂存改名/删除的新旧目标。"""
    dialogues_path = getattr(model, "dialogues_path", None)
    baselines = getattr(model, "_file_baselines", None)
    key_fn = getattr(model, "_baseline_key", None)
    record = getattr(model, "_record_file_baseline", None)
    if dialogues_path is None or not isinstance(baselines, dict) or not callable(key_fn):
        return
    path = Path(dialogues_path) / "graphs" / f"{gid}.json"
    key = key_fn(path)
    if key in baselines:
        return
    if path.exists() and callable(record):
        record(path)
    else:
        baselines[key] = getattr(model, "_BASELINE_ABSENT", (-1, -1))


def rename_dialogue_graph(
    model: Any, old_id: str, new_id: str, *, source_document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """暂存改名并机械改写全项目入站引用；磁盘在 Save All 前零变化。"""
    old = str(old_id or "").strip()
    new = str(new_id or "").strip()
    if not old or not new:
        raise DialogueGraphRefactorError("对话图 id 不能为空")
    if old == new:
        raise DialogueGraphRefactorError("新旧对话图 id 相同")
    from .narrative_templates import _dialogue_id_error
    id_error = _dialogue_id_error(new)
    if id_error:
        raise DialogueGraphRefactorError(str(id_error))
    existing = set(dialogue_graph_ids(model))
    if old not in existing and not isinstance(source_document, dict):
        raise DialogueGraphRefactorError(f"找不到待改名对话图 {old!r}")
    if new in existing or _graph_exists_on_disk(model, new):
        raise DialogueGraphRefactorError(f"对话图 {new!r} 已存在")

    source = copy.deepcopy(source_document) if isinstance(source_document, dict) \
        else copy.deepcopy(dialogue_graph_document(model, old))
    if not isinstance(source, dict):
        raise DialogueGraphRefactorError(f"无法读取待改名对话图 {old!r}")

    usages_before = scan_dialogue_graph_usages(model, old, include_self_graph=True)
    unrewritable = [u for u in usages_before if u.get("kind") == "action-unwritable"]
    if unrewritable:
        raise DialogueGraphRefactorError(
            f"对话图 {old!r} 在尚未接入统一保存脏桶的数据域中有 "
            f"{len(unrewritable)} 处引用；无法保证改写可落盘，已拒绝改名",
            usages=unrewritable,
        )
    _ensure_graph_file_baseline(model, old)
    _ensure_graph_file_baseline(model, new)
    dirty_buckets: set[str] = set()
    dirty_scenes: set[str] = set()
    with _transactional(model):
        dirty_scenes = _replace_scene_refs(model, old, new)
        if _replace_scenario_refs(model, old, new):
            dirty_buckets.add("scenarios")
        if _relink_scenario_from_graph_meta(model, new, source):
            dirty_buckets.add("scenarios")
        if _replace_narrative_refs(model, old, new):
            dirty_buckets.add("narrative_graphs")

        for attr, bucket, root, _writable in _iter_action_sources(model):
            if attr == "scenes":
                continue
            if _replace_actions_in_source(root, old, new):
                dirty_buckets.add(bucket)

        stubs = getattr(model, "pending_dialogue_stubs")
        edits = getattr(model, "pending_dialogue_graph_edits")
        deletes = getattr(model, "pending_dialogue_graph_deletes")
        source_was_stub = old in stubs and not _graph_exists_on_disk(model, old)
        stubs.pop(old, None)
        edits.pop(old, None)

        # 重写其它对话图中的链式 startDialogueGraph。
        for source_gid in list(dialogue_graph_ids(model)):
            if source_gid == old:
                continue
            doc = copy.deepcopy(dialogue_graph_document(model, source_gid))
            if not isinstance(doc, dict) or not _replace_actions_in_source(doc, old, new):
                continue
            if source_gid in stubs and not _graph_exists_on_disk(model, source_gid):
                stubs[source_gid] = doc
                dirty_buckets.add("dialogue_stubs")
            else:
                edits[source_gid] = doc
                dirty_buckets.add("dialogue_graph_edits")

        source["id"] = new
        _replace_actions_in_source(source, old, new)  # 自身递归跳转随改名
        if source_was_stub:
            stubs[new] = source
            dirty_buckets.add("dialogue_stubs")
        else:
            edits[new] = source
            dirty_buckets.add("dialogue_graph_edits")
        if _graph_exists_on_disk(model, old):
            deletes.add(old)
            dirty_buckets.add("dialogue_graph_deletes")

        for sid in sorted(dirty_scenes):
            model.mark_dirty("scene", sid)
        for bucket in sorted(dirty_buckets):
            model.mark_dirty(bucket)

    return {
        "op": "renameDialogueGraph",
        "oldId": old,
        "newId": new,
        "usages": usages_before,
        "dirtyScenes": sorted(dirty_scenes),
        "dirtyBuckets": sorted(dirty_buckets),
    }


def delete_dialogue_graph(model: Any, graph_id: str) -> dict[str, Any]:
    """无入站引用时暂存删除；有任何引用则零修改拒绝。"""
    gid = str(graph_id or "").strip()
    if not gid:
        raise DialogueGraphRefactorError("对话图 id 不能为空")
    if gid not in set(dialogue_graph_ids(model)) and not _graph_exists_on_disk(model, gid):
        raise DialogueGraphRefactorError(f"找不到待删除对话图 {gid!r}")
    usages = scan_dialogue_graph_usages(model, gid, include_self_graph=False)
    if usages:
        raise DialogueGraphRefactorError(
            f"对话图 {gid!r} 仍有 {len(usages)} 处入站引用，已拒绝删除",
            usages=usages,
        )

    _ensure_graph_file_baseline(model, gid)

    with _transactional(model):
        stubs = getattr(model, "pending_dialogue_stubs")
        edits = getattr(model, "pending_dialogue_graph_edits")
        deletes = getattr(model, "pending_dialogue_graph_deletes")
        was_stub_only = gid in stubs and not _graph_exists_on_disk(model, gid)
        stubs.pop(gid, None)
        edits.pop(gid, None)
        if _graph_exists_on_disk(model, gid):
            deletes.add(gid)
            model.mark_dirty("dialogue_graph_deletes")
        elif was_stub_only:
            # dialogue_stubs 桶原本已脏；保留它由 Save All 安全清空暂存面。
            model.mark_dirty("dialogue_stubs")
    return {"op": "deleteDialogueGraph", "graphId": gid, "usages": []}
