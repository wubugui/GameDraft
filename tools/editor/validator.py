"""Cross-data reference validator."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .project_model import ProjectModel

INK_SETFLAG = re.compile(r"#\s*action:setFlag:([^:\s#]+):([^\s#]+)")
INK_REQUIRE = re.compile(r"#\s*require:([^\s#]+)")


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
            df = npc.get("dialogueFile", "")
            if df:
                fname = df.rsplit("/", 1)[-1] if "/" in df else df
                ink_files = model.all_ink_files()
                if fname not in ink_files:
                    issues.append(Issue("warning", "scene", sid,
                                        f"NPC '{npc.get('id')}' dialogueFile '{fname}' not found"))
        fid = sc.get("filterId")
        if fid and fid not in filter_ids:
            issues.append(Issue("warning", "scene", sid,
                                f"filterId '{fid}' has no matching filter JSON"))

    # --- quests ---
    for q in model.quests:
        nxt = q.get("nextQuestId")
        if nxt and nxt not in quest_ids:
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

    _validate_flags(model, issues)

    return issues


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


def _walk_setflag_actions(
    model: ProjectModel, issues: list[Issue], actions: list,
    data_type: str, item_id: str, scene_id: str | None,
) -> None:
    for act in actions or []:
        if not isinstance(act, dict):
            continue
        p = act.get("params") or {}
        if act.get("type") == "setFlag" and p.get("key"):
            _flag_issue(model, issues, str(p["key"]), data_type, item_id, scene_id)


def _validate_ink_file(model: ProjectModel, issues: list[Issue], ink_name: str) -> None:
    dp = model.dialogues_path
    path = dp / ink_name
    if not path.is_file():
        return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for m in INK_SETFLAG.finditer(text):
        key = m.group(1).strip()
        _flag_issue(model, issues, key, "ink", ink_name, None)
    for m in INK_REQUIRE.finditer(text):
        key = m.group(1).strip()
        if key:
            _flag_issue(model, issues, key, "ink", ink_name, None)


def _validate_flags(model: ProjectModel, issues: list[Issue]) -> None:
    reg = model.flag_registry
    if not reg.get("static") and not reg.get("patterns"):
        return

    for sid, sc in model.scenes.items():
        for hs in sc.get("hotspots", []) or []:
            hid = str(hs.get("id", ""))
            _walk_conditions(model, issues, hs.get("conditions"), "scene", hid, sid)
            data = hs.get("data") or {}
            _walk_setflag_actions(model, issues, data.get("actions"), "scene", hid, sid)
        for zone in sc.get("zones", []) or []:
            zid = str(zone.get("id", ""))
            _walk_conditions(model, issues, zone.get("conditions"), "scene", zid, sid)
            for ev in ("onEnter", "onExit"):
                _walk_setflag_actions(model, issues, zone.get(ev), "scene", zid, sid)
            for slot in zone.get("ruleSlots", []) or []:
                _walk_setflag_actions(model, issues, slot.get("resultActions"), "scene", zid, sid)

    for q in model.quests:
        qid = str(q.get("id", ""))
        for ck in ("preconditions", "completionConditions"):
            _walk_conditions(model, issues, q.get(ck), "quest", qid, None)

    for enc in model.encounters:
        eid = str(enc.get("id", ""))
        _walk_conditions(model, issues, enc.get("conditions"), "encounter", eid, None)
        for opt in enc.get("options", []) or []:
            _walk_conditions(model, issues, opt.get("conditions"), "encounter", eid, None)
            _walk_setflag_actions(model, issues, opt.get("resultActions"), "encounter", eid, None)
        for act in enc.get("rewards", []) or []:
            p = (act.get("params") or {}) if isinstance(act, dict) else {}
            if isinstance(act, dict) and act.get("type") == "setFlag" and p.get("key"):
                _flag_issue(model, issues, str(p["key"]), "encounter", eid, None)

    for node in model.map_nodes:
        mid = str(node.get("sceneId", "?"))
        _walk_conditions(model, issues, node.get("unlockConditions"), "map", mid, None)

    for c in model.cutscenes:
        cid = str(c.get("id", ""))
        for cmd in c.get("commands", []) or []:
            if isinstance(cmd, dict) and cmd.get("type") == "set_flag" and cmd.get("key"):
                _flag_issue(model, issues, str(cmd["key"]), "cutscene", cid, None)

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

    entries = model.archive_lore
    if isinstance(entries, dict):
        entries = entries.get("entries", [])
    for le in entries or []:
        lid = str(le.get("id", ""))
        _walk_conditions(model, issues, le.get("unlockConditions"), "archive", lid, None)

    for doc in model.archive_documents:
        did = str(doc.get("id", ""))
        _walk_conditions(model, issues, doc.get("discoverConditions"), "archive", did, None)

    for bk in model.archive_books:
        bid = str(bk.get("id", ""))
        for pg in bk.get("pages", []) or []:
            _walk_conditions(model, issues, pg.get("unlockConditions"), "archive", bid, None)

    cfg = model.game_config
    done_flag = cfg.get("initialCutsceneDoneFlag")
    if done_flag:
        _flag_issue(model, issues, str(done_flag), "config", "game_config", None)
    sf = cfg.get("startupFlags")
    if isinstance(sf, dict):
        for fk in sf:
            if fk:
                _flag_issue(model, issues, str(fk), "config", "game_config", None)

    for ink_name in model.all_ink_files():
        if not ink_name.endswith(".ink"):
            continue
        _validate_ink_file(model, issues, ink_name)
