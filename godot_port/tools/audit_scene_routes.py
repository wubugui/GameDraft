#!/usr/bin/env python3
"""Audit source-authored player reachability without inventing Godot-only routes."""

from __future__ import annotations

import json
import sys
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
SCENES_DIR = ROOT / "public/assets/scenes"
MAP_PATH = ROOT / "public/assets/data/map_config.json"
GAME_CONFIG_PATH = ROOT / "public/assets/data/game_config.json"

# These scenes have no source-authored route from a new game. They must remain
# visible in the report rather than being made "green" with a Godot-only exit.
EXPECTED_NON_PLAYER_SCENES = {
    "dev_room",
    "dev_teahouse_alive",
    "test_scene",
    "深潭水下",
    "深潭绝地",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def walk_switch_targets(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        if value.get("type") == "switchScene" and isinstance(value.get("params"), dict):
            target = value["params"].get("targetScene")
            if isinstance(target, str) and target.strip():
                yield target.strip()
        for child in value.values():
            yield from walk_switch_targets(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_switch_targets(child)


def main() -> int:
    scenes: dict[str, dict[str, Any]] = {}
    source_path_by_id: dict[str, Path] = {}
    errors: list[str] = []
    for path in sorted(SCENES_DIR.glob("*.json")):
        raw = load_json(path)
        scene_id = raw.get("id") if isinstance(raw, dict) else None
        if not isinstance(scene_id, str) or not scene_id.strip():
            errors.append(f"{path.name}: missing scene id")
            continue
        if scene_id in scenes:
            errors.append(f"duplicate scene id {scene_id}: {source_path_by_id[scene_id].name}, {path.name}")
            continue
        scenes[scene_id] = raw
        source_path_by_id[scene_id] = path

    game_config = load_json(GAME_CONFIG_PATH)
    initial = str(game_config.get("initialScene", ""))
    if initial not in scenes:
        errors.append(f"initialScene does not exist: {initial}")

    edges: dict[str, set[str]] = defaultdict(set)
    route_kinds: dict[str, set[str]] = defaultdict(set)
    for source, scene in scenes.items():
        for hotspot in scene.get("hotspots", []):
            if not isinstance(hotspot, dict) or hotspot.get("type") != "transition":
                continue
            data = hotspot.get("data")
            target = data.get("targetScene") if isinstance(data, dict) else None
            if isinstance(target, str) and target.strip():
                edges[source].add(target.strip())
                route_kinds[target.strip()].add("transition")
        for target in walk_switch_targets(scene):
            edges[source].add(target)
            route_kinds[target].add("scene-action")

    # Dialogue graphs can transition between dream/quest scenes. Attribute
    # them to a virtual player action source: they are reachable only after a
    # player starts the corresponding graph, never through a Godot dev command.
    virtual_source = "@dialogue-action"
    for path in sorted((ROOT / "public/assets/dialogues/graphs").glob("*.json")):
        for target in walk_switch_targets(load_json(path)):
            edges[virtual_source].add(target)
            route_kinds[target].add("dialogue-action")

    map_config = load_json(MAP_PATH)
    map_targets: set[str] = set()
    for node in map_config.get("nodes", []):
        if not isinstance(node, dict) or node.get("runtimeVisible") is False or node.get("devOnly") is True:
            continue
        target = node.get("sceneId")
        if isinstance(target, str) and target.strip():
            map_targets.add(target.strip())
            route_kinds[target.strip()].add("map")
    edges[initial].update(map_targets)

    all_targets = {target for targets in edges.values() for target in targets}
    for target in sorted(all_targets):
        if target not in scenes:
            errors.append(f"route target does not exist: {target}")

    # A dialogue action is player-caused once any production scene is reached.
    reachable: set[str] = set()
    queue: deque[str] = deque([initial])
    dialogue_enabled = False
    while queue:
        source = queue.popleft()
        if source in reachable:
            continue
        reachable.add(source)
        if source in scenes and not dialogue_enabled:
            dialogue_enabled = True
            for target in edges[virtual_source]:
                if target not in reachable:
                    queue.append(target)
        for target in edges[source]:
            if target not in reachable:
                queue.append(target)
    reachable.discard(virtual_source)

    non_player = set(scenes) - reachable
    if non_player != EXPECTED_NON_PLAYER_SCENES:
        errors.append(
            "source non-player scene set changed: "
            f"expected={sorted(EXPECTED_NON_PLAYER_SCENES)}, actual={sorted(non_player)}"
        )
    if len(scenes) != 27:
        errors.append(f"expected 27 scenes, found {len(scenes)}")

    print(f"scenes={len(scenes)} player-addressable={len(reachable)} source-non-player={len(non_player)}")
    print("player-addressable:", ", ".join(sorted(reachable)))
    print("source-non-player:", ", ".join(sorted(non_player)))
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Scene route topology audit: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
