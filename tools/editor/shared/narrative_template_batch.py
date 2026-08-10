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
    substitute,
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


def _total_state_count(composition: Any) -> int:
    """一份作曲里所有图（主图 + 内嵌子图）的状态键总数。

    用来发现"代入实体后状态键重名被合并"——dict 后写覆盖先写，状态凭空少一个、
    转移塌成自环，而盖章 ok=True 零警告。只数主图会漏掉 wrapper 元素里的同型塌陷。
    """
    total = 0

    def walk(node: Any) -> None:
        nonlocal total
        if isinstance(node, dict):
            states = node.get("states")
            if isinstance(states, dict):
                total += len(states)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(composition)
    return total


def _scene_entity_row(model: Any, scene_id: str, kind: str, entity_id: str) -> dict[str, Any] | None:
    """在 model 里定位实体行本体（返回的是同一个 dict 对象，改它就是改模型）。"""
    scene = (getattr(model, "scenes", None) or {}).get(_as_str(scene_id))
    if not isinstance(scene, dict):
        return None
    for row in scene.get(_SCENE_COLLECTION_KEY.get(kind, "")) or []:
        if isinstance(row, dict) and _as_str(row.get("id")) == _as_str(entity_id):
            return row
    return None


def _has_authored_conditions(row: dict[str, Any]) -> bool:
    """这一行是不是「已经有作者写的显隐条件」。

    判据刻意**不要求它是合法的 list**：坏值（dict / 字符串 / 数字）同样算"有"。
    照 list 判会把坏值当空、直接覆盖掉作者的东西——编辑器对空集合与数组坏元素一律
    只读透传、绝不改写（editor-tools norms）。
    """
    existing = row.get("conditions")
    if existing is None:
        return False
    if isinstance(existing, (list, dict, str)):
        return len(existing) > 0
    return True


def _visibility_patch(
    model: Any, target: dict[str, Any], composition_id: str, visible_state: str,
) -> dict[str, Any] | None:
    """算一条「把实体显隐接到它自己那张图」的补丁；实体已有条件则返回 None（不覆盖作者编排）。"""
    kind = _as_str(target.get("kind"))
    row = _scene_entity_row(model, target.get("sceneId"), kind, _as_str(target.get("id")))
    if row is None or _has_authored_conditions(row):
        return None
    patch = {
        "sceneId": _as_str(target.get("sceneId")),
        "kind": kind,
        "entityId": _as_str(target.get("id")),
        "conditions": [{"narrative": composition_id, "state": visible_state}],
    }
    # conditionHidesEntity 只有 HotspotDef / NpcDef 有（src/data/types.ts）；
    # 往 zone 上写 = 运行时不认的垃圾键，还会污染字节级往返。
    if kind in ("hotspot", "npc"):
        patch["conditionHidesEntity"] = True
    return patch


