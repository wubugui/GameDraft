"""Cross-data reference validator."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Any

from tools.dialogue_graph_editor.dialogue_condition_text import (
    ALWAYS as _COND_ALWAYS,
    NEVER as _COND_NEVER,
    case_verdict as _dialogue_case_verdict,
)

from .file_io import read_json
from .shared.character_dialogue import resolve_npc_dialogue_graph
from .shared.dialogue_entry_overrides import (
    collect_dialogue_graph_entry_overrides,
    graph_entry_roots,
)
from .shared.cutscene_action_allowlist_io import cutscene_action_allowlist_frozenset
from .shared.move_entity_map_picker import normalize_move_entity_waypoints
from .shared.item_tags import is_known_item_tag
from .shared.audio_library import audio_id_problem
from .shared.narrative_catalog import emitted_signal_ids
from .shared.project_paths import URL_KIND_MEDIA
from .shared.runtime_field_schema import field_meta, is_valid_field, value_matches_field

if TYPE_CHECKING:
    from .project_model import ProjectModel

@dataclass
class Issue:
    severity: str  # "error" | "warning"
    data_type: str
    item_id: str
    message: str


# 「进对话时改不改朝向」的四档；权威在 src/data/types.ts 的 DialogueFacing。
# NPC 与 hotspot 共用同一组值（缺省不同：NPC=player、hotspot=keep，缺省档不写键）。
_DIALOGUE_FACING_VALUES = ("keep", "left", "right", "player")


def _entity_cutscene_bindings(ent: dict) -> list[str]:
    out: list[str] = []
    def add(raw: object) -> None:
        cid = str(raw or "").strip()
        if cid and cid not in out:
            out.append(cid)
    ids = ent.get("cutsceneIds")
    if ids is not None and not isinstance(ids, list):
        return out
    for raw in ids or []:
        add(raw)
    return out


def _anim_bundle_id_from_ref(raw: object) -> str:
    """把 NPC.animFile 归一为动画包目录名（id）。

    现有数据里 animFile 多为完整 manifest URL ``/resources/runtime/animation/<id>/anim.json``，
    少数可能直接是裸 id。两种都解析出 ``<id>``；其它形态返回空串（不误报）。
    与 :meth:`ProjectModel.animation_state_names_for_manifest` 的取段方式保持一致。
    """
    s = str(raw or "").strip()
    if not s:
        return ""
    marker = "/resources/runtime/animation/"
    if s.startswith(marker):
        return s[len(marker):].split("/", 1)[0]
    if "/" not in s:  # 裸 id
        return s
    return ""


def validate(model: ProjectModel) -> list[Issue]:
    issues: list[Issue] = []
    from .shared.ref_validator import REF_WARNING_PREFIX, validate_all_embedded_refs

    # 载入期被静默修正/丢弃的数据异常（重复 id 后者覆盖等）：不冒出来的话，
    # 模型里已看不到原始问题、validator 之后永远发现不了。
    for msg in getattr(model, "load_anomalies", None) or []:
        issues.append(Issue("warning", "load", "project", str(msg)))

    for i, msg in enumerate(validate_all_embedded_refs(model)):
        # warning 面（如 [clue:] 未闭合/多余闭合）：ref_validator 用前缀标注，这里拆 severity。
        if msg.startswith(REF_WARNING_PREFIX):
            issues.append(Issue("warning", "embeddedRef", f"#{i}", msg[len(REF_WARNING_PREFIX):]))
        else:
            issues.append(Issue("error", "embeddedRef", f"#{i}", msg))
    _validate_clues_registry(model, issues)
    _validate_audio_config_ids(model, issues)
    scene_ids = set(model.all_scene_ids())
    # 用 .get 而非 it["id"]：任一条目缺 id 不该让整个 validate() KeyError 崩溃、
    # 用一条格式错误掩盖其余全部校验（审查 P2-34）。缺 id 由各自去重/结构校验单独报。
    def _ids(rows) -> set:
        return {r["id"] for r in rows if isinstance(r, dict) and "id" in r}

    item_ids = _ids(model.items)
    quest_ids = _ids(model.quests)
    encounter_ids = _ids(model.encounters)
    rule_ids = _ids(model.rules_data.get("rules", []))
    frag_ids = _ids(model.rules_data.get("fragments", []))
    cutscene_ids = _ids(model.cutscenes)
    shop_ids = _ids(model.shops)
    filter_ids = set(model.all_filter_ids())

    # 过场 index 重复 id（照 planes 样板）：运行时按 id 建表 first-wins，同名两条会
    # 静默遮蔽后者；改名亦无查重护栏（timeline_editor _add 已防撞、改名裸奔）。
    _cut_seen: set[str] = set()
    for c in model.cutscenes:
        if not isinstance(c, dict):
            continue
        _cid = str(c.get("id", "") or "").strip()
        if not _cid:
            continue
        if _cid in _cut_seen:
            issues.append(Issue(
                "error", "cutscene", _cid,
                f"过场 id 重复: {_cid!r}（cutscenes/index.json 内同名两条，运行时后者被遮蔽）",
            ))
        _cut_seen.add(_cid)

    _validate_cutscene_speakers(model, issues)
    _validate_scenarios_catalog(model, issues)

    # --- scenes ---
    for sid, sc in model.scenes.items():
        # 背景图文件名强约束：场景主背景只能叫 background.png（编辑器导入时统一迁入并命名）。
        # 名字不对运行时直接 throw 不加载，这里作为作者期硬错误提前拦截。
        bgs = sc.get("backgrounds")
        if isinstance(bgs, list) and bgs and isinstance(bgs[0], dict):
            bg0_img = str(bgs[0].get("image", "") or "")
            if bg0_img != "background.png":
                issues.append(Issue(
                    "error", "scene", sid,
                    f"背景图文件名必须是 background.png，实际为 {bg0_img!r}；"
                    f"请在场景编辑器重新导入背景图。",
                ))
        # 场景实体分组：显式定义是一等实体；旧数据仅有成员 group 标签仍兼容。
        _groups_raw = sc.get("entityGroups")
        _declared_groups: set[str] = set()
        if _groups_raw is not None and not isinstance(_groups_raw, list):
            issues.append(Issue(
                "error", "scene", sid,
                f"entityGroups 须为数组（当前 {type(_groups_raw).__name__}）",
            ))
        elif isinstance(_groups_raw, list):
            for _gi, _group in enumerate(_groups_raw):
                if not isinstance(_group, dict):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"entityGroups[{_gi}] 须为对象",
                    ))
                    continue
                _gid = str(_group.get("id") or "").strip()
                if not _gid:
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"entityGroups[{_gi}] 缺少非空 id",
                    ))
                    continue
                if ":" in _gid:
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"场景分组 id {_gid!r} 不得包含 ':'（限定引用使用 sceneId:groupId）",
                    ))
                if _gid in _declared_groups:
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"场景分组 id 重复: {_gid!r}",
                    ))
                _declared_groups.add(_gid)
                _label = _group.get("label")
                if _label is not None and not isinstance(_label, str):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"场景分组 {_gid!r} label 须为字符串（当前 {_label!r}）",
                    ))
                _conds = _group.get("conditions")
                if _conds is not None and not isinstance(_conds, list):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"场景分组 {_gid!r} conditions 须为数组",
                    ))
        # 场景内实体 id 重复：编辑器画布图元按 "kind:id" 建键互相覆盖、属性/删除按
        # id 首匹配串台（P1-26 风险面）；npc 与 hotspot 互为 emote 目标命名空间
        # （重构引擎撞名互拒同口径），跨类同 id 一并拦。zone 独立命名空间单查。
        _ent_seen: dict[str, str] = {}
        for _key, _kind in (("hotspots", "hotspot"), ("npcs", "npc")):
            for _ent in sc.get(_key, []) or []:
                if not isinstance(_ent, dict):
                    continue
                _eid = str(_ent.get("id", "") or "").strip()
                if not _eid:
                    continue
                if _eid in _ent_seen:
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"实体 id 重复: {_kind} {_eid!r} 与同场景 {_ent_seen[_eid]} 同名"
                        "（npc/hotspot 共用寻址命名空间；画布/属性/引用按 id 解析会静默串台）",
                    ))
                else:
                    _ent_seen[_eid] = f"{_kind} {_eid!r}"
        _zone_seen: set[str] = set()
        for _z in sc.get("zones", []) or []:
            if not isinstance(_z, dict):
                continue
            _zid = str(_z.get("id", "") or "").strip()
            if not _zid:
                continue
            if _zid in _zone_seen:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Zone id 重复: {_zid!r}（同场景两条，画布与 setZoneEnabled 类寻址会静默串台）",
                ))
            _zone_seen.add(_zid)
        # 实例 transform（scale/rotation，quad 级真变换）与 group 标签的形状检查。
        # warning 级：运行时对非法值容错回落缺省（scale=1/rotation=0），Python 兜底不得更严。
        import math as _math
        for _key2, _kind2 in (("hotspots", "hotspot"), ("npcs", "npc")):
            for _ent2 in sc.get(_key2, []) or []:
                if not isinstance(_ent2, dict):
                    continue
                _eid2 = str(_ent2.get("id", "") or "").strip() or "?"
                _sv = _ent2.get("scale")
                if _sv is not None and (
                    not isinstance(_sv, (int, float)) or isinstance(_sv, bool)
                    or not _math.isfinite(float(_sv)) or float(_sv) <= 0
                ):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"{_kind2} '{_eid2}' scale 须为正有限数（当前 {_sv!r}；运行时按 1 回落）",
                    ))
                _rv = _ent2.get("rotation")
                if _rv is not None and (
                    not isinstance(_rv, (int, float)) or isinstance(_rv, bool)
                    or not _math.isfinite(float(_rv))
                ):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"{_kind2} '{_eid2}' rotation 须为有限数（度；当前 {_rv!r}；运行时按 0 回落）",
                    ))
                # 遮挡混合系数：运行时对非有限值回落场景默认、对越界值钳到 [0,1]，故 warning 级（兜底不严于运行时）
                _ob = _ent2.get("occlusionBlendFactor")
                if _ob is not None and (
                    not isinstance(_ob, (int, float)) or isinstance(_ob, bool)
                    or not _math.isfinite(float(_ob)) or not (0.0 <= float(_ob) <= 1.0)
                ):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"{_kind2} '{_eid2}' occlusionBlendFactor 须为 [0,1] 有限数"
                        f"（当前 {_ob!r}；运行时非有限→场景默认、越界→钳制）",
                    ))
                _gv = _ent2.get("group")
                if _gv is not None and (not isinstance(_gv, str) or not _gv.strip()):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"{_kind2} '{_eid2}' group 须为非空字符串标签（当前 {_gv!r}）",
                    ))
                _pe = _ent2.get("perspectiveScaleEnabled")
                if _pe is not None and not isinstance(_pe, bool):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"{_kind2} '{_eid2}' perspectiveScaleEnabled 须为布尔"
                        f"（当前 {_pe!r}；运行时按缺省参与规则回落）",
                    ))
        # 场景透视缩放 perspectiveScale（深度轴模型）：形状检查（运行时对非法配置容错为不缩放，warning 级）
        _pcfg = sc.get("perspectiveScale")
        if _pcfg is not None:
            if not isinstance(_pcfg, dict):
                issues.append(Issue(
                    "warning", "scene", sid,
                    f"perspectiveScale 须为对象（当前 {type(_pcfg).__name__}；运行时忽略不缩放）",
                ))
            else:
                def _fin_num(v: object) -> float | None:
                    if isinstance(v, bool) or not isinstance(v, (int, float)):
                        return None
                    return float(v) if _math.isfinite(float(v)) else None

                def _check_point(label: str, pt: object) -> tuple[float, float] | None:
                    if not isinstance(pt, dict):
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"perspectiveScale.{label} 须为 {{x, y, scale}} 对象（运行时忽略不缩放）",
                        ))
                        return None
                    x = _fin_num(pt.get("x"))
                    y = _fin_num(pt.get("y"))
                    s = _fin_num(pt.get("scale"))
                    if x is None or y is None or s is None or s <= 0:
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"perspectiveScale.{label} 需要有限数 x/y 与正有限数 scale"
                            f"（当前 {pt!r}；运行时忽略不缩放）",
                        ))
                        return None
                    return (x, y)

                _n = _check_point("near", _pcfg.get("near"))
                _f = _check_point("far", _pcfg.get("far"))
                if _n is not None and _f is not None:
                    _dx = _f[0] - _n[0]
                    _dy = _f[1] - _n[1]
                    if _dx * _dx + _dy * _dy <= 1e-6:
                        issues.append(Issue(
                            "warning", "scene", sid,
                            "perspectiveScale near≈far 深度轴退化（长度≈0，运行时视为未配置不缩放）",
                        ))
                _mids = _pcfg.get("midStops")
                if _mids is not None:
                    if not isinstance(_mids, list):
                        issues.append(Issue(
                            "warning", "scene", sid,
                            "perspectiveScale.midStops 须为数组（运行时忽略中途点）",
                        ))
                    else:
                        for _mi, _m in enumerate(_mids):
                            _mp = _fin_num(_m.get("pos")) if isinstance(_m, dict) else None
                            _ms = _fin_num(_m.get("scale")) if isinstance(_m, dict) else None
                            if _mp is None or _ms is None or not (0.0 < _mp < 1.0) or _ms <= 0:
                                issues.append(Issue(
                                    "warning", "scene", sid,
                                    f"perspectiveScale.midStops[{_mi}] 需要 pos∈(0,1) 与正 scale"
                                    f"（当前 {_m!r}；运行时跳过该条）",
                                ))
                _pas = _pcfg.get("affectsSpeed")
                if _pas is not None and not isinstance(_pas, bool):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"perspectiveScale.affectsSpeed 须为布尔（当前 {_pas!r}；运行时按 true 回落）",
                    ))
        # zone 只有 group 标签（无 transform 字段是设计）：形状检查对齐 npc/hotspot
        for _z2 in sc.get("zones", []) or []:
            if not isinstance(_z2, dict):
                continue
            _gvz = _z2.get("group")
            if _gvz is not None and (not isinstance(_gvz, str) or not _gvz.strip()):
                _zid2 = str(_z2.get("id", "") or "").strip() or "?"
                issues.append(Issue(
                    "warning", "scene", sid,
                    f"zone '{_zid2}' group 须为非空字符串标签（当前 {_gvz!r}）",
                ))
        # 一旦场景声明了 entityGroups，未声明成员引用给 warning；旧场景完全没该键不制造迁移噪声。
        if isinstance(_groups_raw, list):
            for _coll, _kind in (("npcs", "npc"), ("hotspots", "hotspot"), ("zones", "zone")):
                for _member in sc.get(_coll, []) or []:
                    if not isinstance(_member, dict):
                        continue
                    _mg = str(_member.get("group") or "").strip()
                    if _mg and _mg not in _declared_groups:
                        _mid = str(_member.get("id") or "?")
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"{_kind} {_mid!r} 引用了未在 entityGroups 声明的分组 {_mg!r}"
                            "（运行时按无条件兼容组处理）",
                        ))
        for hs in sc.get("hotspots", []):
            hid = str(hs.get("id", "")) or "?"
            di = hs.get("displayImage")
            if di is not None:
                if not isinstance(di, dict):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"Hotspot '{hid}' displayImage 须为对象",
                    ))
                else:
                    img = str(di.get("image", "") or "").strip()
                    if not img:
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"Hotspot '{hid}' displayImage.image 不能为空",
                        ))
                    for key in ("worldWidth", "worldHeight"):
                        v = di.get(key)
                        try:
                            fv = float(v)
                            if fv <= 0 or not math.isfinite(fv):
                                issues.append(Issue(
                                    "error", "scene", sid,
                                    f"Hotspot '{hid}' displayImage.{key} 须为正有限数",
                                ))
                        except (TypeError, ValueError):
                            issues.append(Issue(
                                "error", "scene", sid,
                                f"Hotspot '{hid}' displayImage.{key} 须为数值",
                            ))
                    fac = di.get("facing")
                    if fac is not None and fac not in ("left", "right"):
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"Hotspot '{hid}' displayImage.facing 须为 left 或 right",
                        ))
                    ssort = di.get("spriteSort")
                    if ssort is not None and ssort not in ("back", "front"):
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"Hotspot '{hid}' displayImage.spriteSort 须为 back 或 front",
                        ))
            hdf = hs.get("dialogueFacing")
            if hdf is not None and hdf not in _DIALOGUE_FACING_VALUES:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Hotspot '{hid}' dialogueFacing 须为 "
                    + " / ".join(_DIALOGUE_FACING_VALUES),
                ))
            elif hdf not in (None, "keep") and not isinstance(hs.get("displayImage"), dict):
                # 没有展示图就没有可镜像的东西：配了也不会有任何效果，属于写了没用
                issues.append(Issue(
                    "warning", "scene", sid,
                    f"Hotspot '{hid}' 配了 dialogueFacing={hdf!r} 但没有 displayImage，"
                    "运行时无可镜像的展示图，该配置不会有任何效果",
                ))
            bindings = _entity_cutscene_bindings(hs)
            if hs.get("cutsceneId") is not None:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Hotspot '{hid}' 已废弃 cutsceneId，请改用 cutsceneIds 数组",
                ))
            if hs.get("cutsceneIds") is not None and not isinstance(hs.get("cutsceneIds"), list):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Hotspot '{hid}' cutsceneIds 须为数组",
                ))
            for cid in bindings:
                if cid not in cutscene_ids:
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"Hotspot '{hid}' cutsceneIds 包含 {cid!r}，不在过场 index 列表中",
                    ))
            if "cutsceneOnly" in hs and not isinstance(hs.get("cutsceneOnly"), bool):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Hotspot '{hid}' cutsceneOnly 须为布尔",
                ))
            cpl = hs.get("collisionPolygonLocal")
            if cpl is not None and not isinstance(cpl, bool):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Hotspot '{hid}' collisionPolygonLocal 须为布尔",
                ))
            poly = hs.get("collisionPolygon")
            if poly is not None:
                if not isinstance(poly, list):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"Hotspot '{hid}' collisionPolygon 须为数组",
                    ))
                elif len(poly) > 0 and len(poly) < 3:
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"Hotspot '{hid}' collisionPolygon 至少 3 个顶点或省略",
                    ))
                else:
                    for pi, p in enumerate(poly):
                        if not isinstance(p, dict):
                            issues.append(Issue(
                                "error", "scene", sid,
                                f"Hotspot '{hid}' collisionPolygon[{pi}] 须为 {{x,y}} 对象",
                            ))
                            continue
                        for coord in ("x", "y"):
                            v = p.get(coord)
                            try:
                                float(v)
                            except (TypeError, ValueError):
                                issues.append(Issue(
                                    "error", "scene", sid,
                                    f"Hotspot '{hid}' collisionPolygon[{pi}].{coord} 须为数值",
                                ))
            data = hs.get("data", {})
            if hs.get("type") == "transition":
                ts = data.get("targetScene", "")
                if ts and ts not in scene_ids:
                    issues.append(Issue("error", "scene", sid,
                                        f"Hotspot '{hs.get('id')}' 的 targetScene '{ts}' 不存在"))
                tsp = str(data.get("targetSpawnPoint") or "").strip()
                if ts and ts in scene_ids and tsp \
                        and tsp not in set(model.spawn_point_keys_for_scene(ts)):
                    # 运行时静默回落默认出生点，落点错位难排查——编辑期兜出来
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"Hotspot '{hs.get('id')}' targetSpawnPoint '{tsp}' 不在场景 "
                        f"'{ts}' 的 spawnPoints 中（运行时将回落默认出生点）"))
            if hs.get("type") == "encounter":
                eid = data.get("encounterId", "")
                if eid and eid not in encounter_ids:
                    issues.append(Issue("error", "scene", sid,
                                        f"Hotspot '{hs.get('id')}' 的 encounterId '{eid}' 不存在"))
            if hs.get("type") == "inspect":
                idata = hs.get("data") or {}
                if isinstance(idata, dict):
                    igraph = str(idata.get("graphId") or "").strip()
                    itext = str(idata.get("text") or "").strip()
                    if igraph and itext:
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"Hotspot '{hid}' inspect 不可同时填写 graphId 与 text",
                        ))
                    if igraph:
                        gpath = model.dialogues_path / "graphs" / f"{igraph}.json"
                        if not gpath.is_file():
                            issues.append(Issue(
                                "error", "scene", sid,
                                f"Hotspot '{hid}' inspect graphId '{igraph}' 缺少 dialogues/graphs/{igraph}.json",
                            ))
                        else:
                            try:
                                gdata = read_json(gpath)
                            except (OSError, ValueError, json.JSONDecodeError):
                                issues.append(Issue(
                                    "error", "scene", sid,
                                    f"Hotspot '{hid}' graphs/{igraph}.json 无法解析",
                                ))
                            else:
                                if isinstance(gdata, dict):
                                    nodes = gdata.get("nodes")
                                    ent = str(idata.get("entry") or "").strip()
                                    if ent and isinstance(nodes, dict) and ent not in nodes:
                                        issues.append(Issue(
                                            "error", "scene", sid,
                                            f"Hotspot '{hid}' inspect entry '{ent}' 不在图 nodes 中",
                                        ))
                    else:
                        acts = idata.get("actions")
                        has_actions = isinstance(acts, list) and len(acts) > 0
                        if not itext and not has_actions:
                            issues.append(Issue(
                                "warning", "scene", sid,
                                f"Hotspot '{hid}' inspect 未配置 graphId、非空 text 或非空 actions",
                            ))
            if hs.get("type") == "pickup":
                iid = data.get("itemId", "")
                if iid and iid not in item_ids:
                    issues.append(Issue("warning", "scene", sid,
                                        f"Hotspot '{hs.get('id')}' 的 itemId '{iid}' 不存在"))
            if hs.get("type") == "act_spot":
                _check_act_spot_data(issues, sid, hid, data, sc)
        for npc in sc.get("npcs", []):
            nid = str(npc.get("id", "") or "?")
            bindings = _entity_cutscene_bindings(npc)
            if npc.get("cutsceneId") is not None:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{nid}' 已废弃 cutsceneId，请改用 cutsceneIds 数组",
                ))
            if npc.get("cutsceneIds") is not None and not isinstance(npc.get("cutsceneIds"), list):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{nid}' cutsceneIds 须为数组",
                ))
            for cid in bindings:
                if cid not in cutscene_ids:
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"NPC '{nid}' cutsceneIds 包含 {cid!r}，不在过场 index 列表中",
                    ))
            if "cutsceneOnly" in npc and not isinstance(npc.get("cutsceneOnly"), bool):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{nid}' cutsceneOnly 须为布尔",
                ))
            ifi = npc.get("initialFacing")
            if ifi is not None and ifi not in ("left", "right"):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{npc.get('id')}' initialFacing 须为 'left' 或 'right'",
                ))
            ndf = npc.get("dialogueFacing")
            if ndf is not None and ndf not in _DIALOGUE_FACING_VALUES:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{nid}' dialogueFacing 须为 "
                    + " / ".join(_DIALOGUE_FACING_VALUES),
                ))
            nsort = npc.get("spriteSort")
            if nsort is not None and nsort not in ("back", "front"):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{nid}' spriteSort 须为 back 或 front",
                ))
            anim_bundle = _anim_bundle_id_from_ref(npc.get("animFile"))
            if anim_bundle and anim_bundle not in model.animations:
                issues.append(Issue(
                    "warning", "scene", sid,
                    f"NPC '{nid}' animFile 指向 '{anim_bundle}'，但无对应动画包目录 "
                    f"public/resources/runtime/animation/{anim_bundle}/anim.json"
                    "（改名/删除导致的孤儿引用？）",
                ))
            iap = npc.get("initialAnimPlayback")
            if iap is not None:
                if not isinstance(iap, dict):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"NPC '{nid}' initialAnimPlayback 须为对象（speed/reverse/holdFrame/startFrame）",
                    ))
                else:
                    _iap_known = {"speed", "reverse", "holdFrame", "startFrame"}
                    for k in iap.keys():
                        if k not in _iap_known:
                            issues.append(Issue(
                                "warning", "scene", sid,
                                f"NPC '{nid}' initialAnimPlayback 含未知键 {k!r}（运行时忽略；拼写错误？）",
                            ))
                    iap_spd = iap.get("speed")
                    if iap_spd is not None:
                        try:
                            fv = float(iap_spd)
                        except (TypeError, ValueError):
                            fv = float("nan")
                        if not math.isfinite(fv) or fv <= 0:
                            issues.append(Issue(
                                "warning", "scene", sid,
                                f"NPC '{nid}' initialAnimPlayback.speed {iap_spd!r} 须为 >0 数值（运行时忽略）",
                            ))
                    if iap.get("reverse") is not None and not isinstance(iap.get("reverse"), bool):
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"NPC '{nid}' initialAnimPlayback.reverse 须为布尔（运行时忽略非 true）",
                        ))
                    for _ik in ("holdFrame", "startFrame"):
                        iv = iap.get(_ik)
                        if iv is None:
                            continue
                        try:
                            fv = float(iv)
                        except (TypeError, ValueError):
                            fv = float("nan")
                        if not math.isfinite(fv) or fv < 0:
                            issues.append(Issue(
                                "warning", "scene", sid,
                                f"NPC '{nid}' initialAnimPlayback.{_ik} {iv!r} 须为 ≥0 整数（运行时忽略）",
                            ))
            cref = npc.get("characterId")
            if cref is not None:
                cid = str(cref).strip()
                if not cid:
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"NPC '{nid}' characterId 须为非空字符串（或删除该键）",
                    ))
                elif cid not in getattr(model, "character_registry", {}):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"NPC '{nid}' characterId 指向 {cid!r}，但 character_registry.json 中无此角色",
                    ))
            pslug = npc.get("portraitSlug")
            if pslug is not None:
                if not isinstance(pslug, str) or not pslug.strip():
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"NPC '{nid}' portraitSlug 须为非空字符串（或删除该键）",
                    ))
                elif model.project_path is not None and not (
                    model.project_path / "public" / "resources" / "runtime" / "images"
                    / "dialogue_portraits" / pslug.strip()
                ).is_dir():
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"NPC '{nid}' portraitSlug 指向 '{pslug.strip()}'，但无对应立绘集目录 "
                        f"public/resources/runtime/images/dialogue_portraits/{pslug.strip()}/",
                    ))
            dcz = npc.get("dialogueCameraZoom")
            if dcz is not None:
                try:
                    fz = float(dcz)
                    if fz <= 0 or not math.isfinite(fz):
                        issues.append(Issue("error", "scene", sid,
                                            f"NPC '{npc.get('id')}' dialogueCameraZoom 须为正有限数"))
                except (TypeError, ValueError):
                    issues.append(Issue("error", "scene", sid,
                                        f"NPC '{npc.get('id')}' dialogueCameraZoom 须为数字"))
            df = str(npc.get("dialogueFile", "") or "").strip()
            dk = str(npc.get("dialogueKnot", "") or "").strip()
            dg = str(npc.get("dialogueGraphId", "") or "").strip()
            if df:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{npc.get('id')}' 仍含已废弃字段 dialogueFile，请改为 dialogueGraphId",
                ))
            if dk:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{npc.get('id')}' 仍含已废弃字段 dialogueKnot（图对话不需要 knot）",
                ))
            if dg:
                gpath = model.dialogues_path / "graphs" / f"{dg}.json"
                if not gpath.is_file():
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"NPC '{npc.get('id')}' dialogueGraphId '{dg}' 缺少文件 dialogues/graphs/{dg}.json",
                    ))
                else:
                    try:
                        gdata = read_json(gpath)
                    except (OSError, ValueError, json.JSONDecodeError):
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"NPC '{npc.get('id')}' 图对话文件 graphs/{dg}.json 无法解析为 JSON",
                        ))
                    else:
                        if not isinstance(gdata, dict):
                            issues.append(Issue(
                                "error", "scene", sid,
                                f"NPC '{npc.get('id')}' graphs/{dg}.json 根须为对象",
                            ))
                        else:
                            nodes = gdata.get("nodes")
                            entry = gdata.get("entry")
                            if not isinstance(nodes, dict) or not isinstance(entry, str) or entry not in nodes:
                                issues.append(Issue(
                                    "error", "scene", sid,
                                    f"NPC '{npc.get('id')}' graphs/{dg}.json 缺少合法 entry 或 nodes",
                                ))
                            else:
                                dge = str(npc.get("dialogueGraphEntry", "") or "").strip()
                                if dge and dge not in nodes:
                                    issues.append(Issue(
                                        "error", "scene", sid,
                                        f"NPC '{npc.get('id')}' dialogueGraphEntry '{dge}' 不在图 nodes 中",
                                    ))
            cpl = npc.get("collisionPolygonLocal")
            if cpl is not None and not isinstance(cpl, bool):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{npc.get('id')}' collisionPolygonLocal 须为布尔",
                ))
            cpoly = npc.get("collisionPolygon")
            if cpoly is not None:
                if not isinstance(cpoly, list):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"NPC '{npc.get('id')}' collisionPolygon 须为数组",
                    ))
                elif len(cpoly) > 0 and len(cpoly) < 3:
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"NPC '{npc.get('id')}' collisionPolygon 至少 3 个顶点或省略",
                    ))
                else:
                    for pi, p in enumerate(cpoly):
                        if not isinstance(p, dict):
                            issues.append(Issue(
                                "error", "scene", sid,
                                f"NPC '{npc.get('id')}' collisionPolygon[{pi}] 须为 {{x,y}} 对象",
                            ))
                            continue
                        for coord in ("x", "y"):
                            v = p.get(coord)
                            try:
                                float(v)
                            except (TypeError, ValueError):
                                issues.append(Issue(
                                    "error", "scene", sid,
                                    f"NPC '{npc.get('id')}' collisionPolygon[{pi}].{coord} 须为数值",
                                ))
        fid = sc.get("filterId")
        if fid and fid not in filter_ids:
            issues.append(Issue("warning", "scene", sid,
                                f"filterId '{fid}' has no matching filter JSON"))

        for zone in sc.get("zones", []) or []:
            zid = str(zone.get("id", "")) or "?"
            poly = zone.get("polygon")
            if not isinstance(poly, list) or len(poly) < 3:
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Zone '{zid}' 需要 polygon 数组且至少 3 个顶点",
                ))
            else:
                for pi, p in enumerate(poly):
                    if not isinstance(p, dict):
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"Zone '{zid}' polygon[{pi}] 须为 {{x,y}} 对象",
                        ))
                        continue
                    for coord in ("x", "y"):
                        v = p.get(coord)
                        try:
                            float(v)
                        except (TypeError, ValueError):
                            issues.append(Issue(
                                "error", "scene", sid,
                                f"Zone '{zid}' polygon[{pi}].{coord} 须为数值",
                            ))
            for legacy in ("x", "y", "width", "height"):
                if legacy in zone:
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"Zone '{zid}' 含遗留几何字段 '{legacy}'，请删除，仅保留 polygon",
                    ))
            zk = zone.get("zoneKind") or "standard"
            if zk not in ("standard", "depth_floor"):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Zone '{zid}' zoneKind 无效: {zk!r}（应为 standard 或 depth_floor）",
                ))
            elif zk == "depth_floor":
                b = zone.get("floorOffsetBoost")
                try:
                    bf = float(b)
                    if not math.isfinite(bf):
                        raise ValueError
                except (TypeError, ValueError):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"Zone '{zid}'（depth_floor）需要有限数值 floorOffsetBoost",
                    ))
                for ev, label in (
                    ("onEnter", "onEnter"),
                    ("onStay", "onStay"),
                    ("onExit", "onExit"),
                    ("onInteract", "onInteract"),
                ):
                    if zone.get(ev):
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"Zone '{zid}'为 depth_floor，{label} 不会执行（区域逻辑已跳过）",
                        ))
            elif zk == "standard" and "floorOffsetBoost" in zone:
                issues.append(Issue(
                    "warning", "scene", sid,
                    f"Zone '{zid}' 为 standard，floorOffsetBoost 无效，可删除",
                ))

            oi = zone.get("onInteract")
            if oi is not None and not isinstance(oi, list):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Zone '{zid}' onInteract 须为动作数组（或删除该字段）",
                ))
            if str(zone.get("interactLabel") or "").strip() and not oi:
                issues.append(Issue(
                    "warning", "scene", sid,
                    f"Zone '{zid}' 配了 interactLabel 却没有 onInteract："
                    "提示条只在有 onInteract 时才出，这行文案永不显示",
                ))

            smell = zone.get("smell")
            if smell is not None:
                if not isinstance(smell, dict) or not str(smell.get("scent") or "").strip():
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"Zone '{zid}' smell 须为含非空 scent 的对象（或删除该字段）",
                    ))
                else:
                    scent_id = str(smell.get("scent")).strip()
                    known_smells = {s for s, _ in model.all_smell_profile_ids()}
                    if known_smells and scent_id not in known_smells:
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"Zone '{zid}' smell.scent {scent_id!r} 不在 smell_profiles.json 的 profiles 中",
                        ))
                    if zk == "depth_floor":
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"Zone '{zid}' 为 depth_floor，smell 不会触发（区域逻辑已跳过）",
                        ))

        # 光环境曲线 lightEnvCurve（玩家位置插值光照）
        lec = sc.get("lightEnvCurve")
        if lec is not None:
            pts = lec.get("points") if isinstance(lec, dict) else None
            if not isinstance(pts, list) or len(pts) < 2:
                issues.append(Issue(
                    "warning", "scene", sid,
                    "lightEnvCurve 需要 points 数组且至少 2 个控制点才会生效",
                ))
            else:
                modes: set = set()
                for pi, pt in enumerate(pts):
                    if not isinstance(pt, dict):
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"lightEnvCurve.points[{pi}] 须为对象",
                        ))
                        continue
                    for coord in ("x", "y"):
                        if not isinstance(pt.get(coord), (int, float)):
                            issues.append(Issue(
                                "error", "scene", sid,
                                f"lightEnvCurve.points[{pi}].{coord} 须为数值",
                            ))
                    env = pt.get("env")
                    if env is not None and not isinstance(env, dict):
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"lightEnvCurve.points[{pi}].env 须为对象",
                        ))
                    elif isinstance(env, dict):
                        sh = env.get("shadow")
                        if isinstance(sh, dict) and "mode" in sh:
                            modes.add(sh.get("mode"))
                if len(modes) > 1:
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"lightEnvCurve 各关键帧 shadow.mode 不一致 {sorted(modes)}；"
                        "运行时跨关键帧切模式会重建阴影实例，建议保持一致",
                    ))

    # --- quest groups ---
    quest_group_ids = {g["id"] for g in model.quest_groups}
    for g in model.quest_groups:
        pg = g.get("parentGroup")
        if pg and pg not in quest_group_ids:
            issues.append(Issue("error", "questGroup", g["id"],
                                f"parentGroup '{pg}' 不存在"))
    # parentGroup circular reference detection
    for g in model.quest_groups:
        visited: set[str] = set()
        cur = g["id"]
        while cur:
            if cur in visited:
                issues.append(Issue("error", "questGroup", g["id"],
                                    f"parentGroup 存在循环引用"))
                break
            visited.add(cur)
            parent_g = next((x for x in model.quest_groups if x["id"] == cur), None)
            cur = parent_g.get("parentGroup", "") if parent_g else ""

    # --- quests ---
    # repeatable（活计镜像任务）硬绑定：runArchetype 必填且须活计图、活计↔任务 1:1、
    # 禁一切条件/动作/后继字段——条目/完成/归档全部由活计生命周期派生，写了也不会被读，
    # 且运行时 QuestManager 对 repeatable 直接跳过状态机（乱配=静默失效，故一律 error）。
    _run_graph_ids = _narrative_run_graph_ids(model)
    _seen_run_archetypes: dict[str, str] = {}
    for q in model.quests:
        qid = str(q.get("id", "?"))
        qtype = str(q.get("type", ""))
        arch = str(q.get("runArchetype", "") or "").strip()
        if qtype not in ("main", "side", "repeatable"):
            issues.append(Issue("error", "quest", qid,
                                f"type {qtype!r} 须为 main|side|repeatable"))
        if qtype == "repeatable":
            if not arch:
                issues.append(Issue("error", "quest", qid,
                                    "repeatable 任务必须配 runArchetype（绑定的活计图 id）"))
            elif arch not in _run_graph_ids:
                issues.append(Issue("error", "quest", qid,
                                    f"runArchetype {arch!r} 不是活计图（须为 narrative_graphs 中声明了 run 的图）"))
            elif arch in _seen_run_archetypes:
                issues.append(Issue("error", "quest", qid,
                                    f"活计图 {arch!r} 已被任务 '{_seen_run_archetypes[arch]}' 绑定（活计↔repeatable 任务须 1:1）"))
            else:
                _seen_run_archetypes[arch] = qid
            banned = [k for k in ("preconditions", "completionConditions",
                                  "acceptActions", "rewards", "nextQuests") if q.get(k)]
            if q.get("nextQuestId"):
                banned.append("nextQuestId")
            if q.get("sideType"):
                banned.append("sideType")
            if banned:
                issues.append(Issue("error", "quest", qid,
                                    f"repeatable 任务禁配 {'/'.join(banned)}（全部由活计生命周期派生，运行时不读）"))
        elif arch:
            issues.append(Issue("error", "quest", qid,
                                "runArchetype 仅 repeatable 任务可配（type 改 repeatable，或删掉该字段）"))
        _append_quest_objective_issues(model, issues, q, qid)
        _append_quest_guidance_issues(model, issues, q.get("guidance"), qid, "guidance")
        ann = q.get("announce")
        if ann is not None and ann not in ("none", "toast", "banner"):
            issues.append(Issue("error", "quest", qid,
                                f"announce {ann!r} 须为 none|toast|banner（不填=按类型取缺省：主线横幅、其余木条）"))
        if q.get("autoFocus") is not None and not isinstance(q.get("autoFocus"), bool):
            issues.append(Issue("error", "quest", qid,
                                "autoFocus 须为布尔（不填=当前任务槽空时才自动占位）"))
    for q in model.quests:
        grp = q.get("group", "")
        if grp and grp not in quest_group_ids:
            issues.append(Issue("error", "quest", q["id"],
                                f"group '{grp}' 不在 questGroups 中"))
        for edge in q.get("nextQuests", []):
            eid = edge.get("questId", "")
            if eid and eid not in quest_ids:
                issues.append(Issue("error", "quest", q["id"],
                                    f"nextQuests 的 questId '{eid}' 不存在"))
            elif eid and eid in _repeatable_quest_ids(model):
                issues.append(Issue("error", "quest", q["id"],
                                    f"nextQuests 不可指向 repeatable 任务 '{eid}'（无状态机可接取；派单用 startNarrativeRun）"))
        nxt = q.get("nextQuestId")
        if nxt and not q.get("nextQuests") and nxt not in quest_ids:
            issues.append(Issue("error", "quest", q["id"],
                                f"nextQuestId '{nxt}' 不存在"))

    # --- encounters ---
    for enc in model.encounters:
        for opt in enc.get("options", []):
            rid = opt.get("requiredRuleId")
            if rid and rid not in rule_ids:
                issues.append(Issue("error", "encounter", enc["id"],
                                    f"requiredRuleId '{rid}' 不存在"))
            rl = opt.get("requiredRuleLayers")
            if rid and isinstance(rl, list) and rl:
                rule = next(
                    (x for x in model.rules_data.get("rules", []) if x.get("id") == rid),
                    None,
                )
                layers_obj = rule.get("layers") if isinstance(rule, dict) else None
                if not isinstance(layers_obj, dict):
                    layers_obj = {}
                for L in rl:
                    if L not in ("xiang", "li", "shu"):
                        issues.append(Issue(
                            "error", "encounter", enc["id"],
                            f"选项 requiredRuleLayers 含非法层 {L!r}",
                        ))
                    elif L not in layers_obj or not isinstance(layers_obj.get(L), dict):
                        issues.append(Issue(
                            "error", "encounter", enc["id"],
                            f"规矩 '{rid}' 未定义层 {L!r}（layers 中缺少该键）",
                        ))
            for ci in opt.get("consumeItems", []):
                if ci.get("id") and ci["id"] not in item_ids:
                    issues.append(Issue("error", "encounter", enc["id"],
                                        f"consumeItem '{ci['id']}' 不存在"))

    # --- rules definitions ---
    _layer_keys = ("xiang", "li", "shu")
    for r in model.rules_data.get("rules", []):
        if not isinstance(r, dict):
            continue
        rid = r.get("id", "?")
        layers = r.get("layers")
        if not isinstance(layers, dict):
            issues.append(Issue("error", "rule", rid, "须有 layers 对象（象/理/术）"))
            continue
        has_text = any(
            isinstance(layers.get(k), dict) and str(layers[k].get("text", "")).strip()
            for k in _layer_keys
        )
        if not has_text:
            issues.append(Issue("error", "rule", rid, "layers 至少有一层含非空 text"))
        _verified_vals = ("unverified", "effective", "questionable")
        for lk in _layer_keys:
            lob = layers.get(lk)
            if not isinstance(lob, dict):
                continue
            lver = lob.get("verified")
            if lver is not None and lver not in _verified_vals:
                issues.append(Issue(
                    "error", "rule", rid,
                    f"layers.{lk}.verified 须为 unverified|effective|questionable，当前为 {lver!r}",
                ))

    # --- rules fragments ---
    for frag in model.rules_data.get("fragments", []):
        if frag.get("ruleId") and frag["ruleId"] not in rule_ids:
            issues.append(Issue("error", "rule", frag["id"],
                                f"Fragment 的 ruleId '{frag['ruleId']}' 不存在"))
        lay = frag.get("layer", "xiang")
        if lay not in _layer_keys:
            issues.append(Issue(
                "error", "rule", frag.get("id", "?"),
                f"fragment.layer 须为 xiang|li|shu，当前为 {lay!r}",
            ))
        if not str(frag.get("source", "")).strip():
            issues.append(Issue(
                "error", "rule", frag.get("id", "?"),
                "fragment.source 不能为空",
            ))

    # --- shops ---
    for shop in model.shops:
        for si in shop.get("items", []):
            if si.get("itemId") and si["itemId"] not in item_ids:
                issues.append(Issue("error", "shop", shop["id"],
                                    f"shopItem '{si['itemId']}' 不存在"))

    # --- book page entries (unique ids across all books) ---
    book_entry_first_book: dict[str, str] = {}
    for bk in model.archive_books:
        if not isinstance(bk, dict):
            continue
        bid = str(bk.get("id", ""))
        for pg in bk.get("pages") or []:
            if not isinstance(pg, dict):
                continue
            for ent in pg.get("entries") or []:
                if not isinstance(ent, dict):
                    continue
                eid = str(ent.get("id", "")).strip()
                if not eid:
                    issues.append(Issue("warning", "archive", bid, "book page entry 缺少 id"))
                    continue
                if eid in book_entry_first_book:
                    issues.append(Issue(
                        "error", "archive", eid,
                        f"重复的 book page entry id（已出现在书 '{book_entry_first_book[eid]}'）",
                    ))
                else:
                    book_entry_first_book[eid] = bid

    # --- map ---
    for node in model.map_nodes:
        if node.get("sceneId") and node["sceneId"] not in scene_ids:
            issues.append(Issue("error", "map", node.get("sceneId", "?"),
                                f"地图节点 sceneId '{node['sceneId']}' 不存在"))

    # --- game config ---
    cfg = model.game_config
    if cfg.get("initialScene") and cfg["initialScene"] not in scene_ids:
        issues.append(Issue("error", "config", "game_config",
                            f"initialScene '{cfg['initialScene']}' 不存在"))
    if cfg.get("initialQuest") and cfg["initialQuest"] not in quest_ids:
        issues.append(Issue("error", "config", "game_config",
                            f"initialQuest '{cfg['initialQuest']}' 不存在"))
    elif cfg.get("initialQuest") and cfg["initialQuest"] in _repeatable_quest_ids(model):
        issues.append(Issue("error", "config", "game_config",
                            f"initialQuest 不可指向 repeatable 任务 '{cfg['initialQuest']}'（无状态机可接取）"))
    if cfg.get("initialCutscene") and cfg["initialCutscene"] not in cutscene_ids:
        issues.append(Issue("warning", "config", "game_config",
                            f"initialCutscene '{cfg['initialCutscene']}' 不存在"))
    # fallbackScene：目标场景缺失时的兜底场景（SaveManager 恢复存档用），悬垂同样致命。
    if cfg.get("fallbackScene") and cfg["fallbackScene"] not in scene_ids:
        issues.append(Issue("error", "config", "game_config",
                            f"fallbackScene '{cfg['fallbackScene']}' 不存在"))

    _validate_day_night(model, issues)
    _validate_player_acts(model, issues)
    _validate_character_avatars(model, issues)
    _validate_animation_sockets(model, issues)

    _validate_items(model, issues)
    _validate_overlay_images(model, issues)
    _validate_parallax_scenes(model, issues)

    _validate_flags(model, issues)

    _validate_dialogue_graphs(model, issues)

    _validate_pressure_holds(model, issues)
    _validate_document_reveals(model, issues)
    _validate_signal_cues(model, issues)
    _validate_bubble_lines(model, issues)
    _validate_water_minigames(model, issues)
    _validate_paper_craft(model, issues)
    _validate_object_examine(model, issues)
    _validate_narrative(model, issues)
    _validate_reactive_cycles(model, issues)
    _validate_narrative_packages(model, issues)
    _validate_planes(model, issues)
    _validate_npc_schedules(model, issues)
    _validate_plane_action_pairing(model, issues)
    _validate_narrative_templates(model, issues)
    _validate_entity_reachability(model, issues)

    return issues


_CLOCK_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _parse_clock_minutes(raw: object) -> int | None:
    """`HH:MM` → 当日分钟数；非法返回 None。与 src/utils/dayTime.ts 的 parseClock 同口径。"""
    m = _CLOCK_RE.match(str(raw or "").strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def _validate_npc_schedules(model: ProjectModel, issues: list[Issue]) -> None:
    """NPC 日程表（npc_schedules.json）+ 场景侧 exitAnchors / dayNight。

    构建期 fail-closed：日程写错的运行时表现是「NPC 莫名其妙不在场」，
    是最难从画面反推原因的一类，宁可在这里拦下。
    """
    data = getattr(model, "npc_schedules", None)
    rows = data.get("schedules") if isinstance(data, dict) else None
    rows = rows if isinstance(rows, list) else []

    scene_ids = set(model.scenes.keys())
    known_chars = set(model.character_registry.keys())
    # 出口锚点候选：日程的 preferredExit 跨场景生效，故按全工程并集判存在性。
    all_exits = {aid for aid, _ in model.all_exit_anchor_ids()}

    seen_chars: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            issues.append(Issue("error", "npc_schedules", "", "日程条目须为 JSON 对象"))
            continue
        cid = str(row.get("characterId") or "").strip()
        item = cid or "(未命名)"
        if not cid:
            issues.append(Issue("error", "npc_schedules", item, "日程表缺 characterId"))
            continue
        if cid in seen_chars:
            issues.append(Issue(
                "error", "npc_schedules", item,
                f"角色 {cid!r} 有多张日程表（运行时只认第一张，其余静默丢弃）",
            ))
        seen_chars.add(cid)
        if known_chars and cid not in known_chars:
            issues.append(Issue(
                "error", "npc_schedules", item,
                f"characterId {cid!r} 不在 character_registry.json 中",
            ))
        pref = str(row.get("preferredExit") or "").strip()
        if pref and pref not in all_exits:
            issues.append(Issue(
                "error", "npc_schedules", item,
                f"preferredExit {pref!r} 不是任何场景的出口锚点 id",
            ))

        entries = row.get("entries")
        if not isinstance(entries, list) or not entries:
            issues.append(Issue(
                "error", "npc_schedules", item,
                "日程表没有任何条目（该角色不会受日程管，等于白配）",
            ))
            continue

        covered = [False] * 1440
        for i, e in enumerate(entries):
            where = f"{item} 条目#{i + 1}"
            if not isinstance(e, dict):
                issues.append(Issue("error", "npc_schedules", item, f"{where} 须为 JSON 对象"))
                continue
            f_min = _parse_clock_minutes(e.get("from"))
            t_min = _parse_clock_minutes(e.get("to"))
            if f_min is None:
                issues.append(Issue(
                    "error", "npc_schedules", item,
                    f"{where} 的 from {e.get('from')!r} 不是合法时刻（需 HH:MM）",
                ))
            if t_min is None:
                issues.append(Issue(
                    "error", "npc_schedules", item,
                    f"{where} 的 to {e.get('to')!r} 不是合法时刻（需 HH:MM）",
                ))
            sc = e.get("scene")
            if isinstance(sc, str) and sc.strip() and sc.strip() not in scene_ids:
                issues.append(Issue(
                    "error", "npc_schedules", item,
                    f"{where} 的 scene {sc.strip()!r} 不存在",
                ))
            spot = e.get("spot")
            if spot is not None:
                if not isinstance(spot, dict) or not _is_num(spot.get("x")) or not _is_num(spot.get("y")):
                    issues.append(Issue(
                        "error", "npc_schedules", item,
                        f"{where} 的 spot 须为 {{x, y}} 数值对象",
                    ))
            if f_min is None or t_min is None:
                continue
            # 跨零点（to < from）是合法写法；起止相等 = 整天。
            if f_min == t_min:
                covered = [True] * 1440
            elif f_min < t_min:
                for mm in range(f_min, t_min):
                    covered[mm] = True
            else:
                for mm in range(f_min, 1440):
                    covered[mm] = True
                for mm in range(0, t_min):
                    covered[mm] = True

        if not all(covered):
            gap = covered.index(False)
            issues.append(Issue(
                "warning", "npc_schedules", item,
                f"日程没覆盖全天（{gap // 60:02d}:{gap % 60:02d} 起有空档）："
                "空档期该角色回落为普通常驻 NPC，不随时段来去",
            ))

    # ---- 场景侧：出口锚点与日夜开关 ----
    for sid, scene in model.scenes.items():
        if not isinstance(scene, dict):
            continue
        anchors = scene.get("exitAnchors")
        if anchors is not None and not isinstance(anchors, list):
            issues.append(Issue("error", "scene", sid, "exitAnchors 须为数组"))
            anchors = None
        seen_exits: set[str] = set()
        for a in anchors or []:
            if not isinstance(a, dict):
                issues.append(Issue("error", "scene", sid, "exitAnchors 条目须为 JSON 对象"))
                continue
            aid = str(a.get("id") or "").strip()
            if not aid:
                issues.append(Issue("error", "scene", sid, "出口锚点缺 id"))
                continue
            if aid in seen_exits:
                issues.append(Issue(
                    "error", "scene", sid, f"出口锚点 id {aid!r} 在本场景内重复",
                ))
            seen_exits.add(aid)
            if not _is_num(a.get("x")) or not _is_num(a.get("y")):
                issues.append(Issue(
                    "error", "scene", sid, f"出口锚点 {aid!r} 的 x/y 须为数值",
                ))
        dn = scene.get("dayNight")
        scene_daynight_on = isinstance(dn, dict) and dn.get("enabled") is True
        # 刻意**不**校验"开了日夜却没配 timeVariants"：夜景既可以是另一张图（timeVariants），
        # 也可以是同一张图由渲染侧按时刻实时算（光照曲线 / 滤镜）。没配 timeVariants
        # 是完全合法的一条路，报警告等于替渲染方案做主。

        # 实体级时段归属 phases：值须登记；写了但场景没开日夜 = 配了不生效
        known_phases = {pid for pid, _ in model.all_time_phase_ids()}
        for kind in ("hotspots", "npcs", "zones"):
            for ent in scene.get(kind) or []:
                if not isinstance(ent, dict):
                    continue
                raw = ent.get("phases")
                if raw is None:
                    continue
                eid = str(ent.get("id") or "(无 id)")
                if not isinstance(raw, list):
                    issues.append(Issue("error", "scene", sid, f"{eid} 的 phases 须为数组"))
                    continue
                for v in raw:
                    pv = str(v).strip()
                    if not pv or pv not in known_phases:
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"{eid} 的 phases 含未登记时段 {pv!r}"
                            f"（可用：{'、'.join(sorted(known_phases))}）",
                        ))
                if raw and not scene_daynight_on:
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"{eid} 配了 phases 但本场景没开 dayNight.enabled——该归属不会生效",
                    ))


def _validate_entity_reachability(model: ProjectModel, issues: list[Issue]) -> None:
    """对话图裸实体引用按可达场景集校验（实体迁移场景后的头号盲区）。

    裸 target/npcId 运行时只在**当前场景**解析,找不到静默跳过;而无场景上下文的
    兜底检查按全局 id 集放行——实体搬走后校验全绿、运行时演出无声丢失。本检查对
    "可达集封闭"（只从已知场景触发）的对话图收紧口径:引用 id 全局存在但不在任何
    可达场景中 → warning。全局都不存在的 id 由既有兜底检查报,这里不重复。
    软引用（startDialogueGraph.npcId 等,未命中回退显示名）不在此列。
    """
    from .shared import signal_refactor as _sig
    from .shared.entity_refactor import (
        ENTITY_REF_PARAMS,
        _walk_ref_actions,
        dialogue_graph_scene_reach,
    )

    global_npcs = _all_npc_ids_global_set(model)
    global_hotspots = _all_hotspot_ids_global_set(model)
    for gid, reach in sorted(dialogue_graph_scene_reach(model).items()):
        if not isinstance(reach, set) or not reach:
            continue  # GLOBAL / 无触发面：可达集不封闭,维持全局口径
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        npc_union: set[str] = set()
        hotspot_union: set[str] = set()
        for sid in reach:
            npc_union |= _npc_ids_in_scene(model, sid)
            hotspot_union |= _hotspot_ids_in_scene(model, sid)
        seen: set[tuple[str, str, str]] = set()

        def visit(act_type: str, params: dict) -> None:
            for param, spec_kind in ENTITY_REF_PARAMS[act_type].items():
                if spec_kind not in ("actor", "emote_subject", "npc", "bubble_speaker"):
                    continue
                value = params.get(param)
                if not isinstance(value, str):
                    continue
                ref = value.strip()
                if not ref or ref == "player" or ref.startswith("_cut_"):
                    continue
                # 头顶闲聊的角色档 target 不是实体引用，可达场景无从谈起
                if ref.startswith(BUBBLE_CHARACTER_TARGET_PREFIX):
                    continue
                # 热点也能冒气泡：emote_subject / bubble_speaker 两档同宽
                wide = spec_kind in ("emote_subject", "bubble_speaker")
                allowed = npc_union | (hotspot_union if wide else set())
                if ref in allowed:
                    continue
                exists_globally = ref in global_npcs or (wide and ref in global_hotspots)
                if not exists_globally:
                    continue
                key = (act_type, param, ref)
                if key in seen:
                    continue
                seen.add(key)
                issues.append(Issue(
                    "warning", "dialogue", gid,
                    f"{act_type}.{param} 引用实体 {ref!r}，但它不在本图任何可达场景"
                    f"（{'、'.join(sorted(reach))}）中——运行时按当前场景解析将静默跳过。"
                    "该实体若刚被迁移过场景，需改此引用或连带处理",
                ))
        _walk_ref_actions(doc, visit)


def _iter_narrative_graphs(model: ProjectModel):
    """遍历 narrative_graphs.json 内的所有图（mainGraph + 元素内嵌子图）。"""
    data = model.narrative_graphs
    if not isinstance(data, dict):
        return
    for comp in data.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict) and main.get("id"):
            yield main
        for el in comp.get("elements") or []:
            # 任何带内嵌 graph 的元素都遍历（wrapperGraph / scenarioSubgraph / 未来新增），
            # 与运行时编译口径一致——只认 wrapperGraph 会漏 scenarioSubgraph 里的状态，
            # activePlane 等状态级校验出盲区。
            if isinstance(el, dict):
                g = el.get("graph")
                if isinstance(g, dict) and g.get("id"):
                    yield g


def _narrative_graph_index(model: ProjectModel) -> dict[str, set[str]]:
    """graphId → 状态 id 集合。"""
    out: dict[str, set[str]] = {}
    for g in _iter_narrative_graphs(model):
        states = g.get("states")
        out[str(g["id"])] = set(states.keys()) if isinstance(states, dict) else set()
    return out


def _narrative_listened_signals(model: ProjectModel) -> set[str]:
    """所有 Transition 正在监听的 signal 集合（含 state:* 跨图广播 key）。"""
    out: set[str] = set()
    for g in _iter_narrative_graphs(model):
        for t in g.get("transitions") or []:
            if isinstance(t, dict):
                sig = str(t.get("signal") or "").strip()
                if sig:
                    out.add(sig)
    return out


def _narrative_registered_signal_ids(model: ProjectModel) -> set[str]:
    data = model.narrative_graphs
    if not isinstance(data, dict):
        return set()
    return {
        str(s.get("id") or "").strip()
        for s in data.get("signals") or []
        if isinstance(s, dict) and str(s.get("id") or "").strip()
    }


def _narrative_run_graph_ids(model: ProjectModel) -> set[str]:
    """活计图（声明了 run）的图 id 集合（叙事运行实例化 S1）。"""
    out: set[str] = set()
    for g in _iter_narrative_graphs(model):
        if isinstance(g.get("run"), dict):
            out.add(str(g.get("id") or "").strip())
    return out


def _all_quest_ids(model: ProjectModel) -> set[str]:
    """全部任务 id（含 repeatable）：setFocusedQuest 的目标集比 updateQuest 宽——活计也能当当前任务。"""
    return {
        str(q.get("id", ""))
        for q in model.quests
        if isinstance(q, dict) and q.get("id")
    }


def _append_quest_objective_issues(
    model: ProjectModel, issues: list[Issue], quest: dict, qid: str,
) -> None:
    """任务目标（玩法文档 D7）：id 唯一非空、文案非空、逐条引导可解析。

    目标勾选是条件派生的，配错的后果是"面板上永远勾不掉的一条"——策划看不出是数据问题，
    所以一律按 error 拦在构建期（runtime-norms 不变量 7：构建期严于运行时）。
    """
    objectives = quest.get("objectives")
    if objectives is None:
        return
    if not isinstance(objectives, list):
        issues.append(Issue("error", "quest", qid, "objectives 须为数组"))
        return
    seen: set[str] = set()
    for index, obj in enumerate(objectives):
        if not isinstance(obj, dict):
            issues.append(Issue("error", "quest", qid, f"objectives[{index}] 须为对象"))
            continue
        oid = str(obj.get("id") or "").strip()
        if not oid:
            issues.append(Issue("error", "quest", qid, f"objectives[{index}] 缺少 id"))
        elif oid in seen:
            issues.append(Issue("error", "quest", qid, f"objectives id 重复: {oid!r}"))
        else:
            seen.add(oid)
        if not str(obj.get("text") or "").strip():
            issues.append(Issue("error", "quest", qid,
                                f"objectives[{index}] 的 text 为空（面板与 HUD 会显示一条空目标）"))
        if obj.get("optional") is not None and not isinstance(obj.get("optional"), bool):
            issues.append(Issue("error", "quest", qid, f"objectives[{index}].optional 须为布尔"))
        _append_quest_guidance_issues(
            model, issues, obj.get("guidance"), qid, f"objectives[{index}].guidance",
        )


def _append_quest_guidance_issues(
    model: ProjectModel, issues: list[Issue], guidance: object, qid: str, where: str,
) -> None:
    """引导通道（玩法文档 D8）：场景/实体必须解析得到，否则运行时是一条"指不到地方的箭头"。"""
    if guidance is None:
        return
    if not isinstance(guidance, list):
        issues.append(Issue("error", "quest", qid, f"{where} 须为数组"))
        return
    known_scenes = set(model.all_scene_ids())
    for index, g in enumerate(guidance):
        tag = f"{where}[{index}]"
        if not isinstance(g, dict):
            issues.append(Issue("error", "quest", qid, f"{tag} 须为对象"))
            continue
        kind = str(g.get("kind") or "").strip()
        if kind not in ("mapMarker", "worldMarker", "sceneHint"):
            issues.append(Issue("error", "quest", qid,
                                f"{tag}.kind {kind!r} 须为 mapMarker|worldMarker|sceneHint"))
            continue
        sid = str(g.get("sceneId") or "").strip()
        if not sid:
            issues.append(Issue("error", "quest", qid, f"{tag} 缺少 sceneId"))
        elif sid not in known_scenes:
            issues.append(Issue("error", "quest", qid, f"{tag} 的 sceneId {sid!r} 不存在"))
        if kind == "sceneHint":
            if not str(g.get("text") or "").strip():
                issues.append(Issue("error", "quest", qid, f"{tag} 是 sceneHint，text 不可为空"))
            continue
        if kind == "mapMarker":
            continue
        # worldMarker：实体优先，没实体就必须给坐标
        ekind = str(g.get("entityKind") or "").strip()
        eid = str(g.get("entityId") or "").strip()
        has_point = isinstance(g.get("x"), (int, float)) and isinstance(g.get("y"), (int, float))
        if not eid and not has_point:
            issues.append(Issue("error", "quest", qid,
                                f"{tag} 是 worldMarker，须指向实体（entityKind+entityId）或坐标（x/y）"))
            continue
        if not eid:
            continue
        if ekind not in ("npc", "hotspot", "zone"):
            issues.append(Issue("error", "quest", qid,
                                f"{tag}.entityKind {ekind!r} 须为 npc|hotspot|zone"))
            continue
        if not sid or sid not in known_scenes:
            continue  # 场景本身已报错，不重复报实体
        if ekind == "npc":
            pool = _npc_ids_in_scene(model, sid)
        elif ekind == "hotspot":
            pool = _hotspot_ids_in_scene(model, sid)
        else:
            pool = _zone_ids_in_scene(model, sid)
        if eid not in pool:
            issues.append(Issue("error", "quest", qid,
                                f"{tag} 指向的 {ekind} {eid!r} 不在场景 {sid!r} 中"
                                "（实体改名/迁场景后引导会静默指空）"))


def _repeatable_quest_ids(model: ProjectModel) -> set[str]:
    """repeatable（活计镜像）任务 id 集合：无状态机，quest 叶/updateQuest/nextQuests 不可指向。"""
    return {
        str(q.get("id", ""))
        for q in model.quests
        if isinstance(q, dict) and str(q.get("type", "")) == "repeatable" and q.get("id")
    }


def _validate_narrative_packages(model: ProjectModel, issues: list[Issue]) -> None:
    """章节导演清单（narrative_packages.json）。⚠**章节包=纯组织标签，不承担任何运行时正确性**
    （2026-07-19 降级定案）：包只标"哪张图属哪章、当前活跃哪些章"，供 UI/编辑器/工具分组展示；
    图恒吃信号、进场演哪场戏走 onEnter→图对话 switch——都与包 live/dormant 无关。本校验只保证清单
    这份组织数据自洽（id/package/scene 存在、when/done 条件合法），不因它推断任何运行时行为。"""
    data = model.narrative_packages if isinstance(model.narrative_packages, dict) else {}
    rows = data.get("packages")
    if rows is None:
        return
    if not isinstance(rows, list):
        issues.append(Issue("error", "narrative_packages", "?",
                            "narrative_packages.json 的 packages 须为数组"))
        return
    known_packages = set(model.narrative_package_ids_ordered())
    scene_ids = set(model.scenes or {})
    seen_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            issues.append(Issue("error", "narrative_packages", "?", "清单行须为 JSON 对象"))
            continue
        rid = str(row.get("id") or "").strip()
        if not rid:
            issues.append(Issue("error", "narrative_packages", "?", "清单行缺 id"))
            continue
        if rid in seen_ids:
            issues.append(Issue("error", "narrative_packages", rid, "清单行 id 重复"))
        seen_ids.add(rid)
        pkg = str(row.get("package") or "").strip()
        scene = str(row.get("scene") or "").strip()
        if not pkg:
            issues.append(Issue("error", "narrative_packages", rid,
                                "清单行必须配 package：清单是章节包（纯组织标签）的活跃度声明，无 package 的行无意义。"
                                "进场演出与包无关——走场景 onEnter → startDialogueGraph 路由图（策划在图对话里 switch）"))
        elif pkg not in known_packages:
            issues.append(Issue("error", "narrative_packages", rid,
                                f"package {pkg!r} 不存在（没有任何编排打此包标）"))
        if row.get("autoPlay") is not None:
            issues.append(Issue("error", "narrative_packages", rid,
                                "导演不触发演出（autoPlay 已废弃）：进场演出走场景 onEnter → "
                                "startDialogueGraph 入口路由图，策划在图对话 switch 里选分支"))
        if scene and scene not in scene_ids:
            issues.append(Issue("error", "narrative_packages", rid,
                                f"scene {scene!r} 不存在"))
        if pkg and not (isinstance(row.get("done"), list) and row.get("done")):
            issues.append(Issue("warning", "narrative_packages", rid,
                                "package 行无 done 判据：这章永不自动标记为非活跃（组织标记而已，不影响行为）——"
                                "确认是有意常标活跃，否则补 done"))
        for cond_key in ("when", "done"):
            conds = row.get(cond_key)
            if conds is None:
                continue
            if not isinstance(conds, list):
                issues.append(Issue("error", "narrative_packages", rid, f"{cond_key} 须为条件数组"))
                continue
            _walk_conditions(model, issues, conds, "narrative_packages", rid, None)


def _compiled_narrative_graph_refs(data: Any):
    """(graph, compositionId, elementId)：与 TS 权威 `compileGraphs` 同口径。

    只收 mainGraph 与 wrapperGraph / scenarioSubgraph 元素的内嵌图；本文件另一个
    `_iter_narrative_graphs` 刻意放宽到「任何带 graph 的元素」（状态级校验要那份宽），
    但私有信号监听面必须与权威一模一样，放宽即变成"兜底比 TS 严"。
    """
    if not isinstance(data, dict):
        return
    for comp in data.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        cid = str(comp.get("id") or "").strip()
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            yield main, cid, ""
        for el in comp.get("elements") or []:
            if not isinstance(el, dict):
                continue
            if str(el.get("kind") or "").strip() not in ("wrapperGraph", "scenarioSubgraph"):
                continue
            g = el.get("graph")
            if isinstance(g, dict):
                yield g, cid, str(el.get("id") or "").strip()


# 与 TS 权威 `PRIVATE_SIGNAL_LISTENER_OWNER_TYPES`（narrativeGraphValidation.ts）逐字镜像；
# 对账测试在 test_narrative_private_signals，改任何一处先改 TS 再镜像过来。
_PRIVATE_SIGNAL_LISTENER_OWNER_TYPES = ("npc", "hotspot", "zone")


def _validate_private_signal_listeners(data: Any, issues: list[Issue]) -> None:
    """私有信号监听面：只有实体 owner（npc/hotspot/zone）绑定的图能听（与 TS 同文案）。

    判据是 ownerType 白名单而不是"成对非空"（终审复审 G-2）：现网 flow/scenario 图
    都带成对 owner，按成对判会全部放行——正常四档发射面产生不了那些发射方（死监听），
    explicit 档还能手写 owner 把共用私有信号灌进主线监听面，故判 error。
    白名单镜像 TS `PRIVATE_SIGNAL_LISTENER_OWNER_TYPES`，对账测试在
    test_narrative_private_signals。无人监听则是 warning（先接线后写图是合法流程）。
    """
    private_ids: list[str] = []
    for s in (data.get("signals") or []) if isinstance(data, dict) else []:
        if not isinstance(s, dict) or s.get("scope") != "private":
            continue
        sid = str(s.get("id") or "").strip()
        if sid and sid not in private_ids:
            private_ids.append(sid)
    if not private_ids:
        return
    private_set = set(private_ids)
    listened: set[str] = set()
    for graph, _cid, _eid in _compiled_narrative_graph_refs(data):
        gid = str(graph.get("id") or "").strip()
        owner_bound = (
            str(graph.get("ownerType") or "").strip() in _PRIVATE_SIGNAL_LISTENER_OWNER_TYPES
            and bool(str(graph.get("ownerId") or "").strip())
        )
        for t in graph.get("transitions") or []:
            if not isinstance(t, dict):
                continue
            # 与 TS 权威逐字对齐（终审 H4）：不 trim，见 narrative_state_editor 同款注释。
            trigger = t.get("trigger")
            if trigger and trigger != "signal":
                continue
            key = str(t.get("signal") or "").strip()
            if key not in private_set:
                continue
            listened.add(key)
            if owner_bound:
                continue
            issues.append(Issue(
                "error", "narrative", gid,
                f'{gid}: 只有实体 owner（npc/hotspot/zone）绑定的 wrapper 图能监听私有信号 "{key}"'
                f"（私有信号按发射方实体定向投递，flow/主线图听不到；要让剧情感知请另发一条全局信号）",
            ))
    for sid in private_ids:
        if sid in listened:
            continue
        issues.append(Issue(
            "warning", "narrative", sid,
            f'私有信号 "{sid}" 没有任何 wrapper 图监听（发射它不会推动任何状态）',
        ))


def _validate_narrative(model: ProjectModel, issues: list[Issue]) -> None:
    """叙事状态机数据一致性：信号注册表、Transition 信号引用、黑盒 emits 与对话图实际发信号的漂移。

    目标：策划在状态图画布上看到的因果关系必须与运行时真值一致。
    """
    data = model.narrative_graphs
    if not isinstance(data, dict) or not data.get("compositions"):
        return
    registered = _narrative_registered_signal_ids(model)
    graphs = _narrative_graph_index(model)

    # sceneGroup 是限定引用（sceneId:groupId）。运行时按 ownerId 绑定实体分组；
    # 目标缺失时状态机黑盒仍会加载但永远没有合法宿主，必须在保存前显式报错。
    known_scene_groups = {value for value, _label in model.all_scene_group_ids()}

    def _scan_scene_group_owners(obj: Any, path: str) -> None:
        if isinstance(obj, dict):
            if str(obj.get("ownerType") or "").strip() == "sceneGroup":
                owner_id = str(obj.get("ownerId") or "").strip()
                if not owner_id:
                    issues.append(Issue(
                        "error", "narrative", path,
                        "ownerType=sceneGroup 时 ownerId 必须为 sceneId:groupId",
                    ))
                elif ":" not in owner_id or owner_id not in known_scene_groups:
                    issues.append(Issue(
                        "error", "narrative", path,
                        f"sceneGroup ownerId {owner_id!r} 不存在（须引用现有 sceneId:groupId）",
                    ))
            for key, value in obj.items():
                _scan_scene_group_owners(value, f"{path}.{key}")
        elif isinstance(obj, list):
            for index, value in enumerate(obj):
                _scan_scene_group_owners(value, f"{path}[{index}]")

    _scan_scene_group_owners(data.get("compositions") or [], "compositions")

    # npc / hotspot / zone 的 wrapper：运行时以**裸**实体 id 建 owner 索引
    # （InteractionCoordinator 传 npc.def.id / hotspot.def.id，ZoneSystem 传 zone.id），
    # 写成 `场景:实体id` 的限定形式会索引不上——wrapper 照常加载、状态照常推进，
    # 但按 owner 的查询永远落空，图里的 ownerState 静默走 missingWrapperNext。
    # 这是"编辑器看着绑好了、跑起来什么都没发生"的一类死绑，必须构建期报死。
    _scene_entity_ids: dict[str, set[str]] = {"npc": set(), "hotspot": set(), "zone": set()}
    _qualified_to_bare: dict[str, dict[str, str]] = {"npc": {}, "hotspot": {}, "zone": {}}
    for _sid, _scene in (model.scenes or {}).items():
        if not isinstance(_scene, dict):
            continue
        for _key, _kind in (("npcs", "npc"), ("hotspots", "hotspot"), ("zones", "zone")):
            for _e in _scene.get(_key) or []:
                if not isinstance(_e, dict):
                    continue
                _eid = str(_e.get("id", "")).strip()
                if not _eid:
                    continue
                _scene_entity_ids[_kind].add(_eid)
                _qualified_to_bare[_kind][f"{_sid}:{_eid}"] = _eid

    def _scan_entity_wrapper_owners(obj: Any, path: str) -> None:
        if isinstance(obj, dict):
            owner_type = str(obj.get("ownerType") or "").strip()
            owner_id = str(obj.get("ownerId") or "").strip()
            if owner_type in _scene_entity_ids and owner_id:
                if owner_id not in _scene_entity_ids[owner_type]:
                    bare = _qualified_to_bare[owner_type].get(owner_id)
                    if bare:
                        issues.append(Issue(
                            "error", "narrative", path,
                            f"{owner_type} wrapper 的 ownerId {owner_id!r} 用了「场景:实体id」限定形式，"
                            f"运行时按裸 id 建 owner 索引、永远匹配不上（ownerState 会静默走 "
                            f"missingWrapperNext）。改成 {bare!r}。",
                        ))
                    else:
                        issues.append(Issue(
                            "warning", "narrative", path,
                            f"{owner_type} wrapper 的 ownerId {owner_id!r} 在场景数据里找不到对应实体，"
                            f"该 wrapper 按 owner 的查询永远落空",
                        ))
            for key, value in obj.items():
                _scan_entity_wrapper_owners(value, f"{path}.{key}")
        elif isinstance(obj, list):
            for index, value in enumerate(obj):
                _scan_entity_wrapper_owners(value, f"{path}[{index}]")

    _scan_entity_wrapper_owners(data.get("compositions") or [], "compositions")

    # 0. 叙事图状态动作树里的 updateQuest.id 必须存在于 quests.json（承接审查新增）：
    # 运行时对未知任务 id 无声跳过，画布上「盖章推进任务」实际不生效。
    _quest_ids = {str(q.get("id", "")) for q in model.quests if isinstance(q, dict) and q.get("id")}

    _repeatable_ids = _repeatable_quest_ids(model)

    def _scan_update_quest(obj: Any, gid: str) -> None:
        if isinstance(obj, dict):
            if obj.get("type") == "updateQuest":
                qid = str((obj.get("params") or {}).get("id") or "").strip()
                if qid and qid not in _quest_ids:
                    issues.append(Issue(
                        "error", "narrative", gid,
                        f"updateQuest 目标任务 {qid!r} 不在 quests.json（运行时静默跳过，任务不会推进）",
                    ))
                elif qid and qid in _repeatable_ids:
                    issues.append(Issue(
                        "error", "narrative", gid,
                        f"updateQuest 不可指向 repeatable 任务 {qid!r}（无状态机；活计用 start/reset/revertNarrativeRun 驱动）",
                    ))
            for v in obj.values():
                _scan_update_quest(v, gid)
        elif isinstance(obj, list):
            for v in obj:
                _scan_update_quest(v, gid)

    for g in _iter_narrative_graphs(model):
        gid = str(g.get("id") or "?")
        states = g.get("states")
        if isinstance(states, dict):
            _scan_update_quest(states, gid)
    # 悬垂监听检查的两个「有人发」集合（口径对齐网页 TaskBusPanel 的 danglingSignalNoEmit）：
    # 实发 = emitted_signal_ids（对话图 + 内容资产 + 叙事图 action 树 + 派生广播）；
    # 声明 = 全项目 blackbox meta.emits 并集（声明未真发的漂移由下方第 3 段单独报）。
    emitted = set(emitted_signal_ids(model))
    declared_emits: set[str] = set()
    for comp in data.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            if not isinstance(el, dict):
                continue
            for raw in (el.get("meta") or {}).get("emits") or []:
                s = str(raw).strip()
                if s:
                    declared_emits.add(s)

    # 1. 信号注册表：重复 id + scope 取值
    seen: set[str] = set()
    for s in data.get("signals") or []:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or "").strip()
        if not sid:
            issues.append(Issue("error", "narrative", "signals", "信号注册表存在空 id"))
            continue
        if sid in seen:
            issues.append(Issue("error", "narrative", "signals", f"信号 id 重复: {sid!r}"))
        seen.add(sid)
        # 私有信号声明。TS 权威（narrativeGraphValidation.ts / signal.scope.invalid）判的是
        # `scope !== undefined`；这里把「缺键」与「显式 null」一并当未声明跳过——兜底只许更松。
        scope = s.get("scope")
        if scope is not None and scope not in ("global", "private"):
            issues.append(Issue(
                "error", "narrative", sid,
                f"{sid}: signal scope must be 'global' or 'private'",
            ))

    _validate_private_signal_listeners(data, issues)

    # 2. Transition.signal：须为已注册信号 / state:<图>:<状态> / __draft__（草稿告警）
    for g in _iter_narrative_graphs(model):
        gid = str(g["id"])
        for t in g.get("transitions") or []:
            if not isinstance(t, dict):
                continue
            trig = str(t.get("trigger") or "").strip()
            if trig in ("reactive", "reactiveAll", "reactiveAny"):
                # 条件驱动迁移：signal 仅为占位（约定 __draft__），不参与触发
                if not (t.get("conditions") or []):
                    issues.append(Issue(
                        "error", "narrative", gid,
                        f"Transition {t.get('id')!r} 为 reactive 触发但缺少 conditions",
                    ))
                continue
            sig = str(t.get("signal") or "").strip()
            tid = str(t.get("id") or "?")
            if not sig:
                issues.append(Issue("error", "narrative", gid, f"Transition {tid!r} 缺少 signal"))
                continue
            if sig == "__draft__":
                issues.append(Issue(
                    "warning", "narrative", gid,
                    f"Transition {tid!r} 仍是草稿信号 __draft__（不会被任何来源触发）",
                ))
                continue
            if sig.startswith("state:"):
                parts = sig.split(":", 2)
                ref_g = parts[1] if len(parts) > 1 else ""
                ref_s = parts[2] if len(parts) > 2 else ""
                if ref_g not in graphs:
                    issues.append(Issue(
                        "error", "narrative", gid,
                        f"Transition {tid!r} 的跨图信号引用的图 {ref_g!r} 不存在",
                    ))
                elif ref_s not in graphs[ref_g]:
                    issues.append(Issue(
                        "error", "narrative", gid,
                        f"Transition {tid!r} 的跨图信号引用的状态 {ref_g}:{ref_s} 不存在",
                    ))
                continue
            if sig not in registered:
                issues.append(Issue(
                    "warning", "narrative", gid,
                    f"Transition {tid!r} 的信号 {sig!r} 未在信号注册表（signals）登记",
                ))
            # 悬垂监听：注册≠有人发。允许「先接线后写对话」的合法流程，故 warning 不 error。
            if sig not in emitted and sig not in declared_emits:
                issues.append(Issue(
                    "warning", "narrative", gid,
                    f"Transition {tid!r} 监听信号 {sig!r}，但全项目没有任何对话/资产/叙事图发出它，"
                    f"也无画布黑盒声明（悬垂监听，永远不会触发）",
                ))

    # 3. dialogueBlackbox meta.emits 与对话图实际 emitNarrativeSignal 的漂移（画布不可说谎）
    gd = model.dialogues_path / "graphs"
    for comp in data.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            if not isinstance(el, dict) or el.get("kind") != "dialogueBlackbox":
                continue
            ref = str(el.get("refId") or "").strip()
            if not ref:
                continue
            declared = {
                str(x).strip()
                for x in ((el.get("meta") or {}).get("emits") or [])
                if str(x).strip()
            }
            path = gd / f"{ref}.json"
            if not path.is_file():
                issues.append(Issue(
                    "warning", "narrative", str(comp.get("id") or "?"),
                    f"dialogueBlackbox 引用的对话图 {ref!r} 不存在",
                ))
                continue
            try:
                gdata = read_json(path)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            actual: set[str] = set()
            for node in (gdata.get("nodes") or {}).values() if isinstance(gdata, dict) else []:
                if not isinstance(node, dict):
                    continue
                for act in node.get("actions") or []:
                    if isinstance(act, dict) and act.get("type") == "emitNarrativeSignal":
                        sig = str((act.get("params") or {}).get("signal") or "").strip()
                        if sig:
                            actual.add(sig)
            for missing in sorted(declared - actual):
                issues.append(Issue(
                    "warning", "narrative", str(comp.get("id") or "?"),
                    f"画布黑盒 {ref!r} 声明发出 {missing!r}，但对话图里没有对应 emitNarrativeSignal（画布与真值漂移）",
                ))
            for undeclared in sorted(actual - declared):
                issues.append(Issue(
                    "warning", "narrative", str(comp.get("id") or "?"),
                    f"对话图 {ref!r} 实际发出 {undeclared!r}，但画布黑盒未声明（画布与真值漂移）",
                ))


_REACTIVE_TRIGGERS = frozenset({"reactive", "reactiveAll", "reactiveAny"})


def _narrative_graphs_read_by(node: Any) -> set[str]:
    """条件树里被读到的叙事图 id（``{narrative, state}`` 叶，含 all/any/not 任意嵌套）。"""
    out: set[str] = set()

    def walk(n: Any) -> None:
        if isinstance(n, dict):
            gid = str(n.get("narrative") or "").strip()
            if gid:
                out.add(gid)
            for value in n.values():
                walk(value)
        elif isinstance(n, list):
            for value in n:
                walk(value)

    walk(node)
    return out


def _validate_reactive_cycles(model: ProjectModel, issues: list[Issue]) -> None:
    """反应式迁移的读依赖成环 —— 排空循环可能振荡。

    只查 **reactive 系**迁移（reactive / reactiveAll / reactiveAny）：它们在每轮队列排空后
    被自动重评、不需要任何外部信号，是唯一能自持的回路。运行时对此只有事后兜底
    （``NarrativeStateManager`` 的 ``drain.loop.guard``：超过步数上限就清空队列并报 error，
    注释同一口径——"几乎总是反应式迁移条件互相触发形成振荡"）。本检查把它提前到编排期。

    信号驱动的回路不在此列：那要追 emit→listen 链，且合法的可重复内容天然成环，报出来
    全是噪音。

    判据是**保守**的：**有环不一定振荡**（环上条件可能永不同时成立），但**无环保证不振荡**。
    所以报 warning 而不是 error——它说的是"这里值得看一眼"，不是"这里错了"。
    """
    # deps[G] = G 的 reactive 迁移条件读到的图集合；边 H → G 表示"H 换态可能让 G 动"。
    deps: dict[str, set[str]] = {}
    for graph in _iter_narrative_graphs(model):
        gid = str(graph.get("id") or "").strip()
        if not gid:
            continue
        for t in graph.get("transitions") or []:
            if not isinstance(t, dict):
                continue
            if str(t.get("trigger") or "signal").strip() not in _REACTIVE_TRIGGERS:
                continue
            read = _narrative_graphs_read_by(t.get("conditions"))
            if read:
                deps.setdefault(gid, set()).update(read)
    if not deps:
        return

    # 只保留工程内真实存在的图（悬垂引用由既有校验点名，这里不重复报）。
    known = {str(g.get("id") or "").strip() for g in _iter_narrative_graphs(model)}
    edges: dict[str, set[str]] = {}
    for consumer, sources in deps.items():
        for src in sources:
            if src in known:
                edges.setdefault(src, set()).add(consumer)

    # Tarjan 求强连通分量：size ≥ 2 的分量 = 互相依赖；自环 = 自己读自己。
    index_of: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    counter = [0]
    components: list[list[str]] = []

    def strongconnect(v: str) -> None:
        index_of[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on_stack.add(v)
        for w in sorted(edges.get(v, ())):
            if w not in index_of:
                strongconnect(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], index_of[w])
        if low[v] == index_of[v]:
            comp: list[str] = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                comp.append(w)
                if w == v:
                    break
            components.append(comp)

    for node in sorted(set(edges) | {c for cs in edges.values() for c in cs}):
        if node not in index_of:
            strongconnect(node)

    for comp in components:
        if len(comp) >= 2:
            names = " → ".join(sorted(comp))
            issues.append(Issue(
                "warning", "narrative", sorted(comp)[0],
                f"反应式迁移读依赖成环：{names} → {sorted(comp)[0]}。"
                "这几张图的 reactive 条件互相读对方状态，排空时可能反复触发（运行时表现为"
                " drain.loop.guard 清空队列、叙事停住）。确认环上条件不会同时成立，"
                "或把其中一条改成信号驱动。",
            ))
        elif comp and comp[0] in edges.get(comp[0], ()):
            gid = comp[0]
            issues.append(Issue(
                "warning", "narrative", gid,
                f"图 {gid!r} 的反应式迁移条件读了本图自己的状态：迁移本身会改这个状态，"
                "重评时可能再次成立而反复触发。确认这是有意的（如条件带 not），"
                "否则改用 from 端约束。",
            ))


_PLANE_KNOWN_TOP_KEYS = frozenset((
    "id", "label", "extends", "membership",
    "movement", "interaction", "camera", "lighting", "travel", "healthDrainPerSec",
))
_PLANE_MOVEMENT_NUM_KEYS = ("driftX", "driftY", "speedScale")
_PLANE_INTERACTION_KEYS = ("canPickup", "canInteractHotspots", "canTalkNpcs")


def _plane_id_set(model: ProjectModel) -> set[str]:
    return {
        str(p.get("id") or "").strip()
        for p in model.planes
        if isinstance(p, dict) and str(p.get("id") or "").strip()
    }


def _validate_narrative_templates(model: ProjectModel, issues: list[Issue]) -> None:
    """narrative_templates.json（编辑器专用模板，运行时永不加载）占位符感知校验。

    ``{{...}}`` 认作合法洞、不当坏引用；声明了没用到 / 用了没声明 = warning；缺 id / 缺
    composition / id 重复 = error。骨架里的引用大多是占位符，故不做跨文件存在性检查——
    真正的存在性由盖章期（stamp）撞名检测与盖章后的 narrative_graphs 校验兜底。
    """
    data = getattr(model, "narrative_templates", None)
    try:
        from .shared.narrative_templates import validate_templates_file
    except Exception:  # pragma: no cover - defensive
        return
    # 重名检测必须读原始磁盘文件：加载期 normalize 已静默去重（保留首条），模型里永远
    # 看不到重复——不读原文件这条检查就是死代码，而下次保存会把第二条从磁盘上抹掉。
    raw_path = model.data_path / "narrative_templates.json"
    if raw_path.is_file():
        try:
            import json as _json
            raw = _json.loads(raw_path.read_text(encoding="utf-8"))
            raw_templates = raw.get("templates") if isinstance(raw, dict) else raw
            seen_ids: set[str] = set()
            if isinstance(raw_templates, list):
                for t in raw_templates:
                    if not isinstance(t, dict):
                        continue
                    tid = str(t.get("id") or "").strip()
                    if tid and tid in seen_ids:
                        issues.append(Issue(
                            "warning", "narrative_template", tid,
                            f"narrative_templates.json 里模板 id「{tid}」重复：编辑器加载只认第一条，"
                            "下次保存会把后面的重复条目从磁盘删除——请先手工去重",
                        ))
                    if tid:
                        seen_ids.add(tid)
        except Exception:
            pass  # 文件损坏由加载路径容错，这里不重复报
    if not isinstance(data, dict) or not (data.get("templates") or []):
        return
    for row in validate_templates_file(data):
        sev = "error" if row.get("severity") == "error" else "warning"
        item = str(row.get("itemId") or "narrative_templates")
        issues.append(Issue(sev, "narrative_template", item, str(row.get("message") or row.get("code"))))


def plane_extends_errors(planes: list) -> list[tuple[str, str]]:
    """planes 的 extends 缺父/成环检查，返回 (位面id, 错误信息) 列表。

    运行时（PlaneReconciler.expandExtends）对这两类问题只 console.warn 并静默忽略
    继承——数据意义被改变，必须在保存/校验层拦成 error。_validate_planes 与
    ProjectModel.save_all 预校验共用本函数，避免两处逻辑漂移（复核 P1-04）。
    """
    ids: set[str] = set()
    extends_of: dict[str, str] = {}
    for p in planes or []:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip()
        if not pid:
            continue
        ids.add(pid)
        ext = p.get("extends")
        if isinstance(ext, str) and ext.strip():
            extends_of[pid] = ext.strip()
    errs: list[tuple[str, str]] = []
    for pid, parent in extends_of.items():
        if parent not in ids:
            errs.append((pid, f"extends 的父位面 {parent!r} 不在 planes.json 中"))
    for pid in extends_of:
        trail: set[str] = set()
        cur: str | None = pid
        while cur is not None and cur in extends_of:
            if cur in trail:
                errs.append((pid, f"extends 链存在环（经 {cur!r}），运行时将忽略继承"))
                break
            trail.add(cur)
            cur = extends_of.get(cur)
    return errs


def _validate_planes(model: ProjectModel, issues: list[Issue]) -> None:
    """planes.json（PlaneDef[]）结构 + 实体 planes / 叙事 activePlane 引用存在性。

    契约（src/systems/plane/types.ts）：id 非空唯一；movement/interaction/camera/lighting
    为对象；未知顶层键 warning。实体归属引用不存在的位面 = error；跨图多于一个声明
    activePlane 的图 = error（决议：运行时恒单激活，组合需求走 extends 组合位面）；
    extends 缺父/成环 = error（运行时忽略继承兜底）。
    """
    seen: set[str] = set()
    for p in model.planes:
        if not isinstance(p, dict):
            issues.append(Issue("error", "plane", "?", "条目须为对象（PlaneDef）"))
            continue
        pid = str(p.get("id") or "").strip()
        if not pid:
            issues.append(Issue("error", "plane", "?", "缺少 id"))
            continue
        if pid in seen:
            issues.append(Issue("error", "plane", pid, f"id 重复: {pid!r}"))
        seen.add(pid)
        label = p.get("label")
        if label is not None and not isinstance(label, str):
            issues.append(Issue("error", "plane", pid, "label 须为字符串"))
        ext = p.get("extends")
        if ext is not None and (not isinstance(ext, str) or not ext.strip()):
            issues.append(Issue("error", "plane", pid, "extends 须为非空字符串（父位面 id）"))
        mem = p.get("membership")
        if mem is not None and mem not in ("shared", "exclusive"):
            issues.append(Issue(
                "error", "plane", pid,
                "membership 须为 'shared' 或 'exclusive'（世界模型：缺省实体是否存在）",
            ))
        if pid == "normal" and mem == "exclusive":
            issues.append(Issue(
                "error", "plane", pid,
                "normal 位面恒为 shared（共享世界型），不可配 membership='exclusive'",
            ))
        mv = p.get("movement")
        if mv is not None:
            if not isinstance(mv, dict):
                issues.append(Issue("error", "plane", pid, "movement 须为对象"))
            else:
                for key in _PLANE_MOVEMENT_NUM_KEYS:
                    v = mv.get(key)
                    if v is None:
                        continue
                    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
                        issues.append(Issue("error", "plane", pid, f"movement.{key} 须为有限数值"))
                ar = mv.get("allowRun")
                if ar is not None and not isinstance(ar, bool):
                    issues.append(Issue("error", "plane", pid, "movement.allowRun 须为布尔"))
        it = p.get("interaction")
        if it is not None:
            if not isinstance(it, dict):
                issues.append(Issue("error", "plane", pid, "interaction 须为对象"))
            else:
                for key in _PLANE_INTERACTION_KEYS:
                    v = it.get(key)
                    if v is not None and not isinstance(v, bool):
                        issues.append(Issue("error", "plane", pid, f"interaction.{key} 须为布尔"))
        cam = p.get("camera")
        if cam is not None:
            if not isinstance(cam, dict):
                issues.append(Issue("error", "plane", pid, "camera 须为对象"))
            else:
                z = cam.get("zoom")
                if z is not None and (
                    isinstance(z, bool) or not isinstance(z, (int, float))
                    or not math.isfinite(float(z)) or float(z) <= 0
                ):
                    issues.append(Issue("error", "plane", pid, "camera.zoom 须为正有限数"))
        lt = p.get("lighting")
        if lt is not None and not isinstance(lt, dict):
            issues.append(Issue("error", "plane", pid, "lighting 须为对象（partial SceneLightEnv）"))
        tv = p.get("travel")
        if tv is not None:
            if not isinstance(tv, dict):
                issues.append(Issue("error", "plane", pid, "travel 须为对象"))
            else:
                amt = tv.get("allowMapTravel")
                if amt is not None and not isinstance(amt, bool):
                    issues.append(Issue("error", "plane", pid, "travel.allowMapTravel 须为布尔"))
        hd = p.get("healthDrainPerSec")
        if hd is not None and (
            isinstance(hd, bool) or not isinstance(hd, (int, float))
            or not math.isfinite(float(hd)) or float(hd) < 0
        ):
            issues.append(Issue("error", "plane", pid, "healthDrainPerSec 须为非负有限数"))
        for key in p.keys():
            if key not in _PLANE_KNOWN_TOP_KEYS:
                issues.append(Issue(
                    "warning", "plane", pid,
                    f"未知顶层键 {key!r}（PlaneDef 之外的字段，运行时不消费）",
                ))
    # --- extends 存在性 + 环检测（运行时忽略非法继承，此处必须 error 拦住）---
    # 与 save_all 预校验共用 plane_extends_errors，防两处逻辑漂移。
    for pid, msg in plane_extends_errors(model.planes):
        issues.append(Issue("error", "plane", pid, msg))

    if model.planes and "normal" not in seen:
        issues.append(Issue(
            "error", "plane", "planes",
            "planes.json 缺少 id='normal' 的常态位面（契约：normal 为开局默认激活位面）",
        ))

    known = _plane_id_set(model)
    explicit_member_counts: dict[str, int] = {}

    # --- 实体归属 planes 引用存在性（hotspot / npc / zone）---
    for sid, sc in model.scenes.items():
        if not isinstance(sc, dict):
            continue
        for key in ("hotspots", "npcs", "zones"):
            for ent in sc.get(key) or []:
                if not isinstance(ent, dict):
                    continue
                # 世界模型提示：项目启用多位面后，transition 未声明 planes 时在
                # exclusive 位面下会随缺省实体一起消失（玩家可能困死在异世界）。
                if (
                    key == "hotspots"
                    and len(known) > 1
                    and str(ent.get("type") or "") == "transition"
                    and "planes" not in ent
                ):
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"transition '{ent.get('id') or '?'}' 未声明 planes 归属"
                        "（项目已有多位面；独立世界型位面下该出口将不存在，请确认是否有意）",
                    ))
                if "planes" not in ent:
                    continue
                eid = str(ent.get("id") or "?")
                raw = ent.get("planes")
                if not isinstance(raw, list):
                    issues.append(Issue(
                        "error", "scene", sid,
                        f"{key[:-1]} '{eid}' 的 planes 须为字符串数组",
                    ))
                    continue
                for ref in raw:
                    ref_s = str(ref or "").strip()
                    if not ref_s:
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"{key[:-1]} '{eid}' 的 planes 含空 id",
                        ))
                    elif ref_s not in known:
                        issues.append(Issue(
                            "error", "scene", sid,
                            f"{key[:-1]} '{eid}' 归属的位面 {ref_s!r} 不在 planes.json 中",
                        ))
                    else:
                        explicit_member_counts[ref_s] = explicit_member_counts.get(ref_s, 0) + 1

    # --- exclusive（独立世界型）位面全项目零显式归属实体 = 空世界 ---
    for pid in sorted(known):
        if pid == "normal":
            continue
        if model.plane_membership(pid) == "exclusive" and not explicit_member_counts.get(pid):
            issues.append(Issue(
                "warning", "plane", pid,
                "独立世界型（exclusive）位面没有任何显式归属实体：激活后是空世界"
                "（缺省实体不存在），请给实体 planes 加该位面或改回 shared",
            ))

    # --- 叙事状态 activePlane 引用存在性 + 跨图点名口径（2026-07-10 制作人拍板）---
    # 同一个位面被多张图点名 = 完全合法不报：模板从 archetype 盖出的每单任务各是一图、
    # 共用同一位面（如多单背尸活），运行时按「最后进入的状态」逐态派生，毫无歧义。
    # 只有「多张图点名了**不同**位面」才提示（warning）：静态无法证明它们不会同时处于
    # 点名状态，运行时后进者胜为兜底——请确认这些任务不会同时进行。
    plane_declaring_graphs: dict[str, set[str]] = {}
    for g in _iter_narrative_graphs(model):
        gid = str(g["id"])
        states = g.get("states")
        if not isinstance(states, dict):
            continue
        for stid, st in states.items():
            if not isinstance(st, dict) or "activePlane" not in st:
                continue
            ap = st.get("activePlane")
            if not isinstance(ap, str) or not ap.strip():
                issues.append(Issue(
                    "error", "narrative", gid,
                    f"状态 {stid!r} 的 activePlane 须为非空字符串",
                ))
                continue
            if ap.strip() not in known:
                issues.append(Issue(
                    "error", "narrative", gid,
                    f"状态 {stid!r} 点名的位面 {ap.strip()!r} 不在 planes.json 中",
                ))
            plane_declaring_graphs.setdefault(ap.strip(), set()).add(gid)
    if len(plane_declaring_graphs) > 1:
        detail = "; ".join(
            f"{pid}: {', '.join(sorted(gids))}"
            for pid, gids in sorted(plane_declaring_graphs.items())
        )
        issues.append(Issue(
            "warning", "narrative", "planes",
            f"多张叙事图点名了不同位面（{detail}）；若这些任务可能同时处于点名状态，"
            "运行时按后进者胜——请确认互斥（同一位面被多图点名不在此列，完全合法）",
        ))


def _validate_plane_action_pairing(model: ProjectModel, issues: list[Issue]) -> None:
    """activatePlane 配对检查（anywhere_scoped 决议）。

    过场内的 activatePlane 随 cutscene:end 自动清除，无需配对；过场外为 session 语义
    ——非过场资产的 action 树里出现 `activatePlane` 而**同资产**内没有任何
    `deactivatePlane`，多半是忘了收（玩家会永久卡在该位面），报 warning。
    粗粒度递归扫描（不区分分支可达性），资产粒度：scene 文件 / quest / encounter /
    叙事图 / pressure_hold / signal_cue 条目。
    """
    def scan(obj: object, found: set[str]) -> None:
        if isinstance(obj, dict):
            t = obj.get("type")
            if t in ("activatePlane", "deactivatePlane"):
                found.add(str(t))
            for v in obj.values():
                scan(v, found)
        elif isinstance(obj, list):
            for v in obj:
                scan(v, found)

    assets: list[tuple[str, str, object]] = []
    for sid, sc in model.scenes.items():
        assets.append(("scene", sid, sc))
    for q in model.quests:
        if isinstance(q, dict):
            assets.append(("quest", str(q.get("id") or "?"), q))
    for e in model.encounters:
        if isinstance(e, dict):
            assets.append(("encounter", str(e.get("id") or "?"), e))
    for g in _iter_narrative_graphs(model):
        assets.append(("narrative", str(g["id"]), g))
    for h in model.pressure_holds:
        if isinstance(h, dict):
            assets.append(("pressure_hold", str(h.get("id") or "?"), h))
    for c in model.signal_cues:
        if isinstance(c, dict):
            assets.append(("signal_cue", str(c.get("id") or "?"), c))
    for data_type, item_id, payload in assets:
        found: set[str] = set()
        scan(payload, found)
        if "activatePlane" in found and "deactivatePlane" not in found:
            issues.append(Issue(
                "warning", data_type, item_id,
                "出现 activatePlane 但同资产内无 deactivatePlane：过场外的手动覆盖持续到"
                " deactivate/读档（压过叙事点名）。确认由别处收尾，或改用叙事点名/过场内激活",
            ))


def _validate_pressure_holds(model: ProjectModel, issues: list[Issue]) -> None:
    """pressure_holds.json：结构 + 内嵌 Action 校验（id 唯一、fillSeconds 正数、atRatio 严格递增）。"""
    seen: set[str] = set()
    for h in model.pressure_holds:
        if not isinstance(h, dict):
            issues.append(Issue("error", "pressure_hold", "?", "条目须为对象"))
            continue
        hid = str(h.get("id") or "").strip()
        if not hid:
            issues.append(Issue("error", "pressure_hold", "?", "缺少 id"))
            continue
        if hid in seen:
            issues.append(Issue("error", "pressure_hold", hid, f"id 重复: {hid!r}"))
        seen.add(hid)
        try:
            fs = float(h.get("fillSeconds"))
            if not (fs > 0) or not math.isfinite(fs):
                raise ValueError
        except (TypeError, ValueError):
            issues.append(Issue("error", "pressure_hold", hid, "fillSeconds 须为正有限数"))
        if not str(h.get("prompt") or "").strip():
            issues.append(Issue("warning", "pressure_hold", hid, "prompt 为空（进度条无引导文案）"))
        bar = h.get("barColor")
        if bar is not None and not re.fullmatch(r"#[0-9a-fA-F]{6}", str(bar)):
            issues.append(Issue("error", "pressure_hold", hid, "barColor 须为 #rrggbb"))
        sfx = str(h.get("holdSfx") or "").strip()
        if sfx and sfx not in (model.audio_config.get("sfx") or {}):
            issues.append(Issue("warning", "pressure_hold", hid, f"holdSfx {sfx!r} 不在 audio_config.sfx 中"))
        prev = 0.0
        for i, it in enumerate(h.get("interrupts") or []):
            if not isinstance(it, dict):
                issues.append(Issue("error", "pressure_hold", hid, f"interrupts[{i}] 须为对象"))
                continue
            try:
                r = float(it.get("atRatio"))
            except (TypeError, ValueError):
                issues.append(Issue("error", "pressure_hold", hid, f"interrupts[{i}].atRatio 须为数值"))
                continue
            if not (0 < r < 1):
                issues.append(Issue("error", "pressure_hold", hid, f"interrupts[{i}].atRatio 须在 (0,1) 内"))
            if r <= prev and i > 0:
                issues.append(Issue("error", "pressure_hold", hid, f"interrupts[{i}].atRatio 须严格递增"))
            prev = r
            rt = it.get("resetToRatio")
            if rt is not None:
                try:
                    rtv = float(rt)
                    if not (0 <= rtv < 1):
                        raise ValueError
                except (TypeError, ValueError):
                    issues.append(Issue("error", "pressure_hold", hid, f"interrupts[{i}].resetToRatio 须在 [0,1) 内"))
            _walk_action_defs(model, issues, it.get("actions"), "pressure_hold", hid, None)
        _walk_action_defs(model, issues, h.get("onComplete"), "pressure_hold", hid, None)


def _validate_document_reveals(model: ProjectModel, issues: list[Issue]) -> None:
    """document_reveals.json 的揭示音效引用（口径同 pressure_hold.holdSfx）。

    条目本身的 id / 图片 / 条件由编辑器保存门与素材审计各管一段，这里只补音频引用面：
    新增引用面必须有校验，否则改名/删音效后静默失声。
    """
    for d in model.document_reveals or []:
        if not isinstance(d, dict):
            continue
        did = str(d.get("id") or "?").strip() or "?"
        sfx = str(d.get("revealSfx") or "").strip()
        if sfx and sfx not in (model.audio_config.get("sfx") or {}):
            issues.append(Issue(
                "warning", "document_reveal", did,
                f"revealSfx {sfx!r} 不在 audio_config.sfx 中",
            ))
        vol = d.get("revealSfxVolume")
        if vol is None:
            continue
        if isinstance(vol, bool) or not isinstance(vol, (int, float)):
            issues.append(Issue(
                "error", "document_reveal", did, "revealSfxVolume 须为数值",
            ))
        elif not sfx:
            issues.append(Issue(
                "warning", "document_reveal", did,
                "配了 revealSfxVolume 却没有 revealSfx（音量无处生效）",
            ))
        elif vol < 0 or vol > 1:
            issues.append(Issue(
                "warning", "document_reveal", did,
                f"revealSfxVolume {vol} 超出 0..1（运行时按 0..1 钳制）",
            ))


def _validate_signal_cues(model: ProjectModel, issues: list[Issue]) -> None:
    """signal_cues.json：id 唯一 + 内嵌 Action 校验（含 cue 自引用检查）。"""
    seen: set[str] = set()
    for c in model.signal_cues:
        if not isinstance(c, dict):
            issues.append(Issue("error", "signal_cue", "?", "条目须为对象"))
            continue
        cid = str(c.get("id") or "").strip()
        if not cid:
            issues.append(Issue("error", "signal_cue", "?", "缺少 id"))
            continue
        if cid in seen:
            issues.append(Issue("error", "signal_cue", cid, f"id 重复: {cid!r}"))
        seen.add(cid)
        actions = c.get("actions")
        if not isinstance(actions, list):
            issues.append(Issue("error", "signal_cue", cid, "actions 须为数组"))
            continue
        for act in actions:
            if isinstance(act, dict) and act.get("type") == "playSignalCue":
                ref = str((act.get("params") or {}).get("id") or "").strip()
                if ref == cid:
                    issues.append(Issue("error", "signal_cue", cid, "cue 不可自引用（运行时会被拒绝）"))
        _walk_action_defs(model, issues, actions, "signal_cue", cid, None)



# 动作 target 的角色档前缀。与 `src/systems/BubbleChatterSystem.ts` 的
# `CHARACTER_TARGET_PREFIX` 是一份手工镜像，parity 由 test_bubble_speaker_model.py 钉住。
BUBBLE_CHARACTER_TARGET_PREFIX = "character:"


def _bubble_speaker_key_from_def(speaker: dict) -> str:
    """台词本 speaker → 说话人键（镜像 BubbleChatterSystem.ts 的 speakerKey）。"""
    kind = str(speaker.get("kind") or "").strip()
    if kind == "player":
        return "player"
    if kind == "character":
        cid = str(speaker.get("characterId") or "").strip()
        return f"{BUBBLE_CHARACTER_TARGET_PREFIX}{cid}" if cid else ""
    eid = str(speaker.get("id") or "").strip()
    return f"entity:{eid}" if eid else ""


def _bubble_speaker_key_from_target(target: str) -> str:
    """动作 target 串 → 说话人键（镜像 BubbleChatterSystem.ts 的 bubbleSpeakerFromActionTarget）。

    ⚠ 与 `_bubble_speaker_key_from_def` 对空值的处理**刻意不同**，因为 TS 两侧本就不同：
    台词本侧先过 `normalizeSpeaker`（空 id ＝非法说话人，整组跳过，故这里返回空串），
    动作侧的 `bubbleSpeakerFromActionTarget` 不做规范化、空串照样落成 `{kind:'entity',id:''}`。
    """
    raw = str(target or "").strip()
    if raw == "player":
        return "player"
    if raw.startswith(BUBBLE_CHARACTER_TARGET_PREFIX):
        cid = raw[len(BUBBLE_CHARACTER_TARGET_PREFIX):].strip()
        if cid:
            return f"{BUBBLE_CHARACTER_TARGET_PREFIX}{cid}"
    return f"entity:{raw}"


def _bubble_speaker_entity_scenes(model: ProjectModel) -> dict[str, set[str]]:
    """实体 id → 定义它的场景集合（只算 NPC 与热点，与 resolveEmoteTarget 同口径）。"""
    out: dict[str, set[str]] = {}
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        for key in ("npcs", "hotspots"):
            for e in scene.get(key) or []:
                if not isinstance(e, dict):
                    continue
                eid = str(e.get("id", "") or "").strip()
                if eid:
                    out.setdefault(eid, set()).add(str(sid))
    return out


def _bubble_character_placements(model: ProjectModel) -> dict[str, list[str]]:
    """角色 id → 引用它的 NPC 摆放所在场景（含重复：同场景两个摆放就出现两次）。"""
    out: dict[str, list[str]] = {}
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            cid = str(npc.get("characterId", "") or "").strip()
            if cid:
                out.setdefault(cid, []).append(str(sid))
    return out


def _validate_bubble_lines(model: ProjectModel, issues: list[Issue]) -> None:
    """bubble_lines.json：id 唯一、说话人可解析、场景存在、至少一句台词、条件可求值。

    说话人漏配是这张表最容易犯的错——运行时解析不到就**整组静默不说话**，
    策划只会看到"配了没反应"，所以这里按 error 拦。

    三档说话人各有各的失效方式（口径与 `src/systems/BubbleChatterSystem.ts` 一致）：
    - `player`    ——「当前受控的那个人」，恒可解析，只校验别的字段；
    - `character` —— 得有摆放才有嘴：注册表里没有、或全工程/限定场景里没有任何 NPC
                     引用它，运行时都是整组不说话；
    - `entity`    —— 实体 id 是**场景相对**的。钉死的场景里没有这个实体＝永远不响（error）；
                     没钉场景而该 id 又跨场景重名＝同名的另一个也会跟着说（warning）。
    """
    data = getattr(model, "bubble_lines", None)
    if not isinstance(data, dict):
        if data not in (None, {}, []):
            issues.append(Issue("error", "bubble_lines", "?", "bubble_lines.json 顶层须为对象 {tuning, lineSets}"))
        return
    sets = data.get("lineSets")
    if sets is None:
        return
    if not isinstance(sets, list):
        issues.append(Issue("error", "bubble_lines", "?", "lineSets 须为数组"))
        return

    # ⚠ 合法实体集刻意**只有 NPC 与热点**（`_bubble_speaker_entity_scenes` 不收 zone）：
    # 运行时 resolveEmoteTarget 只认「过场演员 / NPC / player / 当前场景热点」。把 zone
    # 算进来就等于放行一种"配了完全没反应"的写法——正是这条 error 本来要拦的那类。
    entity_scenes = _bubble_speaker_entity_scenes(model)
    known_entities = set(entity_scenes)
    character_placements = _bubble_character_placements(model)
    known_characters = set(getattr(model, "character_registry", None) or {})
    known_scenes = set(model.all_scene_ids())
    seen: set[str] = set()
    for c in sets:
        if not isinstance(c, dict):
            issues.append(Issue("error", "bubble_lines", "?", "条目须为对象"))
            continue
        cid = str(c.get("id") or "").strip()
        if not cid:
            issues.append(Issue("error", "bubble_lines", "?", "缺少 id"))
            continue
        if cid in seen:
            issues.append(Issue("error", "bubble_lines", cid, f"id 重复: {cid!r}"))
        seen.add(cid)

        pinned = [str(sc) for sc in (c.get("scenes") or [])]
        sp = c.get("speaker")
        if not isinstance(sp, dict) or sp.get("kind") not in ("player", "character", "entity"):
            issues.append(Issue(
                "error", "bubble_lines", cid,
                "speaker 须为 {kind:'player'} / {kind:'character', characterId} / {kind:'entity', id}",
            ))
        elif sp.get("kind") == "character":
            ch = str(sp.get("characterId") or "").strip()
            placed = character_placements.get(ch) or []
            if not ch:
                issues.append(Issue("error", "bubble_lines", cid, "speaker.kind=character 时必须填 characterId"))
            elif ch not in known_characters:
                issues.append(Issue(
                    "error", "bubble_lines", cid,
                    f"speaker.characterId {ch!r} 不在 character_registry.json 中",
                ))
            elif not placed:
                issues.append(Issue(
                    "error", "bubble_lines", cid,
                    f"角色 {ch!r} 没有任何场景摆放引用它（运行时找不到嘴＝整组不说话）",
                ))
            elif pinned and not (set(placed) & set(pinned)):
                issues.append(Issue(
                    "error", "bubble_lines", cid,
                    f"角色 {ch!r} 在限定的场景 {pinned!r} 里没有摆放（整组永远不响）",
                ))
            else:
                # 同一场景两个摆放引用同一角色：运行时取第一个可见的，另一个永远说不上话
                relevant = [s for s in placed if not pinned or s in pinned]
                dup = {s for s in relevant if relevant.count(s) > 1}
                if dup:
                    issues.append(Issue(
                        "warning", "bubble_lines", cid,
                        f"场景 {sorted(dup)!r} 里有多个摆放引用角色 {ch!r}；"
                        "运行时只让其中第一个可见的说话",
                    ))
        elif sp.get("kind") == "entity":
            eid = str(sp.get("id") or "").strip()
            defined_in = entity_scenes.get(eid) or set()
            if not eid:
                issues.append(Issue("error", "bubble_lines", cid, "speaker.kind=entity 时必须填 id"))
            elif eid not in known_entities:
                issues.append(Issue(
                    "error", "bubble_lines", cid,
                    f"speaker.id {eid!r} 不是任何场景里的实体（运行时解析不到＝整组不说话）",
                ))
            elif pinned and not (defined_in & set(pinned)):
                issues.append(Issue(
                    "error", "bubble_lines", cid,
                    f"实体 {eid!r} 不在限定的场景 {pinned!r} 里（运行时按当前场景解析＝整组永远不响）",
                ))
            elif not pinned and len(defined_in) > 1:
                issues.append(Issue(
                    "warning", "bubble_lines", cid,
                    f"实体 id {eid!r} 在 {sorted(defined_in)!r} 多个场景重名，却没钉死场景——"
                    "同名的另一个也会跟着说；用编辑器「选点…」重选一次即可钉死",
                ))

        for sc in pinned:
            if sc not in known_scenes:
                issues.append(Issue("error", "bubble_lines", cid, f"scenes 里的场景 {sc!r} 不存在"))

        lines = c.get("lines")
        if not isinstance(lines, list) or not [
            ln for ln in lines if isinstance(ln, dict) and str(ln.get("text") or "").strip()
        ]:
            issues.append(Issue("error", "bubble_lines", cid, "至少要有一句非空台词"))

        trig = c.get("trigger")
        if trig is not None and trig not in ("ambient", "approach"):
            issues.append(Issue("error", "bubble_lines", cid, f"trigger 只能是 ambient / approach，得到 {trig!r}"))
        pick = c.get("pickMode")
        if pick is not None and pick not in ("random", "sequence"):
            issues.append(Issue("error", "bubble_lines", cid, f"pickMode 只能是 random / sequence，得到 {pick!r}"))

def _validate_water_minigames(model: ProjectModel, issues: list[Issue]) -> None:
    """water_minigames 各实例的实体动作一致性（对齐其它数据类型的 _walk_action_defs）。

    cue/hint 与动作参数里的 [tag:…] 已由 ref_validator.validate_all_embedded_refs 统一覆盖；
    此处补它够不到的「动作类型是否登记 / 裸 id 参数引用（giveItem.id、startCutscene.id…）」，
    免得 onPick/onPullSuccess/onPullFail 里的坏引用一路漏到运行时才暴露。
    """
    bag = getattr(model, "water_minigames_instances", None)
    if not isinstance(bag, dict):
        return
    for iid, doc in bag.items():
        if not isinstance(doc, dict):
            continue
        ents = doc.get("entities")
        if not isinstance(ents, list):
            continue
        for ent in ents:
            if not isinstance(ent, dict):
                continue
            eid = str(ent.get("id") or "").strip() or "?"
            ctx = f"{iid}:{eid}"
            for hook in ("onPick", "onPullSuccess", "onPullFail"):
                acts = ent.get(hook)
                if isinstance(acts, list):
                    _walk_action_defs(model, issues, acts, "water_minigame", ctx, None)


def _validate_paper_craft(model: ProjectModel, issues: list[Issue]) -> None:
    """paper_craft 各实例/订单的结构一致性（编辑器保存抓不到的跨字段引用）：
    槽位 accepts 引用的部件须存在、correctPaper 须指向已声明纸色、三档结果动作
    （onSuccess/Warn/Bad）的动作类型与裸 id 参数引用须合法——免得坏引用漏到运行时。"""
    bag = getattr(model, "paper_craft_instances", None)
    if not isinstance(bag, dict):
        return
    for iid, doc in bag.items():
        if not isinstance(doc, dict):
            continue
        orders = doc.get("orders")
        if not isinstance(orders, list):
            continue
        for order in orders:
            if not isinstance(order, dict):
                continue
            oid = str(order.get("id") or "").strip() or "?"
            ctx = f"{iid}:{oid}"
            for opt_key in ("paperOptions", "finishOptions"):
                rows = order.get(opt_key)
                if not isinstance(rows, list) or not rows:
                    issues.append(Issue(
                        "error", "paper_craft", ctx,
                        f"{opt_key} 为空：运行时加载即拒（PaperCraftMinigameScene 要求每张订单至少 1 条）",
                    ))
            part_ids = {
                str(p.get("id") or "").strip()
                for p in (order.get("parts") or [])
                if isinstance(p, dict) and p.get("id")
            }
            paper_ids = {
                str(p.get("id") or "").strip()
                for p in (order.get("paperOptions") or [])
                if isinstance(p, dict) and p.get("id")
            }
            for slot in (order.get("slots") or []):
                if not isinstance(slot, dict):
                    continue
                slabel = str(slot.get("id") or slot.get("label") or "?")
                for pid in (slot.get("accepts") or []):
                    if str(pid) not in part_ids:
                        issues.append(Issue(
                            "warning", "paper_craft", ctx,
                            f"槽位 {slabel!r} 的 accepts 引用了不存在的部件 id {pid!r}",
                        ))
            cp = str(order.get("correctPaper") or "").strip()
            if cp and cp not in paper_ids:
                issues.append(Issue(
                    "warning", "paper_craft", ctx,
                    f"correctPaper {cp!r} 不在该订单 paperOptions 中",
                ))
            for hook in ("onSuccessActions", "onWarnActions", "onBadActions"):
                acts = order.get(hook)
                if isinstance(acts, list):
                    _walk_action_defs(model, issues, acts, "paper_craft", ctx, None)


def _object_examine_item_exists(model: ProjectModel, item_id: str) -> bool:
    iid = str(item_id or "").strip()
    if not iid:
        return False
    for it in getattr(model, "items", None) or []:
        if isinstance(it, dict) and str(it.get("id") or "").strip() == iid:
            return True
    return False


def _validate_object_examine(model: ProjectModel, issues: list[Issue]) -> None:
    """object_examine：静帧呈现 + 热区动作链校验。"""
    bag = getattr(model, "object_examine_instances", None)
    if not isinstance(bag, dict):
        return
    for iid, doc in bag.items():
        if not isinstance(doc, dict):
            continue
        ctx = str(iid)
        pres = doc.get("presentation")
        if not isinstance(pres, dict) or str(pres.get("kind") or "").strip() != "still":
            issues.append(Issue(
                "error", "object_examine", ctx,
                "presentation.kind 须为 still（一期）",
            ))
        elif not str(pres.get("image") or "").strip():
            issues.append(Issue(
                "error", "object_examine", ctx,
                "presentation.image 不能为空",
            ))
        else:
            bp = pres.get("backgroundPreset")
            if bp is not None and str(bp).strip() not in {
                "mud", "straw", "wood", "stone", "softGlow", "",
            }:
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    f"presentation.backgroundPreset 非法：{bp!r}（允许 mud/straw/wood/stone/softGlow）",
                ))
            bb = pres.get("backgroundBrightness")
            if bb is not None and not isinstance(bb, (int, float)):
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    f"presentation.backgroundBrightness 须为数值，当前 {bb!r}",
                ))
            elif isinstance(bb, (int, float)) and not (0.2 <= float(bb) <= 2.5):
                issues.append(Issue(
                    "warning", "object_examine", ctx,
                    f"presentation.backgroundBrightness={bb} 建议落在 0.2～2.5",
                ))
            bs = pres.get("backgroundScale")
            if bs is not None and not isinstance(bs, (int, float)):
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    f"presentation.backgroundScale 须为数值，当前 {bs!r}",
                ))
            elif isinstance(bs, (int, float)) and not (0.5 <= float(bs) <= 2.5):
                issues.append(Issue(
                    "warning", "object_examine", ctx,
                    f"presentation.backgroundScale={bs} 建议落在 0.5～2.5",
                ))
            cai = pres.get("contactAoIntensity")
            if cai is not None and not isinstance(cai, (int, float)):
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    f"presentation.contactAoIntensity 须为数值，当前 {cai!r}",
                ))
            elif isinstance(cai, (int, float)) and not (0 <= float(cai) <= 3):
                issues.append(Issue(
                    "warning", "object_examine", ctx,
                    f"presentation.contactAoIntensity={cai} 建议落在 0～3",
                ))
            if "contactAoScale" in pres:
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    "presentation.contactAoScale 已废弃（那是贴图像素倍率，换分辨率就变味）；"
                    "改写 contactAoRadiusCm（真实半径，厘米），并补 physicalWidthCm",
                ))
            pw = pres.get("physicalWidthCm")
            if pw is not None and not isinstance(pw, (int, float)):
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    f"presentation.physicalWidthCm 须为数值，当前 {pw!r}",
                ))
            elif isinstance(pw, (int, float)) and not (0.5 <= float(pw) <= 2000):
                issues.append(Issue(
                    "warning", "object_examine", ctx,
                    f"presentation.physicalWidthCm={pw} 建议落在 0.5～2000（厘米）",
                ))
            car = pres.get("contactAoRadiusCm")
            if car is not None and not isinstance(car, (int, float)):
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    f"presentation.contactAoRadiusCm 须为数值，当前 {car!r}",
                ))
            elif isinstance(car, (int, float)) and not (0 <= float(car) <= 8):
                issues.append(Issue(
                    "warning", "object_examine", ctx,
                    f"presentation.contactAoRadiusCm={car} 建议落在 0～8（厘米）",
                ))
            # AO 是按真实长度算的：没有标尺就只能吃兜底值，观感会跟物件实际大小脱节。
            ao_on = not (isinstance(cai, (int, float)) and float(cai) <= 0)
            if pw is None and ao_on:
                issues.append(Issue(
                    "warning", "object_examine", ctx,
                    "presentation 未声明 physicalWidthCm（静帧横向真实宽度，厘米）；"
                    "接触 AO 半径按真实长度换算，缺标尺会退回 100cm 兜底",
                ))
            # ---- 氛围里的物理量：长度/速度一律厘米制，旧的比例/倍率字段一律报错 ----
            amb_doc = doc.get("ambience") or {}
            LEGACY_AMBIENCE_FIELDS = [
                (("dust",), "radius", "radiusCm", "颗粒半径倍率"),
                (("flyingFlies",), "orbitRadius", "roamRadiusCm", "活动域倍率"),
                (("flyingFlies",), "speed", "speedCmPerSec", "速度倍率"),
                (("flyingFlies",), "size", "lengthCm", "尺寸倍率"),
                (("cloudShadow",), "speed", "speedCmPerSec", "设计像素/秒"),
                (("crawlers", "centipede"), "speed", "speedCmPerSec", "速度倍率"),
                (("crawlers", "centipede"), "size", "lengthCm", "尺寸倍率"),
                (("crawlers", "beetles"), "radius", "radiusCm", "长边比例"),
                (("crawlers", "beetles"), "size", "lengthCm", "尺寸倍率"),
            ]
            for path, old_key, new_key, what in LEGACY_AMBIENCE_FIELDS:
                node = amb_doc
                for seg in path:
                    node = node.get(seg) if isinstance(node, dict) else None
                    if node is None:
                        break
                if isinstance(node, dict) and old_key in node:
                    issues.append(Issue(
                        "error", "object_examine", ctx,
                        f"ambience.{'.'.join(path)}.{old_key} 已废弃（{what}，换张分辨率不同的图就变味）；"
                        f"改写 {new_key}（真实单位）",
                    ))
            maggots_doc = (amb_doc.get("crawlers") or {}).get("maggots")
            if isinstance(maggots_doc, dict):
                for cl in (maggots_doc.get("clusters") or []):
                    if not isinstance(cl, dict):
                        continue
                    for old_key, new_key in (("radius", "radiusCm"), ("size", "lengthCm")):
                        if old_key in cl:
                            issues.append(Issue(
                                "error", "object_examine", ctx,
                                f"ambience.crawlers.maggots.clusters[].{old_key} 已废弃；"
                                f"改写 {new_key}（厘米）",
                            ))
            for path, key, lo, hi in [
                (("crawlers", "terrain"), "reliefCm", 0, 200),
                (("crawlers", "terrain"), "grooveFollow", 0, 1),
                (("crawlers", "terrain"), "climbSlowdown", 0, 2),
                (("dust",), "radiusCm", 0.02, 8),
                (("flyingFlies",), "roamRadiusCm", 1, 200),
                (("flyingFlies",), "speedCmPerSec", 1, 200),
                (("flyingFlies",), "lengthCm", 0.2, 40),
                (("cloudShadow",), "speedCmPerSec", 0.1, 10),
                (("crawlers", "centipede"), "speedCmPerSec", 1, 200),
                (("crawlers", "centipede"), "lengthCm", 0.5, 150),
                (("crawlers", "beetles"), "radiusCm", 0.2, 100),
                (("crawlers", "beetles"), "lengthCm", 0.1, 40),
            ]:
                node = amb_doc
                for seg in path:
                    node = node.get(seg) if isinstance(node, dict) else None
                    if node is None:
                        break
                if not isinstance(node, dict):
                    continue
                v = node.get(key)
                if v is None:
                    continue
                label = f"ambience.{'.'.join(path)}.{key}"
                if not isinstance(v, (int, float)):
                    issues.append(Issue(
                        "error", "object_examine", ctx, f"{label} 须为数值，当前 {v!r}"))
                elif not (lo <= float(v) <= hi):
                    issues.append(Issue(
                        "warning", "object_examine", ctx,
                        f"{label}={v} 建议落在 {lo}～{hi}"))

            crawlers = (doc.get("ambience") or {}).get("crawlers")
            if isinstance(crawlers, dict):
                cshadow = crawlers.get("contactShadow")
                if isinstance(cshadow, dict):
                    if "size" in cshadow:
                        issues.append(Issue(
                            "error", "object_examine", ctx,
                            "ambience.crawlers.contactShadow.size 已废弃（尺寸倍率）；"
                            "改写 radiusCm（真实半径，厘米）",
                        ))
                    csr = cshadow.get("radiusCm")
                    if csr is not None and not isinstance(csr, (int, float)):
                        issues.append(Issue(
                            "error", "object_examine", ctx,
                            f"ambience.crawlers.contactShadow.radiusCm 须为数值，当前 {csr!r}",
                        ))
                    elif isinstance(csr, (int, float)) and not (0 <= float(csr) <= 8):
                        issues.append(Issue(
                            "warning", "object_examine", ctx,
                            f"ambience.crawlers.contactShadow.radiusCm={csr} 建议落在 0～8（厘米）",
                        ))
        hotspots = doc.get("hotspots")
        if not isinstance(hotspots, list):
            issues.append(Issue(
                "error", "object_examine", ctx,
                "hotspots 须为数组",
            ))
            continue
        seen: set[str] = set()
        for hs in hotspots:
            if not isinstance(hs, dict):
                continue
            hid = str(hs.get("id") or "").strip()
            if not hid:
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    "存在缺少 id 的热区",
                ))
                continue
            if hid in seen:
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    f"热区 id 重复：{hid!r}",
                ))
            seen.add(hid)
            for key in ("x", "y", "width", "height"):
                if not isinstance(hs.get(key), (int, float)):
                    issues.append(Issue(
                        "warning", "object_examine", f"{ctx}:{hid}",
                        f"热区缺少数值字段 {key}",
                    ))
            decoy = hs.get("decoy")
            if decoy is not None and not isinstance(decoy, bool):
                issues.append(Issue(
                    "error", "object_examine", f"{ctx}:{hid}",
                    f"hotspot.decoy 须为布尔，当前 {decoy!r}",
                ))
            for shade_k in ("shadeUiX", "shadeUiY"):
                sv = hs.get(shade_k)
                if sv is None:
                    continue
                if not isinstance(sv, (int, float)) or isinstance(sv, bool):
                    issues.append(Issue(
                        "error", "object_examine", f"{ctx}:{hid}",
                        f"hotspot.{shade_k} 须为数值，当前 {sv!r}",
                    ))
                elif not (0.0 <= float(sv) <= 1.0):
                    issues.append(Issue(
                        "warning", "object_examine", f"{ctx}:{hid}",
                        f"hotspot.{shade_k}={sv} 建议落在 0～1（屏幕归一化）",
                    ))
            acts = hs.get("actions")
            if isinstance(acts, list):
                _walk_action_defs(model, issues, acts, "object_examine", f"{ctx}:{hid}", None)
            on_found = hs.get("onFound")
            if isinstance(on_found, list):
                _walk_action_defs(
                    model, issues, on_found, "object_examine", f"{ctx}:{hid}:onFound", None,
                )
            for use in hs.get("itemUses") or []:
                if not isinstance(use, dict):
                    continue
                item_id = str(use.get("itemId") or "").strip()
                if not item_id:
                    issues.append(Issue(
                        "error", "object_examine", f"{ctx}:{hid}",
                        "itemUses 条目缺少 itemId",
                    ))
                elif not _object_examine_item_exists(model, item_id):
                    issues.append(Issue(
                        "warning", "object_examine", f"{ctx}:{hid}",
                        f"itemUses.itemId 未在物品表找到：{item_id!r}",
                    ))
                use_acts = use.get("actions")
                if isinstance(use_acts, list):
                    _walk_action_defs(
                        model, issues, use_acts, "object_examine",
                        f"{ctx}:{hid}:item:{item_id or '?'}", None,
                    )
            for op in hs.get("operations") or []:
                if not isinstance(op, dict):
                    continue
                oid = str(op.get("id") or "").strip() or "?"
                req = op.get("requiresItem")
                if req is not None:
                    req_s = str(req).strip()
                    if not req_s:
                        issues.append(Issue(
                            "error", "object_examine", f"{ctx}:{hid}:{oid}",
                            "operations.requiresItem 不能为空字符串",
                        ))
                    elif not _object_examine_item_exists(model, req_s):
                        issues.append(Issue(
                            "warning", "object_examine", f"{ctx}:{hid}:{oid}",
                            f"requiresItem 未在物品表找到：{req_s!r}",
                        ))
                op_acts = op.get("actions")
                if isinstance(op_acts, list):
                    _walk_action_defs(
                        model, issues, op_acts, "object_examine", f"{ctx}:{hid}:{oid}", None,
                    )
        on_all = doc.get("onAllFound")
        if isinstance(on_all, list):
            _walk_action_defs(model, issues, on_all, "object_examine", f"{ctx}:onAllFound", None)
        smell = doc.get("smell")
        if smell is not None:
            if not isinstance(smell, dict) or not str(smell.get("scent") or "").strip():
                issues.append(Issue(
                    "error", "object_examine", ctx,
                    "smell 须为含 scent 的对象",
                ))
            else:
                scent = str(smell.get("scent")).strip()
                profiles = getattr(model, "smell_profiles", None) or {}
                bag = profiles.get("profiles") if isinstance(profiles, dict) else None
                if isinstance(bag, dict) and scent not in bag:
                    issues.append(Issue(
                        "warning", "object_examine", ctx,
                        f"smell.scent 未在 smell_profiles 登记：{scent!r}",
                    ))
        audio = doc.get("audio")
        if audio is not None and not isinstance(audio, dict):
            issues.append(Issue(
                "error", "object_examine", ctx,
                "audio 须为对象",
            ))
        amb = doc.get("ambience")
        if amb is not None and not isinstance(amb, dict):
            issues.append(Issue(
                "error", "object_examine", ctx,
                "ambience 须为对象",
            ))


def _validate_item_tags(it: dict, iid: str, issues: list[Issue]) -> None:
    """标签必须是字符串列表，且收敛到受控词表。

    词表外的值只报 warning **不拦**（编辑器同样原样保值）：拦下来就成了"加个类别
    还得先改代码"。但必须报——「辟邪 / 驱邪 / 避邪」并存时按类别匹配会安静地少匹配
    一批物件，运行时不会有任何抱怨。
    """
    raw = it.get("tags")
    if raw is None:
        return
    if not isinstance(raw, list):
        issues.append(Issue(
            "error", "item", iid, f"tags 必须是字符串数组，当前 {type(raw).__name__}"))
        return
    seen: set[str] = set()
    for t in raw:
        if not isinstance(t, str) or not t.strip():
            issues.append(Issue("error", "item", iid, f"tags 含空/非字符串条目：{t!r}"))
            continue
        tag = t.strip()
        if tag in seen:
            issues.append(Issue("warning", "item", iid, f"tags 重复：{tag!r}"))
        seen.add(tag)
        if not is_known_item_tag(tag):
            issues.append(Issue(
                "warning", "item", iid,
                f"tags 含受控词表外的值 {tag!r}；确认不是同义词拼歧"
                "（词表在 tools/editor/shared/item_tags.py，可加）",
            ))


def _validate_item_use(model: ProjectModel, it: dict, iid: str, issues: list[Issue]) -> None:
    """物件自身用途：按钮得有字、动作树得能跑、关键道具别被自己吃掉。"""
    use = it.get("use")
    if use is None:
        return
    if not isinstance(use, dict):
        issues.append(Issue(
            "error", "item", iid, f"use 必须是对象，当前 {type(use).__name__}"))
        return
    label = use.get("label")
    if not isinstance(label, str) or not label.strip():
        issues.append(Issue(
            "error", "item", iid,
            "use.label 不能为空——背包里会画出一枚没有字的按钮；"
            "该物件若本就不该主动使用，请整个删掉 use 字段",
        ))
    consume = use.get("consume")
    if consume is not None and not isinstance(consume, bool):
        issues.append(Issue(
            "error", "item", iid, f"use.consume 须为布尔，当前 {consume!r}"))
    elif consume is True and it.get("type") == "key":
        issues.append(Issue(
            "warning", "item", iid,
            "关键道具 use.consume=true：用一次这件剧情道具就永久消失了，确认是有意的",
        ))
    hint = use.get("disableHint")
    if hint is not None and (not isinstance(hint, str) or not hint.strip()):
        issues.append(Issue(
            "error", "item", iid,
            "use.disableHint 填了就不能是空串；不想自定义理由请删掉该键（退回默认文案）",
        ))
    acts = use.get("actions")
    if acts is not None:
        if not isinstance(acts, list):
            issues.append(Issue(
                "error", "item", iid, f"use.actions 必须是数组，当前 {type(acts).__name__}"))
        else:
            _walk_action_defs(model, issues, acts, "item", f"{iid}:use", None)
    # 既不跑动作也不出文字的"使用"＝按下去只是东西少一个，玩家读不到任何反馈
    if not acts and not str(use.get("resultText", "") or "").strip():
        issues.append(Issue(
            "warning", "item", iid,
            "use 既没有 actions 也没有 resultText：按下去除了少一个物件，玩家看不到任何反馈",
        ))


def _validate_items(model: ProjectModel, issues: list[Issue]) -> None:
    """物品：背包图标存在性 + 标签词表收敛 + 自身用途（use）的完备性。

    留空是合法的（背包格子退回物品名文字显示），但**填了却指不到文件**运行时就是
    一个静默画不出来的空格子——只报到不存在/越界这两种，不强制所有物品都配图。
    """
    for it in model.items:
        if not isinstance(it, dict):
            continue
        iid = str(it.get("id", "") or "?")
        _validate_item_tags(it, iid, issues)
        _validate_item_use(model, it, iid, issues)
        raw = it.get("icon")
        if raw is None:
            continue
        if not isinstance(raw, str) or not raw.strip():
            issues.append(Issue(
                "error", "item", iid,
                "icon 必须是非空字符串；不配图请直接删掉该字段（背包会退回名称文字）",
            ))
            continue
        ref = raw.strip()
        if ref.startswith("http://") or ref.startswith("https://"):
            continue  # 远端资源不验证（与素材审计同口径）
        disk = model.paths.url_to_disk(ref, kind=URL_KIND_MEDIA)
        if disk is None:
            issues.append(Issue(
                "error", "item", iid,
                f"icon 不可解析为媒体路径（媒体必须落在 public/resources/runtime 下）：{ref!r}",
            ))
        elif not disk.is_file():
            issues.append(Issue(
                "error", "item", iid,
                f"icon 指向的图片文件不存在：{disk}",
            ))


def _validate_overlay_images(model: ProjectModel, issues: list[Issue]) -> None:
    ov = getattr(model, "overlay_images", None)
    if not isinstance(ov, dict):
        return
    for kid, pth in ov.items():
        ks = str(kid).strip()
        if not ks:
            issues.append(Issue(
                "error", "overlay_images", "overlay_images",
                "存在无效的键（空字符串），请用「叠图 ID」页修正并保存",
            ))
            continue
        ps = str(pth or "").strip()
        if not ps:
            issues.append(Issue(
                "error", "overlay_images", ks,
                f"短 id「{ks}」对应的图片路径为空",
            ))
        elif not ps.startswith("/"):
            issues.append(Issue(
                "warning", "overlay_images", ks,
                f"短 id「{ks}」的路径建议以 / 开头（/assets/...），当前：{ps[:80]}",
            ))


_PARALLAX_EASINGS = frozenset({"linear", "easeIn", "easeOut", "easeInOut"})


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _validate_one_parallax_scene(
    scene: dict, issues: list[Issue], data_type: str, item_id: str, *, where: str,
) -> None:
    """校验单个 parallax 场景结构（注册表条目或 cutscene 内联 scene 共用）。

    与运行时 CutsceneRenderer.showParallaxScene / sampleParallaxKeyframe 的读取假设对齐：
    layers 非空、每层有 image + ≥1 关键帧、关键帧 atMs/x/y 为数值且按时间非递减。
    """
    for k in ("widthRef", "heightRef"):
        v = scene.get(k)
        if not _is_num(v) or v <= 0:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{where} 的 {k} 应为正数（参考画布尺寸，运行时按 cover 映射），实为 {v!r}",
            ))
    layers = scene.get("layers")
    if not isinstance(layers, list) or not layers:
        issues.append(Issue(
            "error", data_type, item_id,
            f"{where} 缺少非空 layers（至少一层才能显示）",
        ))
        return
    seen_layer_ids: set[str] = set()
    for li, layer in enumerate(layers):
        if not isinstance(layer, dict):
            issues.append(Issue(
                "error", data_type, item_id,
                f"{where} layers[{li}] 不是对象",
            ))
            continue
        lid = str(layer.get("id") or "").strip()
        lwhere = f"{where} 层 {lid or f'#{li}'}"
        if not lid:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{where} layers[{li}] 缺 id（hideImg/句柄配对时不可寻址）",
            ))
        elif lid in seen_layer_ids:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{where} 存在重复层 id {lid!r}（运行时按 id 建 Map，重复会互相覆盖）",
            ))
        else:
            seen_layer_ids.add(lid)
        img = str(layer.get("image") or "").strip()
        if not img:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{lwhere} 缺 image（图层贴图路径；文件存在性由素材审计另查）",
            ))
        ez = layer.get("easing")
        if ez is not None and ez not in _PARALLAX_EASINGS:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{lwhere} 的 easing {ez!r} 非法（仅 {sorted(_PARALLAX_EASINGS)}）",
            ))
        if "zIndex" in layer and not _is_num(layer.get("zIndex")):
            issues.append(Issue(
                "error", data_type, item_id,
                f"{lwhere} 的 zIndex 应为数值，实为 {layer.get('zIndex')!r}",
            ))
        # depth/baseScale 是「推摄像机」编辑元数据（运行时忽略），有则须为数值。
        for k in ("depth", "baseScale"):
            if k in layer and not _is_num(layer.get(k)):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"{lwhere} 的 {k} 应为数值（推摄像机烘焙元数据），实为 {layer.get(k)!r}",
                ))
        # sourceKeyframes/sourceEasing 是相机模式下保留的「自身运动」（运行时忽略）。
        sk = layer.get("sourceKeyframes")
        if sk is not None and not isinstance(sk, list):
            issues.append(Issue(
                "error", data_type, item_id,
                f"{lwhere} 的 sourceKeyframes 应为数组（自身运动原始帧），实为 {sk!r}",
            ))
        se = layer.get("sourceEasing")
        if se is not None and se not in _PARALLAX_EASINGS:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{lwhere} 的 sourceEasing {se!r} 非法（仅 {sorted(_PARALLAX_EASINGS)}）",
            ))
        kfs = layer.get("keyframes")
        if not isinstance(kfs, list) or not kfs:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{lwhere} 缺少非空 keyframes（至少一帧确定位置）",
            ))
            continue
        prev_ms: float | None = None
        for ki, kf in enumerate(kfs):
            if not isinstance(kf, dict):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"{lwhere} keyframes[{ki}] 不是对象",
                ))
                continue
            for k in ("atMs", "x", "y"):
                if not _is_num(kf.get(k)):
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"{lwhere} keyframes[{ki}].{k} 应为数值，实为 {kf.get(k)!r}",
                    ))
            for k in ("scale", "rotation", "alpha"):
                if k in kf and not _is_num(kf.get(k)):
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"{lwhere} keyframes[{ki}].{k} 应为数值，实为 {kf.get(k)!r}",
                    ))
            ams = kf.get("atMs")
            if _is_num(ams):
                if prev_ms is not None and ams < prev_ms:
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"{lwhere} keyframes[{ki}] 的 atMs={ams} 小于前一帧 {prev_ms}"
                        f"（运行时按顺序线性插值，乱序会得到意外轨迹）",
                    ))
                prev_ms = ams

    # camera 是「推摄像机」的编辑器专用元数据：运行时完全忽略（只播 layers[].keyframes），
    # 但结构错了要提醒，别写出编辑器读不回来的脏数据。
    cam = scene.get("camera")
    if cam is not None:
        if not isinstance(cam, dict):
            issues.append(Issue(
                "error", data_type, item_id,
                f"{where} 的 camera 应为对象（推摄像机元数据），实为 {cam!r}",
            ))
        else:
            if "enabled" in cam and not isinstance(cam.get("enabled"), bool):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"{where} camera.enabled 应为布尔，实为 {cam.get('enabled')!r}",
                ))
            cks = cam.get("keyframes")
            if cks is not None and not isinstance(cks, list):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"{where} camera.keyframes 应为数组",
                ))
            elif isinstance(cks, list):
                for ci, ck in enumerate(cks):
                    if not isinstance(ck, dict):
                        issues.append(Issue(
                            "error", data_type, item_id,
                            f"{where} camera.keyframes[{ci}] 不是对象",
                        ))
                        continue
                    if not _is_num(ck.get("atMs")):
                        issues.append(Issue(
                            "error", data_type, item_id,
                            f"{where} camera.keyframes[{ci}].atMs 应为数值，实为 {ck.get('atMs')!r}",
                        ))
                    for k in ("panX", "panY", "zoom", "roll"):
                        if k in ck and not _is_num(ck.get(k)):
                            issues.append(Issue(
                                "error", data_type, item_id,
                                f"{where} camera.keyframes[{ci}].{k} 应为数值，实为 {ck.get(k)!r}",
                            ))


def _validate_parallax_scenes(model: ProjectModel, issues: list[Issue]) -> None:
    """parallax_scenes.json（parallax Web 编辑器产物）注册表校验：id 唯一 + 逐场景结构。"""
    scenes = getattr(model, "parallax_scenes", None)
    if not scenes:
        return
    if not isinstance(scenes, list):
        issues.append(Issue(
            "error", "parallax", "parallax_scenes",
            "parallax_scenes.json 顶层必须是数组",
        ))
        return
    seen: set[str] = set()
    for idx, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            issues.append(Issue(
                "error", "parallax", "parallax_scenes",
                f"parallax_scenes[{idx}] 不是对象",
            ))
            continue
        sid = str(scene.get("id") or "").strip()
        if not sid:
            issues.append(Issue(
                "error", "parallax", "parallax_scenes",
                f"parallax_scenes[{idx}] 缺 id",
            ))
            continue
        if sid in seen:
            issues.append(Issue(
                "error", "parallax", sid,
                f"重复的 parallax 场景 id {sid!r}（present:parallaxScene 按 id 取，重复会拿错）",
            ))
        seen.add(sid)
        _validate_one_parallax_scene(
            scene, issues, "parallax", sid, where=f"场景 {sid!r}",
        )


_SETFLAG_WHITELIST_CACHE: frozenset[str] | None = None
_SETFLAG_WHITELIST_LOADED = False


def _setflag_whitelist() -> frozenset[str] | None:
    """内容侧 setFlag/appendFlag key 白名单（tools/editor/setflag_whitelist.json）。

    返回 None = 文件缺失/损坏（规则失效，宁缺毋滥不误报）。规则背景：任务逻辑改状态
    的唯一通道是 emitNarrativeSignal→叙事图，内容 JSON 里的裸 setFlag 限白名单。
    """
    global _SETFLAG_WHITELIST_CACHE, _SETFLAG_WHITELIST_LOADED
    if _SETFLAG_WHITELIST_LOADED:
        return _SETFLAG_WHITELIST_CACHE
    _SETFLAG_WHITELIST_LOADED = True
    from pathlib import Path
    path = Path(__file__).resolve().parent / "setflag_whitelist.json"
    try:
        data = read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        _SETFLAG_WHITELIST_CACHE = None
        return None
    keys = data.get("keys") if isinstance(data, dict) else None
    if not isinstance(keys, list):
        _SETFLAG_WHITELIST_CACHE = None
        return None
    _SETFLAG_WHITELIST_CACHE = frozenset(
        str(k).strip() for k in keys if str(k).strip()
    )
    return _SETFLAG_WHITELIST_CACHE


def _setflag_whitelist_issue(issues: list[Issue], action_type: str, key: str,
                             data_type: str, item_id: str) -> None:
    wl = _setflag_whitelist()
    if wl is None or key in wl:
        return
    issues.append(Issue(
        "warning", data_type, item_id,
        f"{action_type} key {key!r} 不在 setFlag 白名单（tools/editor/setflag_whitelist.json）中；"
        f"任务逻辑请走 emitNarrativeSignal→叙事图，确需新 flag 先登记白名单",
    ))


def _flag_issue(model: ProjectModel, issues: list[Issue], key: str,
                data_type: str, item_id: str, scene_id: str | None) -> None:
    from .flag_registry import validate_flag_key
    reg = model.flag_registry
    # 登记表为空（新工程 / 未维护登记表）时不逐个 flag 报「未登记」——否则满屏噪声；
    # 结构性校验（未知 action、空 setFlag key、过场白名单、未知条件叶子等）不受此影响，
    # 它们不经过本函数（审查 P2-①）。
    if not reg or (not reg.get("static") and not reg.get("patterns")):
        return
    ok, msg = validate_flag_key(key, reg, model, scene_id=scene_id, severity="warning")
    if ok or not msg:
        return
    issues.append(Issue("warning", data_type, item_id, msg))


def _walk_conditions(
    model: ProjectModel, issues: list[Issue], conds: list, data_type: str,
    item_id: str, scene_id: str | None,
) -> None:
    scen = _scenario_definitions(model)
    quest_ids = {str(q.get("id", "")) for q in model.quests if q.get("id")}
    for cond in conds or []:
        if isinstance(cond, dict):
            if cond.get("flag") is not None and not any(
                k in cond for k in ("all", "any", "not", "scenario", "quest", "scenarioLine")
            ):
                fk = cond.get("flag")
                _flag_issue(model, issues, str(fk), data_type, item_id, scene_id)
            else:
                _scan_condition_expr(
                    model, issues, cond, scen, quest_ids, data_type, item_id, 0,
                    scene_id_flag=scene_id,
                )


def _scenario_definitions(model: ProjectModel) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for e in model.scenarios_catalog.get("scenarios") or []:
        if isinstance(e, dict) and e.get("id"):
            out[str(e["id"])] = e
    return out


def _cutscene_temp_actor_ids_in_steps(steps: list) -> set[str]:
    """单条过场内 cutsceneSpawnActor 产生的 _cut_* id（含 parallel 子轨）。"""
    found: set[str] = set()

    def walk(sl: list) -> None:
        for step in sl or []:
            if not isinstance(step, dict):
                continue
            if step.get("kind") == "action" and step.get("type") == "cutsceneSpawnActor":
                sid = str((step.get("params") or {}).get("id", "")).strip()
                if sid.startswith("_cut_"):
                    found.add(sid)
            tracks = step.get("tracks")
            if isinstance(tracks, list):
                for sub in tracks:
                    if isinstance(sub, dict):
                        walk([sub])

    walk(steps)
    return found


def _npc_ids_in_scene(model: ProjectModel, scene_id: str | None) -> set[str]:
    if not scene_id:
        return set()
    return {p[0] for p in model.npc_ids_for_scene(scene_id)}


def _hotspot_ids_in_scene(model: ProjectModel, scene_id: str | None) -> set[str]:
    if not scene_id:
        return set()
    return {p[0] for p in model.hotspot_ids_for_scene(scene_id)}


def _zone_ids_in_scene(model: ProjectModel, scene_id: str | None) -> set[str]:
    """场景内全部 zone id（含 depth_floor：引导指向纯遮挡区没意义但不构成"引用不存在"）。"""
    if not scene_id:
        return set()
    sc = model.scenes.get(scene_id) or {}
    out: set[str] = set()
    for z in sc.get("zones") or []:
        if isinstance(z, dict):
            zid = str(z.get("id", "") or "").strip()
            if zid:
                out.add(zid)
    return out


def _all_hotspot_ids_global_set(model: ProjectModel) -> set[str]:
    return {p[0] for p in model.all_hotspot_ids()}


def _all_npc_ids_global_set(model: ProjectModel) -> set[str]:
    return {p[0] for p in model.all_npc_ids_global()}


@lru_cache(maxsize=None)
def _ref_keys_by_kind(kind: str) -> dict[str, tuple[str, ...]]:
    """按引用种类取 {action 类型: 参数名…}，唯一真相源 = ``ENTITY_REF_PARAMS``。

    这里**绝不再手抄第二份清单**：手抄那份曾漏掉 jumpEntityTo.target，导致悬垂演员引用
    在校验里一声不吭（运行时静默跳过该步），而重构引擎那边早就登记了它。
    parity 由 ``tools/editor/tests/test_action_manifest_parity.py`` 钉住。
    """
    from .shared.entity_refactor import ENTITY_REF_PARAMS
    out: dict[str, tuple[str, ...]] = {}
    for act_type, params in ENTITY_REF_PARAMS.items():
        keys = tuple(k for k, role in params.items() if role == kind)
        if keys:
            out[act_type] = keys
    return out


def _actor_ref_keys(act_type: str) -> tuple[str, ...]:
    """该 action 里承载 actor 引用（NPC / player / 本过场 _cut_*）的参数名。"""
    return _ref_keys_by_kind("actor").get(act_type, ())


def _emote_subject_ref_keys(act_type: str) -> tuple[str, ...]:
    """emote 目标口径的参数名（actor 基础上还认当前场景热点）。

    ``bubble_speaker`` 与 emote 同宽（多认一档 ``character:<角色id>``，那不是实体引用，
    由 `_bubble_speaker_*` 一路单独校验），故此处合并同一判据。
    """
    keys = _ref_keys_by_kind("emote_subject").get(act_type, ())
    return keys + _ref_keys_by_kind("bubble_speaker").get(act_type, ())


def _actor_ref_ok(
    model: ProjectModel,
    scene_id: str | None,
    actor_id: str,
    *,
    temp_ids: frozenset[str],
    allow_player: bool,
) -> bool:
    aid = actor_id.strip()
    if not aid:
        return False
    if allow_player and aid == "player":
        return True
    if aid.startswith("_cut_") and aid in temp_ids:
        return True
    if scene_id and aid in _npc_ids_in_scene(model, scene_id):
        return True
    if not scene_id and aid in _all_npc_ids_global_set(model):
        return True
    return False


def _emote_subject_ref_ok(
    model: ProjectModel,
    scene_id: str | None,
    actor_id: str,
    *,
    temp_ids: frozenset[str],
    allow_player: bool,
) -> bool:
    """showEmote 目标：NPC / player / _cut_* / 当前场景热点（无场景上下文时用全局清单）。"""
    aid = actor_id.strip()
    if not aid:
        return False
    if allow_player and aid == "player":
        return True
    if aid.startswith("_cut_") and aid in temp_ids:
        return True
    if scene_id:
        if aid in _npc_ids_in_scene(model, scene_id):
            return True
        if aid in _hotspot_ids_in_scene(model, scene_id):
            return True
        return False
    if aid in _all_npc_ids_global_set(model):
        return True
    if aid in _all_hotspot_ids_global_set(model):
        return True
    return False


def _append_action_param_ref_issues(
    model: ProjectModel,
    issues: list[Issue],
    act: dict,
    data_type: str,
    item_id: str,
    scene_id: str | None,
    *,
    cutscene_temp_ids: frozenset[str] | None = None,
) -> None:
    """Action 参数与工程清单一致性（warning 为主，避免历史数据大量爆红）。"""
    t = act.get("type")
    if not isinstance(t, str) or not t:
        return
    p = act.get("params") if isinstance(act.get("params"), dict) else {}
    temp = cutscene_temp_ids or frozenset()
    graph_ids = set(model.all_dialogue_graph_ids())
    overlay_keys = set(model.overlay_images.keys()) if isinstance(model.overlay_images, dict) else set()

    if t in ("showEmote", "showSpeechBubble", "showEmoteAndWait", "showSpeechBubbleAndWait"):
        # 气泡台词配音：非阻塞的两个不吃 autoAdvance（运行时没有「本拍结束」这个时刻）。
        # sustain_available 恒 True——气泡常紧跟在带 hold 配音的字幕/台词之后，
        # 这里看不到上文，宁可不报也不冤枉合法的接管。
        _validate_voice_beat(
            model, issues, p, data_type, item_id, f"{t} 参数",
            sustain_available=True,
            supports_advance=t.endswith("AndWait"),
        )

    if t == "playScriptedDialogue":
        # 逐行配音：lines 是有序的，hold 留声在同一段台词里可精确记账
        sustain = False
        for li, line in enumerate(p.get("lines") or []):
            if not isinstance(line, dict):
                continue
            held = _validate_voice_beat(
                model, issues, line, data_type, item_id, f"playScriptedDialogue lines[{li}]",
                sustain_available=sustain,
            )
            if held:
                sustain = True
            elif _voice_spec_id(line.get("voice")):
                sustain = False

    if t == "emitNarrativeSignal":
        sig = str(p.get("signal") or "").strip()
        if not sig:
            issues.append(Issue("error", data_type, item_id, "emitNarrativeSignal 缺少 signal"))
        elif sig == "__draft__" or sig.startswith("state:"):
            # 保留前缀不可发射（旧逻辑对 state:* 直接跳过=静默放行伪造派生广播的盲区，
            # 2026-07-17 审查 W5）：state:* 由运行时在 broadcastOnEnter 状态自动派生广播，
            # 内容伪造可直推主线里程碑；__draft__ 是占位符，运行时 emitNarrativeSignal 拒发。
            issues.append(Issue(
                "error", data_type, item_id,
                f"emitNarrativeSignal 不可发射保留信号 {sig!r}（state:* 由运行时派生广播；__draft__ 是占位符）",
            ))
        else:
            registered = _narrative_registered_signal_ids(model)
            listened = _narrative_listened_signals(model)
            if registered and sig not in registered:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"emitNarrativeSignal 信号 {sig!r} 未在 narrative_graphs.signals 注册表登记",
                ))
            if listened and sig not in listened:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"emitNarrativeSignal 信号 {sig!r} 没有任何 Transition 监听（发出后不会推动任何迁移）",
                ))

    if t in ("startNarrativeRun", "resetNarrativeRun", "revertNarrativeRun", "activateNarrativeRun"):
        gid = str(p.get("graphId") or "").strip()
        if not gid and t != "activateNarrativeRun":  # activate 空 graphId=清激活槽（合法）
            issues.append(Issue("error", data_type, item_id, f"{t} 缺少 graphId（活计图）"))
        elif gid:
            known_graphs = {str(g.get("id") or "").strip() for g in _iter_narrative_graphs(model)}
            run_graphs = _narrative_run_graph_ids(model)
            if gid not in known_graphs:
                issues.append(Issue("error", data_type, item_id, f"{t} 目标叙事图 {gid!r} 不存在"))
            elif gid not in run_graphs:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"{t} 目标图 {gid!r} 未声明 run（常驻图不可 start/reset/revert/activate）",
                ))
            elif t == "revertNarrativeRun":
                sid = str(p.get("stateId") or "").strip()
                graph = next((g for g in _iter_narrative_graphs(model) if str(g.get("id") or "").strip() == gid), None)
                states = graph.get("states") if isinstance(graph, dict) else None
                if sid and isinstance(states, dict) and sid not in states:
                    issues.append(Issue("error", data_type, item_id, f"revertNarrativeRun 目标状态不存在: {gid}.{sid}"))

    if t == "startPressureHold":
        hid = str(p.get("id") or "").strip()
        known = {str(h.get("id") or "") for h in model.pressure_holds if isinstance(h, dict)}
        if not hid:
            issues.append(Issue("error", data_type, item_id, "startPressureHold 缺少 id"))
        elif hid not in known:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"startPressureHold id {hid!r} 不在 pressure_holds.json 中",
            ))

    if t == "playSignalCue":
        cid = str(p.get("id") or "").strip()
        known = {str(c.get("id") or "") for c in model.signal_cues if isinstance(c, dict)}
        if not cid:
            issues.append(Issue("error", data_type, item_id, "playSignalCue 缺少 id"))
        elif cid not in known:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"playSignalCue id {cid!r} 不在 signal_cues.json 中",
            ))

    if t == "setBubbleLineSet":
        sid = str(p.get("lineSetId") or "").strip()
        bl = getattr(model, "bubble_lines", None)
        sets = (bl or {}).get("lineSets") if isinstance(bl, dict) else []
        known = {str(c.get("id") or "") for c in (sets or []) if isinstance(c, dict)}
        if not sid:
            issues.append(Issue("error", data_type, item_id, "setBubbleLineSet 缺少 lineSetId"))
        elif sid not in known:
            # 运行时找不到就直接拒绝套用（只打 warn），编辑期必须拦住
            issues.append(Issue(
                "error", data_type, item_id,
                f"setBubbleLineSet lineSetId {sid!r} 不在 bubble_lines.json 中（运行时会拒绝套用）",
            ))
        else:
            # 台词本自带 speaker，与 target 对不上时运行时**静默拒绝**（只有一行 console.warn，
            # 策划只会看到"配了没反应"）。这是这一族数据里最容易犯、最难自查的错，必须编辑期拦。
            target = str(p.get("target") or "").strip()
            want = next(
                (c.get("speaker") for c in (sets or [])
                 if isinstance(c, dict) and str(c.get("id") or "") == sid),
                None,
            )
            if isinstance(want, dict) and target:
                want_key = _bubble_speaker_key_from_def(want)
                have_key = _bubble_speaker_key_from_target(target)
                if want_key and want_key != have_key:
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"setBubbleLineSet target {target!r} 与台词本 {sid!r} 的 speaker "
                        f"{want_key!r} 不一致（运行时会拒绝套用，且只在控制台留一行警告）",
                    ))

    if t == "activatePlane":
        pid = str(p.get("id") or "").strip()
        known = _plane_id_set(model)
        if not pid:
            issues.append(Issue("error", data_type, item_id, "activatePlane 缺少 id"))
        elif pid not in known:
            # 运行时对未注册位面直接拒绝激活（静默跳过），必须 error 拦在编辑期
            issues.append(Issue(
                "error", data_type, item_id,
                f"activatePlane id {pid!r} 不在 planes.json 中（运行时会拒绝激活）",
            ))

    if t == "collectClue":
        from .shared.ref_validator import clue_id_set

        cid = str(p.get("clueId") or "").strip()
        if not cid:
            issues.append(Issue("error", data_type, item_id, "collectClue 缺少 clueId"))
        elif cid not in clue_id_set(model):
            # K7 红线：引用完整性与 [tag:] 同级。运行时 ClueManager.collect 对未知 id
            # 只留一行 console.warn 并跳过（不落 flag、无回执），必须 error 拦在编辑期。
            issues.append(Issue(
                "error", data_type, item_id,
                f"collectClue clueId {cid!r} 不在 clues.json 注册表中（运行时拒绝采集、只留一行警告）",
            ))

    if t == "startDialogueGraph":
        gid = str(p.get("graphId") or "").strip()
        if gid and gid not in graph_ids:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"startDialogueGraph graphId {gid!r} 在 dialogues/graphs 下无对应 .json",
            ))
        ent = str(p.get("entry") or "").strip()
        if gid and ent:
            nodes = set(model.dialogue_graph_node_ids(gid))
            if nodes and ent not in nodes:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"startDialogueGraph entry {ent!r} 不在图 {gid!r} 的 nodes 键中",
                ))
        nid = str(p.get("npcId") or "").strip()
        if nid and not _actor_ref_ok(
            model, scene_id, nid, temp_ids=temp, allow_player=True,
        ):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"startDialogueGraph npcId {nid!r} 在当前上下文下无法解析为实体",
            ))
        owner_type = str(p.get("ownerType") or "").strip()
        owner_id = str(p.get("ownerId") or "").strip()
        if owner_type and not owner_id:
            issues.append(Issue(
                "error", data_type, item_id,
                "startDialogueGraph 显式 ownerType 时必须同时填写 ownerId；"
                "只有 ownerType=自动/空时才会继承 NPC 或场景上下文",
            ))
        elif owner_type == "sceneGroup":
            known_groups = {gid for gid, _label in model.all_scene_group_ids()}
            if owner_id not in known_groups:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"startDialogueGraph sceneGroup ownerId {owner_id!r} 不存在"
                    "（须选择 sceneId:groupId）",
                ))

    if t in ("switchScene", "changeScene"):
        ts = str(p.get("targetScene") or "").strip()
        tsp = str(p.get("targetSpawnPoint") or "").strip()
        known_scenes = set(model.all_scene_ids())
        if not ts:
            issues.append(Issue("error", data_type, item_id, f"{t} 缺少 targetScene"))
        elif ts not in known_scenes:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{t} targetScene {ts!r} 不在场景列表中",
            ))
        elif tsp and tsp not in set(model.spawn_point_keys_for_scene(ts)):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{t} targetSpawnPoint {tsp!r} 不在场景 {ts!r} 的 spawnPoints 中"
                "（运行时将回落默认出生点）",
            ))

    if t == "setHotspotDisplayImage":
        sid = str(p.get("sceneId") or "").strip()
        hid = str(p.get("hotspotId") or "").strip()
        img = str(p.get("image") or "").strip()
        if not sid:
            issues.append(Issue(
                "error", data_type, item_id,
                "setHotspotDisplayImage 缺少 sceneId",
            ))
        elif sid not in set(model.all_scene_ids()):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"setHotspotDisplayImage sceneId {sid!r} 不在场景列表中",
            ))
        if hid and sid:
            known = {x[0] for x in model.hotspot_ids_for_scene(sid)}
            if known and hid not in known:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"setHotspotDisplayImage hotspotId {hid!r} 不在场景 {sid!r} 的 hotspots 列表中",
                ))
        if not img:
            issues.append(Issue(
                "error", data_type, item_id,
                "setHotspotDisplayImage 缺少 image",
            ))
        for key, label in (("worldWidth", "worldWidth"), ("worldHeight", "worldHeight")):
            if key not in p:
                continue
            raw = p.get(key)
            if raw is None or raw is False:
                continue
            try:
                v = float(raw)
            except (TypeError, ValueError):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"setHotspotDisplayImage 的 {label} 须为数值",
                ))
                continue
            if v < 0:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"setHotspotDisplayImage 的 {label} 不可为负",
                ))
            elif v == 0:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"setHotspotDisplayImage 的 {label} 为 0 时按未填写处理，建议从 JSON 中省略",
                ))
        if "facing" in p and p.get("facing") not in (None, ""):
            fv = str(p.get("facing") or "").strip().lower()
            if fv not in ("left", "right"):
                issues.append(Issue(
                    "error", data_type, item_id,
                    "setHotspotDisplayImage 的 facing 须为 left 或 right",
                ))

    if t == "tempSetHotspotDisplayFacing":
        sid = str(p.get("sceneId") or "").strip()
        hid = str(p.get("hotspotId") or "").strip()
        fac = str(p.get("facing") or "").strip().lower()
        if not sid:
            issues.append(Issue(
                "error", data_type, item_id,
                "tempSetHotspotDisplayFacing 缺少 sceneId",
            ))
        elif sid not in set(model.all_scene_ids()):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"tempSetHotspotDisplayFacing sceneId {sid!r} 不在场景列表中",
            ))
        if hid and sid:
            known = {x[0] for x in model.hotspot_ids_for_scene(sid)}
            if known and hid not in known:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"tempSetHotspotDisplayFacing hotspotId {hid!r} 不在场景 {sid!r} 的 hotspots 列表中",
                ))
        if not hid:
            issues.append(Issue(
                "error", data_type, item_id,
                "tempSetHotspotDisplayFacing 缺少 hotspotId",
            ))
        if fac not in ("left", "right", "restore"):
            issues.append(Issue(
                "error", data_type, item_id,
                "tempSetHotspotDisplayFacing 的 facing 须为 left、right 或 restore",
            ))

    if t == "persistHotspotEnabled":
        sid_h = str(p.get("sceneId") or "").strip()
        hid_h = str(p.get("hotspotId") or "").strip()
        if not sid_h:
            issues.append(Issue(
                "error", data_type, item_id,
                "persistHotspotEnabled 缺少 sceneId",
            ))
        elif sid_h not in set(model.all_scene_ids()):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"persistHotspotEnabled sceneId {sid_h!r} 不在场景列表中",
            ))
        if hid_h and sid_h:
            known = {x[0] for x in model.hotspot_ids_for_scene(sid_h)}
            if known and hid_h not in known:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"persistHotspotEnabled hotspotId {hid_h!r} 不在场景 {sid_h!r} 的 hotspots 列表中",
                ))
        if not hid_h:
            issues.append(Issue(
                "error", data_type, item_id,
                "persistHotspotEnabled 缺少 hotspotId",
            ))
        en_h = p.get("enabled")
        if en_h is None:
            issues.append(Issue(
                "error", data_type, item_id,
                "persistHotspotEnabled 缺少 enabled",
            ))
        elif not isinstance(en_h, (bool, int, float, str)):
            issues.append(Issue(
                "error", data_type, item_id,
                "persistHotspotEnabled 的 enabled 须为布尔或可解析为布尔",
            ))
        elif isinstance(en_h, str):
            el = en_h.strip().lower()
            if el and el not in ("true", "false", "1", "0"):
                issues.append(Issue(
                    "error", data_type, item_id,
                    "persistHotspotEnabled 的 enabled 字符串须为 true/false/1/0",
                ))

    if t in ("setZoneEnabled", "persistZoneEnabled"):
        sid_z = str(p.get("sceneId") or "").strip()
        zid_z = str(p.get("zoneId") or "").strip()
        if not sid_z:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{t} 缺少 sceneId",
            ))
        elif sid_z not in set(model.all_scene_ids()):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{t} sceneId {sid_z!r} 不在场景列表中",
            ))
        if zid_z and sid_z:
            known = {x[0] for x in model.standard_zone_ids_for_scene(sid_z)}
            if known and zid_z not in known:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} zoneId {zid_z!r} 不在场景 {sid_z!r} 的普通 Zone 列表中（不含 depth_floor）",
                ))
        if not zid_z:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{t} 缺少 zoneId",
            ))
        en_z = p.get("enabled")
        if en_z is None:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{t} 缺少 enabled",
            ))
        elif not isinstance(en_z, (bool, int, float, str)):
            issues.append(Issue(
                "error", data_type, item_id,
                f"{t} 的 enabled 须为布尔或可解析为布尔",
            ))
        elif isinstance(en_z, str):
            el = en_z.strip().lower()
            if el and el not in ("true", "false", "1", "0"):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"{t} 的 enabled 字符串须为 true/false/1/0",
                ))

    if t in ("setGroupEnabled", "moveGroupBy"):
        gid_g = str(p.get("group") or "").strip()
        if not gid_g:
            issues.append(Issue(
                "error", data_type, item_id,
                f"{t} 缺少非空 group",
            ))
        elif scene_id:
            known_groups = {gid for gid, _label in model.scene_group_ids_for_scene(scene_id)}
            if known_groups and gid_g not in known_groups:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} group {gid_g!r} 不在场景 {scene_id!r} 的 entityGroups/兼容标签中",
                ))

    if t == "setEntityField":
        sid = str(p.get("sceneId") or "").strip()
        kind = str(p.get("entityKind") or "").strip()
        eid = str(p.get("entityId") or "").strip()
        field = str(p.get("fieldName") or "").strip()
        value = p.get("value")
        if sid and sid not in set(model.all_scene_ids()):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"setEntityField sceneId {sid!r} 不在场景列表中",
            ))
        if kind not in ("npc", "hotspot"):
            issues.append(Issue(
                "error", data_type, item_id,
                f"setEntityField entityKind {kind!r} 非 npc/hotspot",
            ))
        elif field and not is_valid_field(kind, field):
            issues.append(Issue(
                "error", data_type, item_id,
                f"setEntityField {kind}.{field} 不是 Save.* 可存档字段",
            ))
        if sid and kind in ("npc", "hotspot") and eid:
            known = {x[0] for x in model.entity_ids_for_scene(sid, kind)}
            if known and eid not in known:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"setEntityField {kind} id {eid!r} 不在场景 {sid!r} 中",
                ))
        if kind in ("npc", "hotspot") and field and field_meta(kind, field):
            if not value_matches_field(kind, field, value):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"setEntityField {kind}.{field} 的 value 类型不匹配",
                ))
            meta = field_meta(kind, field) or {}
            if meta.get("picker") == "animationState" and sid and eid and isinstance(value, str) and value:
                states = set(model.animation_state_names_for_actor(sid, eid))
                if states and value not in states:
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"setEntityField {kind}.{field} state {value!r} 不在 {eid!r} 的 anim.json states 中",
                    ))
            if meta.get("picker") == "portraitSlug" and isinstance(value, str) and value:
                if model.project_path is not None and not (
                    model.project_path / "public" / "resources" / "runtime" / "images"
                    / "dialogue_portraits" / value.strip()
                ).is_dir():
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"setEntityField {kind}.{field} 指向 {value!r}，但无对应立绘集目录 "
                        f"public/resources/runtime/images/dialogue_portraits/{value.strip()}/",
                    ))

    if t == "setSceneEntityPosition":
        sid = str(p.get("sceneId") or "").strip()
        kind = str(p.get("entityKind") or "").strip().lower()
        eid = str(p.get("entityId") or "").strip()
        if not sid:
            issues.append(Issue(
                "error", data_type, item_id,
                "setSceneEntityPosition 缺少 sceneId",
            ))
        elif sid not in set(model.all_scene_ids()):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"setSceneEntityPosition sceneId {sid!r} 不在场景列表中",
            ))
        if kind not in ("npc", "hotspot"):
            issues.append(Issue(
                "error", data_type, item_id,
                f"setSceneEntityPosition entityKind {kind!r} 须为 npc 或 hotspot",
            ))
        if not eid:
            issues.append(Issue(
                "error", data_type, item_id,
                "setSceneEntityPosition 缺少 entityId",
            ))
        elif sid and kind in ("npc", "hotspot"):
            known = {x[0] for x in model.entity_ids_for_scene(sid, kind)}
            if known and eid not in known:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"setSceneEntityPosition {kind} id {eid!r} 不在场景 {sid!r} 中",
                ))
        for key in ("x", "y"):
            rv = p.get(key)
            try:
                fv = float(rv)
            except (TypeError, ValueError):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"setSceneEntityPosition 的 {key} 须为数值",
                ))
                continue
            if not math.isfinite(fv):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"setSceneEntityPosition 的 {key} 须为有限数",
                ))

    if t in ("showOverlayImage", "blendOverlayImage"):
        # 引用 overlay_images.json 的是图片参数(image / fromImage / toImage),
        # 不是 id(id 仅为叠图层句柄,供 hideOverlayImage 寻址,可任意命名)。
        # 仅当填的是短 id(非 / 开头的完整路径)时才比对登记表。
        img_params = ("image",) if t == "showOverlayImage" else ("fromImage", "toImage")
        for ip in img_params:
            iv = str(p.get(ip) or "").strip()
            if iv and not iv.startswith("/") and overlay_keys and iv not in overlay_keys:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} 的 {ip} {iv!r} 不在 overlay_images.json 的键中",
                ))

    if t == "attachToSocket":
        prop_table = getattr(model, "prop_presets", None)
        prop_keys = set(prop_table.keys()) if isinstance(prop_table, dict) else set()
        prop_id = str(p.get("prop") or "").strip()
        if prop_id and prop_id not in prop_keys:
            issues.append(Issue(
                "error", data_type, item_id,
                f"attachToSocket 的 prop {prop_id!r} 不在 prop_presets.json 中"
                "（挂件预设缺席＝运行时挂不出东西，只 warn 一行）",
            ))
        # 贴图可以由 prop 预设提供，所以只在两者都没有时才是硬错
        has_img = bool(str(p.get("image") or "").strip()) or bool(
            [x for x in (p.get("images") or []) if isinstance(x, str) and x.strip()])
        if not prop_id and not has_img:
            issues.append(Issue(
                "error", data_type, item_id,
                "attachToSocket 既没给 prop 也没给 image/images——挂不出任何东西",
            ))
        for key in ("anchorX", "anchorY"):
            if key in p:
                try:
                    v = float(p[key])
                except (TypeError, ValueError):
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"attachToSocket 的 {key} 不是数字：{p[key]!r}"))
                    continue
                if not (0.0 <= v <= 1.0):
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"attachToSocket 的 {key}={v} 超出 0..1（贴图内归一化坐标，运行时会夹取）"))
        if "scale" in p:
            try:
                sv = float(p["scale"])
            except (TypeError, ValueError):
                sv = -1.0
            if sv <= 0:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"attachToSocket 的 scale={p['scale']!r} 非正数——运行时按未设处理"))

    if t == "faceEntity":
        d = str(p.get("direction") or "").strip()
        # 朝向只有左右镜像（SpriteEntity.setDirection 丢弃 dy）：up/down 运行时是空操作，
        # 曾经被编辑器下拉与本校验一起放行 → fail-closed 收掉（构建期严于运行时）。
        if d and d not in ("left", "right"):
            issues.append(Issue(
                "error", data_type, item_id,
                f"faceEntity direction {d!r} 无效：朝向只有 left/right"
                "（无上下朝向，up/down 运行时不生效）",
            ))

    if t == "startWaterMinigame":
        mid = str(p.get("id") or "").strip()
        wm_ids = {x[0] for x in model.all_water_minigame_ids()}
        if mid and wm_ids and mid not in wm_ids:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"startWaterMinigame id {mid!r} 不在 water_minigames/index.json 登记中",
            ))

    if t == "startSugarWheelMinigame":
        sid = str(p.get("id") or "").strip()
        sw_ids = {x[0] for x in model.all_sugar_wheel_minigame_ids()}
        if sid and sw_ids and sid not in sw_ids:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"startSugarWheelMinigame id {sid!r} 不在 sugar_wheel/index.json 登记中",
            ))

    if t == "startPaperCraftMinigame":
        pid = str(p.get("id") or "").strip()
        pc_ids = {x[0] for x in model.all_paper_craft_minigame_ids()}
        if pid and pc_ids and pid not in pc_ids:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"startPaperCraftMinigame id {pid!r} 不在 paper_craft/index.json 登记中",
            ))

    if t == "startObjectExamine":
        eid = str(p.get("id") or "").strip()
        oe_ids = {x[0] for x in model.all_object_examine_ids()}
        if eid and oe_ids and eid not in oe_ids:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"startObjectExamine id {eid!r} 不在 object_examine/index.json 登记中",
            ))

    for key in _emote_subject_ref_keys(t):
        aid = str(p.get(key) or "").strip()
        if aid and not _emote_subject_ref_ok(
            model, scene_id, aid, temp_ids=temp, allow_player=True,
        ):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{t} {key}={aid!r} 无法解析（需 NPC / 热点 id / player / 本过场 _cut_*）",
            ))

    for key in _actor_ref_keys(t):
        if key not in p:
            continue
        aid = str(p.get(key) or "").strip()
        if not aid:
            continue
        if not _actor_ref_ok(
            model, scene_id, aid, temp_ids=temp, allow_player=True,
        ):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{t} {key}={aid!r} 在当前上下文下无法解析为实体（NPC / player / 本过场 _cut_*）",
            ))

    if t == "playNpcAnimation":
        tgt = str(p.get("target") or "").strip()
        st = str(p.get("state") or "").strip()
        known = set(model.animation_state_names_for_actor(scene_id, tgt)) if tgt else set()
        if tgt and st and known and st not in known:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"playNpcAnimation state {st!r} 不在目标 {tgt!r} 的 anim.json states 中",
            ))
        # 可选播放参数（speed/reverse/holdFrame/thenState）：运行时对非法值容错跳过，
        # 这里 warning 提前抓（Python 兜底 ⊆ TS 权威，不升 error）
        then_st = str(p.get("thenState") or "").strip()
        if tgt and then_st and known and then_st not in known:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"playNpcAnimation thenState {then_st!r} 不在目标 {tgt!r} 的 anim.json states 中",
            ))
        spd_raw = p.get("speed")
        if spd_raw is not None and str(spd_raw).strip() != "":
            try:
                spd = float(spd_raw)
            except (TypeError, ValueError):
                spd = float("nan")
            if not math.isfinite(spd) or spd <= 0:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"playNpcAnimation speed {spd_raw!r} 须为 >0 的数值（运行时将忽略该参数）",
                ))
        hf_raw = p.get("holdFrame")
        if hf_raw is not None and str(hf_raw).strip() != "":
            try:
                hf = float(hf_raw)
            except (TypeError, ValueError):
                hf = float("nan")
            if not math.isfinite(hf):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"playNpcAnimation holdFrame {hf_raw!r} 须为数值（运行时将忽略该参数）",
                ))

    if t == "teleportEntityTo":
        sid_tp = str(p.get("sceneId") or "").strip()
        scenes_tp = set(model.all_scene_ids())
        if sid_tp and scenes_tp and sid_tp not in scenes_tp:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"teleportEntityTo sceneId {sid_tp!r} 不在场景列表中（仅编辑器复现地图，可不写）",
            ))
        # 坐标非数/非有限时运行时**整条静默跳过**（只 console.warn），必须在校验门拦下
        for key in ("x", "y"):
            rv = p.get(key)
            try:
                fv = float(rv)
            except (TypeError, ValueError):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"teleportEntityTo 的 {key} 须为数值",
                ))
                continue
            if not math.isfinite(fv):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"teleportEntityTo 的 {key} 须为有限数",
                ))

    if t == "moveEntityTo":
        sid_mp = str(p.get("sceneId") or "").strip()
        scenes_set = set(model.all_scene_ids())
        if sid_mp and scenes_set and sid_mp not in scenes_set:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"moveEntityTo sceneId {sid_mp!r} 不在场景列表中（仅编辑器复现地图，可不写）",
            ))
        for key in ("x", "y"):
            rv = p.get(key)
            try:
                fv = float(rv)
            except (TypeError, ValueError):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"moveEntityTo 的 {key} 须为数值",
                ))
                continue
            if not math.isfinite(fv):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"moveEntityTo 的 {key} 须为有限数",
                ))
        wp_raw = p.get("waypoints")
        if wp_raw is None:
            pass
        elif not isinstance(wp_raw, list):
            issues.append(Issue(
                "error", data_type, item_id,
                "moveEntityTo waypoints 须为省略或坐标对象数组 [{x,y}, …]",
            ))
        else:
            for i, it in enumerate(wp_raw):
                if not isinstance(it, dict):
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"moveEntityTo waypoints[{i}] 须为包含 x/y 的对象",
                    ))
                    continue
                try:
                    wx = float(it.get("x"))
                    wy = float(it.get("y"))
                except (TypeError, ValueError):
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"moveEntityTo waypoints[{i}] x/y 须为数值",
                    ))
                    continue
                if not math.isfinite(wx) or not math.isfinite(wy):
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"moveEntityTo waypoints[{i}] x/y 须为有限数",
                    ))
            if wp_raw and not normalize_move_entity_waypoints(wp_raw):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    "moveEntityTo waypoints 非空但未解析出任何合法坐标（折线将被忽略）",
                ))
        tgt_m = str(p.get("target") or "").strip()
        st_m = str(p.get("moveAnimState") or "").strip()
        sid_eff = sid_mp or (scene_id or "")
        fv_raw = p.get("faceTowardMovement")
        if fv_raw is not None and fv_raw not in (True, False):
            if not (
                isinstance(fv_raw, (int, float)) and fv_raw in (0, 1)
                or (
                    isinstance(fv_raw, str)
                    and str(fv_raw).strip().lower() in ("true", "false", "0", "1", "yes", "no", "")
                )
            ):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    "moveEntityTo faceTowardMovement 建议使用 JSON 布尔 true/false；其它类型运行时可能不按预期解析",
                ))
        if tgt_m and st_m and sid_eff:
            known_m = set(model.animation_state_names_for_actor(sid_eff, tgt_m))
            if known_m and st_m not in known_m:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"moveEntityTo moveAnimState {st_m!r} 不在目标 {tgt_m!r} 的动画包 states 中",
                ))

    if t in ("stopNpcPatrol", "persistNpcDisablePatrol", "persistNpcEnablePatrol"):
        raw = str(p.get("npcId") or "").strip()
        key = "npcId"
        if raw and scene_id:
            if raw not in _npc_ids_in_scene(model, scene_id):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} {key}={raw!r} 不在当前场景 {scene_id!r} 的 NPC 列表中",
                ))
        elif raw and not scene_id:
            if raw not in _all_npc_ids_global_set(model):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} {key}={raw!r} 不在任意场景的 NPC 清单中",
                ))
    if t in ("persistNpcEntityEnabled", "persistNpcAt", "persistNpcAnimState", "persistPlayNpcAnimation"):
        raw = str(p.get("target") or "").strip()
        key = "target"
        if raw and scene_id:
            if raw not in _npc_ids_in_scene(model, scene_id):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} {key}={raw!r} 不在当前场景 {scene_id!r} 的 NPC 列表中",
                ))
        elif raw and not scene_id:
            if raw not in _all_npc_ids_global_set(model):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} {key}={raw!r} 不在任意场景的 NPC 清单中",
                ))
    if t in ("persistNpcAnimState", "persistPlayNpcAnimation"):
        tgt = str(p.get("target") or "").strip()
        st = str(p.get("state") or "").strip()
        if tgt and st and scene_id:
            known = set(model.animation_state_names_for_actor(scene_id, tgt))
            if known and st not in known:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{t} state {st!r} 不在 NPC {tgt!r} 的 anim.json states 中",
                ))


def _iter_cutscene_show_dialogue(steps: object):
    """展平过场步骤（含 parallel.tracks），产出 (下标路径, showDialogue 步骤)。"""
    if not isinstance(steps, list):
        return
    for si, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        if step.get("kind") == "parallel":
            for sub_path, sub in _iter_cutscene_show_dialogue(step.get("tracks")):
                yield f"[{si}].tracks{sub_path}", sub
        elif step.get("type") == "showDialogue":
            yield f"[{si}]", step


def _contains_self_collect_clue(node: object, clue_id: str) -> bool:
    """深遍任意嵌套动作容器（runActions/chooseAction/randomBranch/addDelayedEvent…），
    找 collectClue 引用 *clue_id* 自身——防呆检查用，容器无关（照 narrative_catalog
    的 _collect_emitted_signal_ids 递归范式）。"""
    if isinstance(node, dict):
        if node.get("type") == "collectClue":
            params = node.get("params")
            if (
                isinstance(params, dict)
                and str(params.get("clueId") or "").strip() == clue_id
            ):
                return True
        return any(_contains_self_collect_clue(v, clue_id) for v in node.values())
    if isinstance(node, list):
        return any(_contains_self_collect_clue(x, clue_id) for x in node)
    return False


def _validate_clues_registry(model: ProjectModel, issues: list[Issue]) -> None:
    """线索注册表 clues.json 自身的形状（K7）。

    id 唯一 / id·title·desc 必填 / id 须为 ASCII slug（否则 `[clue:id]` 正则认不出、
    flag `clue_<id>` 也没法在文本标记里引用）= error；category 填了但不在 categories
    表里 = warning（运行时只降级为按原键分组显示，不炸）。
    [clue:] 标记的引用完整性在 ref_validator.scan_clue_markup（embeddedRef 面）。

    K7「采集=内容事件」：collectActions 非数组 = error（运行时 `.length` 判空**静默
    不执行**整批动作）；hidden 非 bool = warning（运行时按 truthy 降级）；collectActions
    里 collectClue 引用自身 id = warning（首采先落 flag 再跑动作批，自采是幂等空转——
    无害但多半是想引用别的线索）。动作批的类型/参数/嵌套容器校验在标准动作遍历通道
    （_validate_flags 的 clues 走访），不在这里重复。
    """
    from .shared.ref_validator import clue_registry_rows
    from .shared.text_palette import ID_RE

    raw = getattr(model, "clues_registry", None)
    if not isinstance(raw, dict) or not raw:
        # 模型未装载（独立工具）或活数据为空：回落磁盘读，保持旧口径。
        try:
            raw = read_json(model.data_path / "clues.json")
        except (OSError, ValueError):
            return  # 注册表尚未建立：合法（[clue:] 引用会在 embeddedRef 面报未知）
    categories = raw.get("categories") if isinstance(raw, dict) else None
    known_categories = set(categories) if isinstance(categories, dict) else set()
    seen: set[str] = set()
    for i, c in enumerate(clue_registry_rows(model)):
        cid = str(c.get("id") or "").strip()
        label = cid or f"#{i}"
        if not cid:
            issues.append(Issue("error", "clue", label, f"clues[{i}] 缺少 id"))
        elif not ID_RE.match(cid):
            issues.append(Issue(
                "error", "clue", label,
                f"线索 id {cid!r} 不是 ASCII slug（只允许字母/数字/下划线/连字符）"
                "——[clue:id] 标记与 flag clue_<id> 都引用不到它",
            ))
        elif cid in seen:
            issues.append(Issue(
                "error", "clue", label,
                f"线索 id 重复: {cid!r}（运行时按 id 建表，后者覆盖前者）",
            ))
        seen.add(cid)
        for field_name in ("title", "desc"):
            if not str(c.get(field_name) or "").strip():
                issues.append(Issue(
                    "error", "clue", label,
                    f"线索 {label!r} 缺少 {field_name}（线索簿与采集回执都要用）",
                ))
        cat = str(c.get("category") or "").strip()
        if cat and cat not in known_categories:
            issues.append(Issue(
                "warning", "clue", label,
                f"线索 {label!r} 的 category {cat!r} 不在 categories 表中"
                "（线索簿会按原键分组、无中文组名）",
            ))
        hid = c.get("hidden")
        if hid is not None and not isinstance(hid, bool):
            issues.append(Issue(
                "warning", "clue", label,
                f"线索 {label!r} 的 hidden 须为 bool（当前 {hid!r}；运行时按 truthy 降级——"
                "写 true/false 或删掉该键）",
            ))
        ca = c.get("collectActions")
        if ca is not None and not isinstance(ca, list):
            issues.append(Issue(
                "error", "clue", label,
                f"线索 {label!r} 的 collectActions 须为动作数组（当前 {type(ca).__name__}）"
                "——运行时判空静默不执行，整批首采动作作废",
            ))
        elif isinstance(ca, list) and cid and _contains_self_collect_clue(ca, cid):
            issues.append(Issue(
                "warning", "clue", label,
                f"线索 {label!r} 的 collectActions 内 collectClue 引用自身 id"
                "（首采先落 flag 再跑动作批，自采是幂等空转——无害但多半是想引用别的线索）",
            ))


def _validate_cutscene_speakers(model: ProjectModel, issues: list[Issue]) -> None:
    """过场台词的说话人配置。

    漏填说话人实体是**静默失败**——运行时只打一条 console.warn，不显立绘、不冒「…」气泡、
    左右分边也失效，跑测试一样过。这里把它变成看得见的问题。

    只在「显示名恰好等于某个在场 NPC 的名字」时报——作者显然是指那位却没连上。
    有意匿名的「???」「女人」这类不匹配任何 NPC，不会误报。
    """
    narrator = "旁白"
    for cut in model.cutscenes:
        if not isinstance(cut, dict):
            continue
        cid = str(cut.get("id", "") or "")
        scene_id = str(cut.get("targetScene", "") or "").strip()
        by_name: dict[str, str] = {}
        known_ids: set[str] = set()
        for nid, label in model.npc_ids_for_scene(scene_id or None):
            known_ids.add(str(nid))
            by_name.setdefault(str(label).strip(), str(nid))
        for path, step in _iter_cutscene_show_dialogue(cut.get("steps")):
            where = f"cutscenes[{cid}].steps{path}"
            speaker = str(step.get("speaker", "") or "").strip()
            snpc = str(step.get("scriptedNpcId", "") or "").strip()
            if snpc and snpc != "player" and scene_id and known_ids and snpc not in known_ids:
                issues.append(Issue(
                    "warning", "cutsceneSpeaker", where,
                    f"说话人 {snpc!r} 不在 targetScene {scene_id!r} 的 NPC 表中"
                    "——运行时取不到实体，本行不显立绘、不冒气泡",
                ))
            if snpc or not speaker or "{{" in speaker or speaker == narrator:
                continue
            hit = by_name.get(speaker)
            if hit:
                issues.append(Issue(
                    "warning", "cutsceneSpeaker", where,
                    f"显示名 {speaker!r} 写成了字面值，但未选说话人（该名字对应场景 NPC {hit!r}）"
                    "——本行不显立绘、不冒「…」气泡、左右分边失效。选上说话人即可，"
                    "选后 speaker 可留空由实体给名字",
                ))


def _validate_scenarios_catalog(model: ProjectModel, issues: list[Issue]) -> None:
    """与 scenarios_catalog_validate.validate_scenarios_list 一致（同保存前逻辑），消除菜单校验分叉。"""
    from .scenarios_catalog_validate import validate_scenarios_list

    cat = model.scenarios_catalog
    if not isinstance(cat, dict):
        issues.append(Issue(
            "error", "scenarios", "",
            "scenarios.json：根须为 JSON 对象",
        ))
        return
    raw = cat.get("scenarios")
    if raw is None:
        issues.append(Issue(
            "error", "scenarios", "",
            "scenarios.json：缺少 scenarios 字段（须为数组）",
        ))
        return
    if not isinstance(raw, list):
        issues.append(Issue(
            "error", "scenarios", "",
            "scenarios.json：scenarios 须为数组",
        ))
        return

    for err in validate_scenarios_list(
        raw, flag_registry=model.flag_registry, model=model,
    ):
        issues.append(Issue("error", "scenarios", "", err))


# 与 src/data/types.ts 的 PLAYER_VERBS / PLAYER_POSTURES 对齐（parity 测试锁定）
PLAYER_VERBS: frozenset[str] = frozenset({"crouch", "gaze", "kick", "jump", "lie"})
PLAYER_POSTURES: frozenset[str] = frozenset({"crouch", "gaze", "lie"})


def _scan_condition_expr(
    model: ProjectModel,
    issues: list[Issue],
    expr: object,
    scen: dict[str, dict],
    quest_ids: set[str],
    data_type: str,
    item_id: str,
    depth: int,
    *,
    scene_id_flag: str | None = None,
) -> None:
    """switch.condition / 文档揭示等：结构 + flag / scenario / quest / scenarioLine 引用粗校验。"""
    if depth > 32:
        issues.append(Issue(
            "error", data_type, item_id,
            "ConditionExpr 嵌套超过 32",
        ))
        return
    if not isinstance(expr, dict):
        issues.append(Issue("error", data_type, item_id, "条件表达式须为 JSON 对象"))
        return
    if "all" in expr:
        ch = expr.get("all")
        if not isinstance(ch, list):
            issues.append(Issue("error", data_type, item_id, "all 须为数组"))
            return
        for e in ch:
            _scan_condition_expr(
                model, issues, e, scen, quest_ids, data_type, item_id, depth + 1,
                scene_id_flag=scene_id_flag,
            )
        return
    if "any" in expr:
        ch = expr.get("any")
        if not isinstance(ch, list):
            issues.append(Issue("error", data_type, item_id, "any 须为数组"))
            return
        for e in ch:
            _scan_condition_expr(
                model, issues, e, scen, quest_ids, data_type, item_id, depth + 1,
                scene_id_flag=scene_id_flag,
            )
        return
    if "not" in expr:
        inner = expr.get("not")
        # 空内层：not{} / not{all:[]} 恒为「非(真)」= 恒假，挂它的分支永不出现，
        # 常是误配（审查新增）。all/any 空数组按恒真处理，故 not 包空 all/any = 恒假。
        _empty_not = (
            (isinstance(inner, dict) and not inner)
            or (isinstance(inner, dict) and isinstance(inner.get("all"), list) and not inner["all"])
            or (isinstance(inner, dict) and isinstance(inner.get("any"), list) and not inner["any"])
        )
        if _empty_not:
            issues.append(Issue(
                "warning", data_type, item_id,
                "not 内层为空（恒为假）：挂此条件的分支永远不出现，请检查是否漏配",
            ))
        _scan_condition_expr(
            model, issues, inner, scen, quest_ids, data_type, item_id, depth + 1,
            scene_id_flag=scene_id_flag,
        )
        return
    if isinstance(expr.get("scenarioLine"), str):
        slid = str(expr["scenarioLine"]).strip()
        lst = str(expr.get("lineStatus", "")).strip()
        allowed = {"inactive", "active", "completed"}
        if not slid:
            issues.append(Issue(
                "error", data_type, item_id,
                "scenarioLine 条件 scenarioLine 不能为空",
            ))
        elif slid not in scen:
            issues.append(Issue(
                "error", data_type, item_id,
                f"scenarioLine {slid!r} 不在 scenarios.json",
            ))
        if lst not in allowed:
            issues.append(Issue(
                "error", data_type, item_id,
                f"scenarioLine lineStatus {lst!r} 须为 inactive|active|completed",
            ))
        return
    if expr.get("flag") is not None:
        _flag_issue(model, issues, str(expr["flag"]), data_type, item_id, scene_id_flag)
        return
    if isinstance(expr.get("quest"), str):
        qid = str(expr["quest"]).strip()
        if qid and qid not in quest_ids:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"quest 条件引用 {qid!r} 不在 quests.json",
            ))
        elif qid and qid in _repeatable_quest_ids(model):
            issues.append(Issue(
                "error", data_type, item_id,
                f"quest 条件不可指向 repeatable 任务 {qid!r}（无状态机、flag 不再同步）；"
                "判活计进度用 narrative / narrativeCount 叶",
            ))
        return
    if isinstance(expr.get("scenario"), str):
        sid = str(expr["scenario"]).strip()
        ph = str(expr.get("phase", "")).strip()
        if sid and sid not in scen:
            issues.append(Issue(
                "error", data_type, item_id,
                f"scenario 条件 scenarioId {sid!r} 不在 scenarios.json",
            ))
        elif ph:
            phases = scen[sid].get("phases")
            if isinstance(phases, dict) and ph not in phases:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"scenario 条件 phase {ph!r} 不在 {sid!r} 的 phases 清单",
                ))
        return
    if isinstance(expr.get("narrative"), str):
        gid = str(expr["narrative"]).strip()
        sid = str(expr.get("state", "")).strip()
        graphs = _narrative_graph_index(model)
        if not gid or not sid:
            issues.append(Issue(
                "error", data_type, item_id,
                "narrative 条件需要非空 narrative（图 id）与 state",
            ))
        elif gid.startswith("@"):
            # 相对 token（@owner / @scene）运行时解析，跳过 graphId/state 存在性检查
            if gid not in ("@owner", "@scene"):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"narrative 条件相对 token {gid!r} 未知（仅支持 @owner / @scene）",
                ))
        elif gid not in graphs:
            issues.append(Issue(
                "error", data_type, item_id,
                f"narrative 条件引用的图 {gid!r} 不在 narrative_graphs.json",
            ))
        elif sid not in graphs[gid]:
            issues.append(Issue(
                "error", data_type, item_id,
                f"narrative 条件 state {sid!r} 不在图 {gid!r} 的 states 中",
            ))
        reached = expr.get("reached")
        if reached is not None and not isinstance(reached, bool):
            issues.append(Issue(
                "error", data_type, item_id,
                "narrative 条件 reached 须为布尔（true=曾到达过，含当前）",
            ))
        return
    if isinstance(expr.get("plane"), str):
        pid = str(expr["plane"]).strip()
        if not pid:
            issues.append(Issue(
                "error", data_type, item_id,
                "plane 条件需要非空位面 id",
            ))
        elif pid not in _plane_id_set(model):
            issues.append(Issue(
                "error", data_type, item_id,
                f"plane 条件引用的位面 {pid!r} 不在 planes.json 中",
            ))
        return
    if isinstance(expr.get("narrativeCount"), str):
        # 活计结算计数叶（叙事运行实例化 S1）：目标须活计图；exitState 须为该图出口。
        gid = str(expr["narrativeCount"]).strip()
        graphs = _narrative_graph_index(model)
        run_graphs = _narrative_run_graph_ids(model)
        if not gid or gid not in graphs:
            issues.append(Issue(
                "error", data_type, item_id,
                f"narrativeCount 条件引用的图 {gid!r} 不在 narrative_graphs.json",
            ))
        elif gid not in run_graphs:
            issues.append(Issue(
                "error", data_type, item_id,
                f"narrativeCount 目标图 {gid!r} 未声明 run（常驻图无结算计数）",
            ))
        else:
            exit_state = expr.get("exitState")
            if exit_state is not None:
                graph = next((g for g in _iter_narrative_graphs(model) if str(g.get("id") or "").strip() == gid), None)
                exits = {str(x).strip() for x in (graph.get("exitStates") or []) if isinstance(graph, dict)} if graph else set()
                if str(exit_state).strip() not in exits:
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"narrativeCount 的 exitState {exit_state!r} 不是图 {gid!r} 的出口状态",
                    ))
        value = expr.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            issues.append(Issue(
                "error", data_type, item_id,
                "narrativeCount 条件需要数值 value",
            ))
        op = expr.get("op")
        if op is not None and str(op) not in ("==", "!=", ">", ">=", "<", "<="):
            issues.append(Issue(
                "error", data_type, item_id,
                f"narrativeCount 的 op {op!r} 不合法（== != > >= < <=）",
            ))
        return
    if isinstance(expr.get("posture"), str):
        want = str(expr.get("posture")).strip()
        if want not in PLAYER_POSTURES:
            issues.append(Issue(
                "error", data_type, item_id,
                f"posture 条件 {want!r} 非法（可用：{'、'.join(sorted(PLAYER_POSTURES))}）",
            ))
        return
    if isinstance(expr.get("timePhase"), str):
        want = str(expr.get("timePhase")).strip()
        known = {pid for pid, _ in model.all_time_phase_ids()}
        if want not in known:
            issues.append(Issue(
                "error", data_type, item_id,
                f"timePhase 条件 {want!r} 未登记于 game_config.dayNight.phases"
                f"（可用：{'、'.join(sorted(known))}）",
            ))
        return
    issues.append(Issue(
        "warning", data_type, item_id,
        f"无法识别的条件叶子（键: {sorted(expr.keys())!s}）",
    ))


def _graph_has_hold_voice(nodes: dict) -> bool:
    """图内是否存在勾了 `voice.hold` 的拍（含多拍与 choice 的 promptLine）。"""
    def _hold(obj: object) -> bool:
        if not isinstance(obj, dict):
            return False
        raw = obj.get("voice")
        return isinstance(raw, dict) and raw.get("hold") is True and bool(_voice_spec_id(raw))

    for node in nodes.values():
        if not isinstance(node, dict):
            continue
        if _hold(node) or _hold(node.get("promptLine")):
            return True
        for beat in node.get("lines") or []:
            if _hold(beat):
                return True
    return False


def _validate_dialogue_node_voices(
    model: ProjectModel,
    issues: list[Issue],
    node: dict,
    stem: str,
    ctx: str,
    graph_has_hold_voice: bool,
) -> None:
    """图对话各拍的配音字段（单拍写在节点顶层、多拍写在 lines[]、choice 写在 promptLine）。"""
    ntype = node.get("type")
    if ntype == "line":
        beats = node.get("lines")
        if isinstance(beats, list) and beats:
            for bi, beat in enumerate(beats):
                if isinstance(beat, dict):
                    _validate_voice_beat(
                        model, issues, beat, "dialogueGraph", ctx, f"lines[{bi}]",
                        sustain_available=graph_has_hold_voice,
                    )
            # 多拍时节点顶层的 voice 运行时读不到（各拍只认自己的），写了必是误会
            if node.get("voice") is not None or node.get("autoAdvance") is not None:
                issues.append(Issue(
                    "warning", "dialogueGraph", ctx,
                    "多拍节点的顶层 voice/autoAdvance 运行时不消费"
                    "（配音只认各拍自己的，节点级不作默认）",
                ))
            return
        _validate_voice_beat(
            model, issues, node, "dialogueGraph", ctx, "台词",
            sustain_available=graph_has_hold_voice,
        )
        return
    if ntype == "choice":
        pl = node.get("promptLine")
        if isinstance(pl, dict):
            _validate_voice_beat(
                model, issues, pl, "dialogueGraph", ctx, "promptLine",
                sustain_available=graph_has_hold_voice,
            )


def _validate_dialogue_graphs(model: ProjectModel, issues: list[Issue]) -> None:
    gd = model.dialogues_path / "graphs"
    if not gd.is_dir():
        return
    scen = _scenario_definitions(model)
    quest_ids = {str(q.get("id", "")) for q in model.quests if q.get("id")}
    entry_overrides = collect_dialogue_graph_entry_overrides(model)
    for path in sorted(gd.glob("*.json")):
        stem = path.stem
        try:
            gdata = read_json(path)
        except (OSError, ValueError, json.JSONDecodeError):
            issues.append(Issue(
                "error", "dialogueGraph", stem,
                f"graphs/{path.name} 无法解析为 JSON",
            ))
            continue
        if not isinstance(gdata, dict):
            issues.append(Issue("error", "dialogueGraph", stem, "图根须为对象"))
            continue
        meta = gdata.get("meta")
        if isinstance(meta, dict):
            msid = str(meta.get("scenarioId") or "").strip()
            if msid and msid not in scen:
                issues.append(Issue(
                    "warning", "dialogueGraph", stem,
                    f"meta.scenarioId {msid!r} 不在 scenarios.json 清单中",
                ))
        nodes = gdata.get("nodes")
        if not isinstance(nodes, dict):
            continue
        # 本图任意一处勾了 hold 的配音：跨节点的接管顺序运行期才定得下来，
        # 故只要图里存在留声配音，就不对「autoAdvance=voice 却没自带配音」报警
        # （fail-open：宁可漏一条 warning，也不冤枉合法的跨拍接管）。
        graph_has_hold_voice = _graph_has_hold_voice(nodes)
        for nid, node in nodes.items():
            if not isinstance(node, dict):
                continue
            ctx = f"{stem}:{nid}"
            _validate_dialogue_node_voices(
                model, issues, node, stem, ctx, graph_has_hold_voice,
            )
            if node.get("type") == "choice":
                for oi, opt in enumerate(node.get("options") or []):
                    if not isinstance(opt, dict):
                        continue
                    octx = f"{ctx} option[{oi}]"
                    rc = opt.get("requireCondition")
                    if rc is not None:
                        _scan_condition_expr(
                            model, issues, rc, scen, quest_ids,
                            "dialogueGraph", octx, 0,
                        )
            if node.get("type") == "switch":
                _switch_cases = node.get("cases") or []
                for ci, case in enumerate(_switch_cases):
                    if not isinstance(case, dict):
                        continue
                    cctx = f"{ctx} 分支 {ci}"
                    # 与游戏状态无关的分支：恒命中会让其后分支与 defaultNext 成死路，
                    # 恒不命中则这条分支自己是死路。判定收口到图对话编辑器的同一个函数，
                    # 两处不会各写一套（norms 不变量 8）。
                    _verdict = _dialogue_case_verdict(case)
                    if _verdict == _COND_ALWAYS:
                        issues.append(Issue(
                            "error", "dialogueGraph", cctx,
                            "switch 分支条件与游戏状态无关、永远命中，"
                            "其后所有分支与 defaultNext 永远走不到",
                        ))
                        if ci < len(_switch_cases) - 1:
                            issues.append(Issue(
                                "warning", "dialogueGraph", cctx,
                                f"其后还有 {len(_switch_cases) - 1 - ci} 条分支永远轮不到",
                            ))
                    elif _verdict == _COND_NEVER:
                        issues.append(Issue(
                            "error", "dialogueGraph", cctx,
                            "switch 分支条件运行时永远为假（写法认不出或是空的），"
                            "这条分支永远走不到",
                        ))
                    cond = case.get("condition")
                    legacy_conds = case.get("conditions") or []
                    if cond is not None and legacy_conds:
                        issues.append(Issue(
                            "warning", "dialogueGraph", cctx,
                            "switch case 同时存在 condition 与 conditions；"
                            "运行时仅使用 condition，conditions 将被忽略",
                        ))
                    if cond is not None:
                        _scan_condition_expr(
                            model, issues, cond, scen, quest_ids,
                            "dialogueGraph", cctx, 0,
                        )
                    for atom in case.get("conditions") or []:
                        if not isinstance(atom, dict):
                            continue
                        if "all" in atom or "any" in atom or "not" in atom:
                            _scan_condition_expr(
                                model, issues, atom, scen, quest_ids,
                                "dialogueGraph", cctx, 0,
                            )
                        elif atom.get("flag") is not None:
                            _flag_issue(
                                model, issues, str(atom["flag"]),
                                "dialogueGraph", cctx, None,
                            )
                        else:
                            _scan_condition_expr(
                                model, issues, atom, scen, quest_ids,
                                "dialogueGraph", cctx, 0,
                            )
            if node.get("type") == "runActions":
                _walk_action_defs(
                    model, issues, node.get("actions"),
                    "dialogueGraph", ctx, None,
                )

        # 连边 / 入口 / 流程孤儿完整性：过去仅编辑器保存时 validate_graph_tiered 校验，
        # 全量校验漏检，悬空 next / 孤儿要打开编辑器才暴露。这里用同一套（无 Qt 依赖）helper 补齐。
        from tools.dialogue_graph_editor.graph_document import (
            extract_flow_edges,
            nodes_reachable_from_entry,
            validate_owner_context_state,
        )

        # ownerState / contextState 的 wrapper / state 存在性：过去只在编辑器保存时随
        # validate_graph_tiered 校验，全量校验漏检（拼错 state / contextState graphId 非法
        # 要打开那张图才暴露）。这里用同一套分层校验补齐（需项目上下文解析 wrapper 与图状态）。
        oc_errors, oc_warnings = validate_owner_context_state(
            gdata, project_root=model.project_path, project_model=model
        )
        for _msg in oc_errors:
            issues.append(Issue("error", "dialogueGraph", stem, _msg))
        for _msg in oc_warnings:
            issues.append(Issue("warning", "dialogueGraph", stem, _msg))

        entry = str(gdata.get("entry", "") or "").strip()
        if entry and entry not in nodes:
            issues.append(Issue(
                "error", "dialogueGraph", stem,
                f"entry {entry!r} 指向不存在的节点",
            ))
        for src, tgt, label in extract_flow_edges(nodes):
            if tgt and tgt not in nodes:
                issues.append(Issue(
                    "error", "dialogueGraph", f"{stem}:{src}",
                    f"连线 {label!r} 指向不存在的节点 {tgt!r}",
                ))
        if entry and entry in nodes:
            # 备用入口（NPC/角色注册表/热区/startDialogueGraph 动作）也算根，避免多入口图误报。
            # 键名清单只在 shared/dialogue_entry_overrides 一处维护，别在这里重写。
            gid_meta = str((meta or {}).get("id") or "").strip() if isinstance(meta, dict) else ""
            gid_self = str(gdata.get("id") or "").strip()
            roots = graph_entry_roots(nodes, entry, (stem, gid_meta, gid_self), entry_overrides)
            reachable: set[str] = set()
            for r in roots:
                reachable |= nodes_reachable_from_entry(nodes, r)
            orphans = sorted(nid for nid in nodes if nid not in reachable)
            if orphans:
                preview = ", ".join(orphans[:10])
                more = "…" if len(orphans) > 10 else ""
                issues.append(Issue(
                    "warning", "dialogueGraph", stem,
                    f"{len(orphans)} 个节点无法从 entry={entry!r}（含备用入口）沿连线到达"
                    f"（流程孤儿）: {preview}{more}",
                ))


_PLAYER_VERB_LOGICAL_STATES: dict[str, str] = {
    "crouch": "crouch", "gaze": "gaze", "kick": "kick", "jump": "jump", "lie": "lie",
}


def _player_avatar_states(model: ProjectModel) -> tuple[set[str], str] | None:
    """当前玩家化身动画包的 states 键集合与包名；解析不到返回 None（不误报）。"""
    cfg = model.game_config.get("playerAvatar")
    if not isinstance(cfg, dict):
        return None
    man = str(cfg.get("animManifest") or "").strip()
    m = re.match(r"^/resources/runtime/animation/([^/]+)/anim\.json$", man)
    bundle = m.group(1) if m else "player_anim"
    anim = model.animations.get(bundle)
    if not isinstance(anim, dict):
        return None
    states = anim.get("states")
    if not isinstance(states, dict):
        return None
    return {str(k) for k in states}, bundle


def _validate_animation_sockets(model: ProjectModel, issues: list[Issue]) -> None:
    """挂点 sidecar：指纹对不上 = 游戏侧整份忽略，必须报出来。

    只在**已经存在** sockets.json 的包上报——绝大多数包没有挂点，那是常态不是问题。
    """
    from .shared.animation_sockets import (
        fingerprint_matches,
        fingerprint_of_anim,
        load_socket_set,
        sockets_path_for_bundle,
    )
    if model.project_path is None:
        return
    for bundle, anim in sorted(model.animations.items()):
        if not isinstance(anim, dict):
            continue
        path = sockets_path_for_bundle(model.animation_bundles_path, bundle)
        raw = load_socket_set(path)
        if raw is None:
            continue
        sockets = raw.get("sockets")
        if not isinstance(sockets, dict) or not sockets:
            issues.append(Issue(
                "warning", "animation", bundle,
                "sockets.json 里一个挂点都没有——空壳文件，删掉即可",
            ))
            continue
        if not fingerprint_matches(raw.get("atlas"), fingerprint_of_anim(anim)):
            issues.append(Issue(
                "error", "animation", bundle,
                "sockets.json 的图集指纹与 anim.json 对不上（重导出过图集？）——"
                "游戏里会整份忽略这些挂点，请在动画编辑器的「挂点」区重标后保存",
            ))
            continue
        slot_count = len(anim.get("atlasFrames") or [])
        for name, sock in sockets.items():
            poses = sock.get("poses") if isinstance(sock, dict) else None
            if not isinstance(poses, dict) or not poses:
                issues.append(Issue(
                    "warning", "animation", bundle,
                    f"挂点 {name!r} 一帧都没标——运行时永远挂不上东西",
                ))
                continue
            for slot in poses:
                if not str(slot).isdigit() or (slot_count and int(slot) >= slot_count):
                    issues.append(Issue(
                        "error", "animation", bundle,
                        f"挂点 {name!r} 标在了不存在的图集槽位 {slot!r}（共 {slot_count} 个槽位）",
                    ))


def _bundle_states(model: ProjectModel, anim_file: str) -> tuple[set[str], str] | None:
    """animFile URL -> (states 键集合, 包名)；解析不到返回 None（不误报）。"""
    m = re.match(r"^/resources/runtime/animation/([^/]+)/anim\.json$", (anim_file or "").strip())
    if not m:
        return None
    bundle = m.group(1)
    anim = model.animations.get(bundle)
    if not isinstance(anim, dict):
        return None
    states = anim.get("states")
    if not isinstance(states, dict):
        return None
    return {str(k) for k in states}, bundle


def _validate_character_avatars(model: ProjectModel, issues: list[Issue]) -> None:
    """character_registry.json 里**可控角色**（带 avatar 段）的化身一致性闸。

    与 playerAvatar 同口径：stateMap 的值必须是动画包里真实存在的 state，否则运行时
    该逻辑名解析不到片段 —— 表现为"该动词在该角色下自动禁用"，是最难查的静默失败
    （策划只会看到"这个角色走路没反应"）。playerAvatar 一侧早有这道闸，可控角色一侧
    不加就是同样的笔误一边报 error 一边放行（运行时不变量 9「登记面同步」）。
    """
    registry = getattr(model, "character_registry", {}) or {}
    known_logical = (
        {"idle", "walk", "run", "crouchWalk"}
        | set(_PLAYER_VERB_LOGICAL_STATES.values())
    )

    # —— 角色级对话图绑定（与 NpcDef 侧同口径，缺了就是"角色配了图、进游戏没反应"）——
    for cid, cdef in sorted(registry.items()):
        if not isinstance(cdef, dict):
            continue
        dg = str(cdef.get("dialogueGraphId") or "").strip()
        dge = str(cdef.get("dialogueGraphEntry") or "").strip()
        if dg:
            gpath = model.dialogues_path / "graphs" / f"{dg}.json"
            if not gpath.is_file():
                issues.append(Issue(
                    "error", "character", cid,
                    f"角色 {cid!r} dialogueGraphId '{dg}' 缺少文件 dialogues/graphs/{dg}.json",
                ))
            elif dge:
                try:
                    gdata = read_json(gpath)
                except (OSError, ValueError, json.JSONDecodeError):
                    gdata = None
                nodes = (gdata or {}).get("nodes") if isinstance(gdata, dict) else None
                if isinstance(nodes, dict) and dge not in nodes:
                    issues.append(Issue(
                        "error", "character", cid,
                        f"角色 {cid!r} dialogueGraphEntry '{dge}' 不是图 '{dg}' 里的节点",
                    ))
        elif dge:
            # entry 是"某张图内部的节点名"，没有图就无从解析——运行时会整条忽略
            issues.append(Issue(
                "error", "character", cid,
                f"角色 {cid!r} 只写了 dialogueGraphEntry 没写 dialogueGraphId，该入口不会生效",
            ))

    for cid, cdef in sorted(registry.items()):
        if not isinstance(cdef, dict):
            continue
        avatar = cdef.get("avatar")
        if not isinstance(avatar, dict):
            continue  # 不可控角色，本闸不管

        own_anim = str(cdef.get("animFile") or "").strip()
        if not own_anim:
            # 运行时刻意不兜底到主角的包（否则漏填会静默套上关二狗的动画与立绘），
            # 于是这里必须拦：可控角色没有动画包 = 上不了场。
            issues.append(Issue(
                "error", "character", cid,
                f"角色 {cid!r} 带 avatar 段（可被接管）但没有 animFile —— 受控时无动画可播",
            ))

        # 常态 + 每套装扮各查一遍：装扮换了包就按新包的 states 查
        variants: list[tuple[str, str, dict]] = [("avatar", own_anim, avatar)]
        outfits = avatar.get("outfits")
        if isinstance(outfits, dict):
            for oname, odef in sorted(outfits.items()):
                if not isinstance(odef, dict):
                    issues.append(Issue(
                        "error", "character", cid,
                        f"角色 {cid!r} 的装扮 {oname!r} 须为对象",
                    ))
                    continue
                variants.append((
                    f"avatar.outfits[{oname}]",
                    str(odef.get("animFile") or "").strip() or own_anim,
                    odef,
                ))

        for label, anim_file, holder in variants:
            state_map = holder.get("stateMap")
            if state_map is not None and not isinstance(state_map, dict):
                issues.append(Issue(
                    "error", "character", cid,
                    f"角色 {cid!r} 的 {label}.stateMap 须为对象",
                ))
                continue
            pack = _bundle_states(model, anim_file) if anim_file else None
            if pack is None:
                continue  # 包解析不到（外部包/尚未导出）：不误报，由素材审计另行兜底
            states, bundle = pack
            for logical, clip in (state_map or {}).items():
                if logical not in known_logical:
                    issues.append(Issue(
                        "warning", "character", cid,
                        f"角色 {cid!r} 的 {label}.stateMap 逻辑名 {logical!r} 不在自动解析清单里"
                        f"（{'、'.join(sorted(known_logical))}）；确认不是笔误",
                    ))
                    continue
                if not isinstance(clip, str) or not clip.strip():
                    issues.append(Issue(
                        "error", "character", cid,
                        f"角色 {cid!r} 的 {label}.stateMap['{logical}'] 须为非空字符串",
                    ))
                    continue
                if clip not in states:
                    issues.append(Issue(
                        "error", "character", cid,
                        f"角色 {cid!r} 的 {label}.stateMap['{logical}'] -> '{clip}' "
                        f"不在动画包 {bundle} 的 states 里",
                    ))

        # 待机节目的动画状态：解析不到运行时**静默跳过**那条节目，与 playerAvatar 侧对称按 error 拦
        idle_cfg = avatar.get("idle")
        pack = _bundle_states(model, own_anim) if own_anim else None
        if isinstance(idle_cfg, dict) and pack is not None:
            states, bundle = pack
            for i, entry in enumerate(idle_cfg.get("entries") or []):
                if not isinstance(entry, dict):
                    continue
                st = str(entry.get("animState") or "").strip()
                if st and st not in states:
                    issues.append(Issue(
                        "error", "character", cid,
                        f"角色 {cid!r} 的 avatar.idle.entries[{i}].animState -> '{st}' "
                        f"不在动画包 {bundle} 的 states 里",
                    ))


def _validate_day_night(model: ProjectModel, issues: list[Issue]) -> None:
    """时段表自身的一致性闸——**专治「整条街静默空掉」**。

    2026-08-18 事故复盘：内容侧把时段表换成 辰/午/暮/夜，而运行时「NPC 未写 phases
    时的缺省归属」是代码里硬写的 `['day']`。'day' 在新表里不存在 → 白名单判定恒假 →
    所有开了日夜的场景 24 小时空无一人，**且没有任何报错**（条件为假就是"不显示"，
    肉眼分不出是设计如此还是坏了）。

    运行时已改成只认 `daylight` 标记、不认任何时段 id，且一段没标时 fail-open。
    这里补上构建期的那一半（律7 构建期严于运行时）：没标就当面说，别等真机发现。
    """
    cfg = model.game_config
    day_night = cfg.get("dayNight")
    if day_night is not None and not isinstance(day_night, dict):
        issues.append(Issue("error", "config", "game_config", "dayNight 须为对象"))
        return
    rows = day_night.get("phases") if isinstance(day_night, dict) else None
    if rows is not None and not isinstance(rows, list):
        issues.append(Issue("error", "config", "game_config", "dayNight.phases 须为数组"))
        return

    # daylight 只认真布尔（运行时是 `=== true`）；写 "true" / 1 会被静默当成没标。
    for i, row in enumerate(rows or []):
        if not isinstance(row, dict):
            continue
        if "daylight" in row and not isinstance(row["daylight"], bool):
            issues.append(Issue(
                "error", "config", "game_config",
                f"dayNight.phases[{i}].daylight 须为真布尔（运行时按 === true 判，"
                f"{row['daylight']!r} 会被当成没标）",
            ))

    # 一段都没标只有在「真有场景开了日夜」时才是问题——没场景用日夜时整套过滤都不生效。
    if model.daylight_phase_ids():
        return
    users = sorted(
        sid for sid, sc in model.scenes.items()
        if isinstance(sc, dict) and (sc.get("dayNight") or {}).get("enabled") is True
    )
    if not users:
        return
    issues.append(Issue(
        "warning", "config", "game_config",
        "dayNight.phases 里一段都没标 daylight（「街上有人」），"
        f"而这些场景开了日夜循环：{'、'.join(users)}。"
        "没写 phases 的 NPC（龙套/群演）的缺省归属因此失效——运行时会 fail-open "
        "让他们全天都在并告警。给白天那几段打上 daylight:true。",
    ))


def _validate_player_acts(model: ProjectModel, issues: list[Issue]) -> None:
    """playerAvatar.stateMap 与 playerActs 的一致性闸。

    - stateMap 的值必须是动画包里真实存在的 state（否则运行时该逻辑名播不出来）。
    - 某动词解析不到片段 = 该动词在本装扮下自动禁用（合法状态，不报——
      编辑器「玩家化身」页的动词折叠区已当面说明这条规则）。
    - 场景里配了某动词的 acts，但该动词被 playerActs 显式关掉 → warning（死配置）。
    """
    cfg = model.game_config
    avatar = cfg.get("playerAvatar")
    state_map = avatar.get("stateMap") if isinstance(avatar, dict) else None
    state_map = state_map if isinstance(state_map, dict) else {}
    pack = _player_avatar_states(model)

    if pack is not None:
        states, bundle = pack
        known_logical = (
            {"idle", "walk", "run", "crouchWalk"}
            | set(_PLAYER_VERB_LOGICAL_STATES.values())
        )
        for logical, clip in state_map.items():
            if logical not in known_logical:
                # stateMap 是 SpriteEntity.resolveClip 的**通用别名表**——过场里
                # playNpcAnimation target=player state=<别名> 同样走它，所以未知逻辑名
                # 不一定是错的，只是没有任何自动系统会去解析它。报 warning 提醒笔误。
                issues.append(Issue(
                    "warning", "config", "game_config",
                    f"playerAvatar.stateMap 的逻辑名 {logical!r} 不在自动解析清单里"
                    f"（{'、'.join(sorted(known_logical))}）；"
                    "只有脚本显式 playAnimation 该名字时才会用到，确认不是笔误",
                ))
                continue
            if not isinstance(clip, str) or not clip.strip():
                issues.append(Issue(
                    "error", "config", "game_config",
                    f"playerAvatar.stateMap['{logical}'] 须为非空字符串",
                ))
                continue
            if clip not in states:
                issues.append(Issue(
                    "error", "config", "game_config",
                    f"playerAvatar.stateMap['{logical}'] -> '{clip}' 不在动画包 {bundle} 的 states 里",
                ))

        # 待机节目的动画状态同理：解析不到的话运行时**静默跳过**那条纯动画节目
        # （策划只会看到"配了没反应"）。与 stateMap 对称，按 error 拦。
        idle_cfg = avatar.get("idle") if isinstance(avatar, dict) else None
        if isinstance(idle_cfg, dict):
            for i, entry in enumerate(idle_cfg.get("entries") or []):
                if not isinstance(entry, dict):
                    continue
                st = str(entry.get("animState") or "").strip()
                if st and st not in states:
                    issues.append(Issue(
                        "error", "config", "game_config",
                        f"playerAvatar.idle.entries[{i}].animState '{st}' 不在动画包 {bundle} 的 states 里"
                        "（运行时会静默跳过这条待机节目）",
                    ))
                if not st and not str(entry.get("bubbleText") or "").strip():
                    issues.append(Issue(
                        "warning", "config", "game_config",
                        f"playerAvatar.idle.entries[{i}] 既没有动画也没有台词，永远不会演",
                    ))

    acts_cfg = cfg.get("playerActs")
    if acts_cfg is not None and not isinstance(acts_cfg, dict):
        issues.append(Issue("error", "config", "game_config", "playerActs 须为对象"))
        acts_cfg = None
    disabled: set[str] = set()
    if isinstance(acts_cfg, dict):
        for verb, slot in acts_cfg.items():
            if verb not in PLAYER_VERBS:
                issues.append(Issue(
                    "error", "config", "game_config",
                    f"playerActs 含未知身体动词 {verb!r}",
                ))
                continue
            if not isinstance(slot, dict):
                issues.append(Issue(
                    "error", "config", "game_config", f"playerActs.{verb} 须为对象"))
                continue
            if slot.get("enabled") is False:
                disabled.add(verb)

    # 设计 §8 #9：踢得出来却没有落空反馈 = 哑键。只在 kick **真能播**（映射到了片段）
    # 时才报——没有 kick 动画时这个动词整个是禁用的，提醒它毫无意义。
    if pack is not None:
        states, _bundle = pack
        kick_clip = state_map.get("kick", "kick")
        kick_slot = acts_cfg.get("kick") if isinstance(acts_cfg, dict) else None
        kick_enabled = not (isinstance(kick_slot, dict) and kick_slot.get("enabled") is False)
        miss = kick_slot.get("missActions") if isinstance(kick_slot, dict) else None
        if kick_clip in states and kick_enabled and not miss:
            issues.append(Issue(
                "warning", "config", "game_config",
                "playerActs.kick.missActions 为空：踢空时只播动画、没有任何反馈"
                "（扬尘 / 踢空音 / 一句 showEmote 至少给一个，否则是哑键）",
            ))

    if not disabled:
        return
    for sid, sc in model.scenes.items():
        for zone in sc.get("zones", []) or []:
            opa = zone.get("onPlayerAct")
            if not isinstance(opa, dict):
                continue
            for verb in opa:
                if verb in disabled:
                    issues.append(Issue(
                        "warning", "scene", sid,
                        f"Zone '{zone.get('id', '?')}' 配了 onPlayerAct.{verb}，"
                        f"但 playerActs.{verb}.enabled=false（这段配置永不会触发）",
                    ))


def _check_act_spot_data(
    issues: list[Issue], sid: str, hid: str, data: dict, scene: dict | None = None,
) -> None:
    """act_spot（躺点 / 跨点）的结构闸：verbs 白名单、跳必须有落点、坐标须为数字。"""
    verbs = data.get("verbs")
    if not isinstance(verbs, list) or not verbs:
        issues.append(Issue(
            "error", "scene", sid,
            f"Hotspot '{hid}' 是 act_spot，data.verbs 必须是非空数组",
        ))
        verbs = []
    for v in verbs:
        if v not in PLAYER_VERBS:
            issues.append(Issue(
                "error", "scene", sid,
                f"Hotspot '{hid}' act_spot verbs 含未知动词 {v!r}",
            ))
    for key in ("align", "landing"):
        pt = data.get(key)
        if pt is None:
            continue
        if (not isinstance(pt, dict)
                or not isinstance(pt.get("x"), (int, float))
                or not isinstance(pt.get("y"), (int, float))
                or isinstance(pt.get("x"), bool) or isinstance(pt.get("y"), bool)):
            issues.append(Issue(
                "error", "scene", sid,
                f"Hotspot '{hid}' act_spot data.{key} 须为 {{x, y}} 数字对象",
            ))
    if "jump" in verbs and not isinstance(data.get("landing"), dict):
        issues.append(Issue(
            "error", "scene", sid,
            f"Hotspot '{hid}' act_spot 支持 jump 时必须设 data.landing（跨点跳的落点）",
        ))
    # 落点/对齐点必须落在世界内（真正的"可走性"另由 audit-walkable 探针把关，
    # 校验器不做几何——但跑到世界外一定是错的，这条能便宜地拦住）
    ww = scene.get("worldWidth") if isinstance(scene, dict) else None
    wh = scene.get("worldHeight") if isinstance(scene, dict) else None
    if isinstance(ww, (int, float)) and isinstance(wh, (int, float)) and ww > 0 and wh > 0:
        for key in ("align", "landing"):
            pt = data.get(key)
            if not isinstance(pt, dict):
                continue
            px, py = pt.get("x"), pt.get("y")
            if not isinstance(px, (int, float)) or not isinstance(py, (int, float)):
                continue
            if not (0 <= px <= ww and 0 <= py <= wh):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"Hotspot '{hid}' act_spot data.{key} ({px}, {py}) 落在世界之外"
                    f"（worldWidth={ww} worldHeight={wh}）",
                ))
    facing = data.get("facing")
    if facing is not None and facing not in ("left", "right"):
        issues.append(Issue(
            "error", "scene", sid,
            f"Hotspot '{hid}' act_spot data.facing 只能是 left / right",
        ))




def _walk_action_defs(
    model: ProjectModel, issues: list[Issue], actions: list,
    data_type: str, item_id: str, scene_id: str | None,
    *,
    cutscene_temp_ids: frozenset[str] | None = None,
) -> None:
    """遍历 ActionDef 列表：校验 type 已登记；setFlag 键；递归嵌套 action 容器。"""
    from .shared.action_editor import ACTION_TYPES
    allowed_types = set(ACTION_TYPES)

    for act in actions or []:
        if not isinstance(act, dict):
            continue
        _append_action_param_ref_issues(
            model, issues, act, data_type, item_id, scene_id,
            cutscene_temp_ids=cutscene_temp_ids,
        )
        t = act.get("type")
        if isinstance(t, str) and t and t not in allowed_types:
            issues.append(Issue(
                "error", data_type, item_id,
                f"Action 类型 {t!r} 未在 action_editor.ACTION_TYPES 中登记；"
                f"添加新 Action 须在 ActionRegistry 与 action_editor 同步维护",
            ))
        p = act.get("params") or {}
        if t in ("setFlag", "appendFlag") and not str(p.get("key") or "").strip():
            issues.append(Issue(
                "error", data_type, item_id,
                f"{t} 的 params.key 为空——运行时 FlagStore 拒写空键，该动作等于无效",
            ))
        elif t == "setFlag" and p.get("key"):
            _flag_issue(model, issues, str(p["key"]), data_type, item_id, scene_id)
            _setflag_whitelist_issue(issues, "setFlag", str(p["key"]).strip(), data_type, item_id)
        elif t == "appendFlag" and p.get("key"):
            fk = str(p["key"])
            _flag_issue(model, issues, fk, data_type, item_id, scene_id)
            _setflag_whitelist_issue(issues, "appendFlag", fk.strip(), data_type, item_id)
            from .flag_registry import registry_value_type_for_key
            rvt = registry_value_type_for_key(fk, model.flag_registry)
            if rvt != "string":
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"appendFlag 的 key {fk!r} 在登记表中须为 string 类型"
                    + (f"（当前为 {rvt!r}）" if rvt else "（未命中 static/pattern）"),
                ))
        elif t == "setFocusedQuest":
            # 空 id = 清空当前任务（合法）；非空但不存在 = 运行时 warn 后什么也不做
            qref = str(p.get("id") or "").strip()
            if qref and qref not in _all_quest_ids(model):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"setFocusedQuest 目标任务 {qref!r} 不在 quests.json（运行时跳过，当前任务不会变）",
                ))
        elif t == "enableRuleOffers":
            for slot in (p.get("slots") or []):
                if isinstance(slot, dict):
                    _walk_action_defs(
                        model, issues, slot.get("resultActions"),
                        data_type, item_id, scene_id,
                        cutscene_temp_ids=cutscene_temp_ids,
                    )
        elif t == "addDelayedEvent":
            _walk_action_defs(
                model, issues, p.get("actions"),
                data_type, item_id, scene_id,
                cutscene_temp_ids=cutscene_temp_ids,
            )
        elif t == "runActions":
            _walk_action_defs(
                model, issues, p.get("actions"),
                data_type, item_id, scene_id,
                cutscene_temp_ids=cutscene_temp_ids,
            )
        elif t == "chooseAction":
            opts = p.get("options")
            if not isinstance(opts, list) or not opts:
                issues.append(Issue(
                    "warning", data_type, item_id,
                    "chooseAction 需要至少一个 options 条目",
                ))
            for idx, opt in enumerate(opts or []):
                if not isinstance(opt, dict):
                    continue
                txt = str(opt.get("text") or "").strip()
                if not txt:
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"chooseAction options[{idx}] 缺少 text",
                    ))
                _walk_action_defs(
                    model, issues, opt.get("actions"),
                    data_type, item_id, scene_id,
                    cutscene_temp_ids=cutscene_temp_ids,
                )
        elif t == "randomBranch":
            prob_raw = p.get("probability", 0.5)
            try:
                _pf = float(prob_raw)
                if not math.isfinite(_pf):
                    raise ValueError
            except (TypeError, ValueError):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    "randomBranch params.probability 非有限数值时将按 0.5 处理（编辑器亦会夹到 0～1）",
                ))
            _walk_action_defs(
                model, issues, p.get("aboveActions"),
                data_type, item_id, scene_id,
                cutscene_temp_ids=cutscene_temp_ids,
            )
            _walk_action_defs(
                model, issues, p.get("belowActions"),
                data_type, item_id, scene_id,
                cutscene_temp_ids=cutscene_temp_ids,
            )
        elif t == "setScenarioPhase":
            scen = _scenario_definitions(model)
            sid = str(p.get("scenarioId") or "").strip()
            ph = str(p.get("phase") or "").strip()
            if not sid:
                issues.append(Issue(
                    "error", data_type, item_id,
                    "setScenarioPhase 缺少 scenarioId",
                ))
            elif sid not in scen:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"setScenarioPhase scenarioId {sid!r} 不在 scenarios.json",
                ))
            elif ph:
                phases = scen[sid].get("phases")
                if isinstance(phases, dict) and ph not in phases:
                    issues.append(Issue(
                        "error", data_type, item_id,
                        f"setScenarioPhase phase {ph!r} 不在 scenario {sid!r} 的 phases 清单",
                    ))
        elif t == "startScenario":
            scen = _scenario_definitions(model)
            sid = str(p.get("scenarioId") or "").strip()
            if not sid:
                issues.append(Issue(
                    "error", data_type, item_id,
                    "startScenario 缺少 scenarioId",
                ))
            elif sid not in scen:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"startScenario scenarioId {sid!r} 不在 scenarios.json",
                ))
        elif t == "activateScenario":
            scen = _scenario_definitions(model)
            sid = str(p.get("scenarioId") or "").strip()
            if not sid:
                issues.append(Issue(
                    "error", data_type, item_id,
                    "activateScenario 缺少 scenarioId",
                ))
            elif sid not in scen:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"activateScenario scenarioId {sid!r} 不在 scenarios.json",
                ))
        elif t == "completeScenario":
            scen = _scenario_definitions(model)
            sid = str(p.get("scenarioId") or "").strip()
            if not sid:
                issues.append(Issue(
                    "error", data_type, item_id,
                    "completeScenario 缺少 scenarioId",
                ))
            elif sid not in scen:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"completeScenario scenarioId {sid!r} 不在 scenarios.json",
                ))
        elif t == "revealDocument":
            doc_id = str(p.get("documentId") or "").strip()
            if not doc_id:
                issues.append(Issue(
                    "error", data_type, item_id,
                    "revealDocument 缺少 documentId",
                ))
            elif doc_id not in set(model.document_reveal_ids()):
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"revealDocument documentId {doc_id!r} 未在 document_reveals.json 注册",
                ))


def _validate_flags(model: ProjectModel, issues: list[Issue]) -> None:
    # 结构性内容校验（未知 action / 空 setFlag key / 过场白名单 / 未知条件叶子 /
    # scenario·narrative·plane 引用等）从这里发起，必须独立于登记表是否为空运行——
    # 旧实现空登记表直接 return，导致假 action、坏过场步骤 0 报告（审查 P2-①）。
    # 逐 flag 的「未登记」告警由 _flag_issue 在登记表为空时自行跳过。
    reg = model.flag_registry
    from .flag_registry import flag_registry_static_format_issues
    for msg in flag_registry_static_format_issues(reg):
        issues.append(Issue("warning", "flag_registry", "flag_registry", msg))
    for i, p in enumerate(reg.get("patterns") or []):
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id", i))
        vt = p.get("valueType")
        if vt is None:
            issues.append(Issue(
                "warning", "flag_registry", pid,
                "pattern 缺少 valueType（bool、float 或 string）",
            ))
        elif vt not in ("bool", "float", "int", "string", "str"):
            issues.append(Issue(
                "warning", "flag_registry", pid,
                f"pattern valueType 无效: {vt!r}",
            ))

    for sid, sc in model.scenes.items():
        for group in sc.get("entityGroups", []) or []:
            if not isinstance(group, dict):
                continue
            gid = str(group.get("id", ""))
            _walk_conditions(model, issues, group.get("conditions"), "sceneGroup", gid, sid)
        for hs in sc.get("hotspots", []) or []:
            hid = str(hs.get("id", ""))
            _walk_conditions(model, issues, hs.get("conditions"), "scene", hid, sid)
            data = hs.get("data") or {}
            _walk_action_defs(model, issues, data.get("actions"), "scene", hid, sid)
            # act_spot 的起身动作批同样要过条件/动作遍历
            _walk_action_defs(model, issues, data.get("exitActions"), "scene", hid, sid)
        for npc in sc.get("npcs", []) or []:
            nid = str(npc.get("id", ""))
            _walk_conditions(model, issues, npc.get("conditions"), "scene", nid, sid)
        _walk_action_defs(model, issues, sc.get("onEnter"), "scene", sid, sid)
        for zone in sc.get("zones", []) or []:
            zid = str(zone.get("id", ""))
            _walk_conditions(model, issues, zone.get("conditions"), "scene", zid, sid)
            for ev in ("onEnter", "onStay", "onExit", "onInteract"):
                _walk_action_defs(model, issues, zone.get(ev), "scene", zid, sid)
            opa = zone.get("onPlayerAct")
            if isinstance(opa, dict):
                for _verb, batch in opa.items():
                    _walk_action_defs(model, issues, batch, "scene", zid, sid)

    for q in model.quests:
        qid = str(q.get("id", ""))
        for ck in ("preconditions", "completionConditions"):
            _walk_conditions(model, issues, q.get(ck), "quest", qid, None)
        for edge in q.get("nextQuests", []) or []:
            _walk_conditions(model, issues, edge.get("conditions"), "quest", qid, None)
        _walk_action_defs(model, issues, q.get("acceptActions"), "quest", qid, None)
        _walk_action_defs(model, issues, q.get("rewards"), "quest", qid, None)
        for obj in q.get("objectives") or []:
            if isinstance(obj, dict):
                _walk_conditions(model, issues, obj.get("completeWhen"), "quest", qid, None)

    for enc in model.encounters:
        eid = str(enc.get("id", ""))
        _walk_conditions(model, issues, enc.get("conditions"), "encounter", eid, None)
        for opt in enc.get("options", []) or []:
            _walk_conditions(model, issues, opt.get("conditions"), "encounter", eid, None)
            _walk_action_defs(model, issues, opt.get("resultActions"), "encounter", eid, None)
        _walk_action_defs(model, issues, enc.get("rewards"), "encounter", eid, None)

    for node in model.map_nodes:
        mid = str(node.get("sceneId", "?"))
        _walk_conditions(model, issues, node.get("unlockConditions"), "map", mid, None)

    for c in model.cutscenes:
        cid = str(c.get("id", ""))
        _validate_cutscene_steps(model, c.get("steps", []) or [], cid, issues)

    for it in model.items:
        iid = str(it.get("id", ""))
        for dd in it.get("dynamicDescriptions", []) or []:
            _walk_conditions(model, issues, dd.get("conditions"), "item", iid, None)
        use = it.get("use")
        if isinstance(use, dict):
            # 这批条件决定背包里那枚使用键灰不灰；条件叶悬垂 = 按钮永远灰着，静默
            _walk_conditions(model, issues, use.get("conditions"), "item", iid, None)

    for ch in model.archive_characters:
        cid = str(ch.get("id", ""))
        # 人物解锁只走 addArchiveEntry，无 unlockConditions 可校验；仅走分段显示条件 + 首阅动作。
        # portrait（人物簿头像）：可选、对话立绘集 slug；缺资产报 warning 不升 error（素材可后补）。
        por = ch.get("portrait")
        if por is not None:
            if not isinstance(por, str) or not por.strip():
                issues.append(Issue(
                    "warning", "archive", cid,
                    "人物档案 portrait 须为非空字符串（对话立绘集 slug，或删除该键）",
                ))
            elif model.project_path is not None and not (
                model.project_path / "public" / "resources" / "runtime" / "images"
                / "dialogue_portraits" / por.strip() / f"{por.strip()}_calm.png"
            ).is_file():
                issues.append(Issue(
                    "warning", "archive", cid,
                    f"人物档案 portrait 指向 '{por.strip()}'，但缺人物簿头像帧 "
                    f"public/resources/runtime/images/dialogue_portraits/"
                    f"{por.strip()}/{por.strip()}_calm.png（人物簿固定用 calm 表情）",
                ))
        for imp in ch.get("impressions", []) or []:
            _walk_conditions(model, issues, imp.get("conditions"), "archive", cid, None)
        for ki in ch.get("knownInfo", []) or []:
            _walk_conditions(model, issues, ki.get("conditions"), "archive", cid, None)
        _walk_action_defs(model, issues, ch.get("firstViewActions"), "archive", cid, None)

    entries = model.archive_lore
    if isinstance(entries, dict):
        entries = entries.get("entries", [])
    for le in entries or []:
        lid = str(le.get("id", ""))
        _walk_conditions(model, issues, le.get("unlockConditions"), "archive", lid, None)
        _walk_action_defs(model, issues, le.get("firstViewActions"), "archive", lid, None)

    slang_root = model.archive_slang
    slang_entries = slang_root.get("entries", []) if isinstance(slang_root, dict) else []
    slang_cat_keys = set()
    if isinstance(slang_root, dict) and isinstance(slang_root.get("categories"), dict):
        slang_cat_keys = set(slang_root["categories"].keys())
    for se in slang_entries or []:
        if not isinstance(se, dict):
            continue
        sid = str(se.get("id", ""))
        _walk_conditions(model, issues, se.get("unlockConditions"), "archive", sid, None)
        _walk_action_defs(model, issues, se.get("firstViewActions"), "archive", sid, None)
        # 词条正文/词条本身为空 → 运行时是个点得开的空壳
        if not str(se.get("title", "")).strip():
            issues.append(Issue("warning", "archive", sid, "怪话词条缺 title（词条本身），运行时列表显示为空行"))
        if not str(se.get("content", "")).strip():
            issues.append(Issue("warning", "archive", sid, "怪话词条缺 content（考据正文），点开是空白"))
        cat = str(se.get("category", "")).strip()
        if not cat:
            issues.append(Issue("warning", "archive", sid, "怪话词条缺 category，将落入兜底分组"))
        elif slang_cat_keys and cat not in slang_cat_keys:
            issues.append(Issue(
                "warning", "archive", sid,
                f"怪话词条 category {cat!r} 不在 categories 映射中，分类标题会显示裸键",
            ))
    if isinstance(slang_root, dict):
        done_map = slang_root.get("categoryCompleteText")
        if isinstance(done_map, dict):
            for k in done_map:
                if slang_cat_keys and k not in slang_cat_keys:
                    issues.append(Issue(
                        "warning", "archive", "slang",
                        f"categoryCompleteText 含未登记分类键 {k!r}，该评语永不显示",
                    ))

    rhyme_root = model.archive_rhymes
    rhyme_entries = rhyme_root.get("entries", []) if isinstance(rhyme_root, dict) else []
    for re_ in rhyme_entries or []:
        if not isinstance(re_, dict):
            continue
        rid = str(re_.get("id", ""))
        _walk_conditions(model, issues, re_.get("unlockConditions"), "archive", rid, None)
        _walk_action_defs(model, issues, re_.get("firstViewActions"), "archive", rid, None)
        # 标题/全文为空 → 运行时是个点得开的空壳（歪歌册无分类，无 category 检查）
        if not str(re_.get("title", "")).strip():
            issues.append(Issue("warning", "archive", rid, "歪歌条目缺 title（标题），运行时列表显示为空行"))
        if not str(re_.get("content", "")).strip():
            issues.append(Issue("warning", "archive", rid, "歪歌条目缺 content（顺口溜全文），点开是空白"))

    # K7 线索注册表：collectActions 由 Game 的 clue:collectActions 监听经统一执行器
    # 真执行（与 archive:firstView 同范式）——注册进标准动作遍历，动作类型登记/参数
    # 引用/setFlag 键/嵌套容器校验全部自动继承。形状检查在 _validate_clues_registry。
    from .shared.ref_validator import clue_registry_rows
    for cl in clue_registry_rows(model):
        clid = str(cl.get("id", ""))
        cl_actions = cl.get("collectActions")
        if isinstance(cl_actions, list):
            _walk_action_defs(model, issues, cl_actions, "clue", clid, None)

    for doc in model.archive_documents:
        did = str(doc.get("id", ""))
        _walk_conditions(model, issues, doc.get("discoverConditions"), "archive", did, None)
        _walk_action_defs(model, issues, doc.get("firstViewActions"), "archive", did, None)

    for bk in model.archive_books:
        bid = str(bk.get("id", ""))
        for pg in bk.get("pages", []) or []:
            pnum = pg.get("pageNum", "?")
            _walk_conditions(model, issues, pg.get("unlockConditions"), "archive", bid, None)
            _walk_action_defs(
                model, issues, pg.get("firstViewActions"),
                "archive", f"{bid}/page/{pnum}", None,
            )
            for ent in pg.get("entries") or []:
                if not isinstance(ent, dict):
                    continue
                eid = str(ent.get("id", "")).strip() or "?"
                if not any(
                    str(ent.get(k, "")).strip()
                    for k in ("title", "content", "annotation", "illustration")
                ):
                    issues.append(Issue(
                        "warning", "archive", f"{bid}/entry/{eid}",
                        "书页子条目无任何可显示内容（标题/正文/按语/插图全空），运行时不可见",
                    ))
                _walk_conditions(
                    model, issues, ent.get("discoverConditions"),
                    "archive", f"{bid}/entry/{eid}", None,
                )
                _walk_action_defs(
                    model, issues, ent.get("firstViewActions"),
                    "archive", f"{bid}/entry/{eid}", None,
                )

    # --- archive 顶层 id 去重：运行时按 id 建 Map（last-wins），重复 id 会让一条档案凭空消失 ---
    def _check_archive_dup_ids(items, label: str) -> None:
        seen: set[str] = set()
        for it in items or []:
            if not isinstance(it, dict):
                continue
            iid = str(it.get("id", "")).strip()
            if not iid:
                issues.append(Issue("warning", "archive", "?", f"{label}缺少 id"))
                continue
            if iid in seen:
                issues.append(Issue(
                    "error", "archive", iid, f"重复的{label} id {iid!r}"))
            seen.add(iid)

    _check_archive_dup_ids(model.archive_characters, "人物档案")
    _lore_dup = model.archive_lore
    if isinstance(_lore_dup, dict):
        _lore_dup = _lore_dup.get("entries", [])
    _check_archive_dup_ids(_lore_dup, "传说条目")
    _slang_dup = model.archive_slang
    if isinstance(_slang_dup, dict):
        _slang_dup = _slang_dup.get("entries", [])
    _check_archive_dup_ids(_slang_dup, "怪话词条")
    _rhyme_dup = model.archive_rhymes
    if isinstance(_rhyme_dup, dict):
        _rhyme_dup = _rhyme_dup.get("entries", [])
    _check_archive_dup_ids(_rhyme_dup, "歪歌条目")
    _check_archive_dup_ids(model.archive_documents, "文档档案")
    _check_archive_dup_ids(model.archive_books, "书籍")

    cfg = model.game_config
    done_flag = cfg.get("initialCutsceneDoneFlag")
    if done_flag:
        _flag_issue(model, issues, str(done_flag), "config", "game_config", None)
    sf = cfg.get("startupFlags")
    if isinstance(sf, dict):
        for fk in sf:
            if fk:
                _flag_issue(model, issues, str(fk), "config", "game_config", None)


_CUTSCENE_ACTION_WHITELIST = cutscene_action_allowlist_frozenset()

_CUTSCENE_STAGING_SAVE_ACTIONS = frozenset([
    "persistNpcEntityEnabled", "persistHotspotEnabled",
    "persistZoneEnabled",
    "persistNpcDisablePatrol", "persistNpcEnablePatrol",
    "persistNpcAt", "persistNpcAnimState", "persistPlayNpcAnimation",
    "setEntityField", "setSceneEntityPosition", "setHotspotDisplayImage",
])

# 与运行时 CutsceneManager.executePresent 的 switch 分支、编辑器 timeline_editor.PRESENT_TYPES 同源；
# 三处须保持一致（新增 present 类型时同步）。
_CUTSCENE_PRESENT_TYPES = frozenset([
    "fadeToBlack", "fadeIn", "flashWhite", "waitTime", "waitClick",
    "showTitle", "showDialogue", "showImg", "hideImg", "animLayer",
    "showMovieBar", "hideMovieBar", "showSubtitle",
    "cameraMove", "cameraZoom", "showCharacter",
    "parallaxScene",
])


def _cutscene_has_show_movie_bar(steps: list) -> bool:
    """整棵步骤树（含并行子轨）是否出现过 showMovieBar。"""
    for step in steps or []:
        if not isinstance(step, dict):
            continue
        if step.get("disabled") is True:
            continue  # 禁用步运行时整步跳过：不能拿它来证明"黑边已经出过"
        if step.get("kind") == "present" and step.get("type") == "showMovieBar":
            return True
        if step.get("kind") == "parallel" and _cutscene_has_show_movie_bar(step.get("tracks") or []):
            return True
    return False


def _validate_audio_config_ids(model: ProjectModel, issues: list[Issue]) -> None:
    """audio_config 各频道的 id 本身合不合法、跨频道有没有重名。

    **在这之前 audio_config 的 id 一个字都没校验过**：``1``、``带 空格``、空串塞进去
    validate-data 一声不吭(实测 issue 数一条不变)。运行时确实照放——坏的不是播放，
    是半年后没人认得 ``9`` 是谁的哪一句、引用扫描被引号打断、id 首尾带空格后
    各处 `.strip()` 一读就对不上。判据与编辑器录入面同一函数，见
    :func:`~.shared.audio_library.audio_id_problem`。

    频道不写死清单：``audio_config`` 里除 ``systemSfx``(逻辑名→sfx id 的映射，键由代码定)
    之外的每个 dict 都查——加频道时这里不用跟着改，少一处会漏登记的面。
    """
    cfg = model.audio_config if isinstance(model.audio_config, dict) else {}
    seen: dict[str, list[str]] = {}
    for channel, entries in cfg.items():
        if channel == "systemSfx" or not isinstance(entries, dict):
            continue
        for aid in entries:
            problem = audio_id_problem(aid)
            if problem:
                issues.append(Issue(
                    "error", "audio_config", f"{channel}.{aid}",
                    f"音频 id {aid!r} 不合法：{problem}",
                ))
            seen.setdefault(str(aid), []).append(str(channel))
    for aid, channels in seen.items():
        if len(channels) > 1:
            issues.append(Issue(
                "warning", "audio_config", aid,
                f"id {aid!r} 同时登记在 {'、'.join(channels)} 里——各区彼此独立、"
                "运行时按区查表不回落，同名两条极易改错一边",
            ))


def _audio_id_known(model: ProjectModel, audio_id: str) -> bool:
    """配音 id 只认 ``audio_config.voice`` 区(运行时 playVoice 也只查这一处)。
    **不做回落**:回落会让"配置写错了"在某些路径上表现正常、只在别处露馅。"""
    return audio_id in (model.audio_config.get("voice") or {})


def _voice_spec_id(raw: object) -> str:
    """配音规格里的 sfx id（字符串形态即 id 本身）；取不到返回空串。"""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, dict):
        sid = raw.get("id")
        if isinstance(sid, str):
            return sid.strip()
        sid = raw.get("sfxId")
        if isinstance(sid, str):
            return sid.strip()
    return ""


def _voice_raw_of(obj: dict, *, legacy_key: str | None = None) -> object:
    """一拍的配音原值：新键 `voice` 优先，回落旧键（仅 showSubtitle 有旧键）。"""
    raw = obj.get("voice")
    if raw is None and legacy_key:
        raw = obj.get(legacy_key)
    return raw


def _voice_advance_raw_of(obj: dict, *, legacy_key: str | None = None) -> object:
    raw = obj.get("autoAdvance")
    if raw is None and legacy_key:
        raw = obj.get(legacy_key)
    return raw


#: 吃配音的四个气泡 action（非阻塞两个的配音一律留声，见 dialogue-voice-channel 卡）
_VOICE_BUBBLE_ACTIONS = frozenset({
    "showEmote", "showSpeechBubble", "showEmoteAndWait", "showSpeechBubbleAndWait",
})


def _voice_sustain_effect(step: dict) -> str | None:
    """这一步对「留声」的影响:``hold``=留下一条没人认领的、``consume``=把它收掉、``None``=不碰。

    与运行时 `VoiceChannel` 同口径:起新配音会顶掉在播的那条(故不 hold 即 consume);
    自己没配音却声明「跟随配音结束」= 接管并跟本拍一起结束。
    """
    kind = step.get("kind")
    if kind == "action":
        if step.get("type") not in _VOICE_BUBBLE_ACTIONS:
            return None
        p = step.get("params") if isinstance(step.get("params"), dict) else {}
        raw = p.get("voice")
        if _voice_spec_id(raw):
            # 非阻塞气泡没有「本拍结束」这个时刻，运行时强制留声
            if not str(step.get("type", "")).endswith("AndWait"):
                return "hold"
            return "hold" if isinstance(raw, dict) and raw.get("hold") is True else "consume"
        return "consume" if p.get("autoAdvance") == "voice" else None
    if kind != "present":
        return None
    t = step.get("type")
    if t not in ("showSubtitle", "showDialogue"):
        return None
    legacy_v = "subtitleVoice" if t == "showSubtitle" else None
    legacy_a = "subtitleAutoAdvance" if t == "showSubtitle" else None
    raw = _voice_raw_of(step, legacy_key=legacy_v)
    if _voice_spec_id(raw):
        return "hold" if isinstance(raw, dict) and raw.get("hold") is True else "consume"
    return "consume" if _voice_advance_raw_of(step, legacy_key=legacy_a) == "voice" else None


def cutscene_voice_sustained_before(steps: list, index: int) -> bool:
    """播到第 ``index`` 步之前,是否还有一条 hold 留声的配音等人接管。

    **给逐行校验的调用方用**(编辑器每行单独校验时看不到上文,不给它这个前置状态,
    凡是"接管前面留声"的合法写法都会被误报成"没有配音可接管")。

    禁用步整步跳过(与运行时一致,也与 `_cutscene_has_show_movie_bar` 同口径);
    并行组内按书写顺序线性推进——组内本就无时序,拿它当"上文"是启发式,
    宁可少报一条 warning 也不冤枉合法编排。
    """
    state = False

    def walk(seq: list) -> None:
        nonlocal state
        for s in seq or []:
            if not isinstance(s, dict) or s.get("disabled") is True:
                continue
            if s.get("kind") == "parallel":
                walk(s.get("tracks") or [])
                continue
            eff = _voice_sustain_effect(s)
            if eff == "hold":
                state = True
            elif eff == "consume":
                state = False

    walk(list(steps or [])[:max(0, index)])
    return state


def _validate_voice_beat(
    model: ProjectModel,
    issues: list[Issue],
    obj: dict,
    data_type: str,
    item_id: str,
    label: str,
    *,
    legacy_voice_key: str | None = None,
    legacy_advance_key: str | None = None,
    sustain_available: bool = False,
    supports_advance: bool = True,
) -> bool:
    """校验一拍台词的 `voice` / `autoAdvance`；返回本拍是否**留声**（供后续拍判定接管）。

    与运行时 `VoiceChannel.parseVoiceSpec` / `parseVoiceAdvanceSpec` 同口径：
    非法值运行时只是退化（不发声 / 等点击），故多数报 warning，形状写错才报 error。
    """
    raw = _voice_raw_of(obj, legacy_key=legacy_voice_key)
    aa = _voice_advance_raw_of(obj, legacy_key=legacy_advance_key)

    for new_key, old_key in (("voice", legacy_voice_key), ("autoAdvance", legacy_advance_key)):
        if old_key and obj.get(new_key) is not None and obj.get(old_key) is not None:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{label} 同时写了 {new_key} 与旧键 {old_key}（运行时只认 {new_key}，旧键是死字段）",
            ))

    voice_id = ""
    hold = False
    if raw is not None:
        if not isinstance(raw, (str, dict)):
            issues.append(Issue(
                "error", data_type, item_id,
                f"{label} voice 应为 sfx id 字符串或 {{id, volume, hold}} 对象，实为 {raw!r}",
            ))
        else:
            voice_id = _voice_spec_id(raw)
            if not voice_id:
                issues.append(Issue(
                    "error", data_type, item_id,
                    f"{label} voice 没有 id（运行时整条配音被忽略）",
                ))
            elif not _audio_id_known(model, voice_id):
                issues.append(Issue(
                    "warning", data_type, item_id,
                    f"{label} voice {voice_id!r} 不在 audio_config.voice 中",
                ))
            if isinstance(raw, dict):
                vol = raw.get("volume")
                if vol is not None and (isinstance(vol, bool) or not isinstance(vol, (int, float))):
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"{label} voice.volume 应为数值，实为 {vol!r}（运行时忽略该键）",
                    ))
                elif isinstance(vol, (int, float)) and not isinstance(vol, bool) and not (0 <= vol <= 1):
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"{label} voice.volume={vol} 超出 0–1（最终仍被夹到满幅内）",
                    ))
                hraw = raw.get("hold")
                if hraw is not None and not isinstance(hraw, bool):
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"{label} voice.hold 只认真布尔 true，实为 {hraw!r}（当没勾处理）",
                    ))
                hold = hraw is True

    if aa is not None:
        if not supports_advance:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{label} 这里的 autoAdvance 运行时不消费（非阻塞动作没有「本拍结束」这个时刻）",
            ))
        aa_is_voice = aa == "voice"
        aa_is_ms = isinstance(aa, (int, float)) and not isinstance(aa, bool) and aa > 0
        if not (aa_is_voice or aa_is_ms):
            issues.append(Issue(
                "error", data_type, item_id,
                f"{label} autoAdvance 应为 \"voice\" 或正毫秒数，实为 {aa!r}"
                f"（运行时非法值退化为等待点击）",
            ))
        if aa_is_voice and not voice_id and not sustain_available:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{label} autoAdvance=\"voice\" 但本拍没有配音、前面也没有勾了 hold 的配音可接管"
                f"（运行时退化为等待点击）",
            ))
        if aa_is_voice and voice_id and hold:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{label} 本拍等的就是自己这条配音播完，voice.hold 没有接手方，等于没勾",
            ))
    return hold and bool(voice_id)


def _walk_cutscene_action_param_refs(
    model: ProjectModel,
    issues: list[Issue],
    steps: list,
    cid: str,
    temp_ids: frozenset[str],
) -> None:
    for step in steps or []:
        if not isinstance(step, dict):
            continue
        if step.get("kind") == "action":
            act = {"type": step.get("type"), "params": step.get("params") or {}}
            _append_action_param_ref_issues(
                model, issues, act, "cutscene", cid, None,
                cutscene_temp_ids=temp_ids,
            )
        elif step.get("kind") == "parallel":
            _walk_cutscene_action_param_refs(
                model, issues, step.get("tracks") or [], cid, temp_ids,
            )


def _validate_cutscene_steps(
    model: ProjectModel, steps: list, cid: str, issues: list[Issue],
    *, cutscene_movie_bar: bool | None = None, scan_param_refs: bool = True,
    step_label_prefix: str = "", step_index_base: int = 0,
    voice_sustain: list[bool] | None = None,
) -> None:
    """消息里的 ``step #N`` 用编辑器同一套行号：顶层 ``4``、并行子轨 ``4.2``。

    ``step_index_base`` 供只传一步（``[step]``）的调用方还原它在整段里的真实序号，
    ``step_label_prefix`` 由并行递归自动透传——两者缺省即历史行为（本段从 1 数起）。

    ``voice_sustain``：单元素可变盒，记「此刻是否有一条 hold 留声的配音等人接管」。
    跨步（含并行子轨）按播放顺序传递，`autoAdvance:"voice"` 却没自带配音的拍据此判定
    是合法的接管、还是真的没声可等。单步调用（编辑器行内校验）缺省从"没有留声"起算——
    宁可多报一条 warning，也不因为看不到上文就静默放过。
    """
    from .shared.action_editor import ACTION_PERSISTENCE, ACTION_TYPES
    allowed_types = set(ACTION_TYPES)

    # 顶层调用时整树扫一次是否出现过 showMovieBar，供 movie 版式字幕校验（向并行子轨透传）。
    if cutscene_movie_bar is None:
        cutscene_movie_bar = _cutscene_has_show_movie_bar(steps)
    if voice_sustain is None:
        voice_sustain = [False]

    # 参数引用只在顶层扫一次：_walk_cutscene_action_param_refs 本身已递归进 parallel 子轨，
    # 且 temp_actor_ids 从整棵树采集（含外层 spawn）。并行子轨的递归 _validate_cutscene_steps
    # 不得重扫——否则外层 spawn 的临时演员在子轨内被误报「无法解析」+ 参数告警翻倍（审查 P1-34）。
    if scan_param_refs:
        temp_actor_ids = frozenset(_cutscene_temp_actor_ids_in_steps(steps))
        _walk_cutscene_action_param_refs(model, issues, steps, cid, temp_actor_ids)

    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        lbl = f"{step_label_prefix}{i + 1 + step_index_base}"
        kind = step.get("kind", "")

        # 禁用标记：运行时只认真布尔 True（`"true"` / 1 都会照常播）——写歪了必须构建期报出来。
        # 已禁用的步仍照常参与其余校验：数据还在，将来一开就得是对的。
        if "disabled" in step and not isinstance(step.get("disabled"), bool):
            issues.append(Issue(
                "error", "cutscene", cid,
                f"step #{lbl} disabled 须为布尔，实为 {step.get('disabled')!r}"
                f"（运行时只认 true，其余一律照常播放）",
            ))

        if kind == "action":
            t = step.get("type", "")
            if t and t not in allowed_types:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{lbl} action type {t!r} 未在 ACTION_TYPES 中登记",
                ))
            if t and t not in _CUTSCENE_ACTION_WHITELIST:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{lbl} action type {t!r} 不在 Cutscene 白名单内（Cutscene 仅允许无副作用 Action）",
                ))
            if t and ACTION_PERSISTENCE.get(t) == "save" and t not in _CUTSCENE_STAGING_SAVE_ACTIONS:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{lbl} action type {t!r} 会修改全局存档状态，必须放到 startCutscene 外层 action 列表",
                ))
            if t == "cutsceneSpawnActor":
                sid = str((step.get("params") or {}).get("id", ""))
                if sid and not sid.startswith("_cut_"):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} cutsceneSpawnActor id {sid!r} 必须以 _cut_ 开头",
                    ))

        elif kind == "present":
            t = str(step.get("type", ""))
            if t and t not in _CUTSCENE_PRESENT_TYPES:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{lbl} 未知 present type {t!r}（运行时 CutsceneManager 会静默跳过）",
                ))
            if t == "showImg" and not str(step.get("image") or "").strip():
                issues.append(Issue(
                    "warning", "cutscene", cid,
                    f"step #{lbl} showImg 缺 image（运行时将加载空路径）",
                ))
            if t in ("cameraMove", "cameraZoom") and "easing" in step:
                ez = step.get("easing")
                if ez not in _PARALLAX_EASINGS:
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} {t} 的 easing {ez!r} 非法"
                        f"（仅 {sorted(_PARALLAX_EASINGS)}；运行时会静默退回默认曲线）",
                    ))
            if t == "animLayer":
                af = str(step.get("animFile") or "").strip()
                if not af:
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} animLayer 缺 animFile（anim.json 路径）",
                    ))
                elif not af.endswith("anim.json"):
                    issues.append(Issue(
                        "warning", "cutscene", cid,
                        f"step #{lbl} animLayer 的 animFile 通常指向 …/anim.json，实为 {af!r}",
                    ))
                for k in ("xPercent", "yPercent", "widthPercent", "alpha", "zIndex"):
                    if k in step:
                        v = step.get(k)
                        if not isinstance(v, (int, float)) or isinstance(v, bool):
                            issues.append(Issue(
                                "error", "cutscene", cid,
                                f"step #{lbl} animLayer.{k} 应为数值，实为 {v!r}",
                            ))
            if t == "parallaxScene":
                inline = step.get("scene")
                ref = str(step.get("id") or "").strip()
                if isinstance(inline, dict):
                    # 内联场景：就地按 parallax_scenes 同一套结构校验（复用注册表校验器）。
                    _validate_one_parallax_scene(
                        inline, issues, "cutscene", cid,
                        where=f"step #{lbl} parallaxScene.scene",
                    )
                elif ref:
                    known = {
                        str(s.get("id") or "").strip()
                        for s in (getattr(model, "parallax_scenes", None) or [])
                        if isinstance(s, dict)
                    }
                    if ref not in known:
                        issues.append(Issue(
                            "error", "cutscene", cid,
                            f"step #{lbl} parallaxScene id {ref!r} 不在 parallax_scenes.json 中"
                            f"（运行时找不到场景会静默跳过该步）",
                        ))
                else:
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} parallaxScene 需给 id（引用 parallax_scenes.json）"
                        f"或内联 scene 对象",
                    ))
                if "handle" in step and not isinstance(step.get("handle"), str):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} parallaxScene 的 handle 应为字符串（叠层句柄；缺省=匿名镜头位，"
                        f"被下一个 parallaxScene / 匿名 showImg 自动顶掉；写了则需 hideImg 手动收）",
                    ))
            if t == "showImg" and "zIndex" in step:
                zi = step.get("zIndex")
                if not isinstance(zi, (int, float)) or isinstance(zi, bool):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} showImg 的 zIndex 应为数值，实为 {zi!r}",
                    ))
                elif zi >= 10000:
                    issues.append(Issue(
                        "warning", "cutscene", cid,
                        f"step #{lbl} showImg zIndex={zi} ≥ 10000（会盖过电影黑边，通常不该这样）",
                    ))
            if t == "showImg" and "kenBurns" in step:
                kb = step.get("kenBurns")
                if not isinstance(kb, dict):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} showImg 的 kenBurns 应为对象（运行时非对象会被忽略）",
                    ))
                else:
                    _KB_KEYS = {"fromScale", "toScale", "fromX", "fromY", "toX", "toY", "durationMs"}
                    for k, v in kb.items():
                        if k not in _KB_KEYS:
                            issues.append(Issue(
                                "warning", "cutscene", cid,
                                f"step #{lbl} kenBurns 含未知键 {k!r}（运行时忽略；已知键：{sorted(_KB_KEYS)}）",
                            ))
                        elif not isinstance(v, (int, float)) or isinstance(v, bool):
                            issues.append(Issue(
                                "error", "cutscene", cid,
                                f"step #{lbl} kenBurns.{k} 应为数值，实为 {v!r}",
                            ))
                    for k in ("fromScale", "toScale"):
                        v = kb.get(k)
                        if isinstance(v, (int, float)) and not isinstance(v, bool) and v < 1:
                            issues.append(Issue(
                                "warning", "cutscene", cid,
                                f"step #{lbl} kenBurns.{k}={v} 小于 1（运行时会夹到 1，等于没推）",
                            ))
                    dur = kb.get("durationMs")
                    if isinstance(dur, (int, float)) and not isinstance(dur, bool) and dur <= 0:
                        issues.append(Issue(
                            "warning", "cutscene", cid,
                            f"step #{lbl} kenBurns.durationMs={dur} 非正数（运行时按 12000 处理）",
                        ))
                    if not kb:
                        issues.append(Issue(
                            "warning", "cutscene", cid,
                            f"step #{lbl} kenBurns 为空对象，等于未启用（可删掉该键）",
                        ))
            if t == "showSubtitle":
                band = str(step.get("subtitleBand") or "").strip()
                align = str(step.get("subtitleAlign") or "").strip()
                if (band or align) and not cutscene_movie_bar:
                    issues.append(Issue(
                        "warning", "cutscene", cid,
                        f"step #{lbl} 字幕用了相对黑边版式（subtitleBand/Align），"
                        f"但本过场没有 showMovieBar，运行时黑边不存在",
                    ))
            if t in ("showSubtitle", "showDialogue") and "typewriter" in step:
                # 逐字显示开关只认真布尔（同 disabled）："true" / 1 运行时按缺省走，
                # 写的人却以为改了演出——构建期抓住，别让它静默。
                tw = step.get("typewriter")
                if not isinstance(tw, bool):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{lbl} typewriter 应为布尔（true/false），实为 {tw!r}"
                        f"——运行时只认真布尔，其余一律按该类型缺省"
                        f"（{'对白框逐字' if t == 'showDialogue' else '字幕整句'}）",
                    ))
            if t in ("showSubtitle", "showDialogue"):
                # 字幕与过场对话框吃同一套配音语义；hold 留声可跨步被后面某拍接管，
                # 故按播放顺序记账（voice_sustain 由调用方在整段里传递）。
                _validate_voice_beat(
                    model, issues, step, "cutscene", cid, f"step #{lbl}",
                    legacy_voice_key="subtitleVoice" if t == "showSubtitle" else None,
                    legacy_advance_key="subtitleAutoAdvance" if t == "showSubtitle" else None,
                    sustain_available=voice_sustain[0],
                )

        elif kind == "parallel":
            tr = step.get("tracks") or []
            if isinstance(tr, list) and len(tr) == 0:
                issues.append(Issue(
                    "warning", "cutscene", cid,
                    f"step #{lbl} parallel 的 tracks 为空（运行时该步将立即结束，确认是否占位遗漏）",
                ))
            _validate_cutscene_steps(
                model, tr, cid, issues, cutscene_movie_bar=cutscene_movie_bar,
                scan_param_refs=False, step_label_prefix=f"{lbl}.",
                voice_sustain=voice_sustain)

        elif kind:
            issues.append(Issue(
                "warning", "cutscene", cid,
                f"step #{lbl} 未知 kind {kind!r}",
            ))

        # 留声记账放在**本步校验之后**：hold 与 consume 都发生在这一拍**结束**时，
        # 本拍自己看到的必须是"进入本拍前"的状态。判据与 cutscene_voice_sustained_before
        # 共用同一个 _voice_sustain_effect——两处分家就会各报各的（逐行校验正是靠那个函数
        # 还原上文）。禁用步整步跳过：既不起配音也不接管。
        # parallel 组的内部效果已由上面的递归写进同一个 voice_sustain 盒子。
        if kind != "parallel" and step.get("disabled") is not True:
            _eff = _voice_sustain_effect(step)
            if _eff == "hold":
                voice_sustain[0] = True
            elif _eff == "consume":
                voice_sustain[0] = False
