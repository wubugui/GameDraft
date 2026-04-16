"""Cross-data reference validator."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .file_io import read_json

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
    scene_ids = set(model.all_scene_ids())
    item_ids = {it["id"] for it in model.items}
    quest_ids = {q["id"] for q in model.quests}
    encounter_ids = {e["id"] for e in model.encounters}
    rule_ids = {r["id"] for r in model.rules_data.get("rules", [])}
    frag_ids = {f["id"] for f in model.rules_data.get("fragments", [])}
    cutscene_ids = {c["id"] for c in model.cutscenes}
    shop_ids = {s["id"] for s in model.shops}
    filter_ids = set(model.all_filter_ids())

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
            for ci in opt.get("consumeItems", []):
                if ci.get("id") and ci["id"] not in item_ids:
                    issues.append(Issue("error", "encounter", enc["id"],
                                        f"consumeItem '{ci['id']}' not found"))

    # --- rules fragments ---
    for frag in model.rules_data.get("fragments", []):
        if frag.get("ruleId") and frag["ruleId"] not in rule_ids:
            issues.append(Issue("error", "rule", frag["id"],
                                f"Fragment ruleId '{frag['ruleId']}' not found"))

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


def _walk_action_defs(
    model: ProjectModel, issues: list[Issue], actions: list,
    data_type: str, item_id: str, scene_id: str | None,
) -> None:
    """遍历 ActionDef 列表：校验 type 已在编辑器登记；setFlag 键；嵌套 enableRuleOffers / addDelayedEvent。"""
    from .shared.action_editor import ACTION_TYPES
    allowed_types = set(ACTION_TYPES)

    for act in actions or []:
        if not isinstance(act, dict):
            continue
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
                    )
        elif t == "addDelayedEvent":
            _walk_action_defs(
                model, issues, p.get("actions"),
                data_type, item_id, scene_id,
            )


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
        _validate_cutscene_steps(c.get("steps", []) or [], cid, issues)

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


def _validate_cutscene_steps(
    steps: list, cid: str, issues: list[Issue],
) -> None:
    from .shared.action_editor import ACTION_TYPES
    allowed_types = set(ACTION_TYPES)

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
            _validate_cutscene_steps(step.get("tracks", []), cid, issues)

        elif kind:
            issues.append(Issue(
                "warning", "cutscene", cid,
                f"step #{i+1} 未知 kind {kind!r}",
            ))

