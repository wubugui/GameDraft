"""Parse ink files to extract structural information for the graph."""
import os
import re
from pathlib import Path

from ..model.graph_model import GameGraph
from ..model.node_types import NodeData, NodeType
from ..model.edge_types import EdgeType


_RE_KNOT = re.compile(r"^===\s*(\w+)\s*===$")
_RE_STITCH = re.compile(r"^=\s+(\w+)\s*$")
_RE_DIVERT = re.compile(r"->\s*(\w+)")
_RE_CHOICE = re.compile(r"^(\s*)\*|\+")
_RE_ACTION_TAG = re.compile(r"#\s*action:(\S+)")
_RE_GETFLAG = re.compile(r'getFlag\(\s*"([^"]+)"\s*\)')


def _ensure_flag(graph: GameGraph, flag_key: str):
    if graph.get_node(flag_key) is None:
        graph.add_node(NodeData(
            id=flag_key,
            node_type=NodeType.FLAG,
            label=flag_key,
        ))


def parse_ink_file(graph: GameGraph, filepath: str):
    basename = Path(filepath).stem

    with open(filepath, "r", encoding="utf-8") as f:
        lines = f.readlines()

    knots: list[dict] = []
    current_knot: dict | None = None

    for lineno, raw_line in enumerate(lines, start=1):
        line = raw_line.rstrip("\n")

        km = _RE_KNOT.match(line)
        if km:
            current_knot = {
                "name": km.group(1),
                "start_line": lineno,
                "lines": [],
                "diverts": [],
                "action_tags": [],
                "getflags": [],
                "choices": [],
            }
            knots.append(current_knot)
            continue

        if current_knot is not None:
            current_knot["lines"].append(line)

            for dm in _RE_DIVERT.finditer(line):
                target = dm.group(1)
                if target not in ("END", "DONE"):
                    current_knot["diverts"].append(target)

            for am in _RE_ACTION_TAG.finditer(line):
                current_knot["action_tags"].append(am.group(1))

            for gm in _RE_GETFLAG.finditer(line):
                current_knot["getflags"].append(gm.group(1))

            if _RE_CHOICE.match(line):
                current_knot["choices"].append(line.strip())

    for knot in knots:
        nid = f"knot:{basename}.{knot['name']}"
        text_preview = ""
        for ln in knot["lines"]:
            stripped = ln.strip()
            if stripped and not stripped.startswith("#") and not stripped.startswith("EXTERNAL"):
                text_preview = stripped[:60]
                break

        graph.add_node(NodeData(
            id=nid,
            node_type=NodeType.DIALOGUE_KNOT,
            label=f"{knot['name']}",
            source_file=filepath,
            data={
                "knot_name": knot["name"],
                "start_line": knot["start_line"],
                "text": "\n".join(knot["lines"]),
                "action_tags": knot["action_tags"],
                "getflags": knot["getflags"],
                "choices": knot["choices"],
                "preview": text_preview,
                "file": basename,
            },
        ))

        for target in set(knot["diverts"]):
            graph.add_edge(nid, f"knot:{basename}.{target}", EdgeType.DIVERTS)

        for tag in knot["action_tags"]:
            parts = tag.split(":")
            if len(parts) >= 2:
                action_type = parts[0]
                if action_type == "setFlag" and len(parts) >= 3:
                    flag_key = parts[1]
                    _ensure_flag(graph, flag_key)
                    graph.add_edge(nid, flag_key, EdgeType.WRITES_FLAG)
                elif action_type == "giveRule" and len(parts) >= 2:
                    rule_id = parts[1]
                    graph.add_edge(nid, f"rule:{rule_id}", EdgeType.GIVES)
                elif action_type == "giveFragment" and len(parts) >= 2:
                    frag_id = parts[1]
                    graph.add_edge(nid, f"frag:{frag_id}", EdgeType.GIVES)
                elif action_type == "giveItem" and len(parts) >= 2:
                    item_id = parts[1]
                    graph.add_edge(nid, f"item:{item_id}", EdgeType.GIVES)
                elif action_type == "startEncounter" and len(parts) >= 2:
                    enc_id = parts[1]
                    graph.add_edge(nid, f"enc:{enc_id}", EdgeType.TRIGGERS)

        for flag_key in set(knot["getflags"]):
            _ensure_flag(graph, flag_key)
            graph.add_edge(flag_key, nid, EdgeType.READS_FLAG)


def parse_all_ink(graph: GameGraph, project_path: str):
    dlg_dir = os.path.join(project_path, "public", "assets", "dialogues")
    if not os.path.isdir(dlg_dir):
        return

    for fname in os.listdir(dlg_dir):
        if fname.endswith(".ink"):
            parse_ink_file(graph, os.path.join(dlg_dir, fname))
