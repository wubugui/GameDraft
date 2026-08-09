"""场景实体 → 叙事状态机模板**批量**盖章（编辑器专用；本模块纯逻辑，不碰 Qt）。

由来：100 个箱子各要一张 wrapper 图，但只该有**一个**私有信号名和**一张**发射端对话图
（私有信号语义见 ``src/core/NarrativeStateManager.ts`` 的 ``NarrativeSignalDef.scope``：
按发射方 owner 定向投递，只进该 owner 自己的 wrapper 图）。手建 100 张图不可行，所以入口
放在**场景编辑器**（摆箱子时顺手绑）：多选实体 → 应用状态机模板 → 每个实体盖一份，
``id`` / ``ownerId`` 由实体推导（模板参数用 ``from: entity.id`` 声明这层绑定）。

硬契约（与单张盖章同一条，见 agent_docs/editor-tools/mechanisms/narrative-template-system.md）：

- **全有全无**：``plan_batch_stamp`` 在内存里把 N 份产物合并 + 过一遍保存期校验，
  全通过才由 ``apply_batch_stamp`` 一次性暂存进 ProjectModel；任一份出错 = 一份都不落。
- **零磁盘写**：本模块只 ``mark_dirty``，落盘只经主编辑器 Save All（对话桩走
  ``ProjectModel.pending_dialogue_stubs``，脏桶键是单数 ``"quest"``——踩过复数键无声丢数据）。
- **批内互撞也算撞**：已存在 id 集合逐份累加，两个实体推出同一个作曲 id 会在第二份上报错，
  而不是静默盖出两条同 id 的作曲。
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

from .narrative_templates import (
    PARAM_SOURCES,
    PRODUCT_DIALOGUE_STUBS,
    PRODUCT_QUEST,
    attach_stamp_provenance,
    normalize_templates_file,
    stamp_template,
    template_produces,
)

#: 可批量盖章的场景实体类型（与 wrapper owner 索引的裸 id 口径一致）。
#: spawn / group 不在内：运行时不给它们建 owner 索引，盖出来的 wrapper 永远收不到信号。
BATCH_ENTITY_KINDS: tuple[str, ...] = ("npc", "hotspot", "zone")

_SCENE_COLLECTION_KEY = {"npc": "npcs", "hotspot": "hotspots", "zone": "zones"}


def _as_str(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def entity_label(kind: str, entity: Any) -> str:
    """实体显示名：NPC 用 name、热点用 label、都没有就退回裸 id（永不返回空）。"""
    eid = _as_str((entity or {}).get("id")) if isinstance(entity, dict) else ""
    if not isinstance(entity, dict):
        return eid
    for key in ("name", "label", "title"):
        text = _as_str(entity.get(key))
        if text:
            return text
    return eid


def scene_entity_targets(
    model: Any, scene_id: str, refs: Iterable[tuple[str, str]],
) -> list[dict[str, Any]]:
    """把场景编辑器的 ``(kind, entityId)`` 选中集转成盖章目标。

    只收 ``BATCH_ENTITY_KINDS``、且在该场景数据里真找得到的实体——树里选中的
    spawn / group 直接落地丢掉（调用方据数量差提示），不能让它们盖出无主 wrapper。

    顺序按**场景数据里的实体顺序**，不按选中顺序：Qt 的 ``selectedItems()`` 顺序未定义，
    跟着它走会让同一次选择在不同机器上盖出不同的作曲排列，凭空制造 JSON diff。
    重复 ref 会被去重，但**同一实体被列两次的场景**（调用方自己传重）交给盖章期撞名去报。
    """
    scene = (getattr(model, "scenes", None) or {}).get(_as_str(scene_id))
    if not isinstance(scene, dict):
        return []
    wanted: set[tuple[str, str]] = set()
    for raw_kind, raw_id in refs or []:
        kind = _as_str(raw_kind)
        eid = _as_str(raw_id)
        if kind in BATCH_ENTITY_KINDS and eid:
            wanted.add((kind, eid))
    out: list[dict[str, Any]] = []
    for kind in BATCH_ENTITY_KINDS:
        for row in scene.get(_SCENE_COLLECTION_KEY[kind]) or []:
            if not isinstance(row, dict):
                continue
            eid = _as_str(row.get("id"))
            if not eid or (kind, eid) not in wanted:
                continue
            out.append({
                "kind": kind,
                "id": eid,
                "label": entity_label(kind, row),
                "sceneId": _as_str(scene_id),
            })
    return out


def entity_derived_values(target: dict[str, Any]) -> dict[str, str]:
    """一个盖章目标能提供的来源令牌（键与 ``narrative_templates.PARAM_SOURCES`` 对齐）。"""
    return {
        "entity.id": _as_str(target.get("id")),
        "entity.kind": _as_str(target.get("kind")),
        "entity.label": _as_str(target.get("label")) or _as_str(target.get("id")),
        "scene.id": _as_str(target.get("sceneId")),
    }


def bound_param_names(tpl: Any) -> dict[str, str]:
    """``{参数名: 来源令牌}``：这些参数由实体现推，不该出现在批量表单里。"""
    out: dict[str, str] = {}
    for p in (tpl or {}).get("params") or [] if isinstance(tpl, dict) else []:
        if not isinstance(p, dict):
            continue
        name = _as_str(p.get("name"))
        source = _as_str(p.get("from"))
        if name and source:
            out[name] = source
    return out


def free_params(tpl: Any) -> list[dict[str, Any]]:
    """需要策划手填的参数（填一次、盖 N 份）。"""
    bound = bound_param_names(tpl)
    return [
        p for p in ((tpl or {}).get("params") or [] if isinstance(tpl, dict) else [])
        if isinstance(p, dict) and _as_str(p.get("name")) and _as_str(p.get("name")) not in bound
    ]


def resolve_target_values(
    tpl: Any, shared_values: dict[str, Any], target: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """共享表单值 + 该实体推导值 → 这一份的参数字典。返回 ``(values, 错误文案)``。

    来源绑定优先级最高：表单里若混进同名键也被实体值覆盖（绑定了就是绑定了，
    不能让一个隐藏的表单残值把 100 份 ownerId 全盖成同一个）。
    """
    derived = entity_derived_values(target)
    values = dict(shared_values or {})
    errors: list[str] = []
    for name, source in bound_param_names(tpl).items():
        if source not in PARAM_SOURCES:
            errors.append(f"参数「{name}」的来源「{source}」未知（可选：{'、'.join(PARAM_SOURCES)}）")
            continue
        resolved = derived.get(source, "")
        if not resolved:
            errors.append(f"实体「{target.get('id')}」推不出参数「{name}」的来源「{source}」")
            continue
        values[name] = resolved
    return values, errors


def _existing_dialogue_ids(model: Any) -> set[str]:
    ids = {_as_str(g) for g in (getattr(model, "all_dialogue_graph_ids", lambda: [])() or [])}
    ids |= {_as_str(k) for k in (getattr(model, "pending_dialogue_stubs", None) or {})}
    ids.discard("")
    return ids


def plan_batch_stamp(
    model: Any,
    template_id: str,
    targets: list[dict[str, Any]],
    shared_values: dict[str, Any] | None = None,
    *,
    generate_dialogue_stubs: bool = False,
    validate: Callable[[dict[str, Any], Any], list[dict[str, Any]]] | None = None,
    normalize: Callable[[Any], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """演算一次批量盖章：纯计算，**对 model 零副作用**（预览与确认共用同一份结果）。

    ``validate`` / ``normalize`` 默认取叙事编辑器保存路径那两个（同一道门，不另起一套口径），
    注入点只为测试与解耦。返回
    ``{ok, errors, warnings, items, narrative, quests, stubs, produces}``。
    """
    if normalize is None or validate is None:
        # 延迟导入：本模块要能在没有 QtWebEngine 的环境里被纯逻辑测试直接 import。
        from ..editors.narrative_state_editor import (  # noqa: PLC0415
            _normalize_file,
            _validation_errors_for_save,
        )
        normalize = normalize or _normalize_file
        validate = validate or _validation_errors_for_save

    errors: list[str] = []
    warnings: list[str] = []
    tid = _as_str(template_id)
    templates = normalize_templates_file(getattr(model, "narrative_templates", None))["templates"]
    tpl = next((t for t in templates if _as_str(t.get("id")) == tid), None)
    if tpl is None:
        return {"ok": False, "errors": [f"模板「{tid}」不存在"], "warnings": [], "items": []}
    if not targets:
        return {"ok": False, "errors": ["没有可盖章的实体（只支持 NPC / 热点 / Zone）"],
                "warnings": [], "items": []}

    produces = template_produces(tpl)
    current = normalize(getattr(model, "narrative_graphs", None))
    merged = normalize(current)
    merged.setdefault("compositions", [])
    merged.setdefault("signals", [])
    if not isinstance(merged["compositions"], list):
        merged["compositions"] = []
    if not isinstance(merged["signals"], list):
        merged["signals"] = []

    # 撞名基线逐份累加：批内两个实体推出同一个 id 也必须被判成撞名。
    existing_comp = {_as_str(c.get("id")) for c in merged["compositions"] if isinstance(c, dict)}
    existing_comp.discard("")
    existing_quest = {q[0] for q in (getattr(model, "all_quest_ids", lambda: [])() or [])}
    existing_dlg = _existing_dialogue_ids(model)
    existing_sig = {_as_str(s.get("id")) for s in merged["signals"] if isinstance(s, dict)}
    existing_sig.discard("")
    # id → 行内容：让 stamp 能做「内容相同 = 幂等注册」的判定（共享私有信号批量盖章的关键，
    # 否则模板声明的 `taken` 在第 2 个实体就撞名、整批作废——终审 H5）。
    existing_sig_rows = {
        _as_str(s.get("id")): s for s in merged["signals"]
        if isinstance(s, dict) and _as_str(s.get("id"))
    }

    items: list[dict[str, Any]] = []
    quests: list[dict[str, Any]] = []
    stubs: dict[str, dict[str, Any]] = {}

    for target in targets:
        values, verr = resolve_target_values(tpl, shared_values or {}, target)
        if verr:
            errors.extend(verr)
            continue
        result = stamp_template(
            tpl, values,
            existing_composition_ids=existing_comp,
            existing_quest_ids=existing_quest,
            existing_dialogue_ids=existing_dlg,
            existing_signal_ids=existing_sig,
            existing_signal_rows=existing_sig_rows,
            generate_dialogue_stubs=generate_dialogue_stubs,
        )
        label = f"{target.get('kind')}:{target.get('id')}"
        if not result.get("ok"):
            errors.extend(
                f"{label}：{_as_str(e.get('message'))}" for e in result.get("errors", [])
            )
            continue
        warnings.extend(
            f"{label}：{_as_str(w.get('message'))}" for w in result.get("warnings", [])
        )

        composition = attach_stamp_provenance(result["composition"], result.get("provenance"))
        merged["compositions"].append(composition)
        existing_comp.add(_as_str(result.get("compositionId")))
        for sig in result.get("signals", []):
            sid = _as_str(sig.get("id")) if isinstance(sig, dict) else ""
            if sid and sid not in existing_sig:
                merged["signals"].append(sig)
                existing_sig.add(sid)
                # 行内容也进映射：批内第 2 份起对同一条信号做幂等判定（内容相同跳过）
                existing_sig_rows[sid] = sig

        quest_obj = result.get("quest")
        if PRODUCT_QUEST in produces and isinstance(quest_obj, dict) and result.get("questId"):
            quests.append(quest_obj)
            existing_quest.add(_as_str(result.get("questId")))

        staged_stubs: list[str] = []
        skipped_stubs: list[str] = []
        if generate_dialogue_stubs and PRODUCT_DIALOGUE_STUBS in produces:
            for stub in result.get("dialogueStubs", []):
                gid = _as_str(stub.get("id"))
                if not gid:
                    continue
                if stub.get("exists") or gid in existing_dlg:
                    skipped_stubs.append(gid)
                    continue
                stubs[gid] = stub.get("graph") or {}
                existing_dlg.add(gid)
                staged_stubs.append(gid)

        items.append({
            "target": target,
            "compositionId": _as_str(result.get("compositionId")),
            "questId": _as_str(result.get("questId")),
            "signals": [_as_str(s.get("id")) for s in result.get("signals", []) if isinstance(s, dict)],
            "stubsStaged": staged_stubs,
            "stubsSkipped": skipped_stubs,
        })

    if errors:
        # 全有全无：任何一份不成立就整批作废，绝不"能盖几份是几份"（半批产物无人认领，
        # 且第二次重跑会在已盖那几份上撞名，越修越乱）。
        return {"ok": False, "errors": errors, "warnings": warnings, "items": items,
                "produces": produces}

    merged_norm = normalize(merged)
    nerrors = validate(merged_norm, model)
    if nerrors:
        return {
            "ok": False,
            "errors": [
                "合并后作曲校验失败（未写入任何东西）：" + _as_str(e.get("message") or e.get("code"))
                for e in nerrors[:8]
            ],
            "warnings": warnings,
            "items": items,
            "produces": produces,
        }
    return {
        "ok": True,
        "errors": [],
        "warnings": warnings,
        "items": items,
        "narrative": merged_norm,
        "quests": quests,
        "stubs": stubs,
        "produces": produces,
    }


def apply_batch_stamp(model: Any, plan: dict[str, Any]) -> dict[str, Any]:
    """把演算好的产物一次性暂存进 ProjectModel（零磁盘写；落盘只经 Save All）。

    ``plan`` 必须是 ``plan_batch_stamp`` 的成功结果——不成立的计划原样退回，不做半批写入。
    """
    if not plan or not plan.get("ok"):
        return plan or {"ok": False, "errors": ["无可应用的盖章计划"]}
    model.narrative_graphs = plan["narrative"]
    model.mark_dirty("narrative_graphs")

    quests = plan.get("quests") or []
    if quests:
        if not isinstance(getattr(model, "quests", None), list):
            model.quests = []
        model.quests.extend(quests)
        # 脏桶键是单数 "quest"：标错键 = Save All 不写文件却清脏标记，暂存内容无声丢失。
        model.mark_dirty("quest")

    stubs = plan.get("stubs") or {}
    if stubs:
        for gid, graph in stubs.items():
            model.pending_dialogue_stubs[gid] = graph
        model.mark_dirty("dialogue_stubs")

    return {
        "ok": True,
        "compositions": [item["compositionId"] for item in plan.get("items", [])],
        "quests": [_as_str(q.get("id")) for q in quests],
        "stubs": sorted(stubs),
        "warnings": plan.get("warnings", []),
    }
