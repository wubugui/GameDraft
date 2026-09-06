"""Build an atlas from current native scene data; never edit game data or fetch assets.

Coordinates mirror SceneManager background placement, not a screenshot camera.
NPC markers describe authored anchors/routes and conditional schedules, never a
claim that every shift or every marker is simultaneously present in the game.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).with_name("atlas-data.json")
SCENES = ["雾津街头", "test_room_b", "码头白天", "河边", "bridge_underpass",
          "mountain_pass", "temple_exterior", "temple", "teahouse"]
STRING_TAG = re.compile(r"\[tag:string:([^:\]]+):([^\]]+)\]")


def read(relative: str):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def absolute(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/")


def source(relative: str, pointer: str = "") -> dict:
    return {"file": absolute(ROOT / relative), "repositoryPath": relative, "jsonPointer": pointer}


def main() -> None:
    strings = read("public/assets/data/strings.json")
    characters = {c["id"]: c for c in read("public/assets/data/character_registry.json")["characters"]}
    schedules = {s["characterId"]: s for s in read("public/assets/data/npc_schedules.json")["schedules"]}
    quests = read("public/assets/data/quests.json")
    config = read("public/assets/data/game_config.json")
    missing: list[dict] = []
    unresolved: list[dict] = []

    def resolve(value):
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            return [resolve(v) for v in value]
        if isinstance(value, str):
            return STRING_TAG.sub(lambda m: str(strings.get(m[1], {}).get(m[2], m[0])), value)
        return value

    def asset(ref: str, scene_id: str | None = None) -> dict:
        # Mirrors sceneRuntimeAssetUrl for local runtime paths; no network access.
        if ref.startswith(("http://", "https://")):
            unresolved.append({"kind": "remote_resource_not_requested", "ref": ref})
            return {"sourceRef": ref, "url": ref, "absolutePath": None, "exists": None}
        if re.match(r"^[A-Za-z]:[\\/]", ref):
            path = Path(ref)
            url = ref
        elif ref.startswith(("/resources/", "/assets/", "resources/", "assets/")):
            url = "/" + ref.lstrip("/")
            path = ROOT / "public" / url.lstrip("/")
        elif ref.startswith("/"):
            path, url = Path(ref), ref
        elif scene_id:
            url = f"/resources/runtime/scenes/{scene_id}/{ref}"
            path = ROOT / "public" / url.lstrip("/")
        else:
            url = f"/resources/runtime/{ref}"
            path = ROOT / "public" / url.lstrip("/")
        record = {"sourceRef": ref, "url": url, "absolutePath": absolute(path), "exists": path.is_file()}
        if not record["exists"]:
            missing.append(record.copy())
        elif path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
            with Image.open(path) as im:
                record["pixelWidth"], record["pixelHeight"] = im.size
        return record

    def bounds(points: list[dict]) -> dict | None:
        if not points:
            return None
        xs, ys = [p["x"] for p in points], [p["y"] for p in points]
        return {"x": min(xs), "y": min(ys), "width": max(xs)-min(xs), "height": max(ys)-min(ys)}

    def links(scene_id: str, entity_id: str) -> list[dict]:
        found = []
        for q in quests:
            for o in q.get("objectives", []):
                gs = [g for g in o.get("guidance", []) if g.get("sceneId") == scene_id and g.get("entityId") == entity_id]
                if gs:
                    found.append({"questId": q["id"], "questTitle": resolve(q.get("title", q["id"])),
                                  "objectiveId": o["id"], "text": resolve(o.get("text", "")),
                                  "availableWhen": o.get("availableWhen", []), "guidanceConditions": [g.get("conditions", []) for g in gs]})
        return found

    def is_ow(raw: dict) -> bool:
        return (str(raw.get("id", "")).startswith("ow_") or
                str(raw.get("characterId", "")).startswith("ow_") or
                bool(re.search(r'"(?:flow_ow_|ow_)[^" ]*"|"开放世界_', json.dumps(raw, ensure_ascii=False))))

    def action_exits(value) -> list[dict]:
        found = []
        if isinstance(value, dict):
            if value.get("type") == "switchScene":
                found.append(value.get("params", {}))
            for v in value.values():
                found.extend(action_exits(v))
        elif isinstance(value, list):
            for v in value:
                found.extend(action_exits(v))
        return found

    result = {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
              "coordinateSpace": "game-world; origin top-left; +x right; +y down",
              "notLiveScreenshot": True, "markerIdRule": "sceneId + '::' + entityId",
              "timeConfig": config.get("time", config.get("dayNight", {})),
              "notes": ["背景是当前游戏实际引用的原画资源；图上注记是策划坐标，不是运行中截图。",
                        "同一NPC可在多图出现，只有当前时间和条件命中的一处才在场；不要把所有班次同时画成在场。",
                        "NPC锚点是配置的初始/到岗点；往返路线描述移动范围，不是角色当前脚点。",
                        "玩家游玩产生的实体覆盖、拾物状态、临时演出、到岗/离岗过程无法从静态JSON判定。",
                        "渲染地图时用SVG viewBox=0 0 worldWidth worldHeight，不乘camera.zoom或pixelsPerUnit。",
                        "原画叠标不会重现运行时灯光、雾、深度遮挡、角色和未烘进背景的道具。"],
              "runtimeEvidence": [{"file": absolute(ROOT / "src/core/projectPaths.ts"), "line": 182, "fact": "sceneRuntimeAssetUrl resolves background paths"},
                                  {"file": absolute(ROOT / "src/systems/SceneManager.ts"), "line": 1573, "fact": "background layers sort by z; x/y; scale independently to world dimensions"},
                                  {"file": absolute(ROOT / "src/utils/sceneAppearance.ts"), "line": 91, "fact": "enabled time variant substitutes nonempty backgrounds"},
                                  {"file": absolute(ROOT / "src/core/Game.ts"), "line": 3537, "fact": "NPC patrol ping-pong; deduplicate adjacent points; one point parks"},
                                  {"file": absolute(ROOT / "src/systems/NpcScheduleSystem.ts"), "line": 216, "fact": "first matching time+conditions entry wins; spot overrides scene anchor"},
                                  {"file": absolute(ROOT / "src/entities/Hotspot.ts"), "line": 195, "fact": "displayImage uses bottom-center anchor"}],
              "scenes": []}
    # Retain the native phase block rather than invent time ranges.
    for key, value in config.items():
        if isinstance(value, dict) and "phases" in value and "startAt" in value:
            result["timeConfig"] = {"sourceKey": key, **value}

    for sid in SCENES:
        relative = f"public/assets/scenes/{sid}.json"
        raw = read(relative)
        w, h = raw.get("worldWidth"), raw.get("worldHeight")
        if not w or not h:
            unresolved.append({"sceneId": sid, "kind": "world_size_requires_runtime_fallback"})
        scene = {"id": sid, "name": resolve(raw.get("name", sid)), "worldWidth": w, "worldHeight": h,
                 "world": {"width": w, "height": h}, "source": source(relative),
                 "camera": raw.get("camera", {}), "dayNight": raw.get("dayNight", {}),
                 "backgrounds": [], "backgroundVariants": {}, "entities": [], "spawns": [],
                 "npcExitAnchors": raw.get("exitAnchors", []), "entityGroups": resolve(raw.get("entityGroups", [])),
                 "depthConfig": raw.get("depthConfig", {}), "perspectiveScale": raw.get("perspectiveScale"),
                 "unresolved": []}

        def layer_data(layer: dict, phase: str | None = None) -> dict:
            res = asset(layer["image"], sid)
            tw, th = res.get("pixelWidth"), res.get("pixelHeight")
            return {**res, "phase": phase, "z": layer.get("z", 0),
                    "rect": {"x": layer.get("x", 0), "y": layer.get("y", 0), "width": w, "height": h},
                    "transform": {"translateX": layer.get("x", 0), "translateY": layer.get("y", 0),
                                  "scaleX": w/tw if tw else None, "scaleY": h/th if th else None,
                                  "rotationRadians": 0, "anchorX": 0, "anchorY": 0}, "raw": layer}
        scene["backgrounds"] = [layer_data(v) for v in sorted(raw.get("backgrounds", []), key=lambda l: l.get("z", 0))]
        scene["background"] = scene["backgrounds"][0] if scene["backgrounds"] else None
        for phase, variant in raw.get("timeVariants", {}).items():
            if variant.get("backgrounds"):
                scene["backgroundVariants"][phase] = [layer_data(v, phase) for v in sorted(variant["backgrounds"], key=lambda l: l.get("z", 0))]
        if raw.get("spawnPoint"):
            scene["spawns"].append({"id": "default", **raw["spawnPoint"], "source": source(relative, "/spawnPoint")})
        for name, point in raw.get("spawnPoints", {}).items():
            scene["spawns"].append({"id": name, **point, "source": source(relative, "/spawnPoints/"+name)})
        groups = {g["id"]: g for g in raw.get("entityGroups", [])}
        for bucket_name in ["hotspots", "npcs", "zones"]:
            for index, entity in enumerate(raw.get(bucket_name, [])):
                exit_actions = action_exits(entity)
                is_exit = bucket_name == "hotspots" and entity.get("type") == "transition"
                mainline_warning = sid == "雾津街头" and entity.get("id") == "主线_吃饭点A"
                if not (is_ow(entity) or is_exit or exit_actions or mainline_warning):
                    continue
                eid = entity["id"]
                cid = entity.get("characterId", eid)
                char = characters.get(cid, {})
                kind = "npc" if bucket_name == "npcs" else "zone" if bucket_name == "zones" else "exit" if is_exit else "pickup" if entity.get("type") == "pickup" else "hotspot"
                if mainline_warning:
                    kind = "mainline-warning"
                name = resolve(entity.get("name") or entity.get("label") or char.get("name") or eid)
                ent = {"markerId": sid+"::"+eid, "entityId": eid, "kind": kind, "name": name,
                       "source": source(relative, f"/{bucket_name}/{index}"), "raw": resolve(entity),
                       "isOpenWorld": is_ow(entity), "questLinks": links(sid, eid),
                       "interactionRange": entity.get("interactionRange"), "conditions": entity.get("conditions", []),
                       "conditionHidesEntity": entity.get("conditionHidesEntity", False),
                       "phases": entity.get("phases"), "planes": entity.get("planes"),
                       "group": entity.get("group"), "groupDefinition": resolve(groups.get(entity.get("group"))),
                       "scheduled": False}
                if mainline_warning:
                    ent["doNotInteractOnWalkthroughRoute"] = True
                    ent["warning"] = "本攻略不点包子铺：这里启动序章主线吃饭流程；本路线保留主线 state_2。"
                if "x" in entity and "y" in entity:
                    ent["anchor"] = {"x": entity["x"], "y": entity["y"]}
                    ent["x"], ent["y"] = entity["x"], entity["y"]
                    ent["anchorMeaning"] = "authored interaction center"
                if entity.get("polygon"):
                    ent["polygon"] = entity["polygon"]
                    ent["bounds"] = bounds(entity["polygon"])
                    ent["anchor"] = {"x": sum(p["x"] for p in entity["polygon"])/len(entity["polygon"]),
                                     "y": sum(p["y"] for p in entity["polygon"])/len(entity["polygon"])}
                    ent["anchorMeaning"] = "polygon vertex average for label; polygon is the true activation area"
                if is_exit or exit_actions:
                    ent["exit"] = {"targetScene": entity.get("data", {}).get("targetScene"),
                                   "targetSpawnPoint": entity.get("data", {}).get("targetSpawnPoint"),
                                   "scriptedTransitions": exit_actions}
                if entity.get("data", {}).get("graphId"):
                    graph = entity["data"]["graphId"]
                    ent["interactionGraph"] = {"id": graph, "entry": entity["data"].get("entry"),
                                               "source": source(f"public/assets/dialogues/graphs/{graph}.json"),
                                               "note": "Dialogue conditions can gate individual actions after interaction; see native graph."}
                if entity.get("displayImage"):
                    di = entity["displayImage"]
                    ent["displayImage"] = {**asset(di["image"], sid), "worldWidth": di["worldWidth"], "worldHeight": di["worldHeight"],
                                           "anchorX": 0.5, "anchorY": 1,
                                           "baseRect": {"x": entity["x"]-di["worldWidth"]/2, "y": entity["y"]-di["worldHeight"],
                                                        "width": di["worldWidth"], "height": di["worldHeight"]},
                                           "note": "Authored size before runtime perspective scaling/lighting; hotspot anchor remains exact."}
                if kind == "npc":
                    ent["characterId"] = cid
                    ent["characterDefinition"] = resolve(char)
                    ent["anchorMeaning"] = "authored initial/arrival anchor; not a permanent live foot position"
                    route = []
                    for point in entity.get("patrol", {}).get("route", []):
                        if not route or math.hypot(point["x"]-route[-1]["x"], point["y"]-route[-1]["y"]) > .001:
                            route.append(point)
                    ent["motion"] = {"mode": "ping-pong" if len(route)>1 else "park-at-single-waypoint" if route else "no-authored-patrol",
                                     "route": route, "bounds": bounds(route or [ent["anchor"]]),
                                     "speed": entity.get("patrol", {}).get("speed", 60),
                                     "rawPatrol": entity.get("patrol"),
                                     "note": "Route is traversed back and forth; dialogue/schedule transit can pause it. Bounds are not a random-wander region."}
                    if cid in schedules:
                        schedule = schedules[cid]
                        ent["scheduled"] = True
                        ent["schedule"] = [{"priority": i, **e} for i,e in enumerate(schedule["entries"]) if e.get("scene")==sid]
                        ent["hours"] = [{"from": e["from"], "to": e["to"], "conditions": e.get("conditions", [])} for e in ent["schedule"]]
                        ent["scheduleAllEntries"] = [{"priority": i, **e} for i,e in enumerate(schedule["entries"])]
                        ent["scheduleConditions"] = schedule.get("conditions", [])
                        ent["scheduleSemantics"] = "First matching time-and-condition entry globally wins; end exclusive; ranges may cross midnight; null scene means absent. Only active when scene.dayNight.enabled."
                        ent["scheduleSource"] = source("public/assets/data/npc_schedules.json")
                        ent["preferredExit"] = schedule.get("preferredExit")
                        if not ent["schedule"]:
                            scene["unresolved"].append({"entityId": eid, "kind": "npc_has_no_schedule_entry_for_this_scene"})
                scene["entities"].append(ent)
                anchor = ent.get("anchor")
                if anchor and not (0 <= anchor["x"] <= w and 0 <= anchor["y"] <= h):
                    scene["unresolved"].append({"entityId": eid, "kind": "authored_anchor_outside_world", "anchor": anchor})
        result["scenes"].append(scene)
    result["missingResources"] = missing
    result["projectionQuestions"] = unresolved
    result["totals"] = {"scenes": len(result["scenes"]), "entities": sum(len(s["entities"]) for s in result["scenes"]),
                         "npcs": sum(e["kind"]=="npc" for s in result["scenes"] for e in s["entities"]), "missingResources": len(missing)}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"output": absolute(OUT), **result["totals"], "projectionQuestions": len(unresolved)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