def plan_batch_stamp(
    model: Any,
    template_id: str,
    targets: list[dict[str, Any]],
    shared_values: dict[str, Any] | None = None,
    *,
    generate_dialogue_stubs: bool = False,
    visible_state: str = "",
    validate: Callable[[dict[str, Any], Any], list[dict[str, Any]]] | None = None,
    normalize: Callable[[Any], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """演算一次批量盖章：纯计算，**对 model 零副作用**（预览与确认共用同一份结果）。

    ``visible_state`` 非空 = 顺带把每个实体自己的显隐条件接到它自己那张图上
    （``conditions=[{narrative: <本份作曲>, state: <visible_state>}]`` + ``conditionHidesEntity``）。
    不接的话策划盖完 20 张图还要回场景编辑器手填 20 次条件，模板省下的活原样赔回去。
    只在**实体当前没有 conditions** 时接——已有条件是作者手写的编排，绝不覆盖。

    ``validate`` / ``normalize`` 默认取叙事编辑器保存路径那两个（同一道门，不另起一套口径），
    注入点只为测试与解耦。返回
    ``{ok, errors, warnings, items, narrative, quests, stubs, produces, entityPatches}``。
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
    # 落地时要跟这份基线对账：plan 产出的是**整份** narrative 快照，直接盖回模型会把
    # plan 之后别处新加的图/信号一起抹掉。实体侧已有 vanished 闸，这里是对称的那一半。
    baseline_narrative = {
        "compositionIds": sorted(existing_comp),
        "signalIds": sorted(
            {_as_str(s.get("id")) for s in merged["signals"] if isinstance(s, dict)} - {""},
        ),
    }
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
    entity_patches: list[dict[str, Any]] = []
    already_stamped: list[str] = []

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
            for err in result.get("errors", []):
                # 撞名在批量语境下要给**能执行的**动作：这里的 ownerId 是实体推导来的、改不了，
                # 引擎那句「换个 ownerId」等于没说。真正的动作是把已盖过的实体取消勾选。
                if _as_str(err.get("code")) == "stamp.collision.composition":
                    already_stamped.append(label)
                    continue
                errors.append(f"{label}：{_as_str(err.get('message'))}")
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

        comp_id = _as_str(result.get("compositionId"))
        # 状态键替换后互撞（骨架里参数化键与硬编码键并存，代入某个实体后重名）：
        # dict 后写覆盖先写，状态凭空少一个、转移变自环，ok=True 零警告。
        # 必须数**全部图**（含内嵌子图）——只数 mainGraph 会漏掉 wrapper 元素里的同型塌陷。
        skeleton_count = _total_state_count(tpl.get("composition"))
        stamped_count = _total_state_count(composition)
        if stamped_count < skeleton_count:
            lost = skeleton_count - stamped_count
            errors.append(
                f"{label}：代入这个实体后有 {lost} 个状态重名被合并了"
                f"（模板 {skeleton_count} 个 → 盖出 {stamped_count} 个）"
                f"——检查骨架里是不是同时有参数化状态名和写死的状态名",
            )
            continue
        wired = ""
        if visible_state:
            states = ((composition.get("mainGraph") or {}).get("states") or {})
            # 状态 id 自己也可能带占位符（`{{ownerId}}_出现`——抽取会把实体 id 从状态键里
            # 一起挖走）。下拉给的是**骨架**键，这里比的是**盖出来**的键，所以得先做同一次替换，
            # 否则每一项都点不通、整批恒被拦，而骨架只读、没有出口。
            resolved_state, _unknown = substitute(visible_state, values)
            resolved_state = _as_str(resolved_state)
            if resolved_state not in states:
                errors.append(
                    f"{label}：模板的图里没有状态「{visible_state}」"
                    + (f"（代入本实体后是「{resolved_state}」）" if resolved_state != visible_state else "")
                    + f"，接不了显隐条件（有的是：{'、'.join(sorted(states)) or '无'}）",
                )
            else:
                patch = _visibility_patch(model, target, comp_id, resolved_state)
                if patch is None:
                    warnings.append(f"{label}：已有自己的显隐条件，未改动（模板只接空白的）")
                else:
                    entity_patches.append(patch)
                    wired = resolved_state

        items.append({
            "target": target,
            "compositionId": comp_id,
            "questId": _as_str(result.get("questId")),
            "signals": [_as_str(s.get("id")) for s in result.get("signals", []) if isinstance(s, dict)],
            "stubsStaged": staged_stubs,
            "stubsSkipped": skipped_stubs,
            "visibilityWiredTo": wired,
        })

    if already_stamped:
        # 聚成一条，并给出真正能做的动作（逐条「换个 ownerId」在批量里是死路：
        # ownerId 是实体推导来的、改不了）。两种成因都要说，因为动作完全不同。
        errors.insert(0, (
            f"这 {len(already_stamped)} 个实体的作曲 id 已存在：{'、'.join(already_stamped)}\n"
            f"  · 如果是之前盖过：在实体树里把它们取消勾选，只盖还没盖过的\n"
            f"  · 如果是别的场景有同名实体：运行时按**裸 id** 建 owner 索引，"
            f"同名 = 同一个 owner、本来就该共用这一张图；真要各自独立，先给其中一个改名"
        ))

    if errors:
        # 全有全无：任何一份不成立就整批作废，绝不"能盖几份是几份"（半批产物无人认领，
        # 且第二次重跑会在已盖那几份上撞名，越修越乱）。
        return {"ok": False, "errors": errors, "warnings": warnings, "items": items,
                "produces": produces, "alreadyStamped": already_stamped}

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
        "entityPatches": entity_patches,
        "baselineNarrative": baseline_narrative,
    }


def apply_batch_stamp(model: Any, plan: dict[str, Any]) -> dict[str, Any]:
    """把演算好的产物一次性暂存进 ProjectModel（零磁盘写；落盘只经 Save All）。

    ``plan`` 必须是 ``plan_batch_stamp`` 的成功结果——不成立的计划原样退回，不做半批写入。
    """
    if not plan or not plan.get("ok"):
        return plan or {"ok": False, "errors": ["无可应用的盖章计划"]}

    # 落地前重新对一遍现实：plan 是纯计算，算完到确认之间实体可能被改名/删除
    # （对话框开着时另一头照样能改）。任一目标不在了就整批不写——否则会给一个
    # 已经不存在的实体暂存一张无主 wrapper 图，而弹窗照报"已暂存 N 份"。
    vanished = [
        f"{_as_str(t.get('kind'))}:{_as_str(t.get('id'))}"
        for t in (item.get("target") or {} for item in plan.get("items") or [])
        if _scene_entity_row(model, t.get("sceneId"), _as_str(t.get("kind")), _as_str(t.get("id"))) is None
    ]
    if vanished:
        return {
            "ok": False,
            "errors": [
                f"这些实体在盖章前被改名或删除了：{'、'.join(vanished)}"
                "——什么都没写入，请关掉对话框重新选一次",
            ],
            "warnings": plan.get("warnings", []),
        }

    # 作曲/信号侧同样要对账：plan 产出的是整份 narrative 快照，若这中间别处新加了图或
    # 注册了信号（另一个工具、另一条命令），直接盖回去就把人家的东西抹了。
    baseline = plan.get("baselineNarrative")
    if isinstance(baseline, dict):
        now = getattr(model, "narrative_graphs", None) or {}
        now_comp = sorted(
            {_as_str(c.get("id")) for c in (now.get("compositions") or []) if isinstance(c, dict)} - {""},
        )
        now_sig = sorted(
            {_as_str(s.get("id")) for s in (now.get("signals") or []) if isinstance(s, dict)} - {""},
        )
        drifted = [
            *(f"作曲 {i}" for i in sorted(set(now_comp) ^ set(baseline.get("compositionIds") or []))),
            *(f"信号 {i}" for i in sorted(set(now_sig) ^ set(baseline.get("signalIds") or []))),
        ]
        if drifted:
            return {
                "ok": False,
                "errors": [
                    f"叙事数据在这中间被改过了（{'、'.join(drifted[:6])}"
                    f"{f' 等 {len(drifted)} 处' if len(drifted) > 6 else ''}）"
                    "——什么都没写入，请关掉对话框重新算一次，否则会把这些改动一起抹掉",
                ],
                "warnings": plan.get("warnings", []),
            }

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

    # 显隐条件补丁：只写「本来没有 conditions」的实体（plan 期已判定），逐场景标脏。
    # 脏桶键是单数 "scene" + scene_id——标错键 = Save All 不写文件却清脏标记，改动无声丢失。
    wired: list[str] = []
    missed_gone: list[str] = []
    missed_authored: list[str] = []
    for patch in plan.get("entityPatches") or []:
        row = _scene_entity_row(model, patch["sceneId"], patch["kind"], patch["entityId"])
        if row is None:
            # 上面的 vanished 闸已拦过整批，这里是兜底：宁可落空也绝不按位置写到别人身上。
            missed_gone.append(f"{patch['kind']}:{patch['entityId']}")
            continue
        # **落地这一刻**再判一次"有没有作者条件"：plan 算完之后作者可能刚写上，
        # 照 plan 期的判断盲写 = 把人家刚写的编排覆盖掉（契约是绝不覆盖）。
        if _has_authored_conditions(row):
            missed_authored.append(f"{patch['kind']}:{patch['entityId']}")
            continue
        row["conditions"] = patch["conditions"]
        if "conditionHidesEntity" in patch:
            row["conditionHidesEntity"] = patch["conditionHidesEntity"]
        model.mark_dirty("scene", patch["sceneId"])
        wired.append(f"{patch['kind']}:{patch['entityId']}")

    return {
        "ok": True,
        "compositions": [item["compositionId"] for item in plan.get("items", [])],
        "quests": [_as_str(q.get("id")) for q in quests],
        "stubs": sorted(stubs),
        "warnings": [
            *plan.get("warnings", []),
            # 两种落空原因分开说：抬头与括号自相矛盾时人只会更糊涂。
            *([f"显隐条件没接上（实体已不在场景里）：{'、'.join(missed_gone)}"] if missed_gone else []),
            *([f"显隐条件没接上（这中间已被写入条件，未覆盖）：{'、'.join(missed_authored)}"]
              if missed_authored else []),
        ],
        "visibilityWired": wired,
        "visibilityMissed": [*missed_gone, *missed_authored],
    }
