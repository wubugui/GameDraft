"""Parse all game JSON config files and populate the graph."""
import json
import os
from pathlib import Path

from ..model.graph_model import GameGraph
from ..model.node_types import NodeData, NodeType
from ..model.edge_types import EdgeType


def _ensure_flag(graph: GameGraph, flag_key: str):
    if graph.get_node(flag_key) is None:
        graph.add_node(NodeData(
            id=flag_key,
            node_type=NodeType.FLAG,
            label=flag_key,
        ))


def _extract_flags_from_conditions(graph: GameGraph, owner_id: str, conditions: list[dict]):
    for cond in conditions:
        fk = cond.get("flag", "")
        if fk:
            _ensure_flag(graph, fk)
            graph.add_edge(fk, owner_id, EdgeType.READS_FLAG)


def _extract_flags_from_actions(graph: GameGraph, owner_id: str, actions: list[dict]):
    for act in actions:
        atype = act.get("type", "")
        params = act.get("params", {})

        if atype == "setFlag":
            fk = params.get("key", "")
            if fk:
                _ensure_flag(graph, fk)
                graph.add_edge(owner_id, fk, EdgeType.WRITES_FLAG)

        elif atype in ("giveItem", "removeItem"):
            item_id = params.get("id", "")
            if item_id:
                graph.add_edge(owner_id, f"item:{item_id}", EdgeType.GIVES if atype == "giveItem" else EdgeType.CONSUMES)

        elif atype in ("giveCurrency", "removeCurrency"):
            _ensure_flag(graph, "coins")
            graph.add_edge(owner_id, "coins", EdgeType.WRITES_FLAG)

        elif atype == "giveRule":
            rule_id = params.get("id", "")
            if rule_id:
                graph.add_edge(owner_id, f"rule:{rule_id}", EdgeType.GIVES)

        elif atype == "giveFragment":
            frag_id = params.get("id", "")
            if frag_id:
                graph.add_edge(owner_id, f"frag:{frag_id}", EdgeType.GIVES)

        elif atype == "updateQuest":
            qid = params.get("id", "")
            if qid:
                graph.add_edge(owner_id, f"quest:{qid}", EdgeType.TRIGGERS)

        elif atype == "startEncounter":
            eid = params.get("id", "")
            if eid:
                graph.add_edge(owner_id, f"enc:{eid}", EdgeType.TRIGGERS)

        elif atype == "enableRuleOffers":
            for slot in params.get("slots") or []:
                if not isinstance(slot, dict):
                    continue
                rule_id = slot.get("ruleId", "")
                if rule_id:
                    graph.add_edge(owner_id, f"rule:{rule_id}", EdgeType.RULE_SLOT)
                _extract_flags_from_actions(graph, owner_id, slot.get("resultActions") or [])


def parse_quest_groups(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "questGroups.json")
    if not os.path.exists(fp):
        return
    with open(fp, "r", encoding="utf-8") as f:
        groups = json.load(f)

    for g in groups:
        nid = f"qgroup:{g['id']}"
        graph.add_node(NodeData(
            id=nid,
            node_type=NodeType.QUEST_GROUP,
            label=g.get("name", g["id"]),
            source_file=fp,
            data=g,
        ))
        pg = g.get("parentGroup")
        if pg:
            graph.add_edge(f"qgroup:{pg}", nid, EdgeType.CONTAINS)


def parse_quests(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "quests.json")
    if not os.path.exists(fp):
        return
    with open(fp, "r", encoding="utf-8") as f:
        quests = json.load(f)

    for q in quests:
        nid = f"quest:{q['id']}"
        graph.add_node(NodeData(
            id=nid,
            node_type=NodeType.QUEST,
            label=q.get("title", q["id"]),
            source_file=fp,
            data=q,
        ))

        grp = q.get("group", "")
        if grp:
            graph.add_edge(f"qgroup:{grp}", nid, EdgeType.BELONGS_TO_GROUP)

        _extract_flags_from_conditions(graph, nid, q.get("preconditions", []))
        _extract_flags_from_conditions(graph, nid, q.get("completionConditions", []))
        _extract_flags_from_actions(graph, nid, q.get("rewards", []))

        for edge in q.get("nextQuests", []):
            tgt = edge.get("questId", "")
            if tgt:
                graph.add_edge(nid, f"quest:{tgt}", EdgeType.NEXT_QUEST)
                _extract_flags_from_conditions(graph, nid, edge.get("conditions", []))
        nq = q.get("nextQuestId")
        if nq and not q.get("nextQuests"):
            graph.add_edge(nid, f"quest:{nq}", EdgeType.NEXT_QUEST)


