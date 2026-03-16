"""Write modified game data back to JSON files with atomic writes."""
import json
import os
import tempfile

from .model.graph_model import GameGraph
from .model.node_types import NodeType


def _atomic_write(filepath: str, data):
    content = json.dumps(data, ensure_ascii=False, indent=2)
    dir_name = os.path.dirname(filepath)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.write("\n")
        os.replace(tmp_path, filepath)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def save_quests(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "quests.json")
    quests = []
    for nd in graph.nodes_by_type(NodeType.QUEST):
        quests.append(nd.data)
        nd.dirty = False
    _atomic_write(fp, quests)


def save_encounters(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "encounters.json")
    encounters = []
    for nd in graph.nodes_by_type(NodeType.ENCOUNTER):
        encounters.append(nd.data)
        nd.dirty = False
    _atomic_write(fp, encounters)


def save_items(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "items.json")
    items = []
    for nd in graph.nodes_by_type(NodeType.ITEM):
        items.append(nd.data)
        nd.dirty = False
    _atomic_write(fp, items)


def save_rules(graph: GameGraph, project_path: str):
    fp = os.path.join(project_path, "public", "assets", "data", "rules.json")
    rules = []
    fragments = []
    for nd in graph.nodes_by_type(NodeType.RULE):
        rules.append(nd.data)
        nd.dirty = False
    for nd in graph.nodes_by_type(NodeType.FRAGMENT):
        fragments.append(nd.data)
        nd.dirty = False
    _atomic_write(fp, {"rules": rules, "fragments": fragments})


def save_scene(graph: GameGraph, project_path: str, scene_id: str):
    scene_nd = graph.get_node(f"scene:{scene_id}")
    if not scene_nd:
        return
    scene_data = dict(scene_nd.data)

    hotspots = []
    npcs = []
    zones = []
    for nd in graph.nodes_by_type(NodeType.HOTSPOT):
        if nd.id.startswith(f"hotspot:{scene_id}."):
            hotspots.append(nd.data)
            nd.dirty = False
    for nd in graph.nodes_by_type(NodeType.NPC):
        if nd.id.startswith(f"npc:{scene_id}."):
            npcs.append(nd.data)
            nd.dirty = False
    for nd in graph.nodes_by_type(NodeType.ZONE):
        if nd.id.startswith(f"zone:{scene_id}."):
            zones.append(nd.data)
            nd.dirty = False

    scene_data["hotspots"] = hotspots
    scene_data["npcs"] = npcs
    if zones:
        scene_data["zones"] = zones
    elif "zones" in scene_data:
        del scene_data["zones"]
    scene_nd.dirty = False

    fp = scene_nd.source_file
    if fp:
        _atomic_write(fp, scene_data)


def save_all(graph: GameGraph, project_path: str):
    save_quests(graph, project_path)
    save_encounters(graph, project_path)
    save_items(graph, project_path)
    save_rules(graph, project_path)

    scene_ids = set()
    for nd in graph.nodes_by_type(NodeType.SCENE):
        raw_id = nd.id.replace("scene:", "")
        scene_ids.add(raw_id)
    for sid in scene_ids:
        save_scene(graph, project_path, sid)
