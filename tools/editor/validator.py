"""Cross-data reference validator."""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

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

    return issues