def parse_encounters(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "encounters.json")
    if not os.path.exists(fp):
        return
    with open(fp, "r", encoding="utf-8") as f:
        encounters = json.load(f)

    for enc in encounters:
        nid = f"enc:{enc['id']}"
        graph.add_node(NodeData(
            id=nid,
            node_type=NodeType.ENCOUNTER,
            label=enc["id"],
            source_file=fp,
            data=enc,
        ))

        for i, opt in enumerate(enc.get("options", [])):
            opt_id = f"{nid}:opt{i}"
            _extract_flags_from_conditions(graph, nid, opt.get("conditions", []))
            _extract_flags_from_actions(graph, nid, opt.get("resultActions", []))

            for ci in opt.get("consumeItems", []):
                item_id = ci.get("id", "")
                if item_id:
                    graph.add_edge(nid, f"item:{item_id}", EdgeType.CONSUMES)


def parse_items(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "items.json")
    if not os.path.exists(fp):
        return
    with open(fp, "r", encoding="utf-8") as f:
        items = json.load(f)

    for item in items:
        nid = f"item:{item['id']}"
        graph.add_node(NodeData(
            id=nid,
            node_type=NodeType.ITEM,
            label=item.get("name", item["id"]),
            source_file=fp,
            data=item,
        ))


def parse_rules(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "rules.json")
    if not os.path.exists(fp):
        return
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)

    for rule in data.get("rules", []):
        nid = f"rule:{rule['id']}"
        graph.add_node(NodeData(
            id=nid,
            node_type=NodeType.RULE,
            label=rule.get("name", rule["id"]),
            source_file=fp,
            data=rule,
        ))
    for frag in data.get("fragments", []):
        nid = f"frag:{frag['id']}"
        graph.add_node(NodeData(
            id=nid,
            node_type=NodeType.FRAGMENT,
            label=frag.get("text", frag["id"])[:30],
            source_file=fp,
            data=frag,
        ))
        rule_id = frag.get("ruleId", "")
        if rule_id:
            graph.add_edge(nid, f"rule:{rule_id}", EdgeType.SYNTHESIZES)


def parse_scenes(graph: GameGraph, project_path: str):
    scenes_dir = os.path.join(project_path, "public", "assets", "scenes")
    if not os.path.isdir(scenes_dir):
        return

    for fname in os.listdir(scenes_dir):
        if not fname.endswith(".json"):
            continue
        fp = os.path.join(scenes_dir, fname)
        with open(fp, "r", encoding="utf-8") as f:
            scene = json.load(f)

        scene_id = f"scene:{scene['id']}"
        graph.add_node(NodeData(
            id=scene_id,
            node_type=NodeType.SCENE,
            label=scene.get("name", scene["id"]),
            source_file=fp,
            data=scene,
        ))

        for hs in scene.get("hotspots", []):
            hs_id = f"hotspot:{scene['id']}.{hs['id']}"
            graph.add_node(NodeData(
                id=hs_id,
                node_type=NodeType.HOTSPOT,
                label=hs.get("label", hs["id"]),
                source_file=fp,
                data=hs,
            ))
            graph.add_edge(scene_id, hs_id, EdgeType.CONTAINS)
            _extract_flags_from_conditions(graph, hs_id, hs.get("conditions", []))

            hs_type = hs.get("type", "")
            hs_data = hs.get("data", {})

            if hs_type == "transition":
                target = hs_data.get("targetScene", "")
                if target:
                    graph.add_edge(hs_id, f"scene:{target}", EdgeType.TRANSITIONS)

            elif hs_type == "encounter":
                enc_id = hs_data.get("encounterId", "")
                if enc_id:
                    graph.add_edge(hs_id, f"enc:{enc_id}", EdgeType.TRIGGERS)

            elif hs_type == "pickup":
                item_id = hs_data.get("itemId", "")
                if item_id and not hs_data.get("isCurrency"):
                    graph.add_edge(hs_id, f"item:{item_id}", EdgeType.GIVES)

        for npc in scene.get("npcs", []):
            npc_id = f"npc:{scene['id']}.{npc['id']}"
            graph.add_node(NodeData(
                id=npc_id,
                node_type=NodeType.NPC,
                label=npc.get("name", npc["id"]),
                source_file=fp,
                data=npc,
            ))
            graph.add_edge(scene_id, npc_id, EdgeType.CONTAINS)

            dlg_file = npc.get("dialogueFile", "")
            if dlg_file:
                knot = npc.get("dialogueKnot", "start")
                dlg_base = Path(dlg_file).stem
                graph.add_edge(npc_id, f"knot:{dlg_base}.{knot}", EdgeType.TRIGGERS)

        for zone in scene.get("zones", []):
            zone_id = f"zone:{scene['id']}.{zone['id']}"
            graph.add_node(NodeData(
                id=zone_id,
                node_type=NodeType.ZONE,
                label=zone.get("id", ""),
                source_file=fp,
                data=zone,
            ))
            graph.add_edge(scene_id, zone_id, EdgeType.CONTAINS)
            _extract_flags_from_conditions(graph, zone_id, zone.get("conditions", []))
            _extract_flags_from_actions(graph, zone_id, zone.get("onEnter", []))
            _extract_flags_from_actions(graph, zone_id, zone.get("onStay", []))
            _extract_flags_from_actions(graph, zone_id, zone.get("onExit", []))
