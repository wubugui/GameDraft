"""Orchestrates parsing of all game data files into a unified graph."""
from ..model.graph_model import GameGraph
from .json_parser import parse_quest_groups, parse_quests, parse_encounters, parse_items, parse_rules, parse_scenes
from .ink_parser import parse_all_ink


def parse_project(project_path: str) -> GameGraph:
    graph = GameGraph()

    parse_items(graph, project_path)
    parse_rules(graph, project_path)
    parse_quest_groups(graph, project_path)
    parse_quests(graph, project_path)
    parse_encounters(graph, project_path)
    parse_scenes(graph, project_path)
    parse_all_ink(graph, project_path)

    return graph
