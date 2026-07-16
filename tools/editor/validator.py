"""Cross-data reference validator."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .file_io import read_json
from .shared.cutscene_action_allowlist_io import cutscene_action_allowlist_frozenset
from .shared.move_entity_map_picker import normalize_move_entity_waypoints
from .shared.narrative_catalog import emitted_signal_ids
from .shared.runtime_field_schema import field_meta, is_valid_field, value_matches_field

if TYPE_CHECKING:
    from .project_model import ProjectModel

@dataclass
class Issue:
    severity: str  # "error" | "warning"
    data_type: str
    item_id: str
    message: str


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
    from .shared.ref_validator import validate_all_embedded_refs

    # 载入期被静默修正/丢弃的数据异常（重复 id 后者覆盖等）：不冒出来的话，
    # 模型里已看不到原始问题、validator 之后永远发现不了。
    for msg in getattr(model, "load_anomalies", None) or []:
        issues.append(Issue("warning", "load", "project", str(msg)))

    for i, msg in enumerate(validate_all_embedded_refs(model)):
        issues.append(Issue("error", "embeddedRef", f"#{i}", msg))
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
            anim_bundle = _anim_bundle_id_from_ref(npc.get("animFile"))
            if anim_bundle and anim_bundle not in model.animations:
                issues.append(Issue(
                    "warning", "scene", sid,
                    f"NPC '{nid}' animFile 指向 '{anim_bundle}'，但无对应动画包目录 "
                    f"public/resources/runtime/animation/{anim_bundle}/anim.json"
                    "（改名/删除导致的孤儿引用？）",
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
    if cfg.get("initialCutscene") and cfg["initialCutscene"] not in cutscene_ids:
        issues.append(Issue("warning", "config", "game_config",
                            f"initialCutscene '{cfg['initialCutscene']}' 不存在"))
    # fallbackScene：目标场景缺失时的兜底场景（SaveManager 恢复存档用），悬垂同样致命。
    if cfg.get("fallbackScene") and cfg["fallbackScene"] not in scene_ids:
        issues.append(Issue("error", "config", "game_config",
                            f"fallbackScene '{cfg['fallbackScene']}' 不存在"))

    _validate_overlay_images(model, issues)
    _validate_parallax_scenes(model, issues)

    _validate_flags(model, issues)

    _validate_dialogue_graphs(model, issues)

    _validate_pressure_holds(model, issues)
    _validate_signal_cues(model, issues)
    _validate_water_minigames(model, issues)
    _validate_paper_craft(model, issues)
    _validate_narrative(model, issues)
    _validate_planes(model, issues)
    _validate_plane_action_pairing(model, issues)
    _validate_narrative_templates(model, issues)
    _validate_entity_reachability(model, issues)

    return issues


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
                if spec_kind not in ("actor", "emote_subject", "npc"):
                    continue
                value = params.get(param)
                if not isinstance(value, str):
                    continue
                ref = value.strip()
                if not ref or ref == "player" or ref.startswith("_cut_"):
                    continue
                allowed = npc_union | (hotspot_union if spec_kind == "emote_subject" else set())
                if ref in allowed:
                    continue
                exists_globally = ref in global_npcs or (
                    spec_kind == "emote_subject" and ref in global_hotspots)
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


def _validate_narrative(model: ProjectModel, issues: list[Issue]) -> None:
    """叙事状态机数据一致性：信号注册表、Transition 信号引用、黑盒 emits 与对话图实际发信号的漂移。

    目标：策划在状态图画布上看到的因果关系必须与运行时真值一致。
    """
    data = model.narrative_graphs
    if not isinstance(data, dict) or not data.get("compositions"):
        return
    registered = _narrative_registered_signal_ids(model)
    graphs = _narrative_graph_index(model)

    # 0. 叙事图状态动作树里的 updateQuest.id 必须存在于 quests.json（承接审查新增）：
    # 运行时对未知任务 id 无声跳过，画布上「盖章推进任务」实际不生效。
    _quest_ids = {str(q.get("id", "")) for q in model.quests if isinstance(q, dict) and q.get("id")}

    def _scan_update_quest(obj: Any, gid: str) -> None:
        if isinstance(obj, dict):
            if obj.get("type") == "updateQuest":
                qid = str((obj.get("params") or {}).get("id") or "").strip()
                if qid and qid not in _quest_ids:
                    issues.append(Issue(
                        "error", "narrative", gid,
                        f"updateQuest 目标任务 {qid!r} 不在 quests.json（运行时静默跳过，任务不会推进）",
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

    # 1. 信号注册表：重复 id
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


def _all_hotspot_ids_global_set(model: ProjectModel) -> set[str]:
    return {p[0] for p in model.all_hotspot_ids()}


def _all_npc_ids_global_set(model: ProjectModel) -> set[str]:
    return {p[0] for p in model.all_npc_ids_global()}


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

    if t == "faceEntity":
        d = str(p.get("direction") or "").strip()
        if d and d not in ("left", "right", "up", "down"):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"faceEntity direction {d!r} 非 left/right/up/down",
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

    if t in ("showEmote", "showEmoteAndWait", "showSpeechBubble", "showSpeechBubbleAndWait"):
        aid = str(p.get("target") or "").strip()
        if aid and not _emote_subject_ref_ok(
            model, scene_id, aid, temp_ids=temp, allow_player=True,
        ):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{t} target={aid!r} 无法解析（需 NPC / 热点 id / player / 本过场 _cut_*）",
            ))

    actor_actions = (
        "playNpcAnimation", "setEntityEnabled", "moveEntityTo",
        "faceEntity",
    )
    if t in actor_actions:
        for key in ("target", "faceTarget"):
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
            if tgt and st:
                known = set(model.animation_state_names_for_actor(scene_id, tgt))
                if known and st not in known:
                    issues.append(Issue(
                        "warning", data_type, item_id,
                        f"playNpcAnimation state {st!r} 不在目标 {tgt!r} 的 anim.json states 中",
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
    issues.append(Issue(
        "warning", data_type, item_id,
        f"无法识别的条件叶子（键: {sorted(expr.keys())!s}）",
    ))


def _collect_dialogue_graph_entry_overrides(model: ProjectModel) -> dict[str, set[str]]:
    """图 id → 该图被 NPC 用 dialogueGraphEntry 指定的备用入口节点集合。

    多入口共享图（如市井闲谈被十几个 NPC 各自从不同节点进入）的可达性必须把这些
    override 入口也当根，否则会误报「流程孤儿」（审查 P1-33；运行时
    GraphDialogueManager 明确支持 params.entry 覆盖入口）。"""
    overrides: dict[str, set[str]] = {}
    for sc in (getattr(model, "scenes", {}) or {}).values():
        if not isinstance(sc, dict):
            continue
        for npc in sc.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            gid = str(npc.get("dialogueGraphId", "") or "").strip()
            dge = str(npc.get("dialogueGraphEntry", "") or "").strip()
            if gid and dge:
                overrides.setdefault(gid, set()).add(dge)
        # 热区也可能带 dialogueGraphId/Entry
        for hs in sc.get("hotspots") or []:
            if not isinstance(hs, dict):
                continue
            data = hs.get("data") if isinstance(hs.get("data"), dict) else {}
            gid = str(data.get("dialogueGraphId", "") or "").strip()
            dge = str(data.get("dialogueGraphEntry", "") or "").strip()
            if gid and dge:
                overrides.setdefault(gid, set()).add(dge)
    return overrides


def _validate_dialogue_graphs(model: ProjectModel, issues: list[Issue]) -> None:
    gd = model.dialogues_path / "graphs"
    if not gd.is_dir():
        return
    scen = _scenario_definitions(model)
    quest_ids = {str(q.get("id", "")) for q in model.quests if q.get("id")}
    entry_overrides = _collect_dialogue_graph_entry_overrides(model)
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
        for nid, node in nodes.items():
            if not isinstance(node, dict):
                continue
            ctx = f"{stem}:{nid}"
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
                for ci, case in enumerate(node.get("cases") or []):
                    if not isinstance(case, dict):
                        continue
                    cctx = f"{ctx} case[{ci}]"
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
            # 备用入口（NPC/热区的 dialogueGraphEntry 覆盖）也算根，避免多入口共享图误报
            roots = {entry} | {e for e in entry_overrides.get(stem, set()) if e in nodes}
            gid_meta = str((meta or {}).get("id") or "").strip() if isinstance(meta, dict) else ""
            gid_self = str(gdata.get("id") or "").strip()
            for alt_key in (gid_meta, gid_self):
                if alt_key:
                    roots |= {e for e in entry_overrides.get(alt_key, set()) if e in nodes}
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
        for hs in sc.get("hotspots", []) or []:
            hid = str(hs.get("id", ""))
            _walk_conditions(model, issues, hs.get("conditions"), "scene", hid, sid)
            data = hs.get("data") or {}
            _walk_action_defs(model, issues, data.get("actions"), "scene", hid, sid)
        for npc in sc.get("npcs", []) or []:
            nid = str(npc.get("id", ""))
            _walk_conditions(model, issues, npc.get("conditions"), "scene", nid, sid)
        _walk_action_defs(model, issues, sc.get("onEnter"), "scene", sid, sid)
        for zone in sc.get("zones", []) or []:
            zid = str(zone.get("id", ""))
            _walk_conditions(model, issues, zone.get("conditions"), "scene", zid, sid)
            for ev in ("onEnter", "onStay", "onExit"):
                _walk_action_defs(model, issues, zone.get(ev), "scene", zid, sid)

    for q in model.quests:
        qid = str(q.get("id", ""))
        for ck in ("preconditions", "completionConditions"):
            _walk_conditions(model, issues, q.get(ck), "quest", qid, None)
        for edge in q.get("nextQuests", []) or []:
            _walk_conditions(model, issues, edge.get("conditions"), "quest", qid, None)
        _walk_action_defs(model, issues, q.get("acceptActions"), "quest", qid, None)
        _walk_action_defs(model, issues, q.get("rewards"), "quest", qid, None)

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

    for ch in model.archive_characters:
        cid = str(ch.get("id", ""))
        # 人物解锁只走 addArchiveEntry，无 unlockConditions 可校验；仅走分段显示条件 + 首阅动作。
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
        if step.get("kind") == "present" and step.get("type") == "showMovieBar":
            return True
        if step.get("kind") == "parallel" and _cutscene_has_show_movie_bar(step.get("tracks") or []):
            return True
    return False


def _cutscene_subtitle_voice_id(step: dict) -> str:
    raw = step.get("subtitleVoice")
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
) -> None:
    from .shared.action_editor import ACTION_PERSISTENCE, ACTION_TYPES
    allowed_types = set(ACTION_TYPES)

    # 顶层调用时整树扫一次是否出现过 showMovieBar，供 movie 版式字幕校验（向并行子轨透传）。
    if cutscene_movie_bar is None:
        cutscene_movie_bar = _cutscene_has_show_movie_bar(steps)

    # 参数引用只在顶层扫一次：_walk_cutscene_action_param_refs 本身已递归进 parallel 子轨，
    # 且 temp_actor_ids 从整棵树采集（含外层 spawn）。并行子轨的递归 _validate_cutscene_steps
    # 不得重扫——否则外层 spawn 的临时演员在子轨内被误报「无法解析」+ 参数告警翻倍（审查 P1-34）。
    if scan_param_refs:
        temp_actor_ids = frozenset(_cutscene_temp_actor_ids_in_steps(steps))
        _walk_cutscene_action_param_refs(model, issues, steps, cid, temp_actor_ids)

    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        kind = step.get("kind", "")

        if kind == "action":
            t = step.get("type", "")
            if t and t not in allowed_types:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{i+1} action type {t!r} 未在 ACTION_TYPES 中登记",
                ))
            if t and t not in _CUTSCENE_ACTION_WHITELIST:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{i+1} action type {t!r} 不在 Cutscene 白名单内（Cutscene 仅允许无副作用 Action）",
                ))
            if t and ACTION_PERSISTENCE.get(t) == "save" and t not in _CUTSCENE_STAGING_SAVE_ACTIONS:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{i+1} action type {t!r} 会修改全局存档状态，必须放到 startCutscene 外层 action 列表",
                ))
            if t == "cutsceneSpawnActor":
                sid = str((step.get("params") or {}).get("id", ""))
                if sid and not sid.startswith("_cut_"):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{i+1} cutsceneSpawnActor id {sid!r} 必须以 _cut_ 开头",
                    ))

        elif kind == "present":
            t = str(step.get("type", ""))
            if t and t not in _CUTSCENE_PRESENT_TYPES:
                issues.append(Issue(
                    "error", "cutscene", cid,
                    f"step #{i+1} 未知 present type {t!r}（运行时 CutsceneManager 会静默跳过）",
                ))
            if t == "showImg" and not str(step.get("image") or "").strip():
                issues.append(Issue(
                    "warning", "cutscene", cid,
                    f"step #{i+1} showImg 缺 image（运行时将加载空路径）",
                ))
            if t == "animLayer":
                af = str(step.get("animFile") or "").strip()
                if not af:
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{i+1} animLayer 缺 animFile（anim.json 路径）",
                    ))
                elif not af.endswith("anim.json"):
                    issues.append(Issue(
                        "warning", "cutscene", cid,
                        f"step #{i+1} animLayer 的 animFile 通常指向 …/anim.json，实为 {af!r}",
                    ))
                for k in ("xPercent", "yPercent", "widthPercent", "alpha", "zIndex"):
                    if k in step:
                        v = step.get(k)
                        if not isinstance(v, (int, float)) or isinstance(v, bool):
                            issues.append(Issue(
                                "error", "cutscene", cid,
                                f"step #{i+1} animLayer.{k} 应为数值，实为 {v!r}",
                            ))
            if t == "parallaxScene":
                inline = step.get("scene")
                ref = str(step.get("id") or "").strip()
                if isinstance(inline, dict):
                    # 内联场景：就地按 parallax_scenes 同一套结构校验（复用注册表校验器）。
                    _validate_one_parallax_scene(
                        inline, issues, "cutscene", cid,
                        where=f"step #{i+1} parallaxScene.scene",
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
                            f"step #{i+1} parallaxScene id {ref!r} 不在 parallax_scenes.json 中"
                            f"（运行时找不到场景会静默跳过该步）",
                        ))
                else:
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{i+1} parallaxScene 需给 id（引用 parallax_scenes.json）"
                        f"或内联 scene 对象",
                    ))
                if "handle" in step and not isinstance(step.get("handle"), str):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{i+1} parallaxScene 的 handle 应为字符串（叠层句柄；缺省=匿名镜头位，"
                        f"被下一个 parallaxScene / 匿名 showImg 自动顶掉；写了则需 hideImg 手动收）",
                    ))
            if t == "showImg" and "zIndex" in step:
                zi = step.get("zIndex")
                if not isinstance(zi, (int, float)) or isinstance(zi, bool):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{i+1} showImg 的 zIndex 应为数值，实为 {zi!r}",
                    ))
                elif zi >= 10000:
                    issues.append(Issue(
                        "warning", "cutscene", cid,
                        f"step #{i+1} showImg zIndex={zi} ≥ 10000（会盖过电影黑边，通常不该这样）",
                    ))
            if t == "showImg" and "kenBurns" in step:
                kb = step.get("kenBurns")
                if not isinstance(kb, dict):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{i+1} showImg 的 kenBurns 应为对象（运行时非对象会被忽略）",
                    ))
                else:
                    _KB_KEYS = {"fromScale", "toScale", "fromX", "fromY", "toX", "toY", "durationMs"}
                    for k, v in kb.items():
                        if k not in _KB_KEYS:
                            issues.append(Issue(
                                "warning", "cutscene", cid,
                                f"step #{i+1} kenBurns 含未知键 {k!r}（运行时忽略；已知键：{sorted(_KB_KEYS)}）",
                            ))
                        elif not isinstance(v, (int, float)) or isinstance(v, bool):
                            issues.append(Issue(
                                "error", "cutscene", cid,
                                f"step #{i+1} kenBurns.{k} 应为数值，实为 {v!r}",
                            ))
                    for k in ("fromScale", "toScale"):
                        v = kb.get(k)
                        if isinstance(v, (int, float)) and not isinstance(v, bool) and v < 1:
                            issues.append(Issue(
                                "warning", "cutscene", cid,
                                f"step #{i+1} kenBurns.{k}={v} 小于 1（运行时会夹到 1，等于没推）",
                            ))
                    dur = kb.get("durationMs")
                    if isinstance(dur, (int, float)) and not isinstance(dur, bool) and dur <= 0:
                        issues.append(Issue(
                            "warning", "cutscene", cid,
                            f"step #{i+1} kenBurns.durationMs={dur} 非正数（运行时按 12000 处理）",
                        ))
                    if not kb:
                        issues.append(Issue(
                            "warning", "cutscene", cid,
                            f"step #{i+1} kenBurns 为空对象，等于未启用（可删掉该键）",
                        ))
            if t == "showSubtitle":
                band = str(step.get("subtitleBand") or "").strip()
                align = str(step.get("subtitleAlign") or "").strip()
                if (band or align) and not cutscene_movie_bar:
                    issues.append(Issue(
                        "warning", "cutscene", cid,
                        f"step #{i+1} 字幕用了相对黑边版式（subtitleBand/Align），"
                        f"但本过场没有 showMovieBar，运行时黑边不存在",
                    ))
                voice_id = _cutscene_subtitle_voice_id(step)
                if voice_id and voice_id not in (model.audio_config.get("sfx") or {}):
                    issues.append(Issue(
                        "warning", "cutscene", cid,
                        f"step #{i+1} subtitleVoice {voice_id!r} 不在 audio_config.sfx 中",
                    ))
                if "subtitleAutoAdvance" in step:
                    aa = step.get("subtitleAutoAdvance")
                    aa_is_voice = aa == "voice"
                    aa_is_ms = isinstance(aa, (int, float)) and not isinstance(aa, bool) and aa > 0
                    if not (aa_is_voice or aa_is_ms):
                        issues.append(Issue(
                            "error", "cutscene", cid,
                            f"step #{i+1} subtitleAutoAdvance 应为 \"voice\" 或正毫秒数，实为 {aa!r}"
                            f"（运行时非法值退化为等待点击）",
                        ))
                    if aa_is_voice and not voice_id:
                        issues.append(Issue(
                            "warning", "cutscene", cid,
                            f"step #{i+1} subtitleAutoAdvance=\"voice\" 但未配置 subtitleVoice"
                            f"（运行时退化为等待点击）",
                        ))

        elif kind == "parallel":
            tr = step.get("tracks") or []
            if isinstance(tr, list) and len(tr) == 0:
                issues.append(Issue(
                    "warning", "cutscene", cid,
                    f"step #{i+1} parallel 的 tracks 为空（运行时该步将立即结束，确认是否占位遗漏）",
                ))
            _validate_cutscene_steps(
                model, tr, cid, issues, cutscene_movie_bar=cutscene_movie_bar,
                scan_param_refs=False)

        elif kind:
            issues.append(Issue(
                "warning", "cutscene", cid,
                f"step #{i+1} 未知 kind {kind!r}",
            ))
