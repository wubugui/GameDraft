"""Cross-data reference validator."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .file_io import read_json
from .flag_registry import scenario_exposes_flag_errors
from .shared.runtime_field_schema import field_meta, is_valid_field, value_matches_field

if TYPE_CHECKING:
    from .project_model import ProjectModel

@dataclass
class Issue:
    severity: str  # "error" | "warning"
    data_type: str
    item_id: str
    message: str


def validate(model: ProjectModel) -> list[Issue]:
    issues: list[Issue] = []
    from .shared.ref_validator import validate_all_embedded_refs

    for i, msg in enumerate(validate_all_embedded_refs(model)):
        issues.append(Issue("error", "embeddedRef", f"#{i}", msg))
    scene_ids = set(model.all_scene_ids())
    item_ids = {it["id"] for it in model.items}
    quest_ids = {q["id"] for q in model.quests}
    encounter_ids = {e["id"] for e in model.encounters}
    rule_ids = {r["id"] for r in model.rules_data.get("rules", [])}
    frag_ids = {f["id"] for f in model.rules_data.get("fragments", [])}
    cutscene_ids = {c["id"] for c in model.cutscenes}
    shop_ids = {s["id"] for s in model.shops}
    filter_ids = set(model.all_filter_ids())

    _validate_scenarios_catalog(model, issues)

    # --- scenes ---
    for sid, sc in model.scenes.items():
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
                                        f"Hotspot '{hs.get('id')}' targetScene '{ts}' not found"))
            if hs.get("type") == "encounter":
                eid = data.get("encounterId", "")
                if eid and eid not in encounter_ids:
                    issues.append(Issue("error", "scene", sid,
                                        f"Hotspot '{hs.get('id')}' encounterId '{eid}' not found"))
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
                    elif not itext and not idata.get("actions"):
                        issues.append(Issue(
                            "warning", "scene", sid,
                            f"Hotspot '{hid}' inspect 未配置 text 或 graphId",
                        ))
            if hs.get("type") == "pickup":
                iid = data.get("itemId", "")
                if iid and iid not in item_ids:
                    issues.append(Issue("warning", "scene", sid,
                                        f"Hotspot '{hs.get('id')}' itemId '{iid}' not found"))
        for npc in sc.get("npcs", []):
            ifi = npc.get("initialFacing")
            if ifi is not None and ifi not in ("left", "right"):
                issues.append(Issue(
                    "error", "scene", sid,
                    f"NPC '{npc.get('id')}' initialFacing 须为 'left' 或 'right'",
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

    # --- quest groups ---
    quest_group_ids = {g["id"] for g in model.quest_groups}
    for g in model.quest_groups:
        pg = g.get("parentGroup")
        if pg and pg not in quest_group_ids:
            issues.append(Issue("error", "questGroup", g["id"],
                                f"parentGroup '{pg}' not found"))
    # parentGroup circular reference detection
    for g in model.quest_groups:
        visited: set[str] = set()
        cur = g["id"]
        while cur:
            if cur in visited:
                issues.append(Issue("error", "questGroup", g["id"],
                                    f"parentGroup circular reference detected"))
                break
            visited.add(cur)
            parent_g = next((x for x in model.quest_groups if x["id"] == cur), None)
            cur = parent_g.get("parentGroup", "") if parent_g else ""

    # --- quests ---
    for q in model.quests:
        grp = q.get("group", "")
        if grp and grp not in quest_group_ids:
            issues.append(Issue("error", "quest", q["id"],
                                f"group '{grp}' not found in questGroups"))
        for edge in q.get("nextQuests", []):
            eid = edge.get("questId", "")
            if eid and eid not in quest_ids:
                issues.append(Issue("error", "quest", q["id"],
                                    f"nextQuests questId '{eid}' not found"))
        nxt = q.get("nextQuestId")
        if nxt and not q.get("nextQuests") and nxt not in quest_ids:
            issues.append(Issue("error", "quest", q["id"],
                                f"nextQuestId '{nxt}' not found"))

    # --- encounters ---
    for enc in model.encounters:
        for opt in enc.get("options", []):
            rid = opt.get("requiredRuleId")
            if rid and rid not in rule_ids:
                issues.append(Issue("error", "encounter", enc["id"],
                                    f"requiredRuleId '{rid}' not found"))
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
                                        f"consumeItem '{ci['id']}' not found"))

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
                                f"Fragment ruleId '{frag['ruleId']}' not found"))
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
                                    f"shopItem '{si['itemId']}' not found"))

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
                                f"Map node sceneId '{node['sceneId']}' not found"))

    # --- game config ---
    cfg = model.game_config
    if cfg.get("initialScene") and cfg["initialScene"] not in scene_ids:
        issues.append(Issue("error", "config", "game_config",
                            f"initialScene '{cfg['initialScene']}' not found"))
    if cfg.get("initialQuest") and cfg["initialQuest"] not in quest_ids:
        issues.append(Issue("error", "config", "game_config",
                            f"initialQuest '{cfg['initialQuest']}' not found"))
    if cfg.get("initialCutscene") and cfg["initialCutscene"] not in cutscene_ids:
        issues.append(Issue("warning", "config", "game_config",
                            f"initialCutscene '{cfg['initialCutscene']}' not found"))

    _validate_overlay_images(model, issues)

    _validate_flags(model, issues)

    _validate_dialogue_graphs(model, issues)

    return issues


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


def _flag_issue(model: ProjectModel, issues: list[Issue], key: str,
                data_type: str, item_id: str, scene_id: str | None) -> None:
    from .flag_registry import validate_flag_key
    reg = model.flag_registry
    if not reg:
        return
    ok, msg = validate_flag_key(key, reg, model, scene_id=scene_id, severity="warning")
    if ok or not msg:
        return
    issues.append(Issue("warning", data_type, item_id, msg))


def _walk_conditions(
    model: ProjectModel, issues: list[Issue], conds: list, data_type: str,
    item_id: str, scene_id: str | None,
) -> None:
    for cond in conds or []:
        if isinstance(cond, dict) and cond.get("flag"):
            _flag_issue(model, issues, str(cond["flag"]), data_type, item_id, scene_id)


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

    if t in ("hideOverlayImage", "showOverlayImage", "blendOverlayImage"):
        oid = str(p.get("id") or "").strip()
        if oid and overlay_keys and oid not in overlay_keys:
            issues.append(Issue(
                "warning", data_type, item_id,
                f"{t} id {oid!r} 不在 overlay_images.json 的键中",
            ))

    if t == "faceEntity":
        d = str(p.get("direction") or "").strip()
        if d and d not in ("left", "right", "up", "down"):
            issues.append(Issue(
                "warning", data_type, item_id,
                f"faceEntity direction {d!r} 非 left/right/up/down",
            ))

    actor_actions = (
        "playNpcAnimation", "setEntityEnabled", "moveEntityTo", "showEmoteAndWait",
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
    """per-phase /进线 requires 布尔式、引用与纯与链 DAG（无环）。"""
    from .scenario_requires_expr import flatten_and_of_phase_strings, validate_requires_expr
    from .scenarios_catalog_validate import scenario_entry_prereq_cycle_among_leaves

    raw = model.scenarios_catalog.get("scenarios")
    if not isinstance(raw, list):
        return
    for e in raw:
        if not isinstance(e, dict):
            continue
        sid = str(e.get("id", "")).strip()
        if not sid:
            continue
        phases = e.get("phases")
        if not isinstance(phases, dict):
            continue
        pnames = {str(k) for k in phases.keys()}
        entry_req = e.get("requires")
        if entry_req is not None:
            err = validate_requires_expr(
                entry_req,
                pset=pnames,
                where=f"{sid!r} 的 scenario 进线 requires",
            )
            if err:
                issues.append(Issue("error", "scenarios", sid, err))
            else:
                cyc = scenario_entry_prereq_cycle_among_leaves(
                    entry_req, phases, sid=sid,
                )
                if cyc:
                    issues.append(Issue("error", "scenarios", sid, cyc))
        adj: dict[str, list[str]] = {}
        skip_cycle = False
        for pname, pval in phases.items():
            pn = str(pname)
            req_list: list[str] = []
            if isinstance(pval, dict):
                req = pval.get("requires")
                if req is not None:
                    err = validate_requires_expr(
                        req,
                        pset=pnames,
                        where=f"{sid!r} 的 phase {pn!r} requires",
                    )
                    if err:
                        issues.append(Issue("error", "scenarios", sid, err))
                    flat = flatten_and_of_phase_strings(req)
                    if flat is None:
                        skip_cycle = True
                    else:
                        req_list = flat
            adj[pn] = req_list
        _WHITE, _GREY, _BLACK = 0, 1, 2
        color = {n: _WHITE for n in adj}

        def _dfs(u: str) -> bool:
            color[u] = _GREY
            for v in adj.get(u, []):
                if v not in color:
                    continue
                if color.get(v) == _GREY:
                    return True
                if color.get(v) == _WHITE and _dfs(v):
                    return True
            color[u] = _BLACK
            return False

        if not skip_cycle:
            cyc = False
            for n in adj:
                if color.get(n) == _WHITE and _dfs(n):
                    cyc = True
                    break
            if cyc:
                issues.append(Issue(
                    "error", "scenarios", sid,
                    "phases.requires 存在循环依赖",
                ))

        exp_msg = scenario_exposes_flag_errors(
            e.get("exposes"), model.flag_registry, model, scenario_id=sid,
        )
        if exp_msg:
            issues.append(Issue("error", "scenarios", sid, exp_msg))


def _scan_condition_expr(
    model: ProjectModel,
    issues: list[Issue],
    expr: object,
    scen: dict[str, dict],
    quest_ids: set[str],
    data_type: str,
    item_id: str,
    depth: int,
) -> None:
    """switch.condition / 文档揭示等：结构 + flag / scenario / quest 引用粗校验。"""
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
            )
        return
    if "not" in expr:
        _scan_condition_expr(
            model, issues, expr.get("not"), scen, quest_ids, data_type, item_id, depth + 1,
        )
        return
    if expr.get("flag") is not None:
        _flag_issue(model, issues, str(expr["flag"]), data_type, item_id, None)
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
    issues.append(Issue(
        "warning", data_type, item_id,
        f"无法识别的条件叶子（键: {sorted(expr.keys())!s}）",
    ))


def _validate_dialogue_graphs(model: ProjectModel, issues: list[Issue]) -> None:
    gd = model.dialogues_path / "graphs"
    if not gd.is_dir():
        return
    scen = _scenario_definitions(model)
    quest_ids = {str(q.get("id", "")) for q in model.quests if q.get("id")}
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


def _walk_action_defs(
    model: ProjectModel, issues: list[Issue], actions: list,
    data_type: str, item_id: str, scene_id: str | None,
    *,
    cutscene_temp_ids: frozenset[str] | None = None,
) -> None:
    """遍历 ActionDef 列表：校验 type 已在编辑器登记；setFlag 键；嵌套 enableRuleOffers / addDelayedEvent。"""
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
        if t == "setFlag" and p.get("key"):
            _flag_issue(model, issues, str(p["key"]), data_type, item_id, scene_id)
        elif t == "appendFlag" and p.get("key"):
            fk = str(p["key"])
            _flag_issue(model, issues, fk, data_type, item_id, scene_id)
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
    reg = model.flag_registry
    if not reg.get("static") and not reg.get("patterns"):
        return

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
        _walk_conditions(model, issues, ch.get("unlockConditions"), "archive", cid, None)
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
                _walk_conditions(
                    model, issues, ent.get("discoverConditions"),
                    "archive", f"{bid}/entry/{eid}", None,
                )
                _walk_action_defs(
                    model, issues, ent.get("firstViewActions"),
                    "archive", f"{bid}/entry/{eid}", None,
                )

    cfg = model.game_config
    done_flag = cfg.get("initialCutsceneDoneFlag")
    if done_flag:
        _flag_issue(model, issues, str(done_flag), "config", "game_config", None)
    sf = cfg.get("startupFlags")
    if isinstance(sf, dict):
        for fk in sf:
            if fk:
                _flag_issue(model, issues, str(fk), "config", "game_config", None)


_CUTSCENE_ACTION_WHITELIST = frozenset([
    "moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor",
    "showEmoteAndWait", "playNpcAnimation", "setEntityEnabled",
    "playSfx", "playBgm", "stopBgm",
])


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
) -> None:
    from .shared.action_editor import ACTION_TYPES
    allowed_types = set(ACTION_TYPES)

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
            if t == "cutsceneSpawnActor":
                sid = str((step.get("params") or {}).get("id", ""))
                if sid and not sid.startswith("_cut_"):
                    issues.append(Issue(
                        "error", "cutscene", cid,
                        f"step #{i+1} cutsceneSpawnActor id {sid!r} 必须以 _cut_ 开头",
                    ))

        elif kind == "present":
            pass

        elif kind == "parallel":
            tr = step.get("tracks") or []
            if isinstance(tr, list) and len(tr) == 0:
                issues.append(Issue(
                    "warning", "cutscene", cid,
                    f"step #{i+1} parallel 的 tracks 为空（运行时该步将立即结束，确认是否占位遗漏）",
                ))
            _validate_cutscene_steps(model, tr, cid, issues)

        elif kind:
            issues.append(Issue(
                "warning", "cutscene", cid,
                f"step #{i+1} 未知 kind {kind!r}",
            ))

