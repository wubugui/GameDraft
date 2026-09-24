"""「它调的」：把叙事图状态动作里的一条动作翻成「世界里的哪个东西」。

判据只有一张表：动作参数里被登记为**内容 id** 的那些——``tools/json_lang/schema_build``
的 ``CONTENT_ID_PARAMS``（编辑器选择器 / JSON 语言服务 / 校验器同一张表），外加场景作用域的
实体参数（``SCOPED_PARAM_RULES``）与按 id 能在某个场景里找到的实体参数（target / npcId…）。

信号名、flag、状态名**不算目标**（:data:`EXCLUDED_UNIVERSES`）：它们是编排的机制，不是策划
要跳过去看的那个东西。``CONTENT_ID_PARAMS`` 里出现的每个宇宙都必须在 :data:`TARGET_SPECS`
登记或明确排除——护栏测试锁定，否则新加一种动作会**静默**少算一类目标。

每个宇宙给两样：人话类别名，和一种跳法（文件+锚点交宿主跳转引擎 / navigate(kind,id) /
画布定位 / 明说跳不过去）。跳法对着 ``main_window._navigate_to_search_hit_inner`` 的路由
写，那边认 anchors 最外层 id（``outer_id``）或指针段。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .model import Target

#: 这些"宇宙"不是世界里的东西：flag 是机制、信号是机制。它们各有自己的面板。
EXCLUDED_UNIVERSES = frozenset({"__flag__", "narrative_signals"})

_ASSETS = "public/assets"
_DATA = f"{_ASSETS}/data"
_SCENES = f"{_ASSETS}/scenes"

#: 宇宙 → {label, 跳法}。跳法字段（四选一，都没有 = 只列不跳）：
#:   file + anchor        整份文件装一堆条目：anchors=[[anchor, id]]，宿主按 outer_id 深选
#:   file + pointer       指针段定位（audio_config /sfx/<id>、prop_presets /<id>）
#:   file_pattern         一条一个文件（对话图 / 轨迹 / 粒子效果），{id} 代入
#:   nav                  navigate(kind, id) 路由（位面 / 小游戏）
#:   graph_ref            目标是另一张叙事图：画布定位
#: readonly = 主编辑器只读（工作台资产）；note = 没有编辑页时说给人听的一句话。
TARGET_SPECS: dict[str, dict[str, Any]] = {
    "items": {"label": "物品", "file": f"{_DATA}/items.json", "anchor": "items"},
    "igniter_items": {"label": "火种", "file": f"{_DATA}/items.json", "anchor": "items"},
    "rules": {"label": "规矩", "file": f"{_DATA}/rules.json", "anchor": "rules"},
    "fragments": {"label": "规矩碎片", "file": f"{_DATA}/rules.json", "anchor": "fragments"},
    "quests": {"label": "任务", "file": f"{_DATA}/quests.json", "anchor": "quests"},
    "encounters": {"label": "遭遇", "file": f"{_DATA}/encounters.json", "anchor": "encounters"},
    "cutscenes": {"label": "过场", "file": f"{_DATA}/cutscenes/index.json", "anchor": "cutscenes"},
    "dialogue_graphs": {"label": "对话图", "file_pattern": f"{_ASSETS}/dialogues/graphs/{{id}}.json"},
    "water_minigames": {"label": "小游戏", "nav": "minigame"},
    "sugar_wheel_minigames": {"label": "小游戏", "nav": "minigame"},
    "paper_craft_minigames": {"label": "小游戏", "nav": "minigame"},
    "pressure_holds": {"label": "临场长按", "file": f"{_DATA}/pressure_holds.json", "anchor": "pressure_holds"},
    "signal_cues": {"label": "信号Cue", "file": f"{_DATA}/signal_cues.json", "anchor": "signal_cues"},
    "bubble_line_sets": {"label": "头顶闲聊", "file": f"{_DATA}/bubble_lines.json", "anchor": "lineSets"},
    "planes": {"label": "位面", "nav": "plane"},
    "shops": {"label": "商店", "file": f"{_DATA}/shops.json", "anchor": "shops"},
    "smells": {"label": "气味", "file": f"{_DATA}/smell_profiles.json", "pointer": "/profiles/{id}"},
    "prop_presets": {"label": "挂件预设", "file": f"{_DATA}/prop_presets.json", "pointer": "/{id}"},
    "prop_leveled": {"label": "挂件预设", "file": f"{_DATA}/prop_presets.json", "pointer": "/{id}"},
    "documents": {"label": "文档揭示", "file": f"{_DATA}/document_reveals.json", "anchor": "documents"},
    "bgm": {"label": "音乐", "file": f"{_DATA}/audio_config.json", "pointer": "/bgm/{id}"},
    "ambient": {"label": "环境声", "file": f"{_DATA}/audio_config.json", "pointer": "/ambient/{id}"},
    "sfx": {"label": "音效", "file": f"{_DATA}/audio_config.json", "pointer": "/sfx/{id}"},
    "scenarios": {"label": "Scenario", "file": f"{_DATA}/scenarios.json", "anchor": "scenarios"},
    "archive_entries": {"label": "档案", "file_pattern": f"{_DATA}/archive/{{bookType}}.json",
                        "anchor": "entries", "scope_param": "bookType"},
    "clues": {"label": "线索", "file": f"{_DATA}/clues.json", "anchor": "clues"},
    "system_notes": {"label": "系统说明卡", "file": f"{_DATA}/system_notes.json", "anchor": "notes"},
    "health_threats": {"label": "血量威胁", "note": "运行时血量配置，没有单独的编辑页"},
    "health_bounds": {"label": "血量锁", "note": "运行时血量配置，没有单独的编辑页"},
    "health_protections": {"label": "血量防护", "note": "运行时血量配置，没有单独的编辑页"},
    "trajectories": {"label": "轨迹", "file_pattern": f"{_DATA}/trajectories/{{id}}.json",
                     "readonly": "轨迹工作台的资产，主编辑器只读；要改去轨迹工作台"},
    "vfx_effects": {"label": "粒子效果", "file_pattern": f"{_DATA}/vfx/{{id}}.json",
                    "readonly": "粒子工作台的资产，主编辑器只读；要改去粒子工作台"},
    "breathing_overlays": {"label": "呼吸图", "file_pattern": f"{_DATA}/breathing/{{id}}.json",
                           "readonly": "呼吸工作台的资产，主编辑器只读；要改去呼吸工作台"},
    "narrative_graph_ids": {"label": "叙事图", "graph_ref": True},
    "narrative_package_ids": {"label": "章节包", "file": f"{_DATA}/narrative_packages.json", "anchor": "packages"},
    # 下面几种不在 CONTENT_ID_PARAMS 里，是场景作用域规则 / 实体参数解出来的
    "scenes": {"label": "场景", "file_pattern": f"{_SCENES}/{{id}}.json"},
    "zones": {"label": "区域", "scene_entity": "zones"},
    "hotspots": {"label": "热点", "scene_entity": "hotspots"},
    "npcs": {"label": "NPC", "scene_entity": "npcs"},
}

#: 场景作用域规则里各收窄映射对应的实体容器（`scene_spawns` 是出生点，落到场景本身）
_SCOPED_CONTAINER: dict[str, str | None] = {
    "scene_zones": "zones",
    "scene_hotspots": "hotspots",
    "scene_entities": None,      # npc 或热点：按 id 在那个场景里找
    "scene_actors": "npcs",
    "scene_spawns": "",          # 目标是场景本身
    "archive_by_booktype": "archive",  # 走 CONTENT_ID_PARAMS 的 archive_entries
}

#: 没登记场景作用域、但值就是某个实体 id 的参数名。判据是**数据**：值能在某个场景的
#: npcs / hotspots / zones 里找到才算（`player`、过场临时演员找不到就不算）。
ENTITY_PARAM_KEYS = ("target", "npcId", "entityId", "hotspotId", "zoneId", "npc", "hotspot", "actor")

_CONTAINER_UNIVERSE = {"npcs": "npcs", "hotspots": "hotspots", "zones": "zones"}


def _text(value: Any) -> str:
    return str(value or "").strip() if isinstance(value, (str, int, float)) else ""


@dataclass
class TargetContext:
    """解目标要用到的现场知识：id → 中文名（各宇宙）、实体 id → 在哪些场景、场景 id → 名。"""

    labels: dict[str, dict[str, str]] = field(default_factory=dict)
    # 实体 id → [(scene_id, container, 人话名)]；同名实体可能出现在多个场景
    entities: dict[str, list[tuple[str, str, str]]] = field(default_factory=dict)
    scene_labels: dict[str, str] = field(default_factory=dict)

    def label_of(self, universe: str, ident: str) -> str:
        return self.labels.get(universe, {}).get(ident, "") or ident

    def find_entity(self, ident: str, scene_id: str = "", container: str | None = None) -> tuple[str, str, str] | None:
        rows = self.entities.get(ident) or []
        for sid, cont, human in rows:
            if scene_id and sid != scene_id:
                continue
            if container and cont != container:
                continue
            return sid, cont, human
        return None


def _labels_from_doc(doc: Any, out: dict[str, str], depth: int = 0) -> None:
    """一份资产文档里条目的 id → 中文名（title / name / label）。列表条目与「id 作键」的字典都认。"""
    if depth > 6:
        return
    if isinstance(doc, list):
        for entry in doc:
            if isinstance(entry, dict):
                ident = _text(entry.get("id"))
                human = _human(entry)
                if ident and human:
                    out.setdefault(ident, human)
        return
    if isinstance(doc, dict):
        for key, value in doc.items():
            if isinstance(value, dict):
                human = _human(value)
                if human and isinstance(key, str) and key and not key.startswith("_"):
                    out.setdefault(key, human)
                _labels_from_doc(value, out, depth + 1)
            elif isinstance(value, list):
                _labels_from_doc(value, out, depth + 1)


def _human(node: dict[str, Any]) -> str:
    for key in ("title", "name", "label"):
        value = node.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


#: 已加载的资产文档 → 它给哪个宇宙补名字（文档里的名字优先于磁盘宇宙：编辑器里未保存的改名要算数）
_ATTR_UNIVERSE: dict[str, str] = {
    "cutscenes": "cutscenes",
    "quests": "quests",
    "items": "items",
    "encounters": "encounters",
    "pressure_holds": "pressure_holds",
    "signal_cues": "signal_cues",
    "shops": "shops",
    "clues_registry": "clues",
    "prop_presets": "prop_presets",
    "bubble_lines": "bubble_line_sets",
    "narrative_packages": "narrative_package_ids",
    "document_reveals": "documents",
    "smell_profiles": "smells",
    "rules_data": "rules",
    "archive_characters": "archive_entries",
    "archive_books": "archive_entries",
    "archive_documents": "archive_entries",
    "archive_lore": "archive_entries",
    "archive_slang": "archive_entries",
    "archive_rhymes": "archive_entries",
}


def build_target_context(source: Any) -> TargetContext:
    """从扫描来源建现场知识。磁盘宇宙（json_lang）给全表名字，已加载的文档再覆盖一遍。"""
    ctx = TargetContext()
    root = _text(getattr(source, "project_root", ""))
    if root:
        try:
            from tools.json_lang.id_universes import collect_id_universes

            data = collect_id_universes(Path(root))
            ctx.labels = {k: dict(v) for k, v in data.labels.items()}
        except Exception:  # noqa: BLE001 - 名字只是锦上添花，扫描不能因为它挂
            ctx.labels = {}
    for asset in getattr(source, "assets", []) or []:
        kind = _text(getattr(asset, "kind", ""))
        attr = _text(getattr(asset, "attr", ""))
        root_doc = getattr(asset, "root", None)
        if kind == "scene" and isinstance(root_doc, dict):
            scene_id = _text(getattr(asset, "item_id", "")) or _text(root_doc.get("id"))
            if not scene_id:
                continue
            name = _text(root_doc.get("name"))
            if name:
                ctx.scene_labels[scene_id] = name
            for container in ("npcs", "hotspots", "zones"):
                for entity in root_doc.get(container) or []:
                    if not isinstance(entity, dict):
                        continue
                    ident = _text(entity.get("id"))
                    if not ident:
                        continue
                    ctx.entities.setdefault(ident, []).append((scene_id, container, _human(entity)))
            continue
        universe = _ATTR_UNIVERSE.get(attr)
        if not universe:
            continue
        found: dict[str, str] = {}
        _labels_from_doc(root_doc, found)
        if found:
            bucket = ctx.labels.setdefault(universe, {})
            bucket.update(found)
    for doc in getattr(source, "dialogues", []) or []:
        meta = doc.doc.get("meta") if isinstance(doc.doc, dict) else None
        title = _text(meta.get("title")) if isinstance(meta, dict) else ""
        if title:
            ctx.labels.setdefault("dialogue_graphs", {})[doc.graph_id] = title
    ctx.labels.setdefault("scenes", {}).update(ctx.scene_labels)
    return ctx


def _content_id_params() -> dict[tuple[str, str], str]:
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS

    return CONTENT_ID_PARAMS


def _scoped_rules() -> list[tuple[str, str, str, str, bool, str | None]]:
    from tools.json_lang.schema_build import SCOPED_PARAM_RULES

    return SCOPED_PARAM_RULES


def _apply_spec(row: Target, spec: dict[str, Any], params: dict[str, Any]) -> None:
    """按宇宙登记表给一行填跳法。"""
    row.kind_label = spec.get("label", row.universe)
    if spec.get("readonly"):
        row.readonly = True
        row.note = str(spec["readonly"])
    elif spec.get("note"):
        row.note = str(spec["note"])
    if spec.get("nav"):
        row.nav_kind = str(spec["nav"])
        return
    if spec.get("graph_ref"):
        row.ref_graph_id = row.target_id
        return
    if spec.get("file_pattern"):
        pattern = str(spec["file_pattern"])
        scope_param = spec.get("scope_param")
        if scope_param:
            scope = _text(params.get(scope_param))
            if not scope:
                row.note = row.note or f"没填 {scope_param}，定位不到是哪一本"
                return
            pattern = pattern.replace(f"{{{scope_param}}}", scope)
        row.file = pattern.replace("{id}", row.target_id)
        if spec.get("anchor"):
            row.anchors = [[str(spec["anchor"]), row.target_id]]
        return
    if spec.get("file"):
        row.file = str(spec["file"])
        if spec.get("anchor"):
            row.anchors = [[str(spec["anchor"]), row.target_id]]
        if spec.get("pointer"):
            row.pointer = str(spec["pointer"]).replace("{id}", row.target_id)


def _scene_entity_target(
    ctx: TargetContext, action_type: str, param: str, ident: str,
    scene_id: str, container: str | None,
) -> Target | None:
    hit = ctx.find_entity(ident, scene_id, container)
    if hit is None:
        return None
    sid, cont, human = hit
    universe = _CONTAINER_UNIVERSE.get(cont, cont)
    spec = TARGET_SPECS.get(universe, {})
    row = Target(
        universe=universe,
        kind_label=spec.get("label", universe),
        target_id=ident,
        label=human or ident,
        action_type=action_type,
        param=param,
        scene_id=sid,
        scene_label=ctx.scene_labels.get(sid, sid),
        file=f"{_SCENES}/{sid}.json",
        anchors=[[cont, ident]],
    )
    return row


def resolve_action_targets(action_type: str, params: Any, ctx: TargetContext) -> list[Target]:
    """一条动作 → 它指向的世界里的东西（可能零个、一个或几个）。"""
    if not action_type or not isinstance(params, dict):
        return []
    out: list[Target] = []
    consumed: set[str] = set()
    content = _content_id_params()

    for (atype, param), universe in content.items():
        if atype != action_type or universe in EXCLUDED_UNIVERSES:
            continue
        ident = _text(params.get(param))
        if not ident:
            continue
        consumed.add(param)
        spec = TARGET_SPECS.get(universe)
        row = Target(universe=universe, kind_label=universe, target_id=ident,
                     label=ctx.label_of(universe, ident), action_type=action_type, param=param)
        if spec is None:
            row.note = "这类目标还没登记跳法"
        else:
            _apply_spec(row, spec, params)
        out.append(row)

    for atype, scope_param, param, scoped_map, _allow_empty, _label_universe in _scoped_rules():
        if atype != action_type:
            continue
        container = _SCOPED_CONTAINER.get(scoped_map)
        if container == "archive":
            continue  # archive_entries 已由上面收走（bookType 只是收窄）
        scene_id = _text(params.get(scope_param))
        if container == "":
            # switchScene / changeScene：目标是那个场景本身
            if scene_id and scope_param not in consumed:
                consumed.add(scope_param)
                spec = TARGET_SPECS["scenes"]
                row = Target(universe="scenes", kind_label=spec["label"], target_id=scene_id,
                             label=ctx.scene_labels.get(scene_id, scene_id), action_type=action_type,
                             param=scope_param, scene_id=scene_id,
                             scene_label=ctx.scene_labels.get(scene_id, scene_id))
                _apply_spec(row, spec, params)
                out.append(row)
            continue
        ident = _text(params.get(param))
        if not ident or param in consumed:
            continue
        row = _scene_entity_target(ctx, action_type, param, ident, scene_id, container or None)
        if row is not None:
            consumed.add(param)
            out.append(row)

    scene_hint = _text(params.get("sceneId")) or _text(params.get("scene"))
    for key in ENTITY_PARAM_KEYS:
        if key in consumed:
            continue
        ident = _text(params.get(key))
        if not ident or ident == "player":
            continue
        row = _scene_entity_target(ctx, action_type, key, ident, scene_hint, None)
        if row is not None:
            consumed.add(key)
            out.append(row)
    return out
