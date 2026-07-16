"""扫描 public/assets 数据文件,收集 schema 需要的三类现场知识:

- ids     各类 id 宇宙(烤入枚举)——一律取自**定义处**,不从引用处反推
- labels  id → 中文名/说明(烤入 enumDescriptions,补全列表里直接看得懂)
- scoped  按作用域收窄的映射(场景→出生点/zone/hotspot/实体;bookType→档案条目),
          供 schema 生成跨字段 if/then,消掉"全局并集"的软肋
- action_host_keys  实证发现的"动作数组宿主键"(值为 {type,params} 列表的键),
          供 schema 在这些位置挂 defaultSnippets 脚手架

只读、防御式:文件缺失/形状意外 → 对应宇宙为空,schema_build 对空宇宙不注入枚举
(宁可少校验,不误报)。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# 过场 steps/tracks 是 kind:present/action 混合结构,裸 action 脚手架放进去是错的
_SNIPPET_HOST_BLOCKLIST = {"steps", "tracks"}


@dataclass
class UniverseData:
    ids: dict[str, list[str]] = field(default_factory=dict)
    labels: dict[str, dict[str, str]] = field(default_factory=dict)
    scoped: dict[str, dict[str, list[str]]] = field(default_factory=dict)
    action_host_keys: list[str] = field(default_factory=list)


def _load(path: Path, read=None):
    try:
        text = read(path) if read else path.read_text(encoding="utf-8")
        return json.loads(text)
    except Exception:
        return None


def _trunc(s: str, n: int = 60) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _ids_and_labels(entries, label_key: str | None = None, id_key: str = "id") -> tuple[list[str], dict[str, str]]:
    ids: list[str] = []
    labels: dict[str, str] = {}
    if isinstance(entries, list):
        for e in entries:
            if isinstance(e, dict) and isinstance(e.get(id_key), str) and e[id_key].strip():
                ids.append(e[id_key])
                if label_key and isinstance(e.get(label_key), str) and e[label_key].strip():
                    labels[e[id_key]] = _trunc(e[label_key])
    return ids, labels


def _index_ids(path: Path, read=None) -> list[str]:
    """小游戏 index.json:兼容 [{id,…}] / ["id",…] / {ids:[…]} 三种形状。"""
    doc = _load(path, read)
    if isinstance(doc, list):
        if all(isinstance(x, str) for x in doc):
            return [x for x in doc if x.strip()]
        return _ids_and_labels(doc)[0]
    if isinstance(doc, dict):
        for k in ("ids", "entries", "instances"):
            if isinstance(doc.get(k), list):
                inner = doc[k]
                if all(isinstance(x, str) for x in inner):
                    return [x for x in inner if x.strip()]
                return _ids_and_labels(inner)[0]
    return []


def _deep_entries(node, out: dict[str, str]) -> None:
    """深度收集嵌套结构里对象的 id → 标签(title/name 优先)。"""
    if isinstance(node, dict):
        v = node.get("id")
        if isinstance(v, str) and v.strip():
            lab = node.get("title") or node.get("name")
            out[v] = _trunc(lab) if isinstance(lab, str) and lab.strip() else out.get(v, "")
        for child in node.values():
            _deep_entries(child, out)
    elif isinstance(node, list):
        for child in node:
            _deep_entries(child, out)


def _cutscene_spawned_actor_ids(root: Path, read=None) -> set[str]:
    """cutsceneSpawnActor 是演员 id 的**定义处**——扫全部内容文件收集其 params.id,
    否则过场里 faceEntity/moveEntityTo 引用临时演员会被枚举误报。"""
    ids: set[str] = set()

    def walk(node) -> None:
        if isinstance(node, dict):
            if node.get("type") == "cutsceneSpawnActor" and isinstance(node.get("params"), dict):
                v = node["params"].get("id")
                if isinstance(v, str) and v.strip():
                    ids.add(v)
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    for pattern in (
        "public/assets/data/**/*.json",
        "public/assets/scenes/*.json",
        "public/assets/dialogues/graphs/*.json",
    ):
        for f in root.glob(pattern):
            walk(_load(f, read))
    return ids


def _action_host_keys(root: Path, read=None) -> list[str]:
    """实证扫描:值为「含 {type,params} 元素的列表」的键名(actions/onEnter/onComplete…)。
    数据长出新宿主键时自动跟上,无需手维护清单。"""
    hosts: set[str] = set()

    def walk(node) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                if (
                    isinstance(v, list) and v
                    and all(isinstance(x, dict) for x in v)
                    and any("type" in x and isinstance(x.get("params"), dict) for x in v)
                ):
                    hosts.add(k)
                walk(v)
        elif isinstance(node, list):
            for x in node:
                walk(x)

    for pattern in (
        "public/assets/data/**/*.json",
        "public/assets/scenes/*.json",
        "public/assets/dialogues/graphs/*.json",
    ):
        for f in root.glob(pattern):
            walk(_load(f, read))
    return sorted(hosts - _SNIPPET_HOST_BLOCKLIST)


def collect_id_universes(root: Path, read_text=None) -> UniverseData:
    """read_text(path)->str 可注入(LSP server 传 overlay 感知读取口);缺省读盘。"""
    read = read_text
    data = root / "public/assets/data"
    ud = UniverseData()
    u, labels, scoped = ud.ids, ud.labels, ud.scoped

    # ---- 场景与场景内实体(顺带建 per-scene 收窄映射) ----
    scene_ids: list[str] = []
    scene_labels: dict[str, str] = {}
    npc_ids: set[str] = set()
    hotspot_ids: set[str] = set()
    zone_ids: set[str] = set()
    spawn_keys: set[str] = set()
    entity_labels: dict[str, str] = {}
    scene_spawns: dict[str, list[str]] = {}
    scene_zones: dict[str, list[str]] = {}
    scene_hotspots: dict[str, list[str]] = {}
    scene_entities: dict[str, list[str]] = {}
    scene_npcs: dict[str, list[str]] = {}

    for f in sorted((root / "public/assets/scenes").glob("*.json")):
        doc = _load(f, read)
        if not isinstance(doc, dict):
            continue
        sid = doc.get("id")
        sid = sid if isinstance(sid, str) and sid.strip() else f.stem
        scene_ids.append(sid)
        if isinstance(doc.get("name"), str) and doc["name"].strip():
            scene_labels[sid] = _trunc(doc["name"])
        npcs, npc_labs = _ids_and_labels(doc.get("npcs"), "name")
        hots, hot_labs = _ids_and_labels(doc.get("hotspots"), "label")
        zones, _ = _ids_and_labels(doc.get("zones"))
        npc_ids.update(npcs)
        hotspot_ids.update(hots)
        zone_ids.update(zones)
        entity_labels.update(npc_labs)
        entity_labels.update(hot_labs)
        sp = doc.get("spawnPoints")
        keys = sorted(k for k in sp if isinstance(k, str) and k.strip()) if isinstance(sp, dict) else []
        spawn_keys.update(keys)
        scene_spawns[sid] = keys
        scene_zones[sid] = sorted(zones)
        scene_hotspots[sid] = sorted(hots)
        scene_entities[sid] = sorted(set(npcs) | set(hots))
        scene_npcs[sid] = sorted(npcs)

    spawned = _cutscene_spawned_actor_ids(root, read)
    u["scenes"] = scene_ids
    labels["scenes"] = scene_labels
    u["hotspots"] = sorted(hotspot_ids)
    u["zones"] = sorted(zone_ids)
    u["spawn_points"] = sorted(spawn_keys)  # 全局并集只是兜底,真正收窄走 scoped.scene_spawns
    u["actors"] = sorted(npc_ids | spawned | {"player"})
    u["emote_subjects"] = sorted(npc_ids | hotspot_ids | spawned | {"player"})
    u["scene_entities"] = sorted(npc_ids | hotspot_ids)
    actor_labels = dict(entity_labels)
    actor_labels["player"] = "玩家(运行时魔法名)"
    for s in spawned:
        actor_labels.setdefault(s, "过场演员(cutsceneSpawnActor 定义)")
    for name in ("actors", "emote_subjects", "scene_entities", "hotspots"):
        labels[name] = actor_labels

    scoped["scene_spawns"] = scene_spawns
    scoped["scene_zones"] = scene_zones
    scoped["scene_hotspots"] = scene_hotspots
    scoped["scene_entities"] = scene_entities
    scoped["scene_actors"] = {
        sid: sorted(set(npcs) | spawned | {"player"}) for sid, npcs in scene_npcs.items()
    }

    # ---- 数据表(id + 中文名) ----
    for name, path, label_key in (
        ("items", data / "items.json", "name"),
        ("quests", data / "quests.json", "title"),
        ("encounters", data / "encounters.json", "narrative"),
        ("shops", data / "shops.json", "name"),
        ("pressure_holds", data / "pressure_holds.json", "prompt"),
        ("signal_cues", data / "signal_cues.json", "description"),
        ("documents", data / "document_reveals.json", None),
    ):
        u[name], labels[name] = _ids_and_labels(_load(path, read), label_key)

    plane_ids, plane_labels = _ids_and_labels(_load(data / "planes.json", read), "label")
    u["planes"] = sorted(set(plane_ids) | {"normal"})
    plane_labels.setdefault("normal", "常态(无位面)")
    labels["planes"] = plane_labels

    rules_doc = _load(data / "rules.json", read)
    if isinstance(rules_doc, dict):
        u["rules"], labels["rules"] = _ids_and_labels(rules_doc.get("rules"), "name")
        u["fragments"], labels["fragments"] = _ids_and_labels(rules_doc.get("fragments"), "name")
    else:
        u["rules"], u["fragments"] = [], []

    scen_doc = _load(data / "scenarios.json", read)
    u["scenarios"], labels["scenarios"] = (
        _ids_and_labels(scen_doc.get("scenarios"), "description") if isinstance(scen_doc, dict) else ([], {})
    )
    scenario_phases: dict[str, list[str]] = {}
    if isinstance(scen_doc, dict):
        for s in scen_doc.get("scenarios") or []:
            if isinstance(s, dict) and isinstance(s.get("id"), str) and isinstance(s.get("phases"), dict):
                scenario_phases[s["id"]] = sorted(s["phases"])
    scoped["scenario_phases"] = scenario_phases

    smell_doc = _load(data / "smell_profiles.json", read)
    profiles = smell_doc.get("profiles") if isinstance(smell_doc, dict) else None
    if isinstance(profiles, dict):
        u["smells"] = sorted(profiles)
        labels["smells"] = {
            k: _trunc(v["name"]) for k, v in profiles.items()
            if isinstance(v, dict) and isinstance(v.get("name"), str)
        }
    else:
        u["smells"] = []

    audio = _load(data / "audio_config.json", read)
    if isinstance(audio, dict):
        u["bgm"] = sorted(k for k in (audio.get("bgm") or {}) if isinstance(k, str))
        u["ambient"] = sorted(k for k in (audio.get("ambient") or {}) if isinstance(k, str))
        u["sfx"] = sorted(
            {k for k in (audio.get("sfx") or {}) if isinstance(k, str)}
            | {k for k in (audio.get("systemSfx") or {}) if isinstance(k, str)}
        )
    else:
        u["bgm"] = u["ambient"] = u["sfx"] = []

    # ---- 过场 / 小游戏 ----
    u["cutscenes"] = _index_ids(data / "cutscenes/index.json", read)
    u["water_minigames"] = _index_ids(data / "water_minigames/index.json", read)
    u["sugar_wheel_minigames"] = _index_ids(data / "sugar_wheel/index.json", read)
    u["paper_craft_minigames"] = _index_ids(data / "paper_craft/index.json", read)

    # ---- 对话图 / 叙事 ----
    graph_ids: list[str] = []
    graph_labels: dict[str, str] = {}
    for f in sorted((root / "public/assets/dialogues/graphs").glob("*.json")):
        doc = _load(f, read)
        gid = doc.get("id") if isinstance(doc, dict) else None
        gid = gid if isinstance(gid, str) and gid.strip() else f.stem
        graph_ids.append(gid)
        meta = doc.get("meta") if isinstance(doc, dict) else None
        if isinstance(meta, dict) and isinstance(meta.get("title"), str) and meta["title"].strip():
            graph_labels[gid] = _trunc(meta["title"])
    u["dialogue_graphs"] = graph_ids
    labels["dialogue_graphs"] = graph_labels

    ng = _load(data / "narrative_graphs.json", read)
    u["narrative_signals"], labels["narrative_signals"] = (
        _ids_and_labels(ng.get("signals"), "label") if isinstance(ng, dict) else ([], {})
    )

    # 叙事图宇宙 + 图→states 收窄(定义处 = compositions[].mainGraph 与 elements[].graph)
    narrative_states: dict[str, list[str]] = {}
    narrative_labels: dict[str, str] = {}

    def _grab_graph(g) -> None:
        if isinstance(g, dict) and isinstance(g.get("id"), str) and g["id"].strip() \
                and isinstance(g.get("states"), dict):
            narrative_states[g["id"]] = sorted(g["states"])
            lab = g.get("label")
            if isinstance(lab, str) and lab.strip():
                narrative_labels[g["id"]] = _trunc(lab)

    if isinstance(ng, dict):
        for comp in ng.get("compositions") or []:
            if not isinstance(comp, dict):
                continue
            _grab_graph(comp.get("mainGraph"))
            for el in comp.get("elements") or []:
                if isinstance(el, dict):
                    _grab_graph(el.get("graph"))
    u["narrative_graph_ids"] = sorted(narrative_states)
    labels["narrative_graph_ids"] = narrative_labels
    scoped["narrative_states"] = narrative_states

    # ---- flag:静态键 + 模式前缀(前缀走 pattern,不进枚举) ----
    fr = _load(data / "flag_registry.json", read)
    if isinstance(fr, dict):
        static = [e for e in (fr.get("static") or []) if isinstance(e, dict)]
        u["flag_static_keys"] = [e["key"] for e in static if isinstance(e.get("key"), str) and e["key"].strip()]
        labels["flag_static_keys"] = {
            e["key"]: _trunc(str(e.get("valueType") or "")) for e in static
            if isinstance(e.get("key"), str) and e.get("valueType")
        }
        u["flag_prefixes"] = [
            e["prefix"] for e in (fr.get("patterns") or [])
            if isinstance(e, dict) and isinstance(e.get("prefix"), str) and e["prefix"].strip()
        ]
    else:
        u["flag_static_keys"] = u["flag_prefixes"] = []

    # ---- 档案:全量并集 + bookType 收窄映射(对齐 ArchiveManager.addEntry 的五路 switch) ----
    def _archive(path: Path) -> dict[str, str]:
        out: dict[str, str] = {}
        _deep_entries(_load(path, read), out)
        return out

    characters = _archive(data / "archive/characters.json")
    lore = _archive(data / "archive/lore.json")
    documents = _archive(data / "archive/documents.json")
    books_doc = _load(data / "archive/books.json", read)
    book_labels: dict[str, str] = {}
    book_entry_labels: dict[str, str] = {}
    if isinstance(books_doc, list):
        for b in books_doc:
            if not isinstance(b, dict):
                continue
            if isinstance(b.get("id"), str) and b["id"].strip():
                t = b.get("title")
                book_labels[b["id"]] = _trunc(t) if isinstance(t, str) and t.strip() else ""
            for pg in b.get("pages") or []:
                if isinstance(pg, dict):
                    _deep_entries(pg.get("entries"), book_entry_labels)

    all_archive = {**characters, **lore, **documents, **book_labels, **book_entry_labels}
    u["archive_entries"] = sorted(all_archive)
    labels["archive_entries"] = {k: v for k, v in all_archive.items() if v}
    scoped["archive_by_booktype"] = {
        "character": sorted(characters),
        "lore": sorted(lore),
        "document": sorted(documents),
        "book": sorted(book_labels),
        "bookEntry": sorted(book_entry_labels),
    }

    ud.action_host_keys = _action_host_keys(root, read)
    # 清掉空 label 表,schema 侧按"有才注"处理
    ud.labels = {k: {i: t for i, t in v.items() if t} for k, v in labels.items()}
    ud.labels = {k: v for k, v in ud.labels.items() if v}
    return ud
