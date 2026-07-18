"""把 LanguageSpec + 数据现场(UniverseData)组装成一份 JSON Schema
(draft-07 + VS Code 方言扩展 enumDescriptions/defaultSnippets)。

核心设计:**结构无关深扫描(walker)**——不建模任何文档结构(那会变成 validator.py
的第四份拷贝),而是递归走访任意 JSON,凭签名识别语言构造:

1. action:带 `type`(string)+ `params`(object)的对象。全项目侦察确认该签名
   零歧义(图对话 runActions **节点**无 params、hotspot 的 type 无 params、过场
   present 步无 params,均不误触)。type 必须 ∈ 权威枚举 → typo 直接波浪线。
2. condition:键名匹配 `*[cC]ondition(s)?` 的属性值,按 6 叶 + all/any/not 递归校验。
3. 动作数组宿主键(实证发现的 actions/onEnter/onComplete…):挂 defaultSnippets,
   补全时直接给出带必填参数占位的完整 action 骨架。

ID 引用参数烤入真实数据枚举 + 中文旁注(enumDescriptions);场景限定引用
(出生点/zone/hotspot/实体)与档案 bookType↔entryId 按 scoped 映射生成跨字段
if/then 收窄——"选了场景 A 却填场景 B 的出生点"当场波浪线。
空宇宙不注入枚举,宁可少校验不误报。
"""

from __future__ import annotations

import re

try:  # 脚本模式(build.py 已把本目录压进 sys.path)
    from extract import LanguageSpec
    from id_universes import UniverseData
except ImportError:  # 包模式(tools.json_lang.schema_build)
    from .extract import LanguageSpec
    from .id_universes import UniverseData

# ENTITY_REF_PARAMS 的 ref kind → id 宇宙(owner 由同 action 的 ownerType 决定,无法静态校验)
REF_KIND_UNIVERSE: dict[str, str | None] = {
    "scene": "scenes",
    "scene_hint": "scenes",
    "spawn": "spawn_points",
    "actor": "actors",
    "npc": "actors",
    "npc_soft": "actors",
    "emote_subject": "emote_subjects",
    "scene_entity": "scene_entities",
    "scene_hotspot": "hotspots",
    "scene_zone": "zones",
    "owner": None,
}

# 内容 id 参数 → 宇宙(ENTITY_REF_PARAMS 之外的裸 id 引用;这是本工具唯一一张
# 手维护的映射表,新增此类 action 参数时在此补一行)
CONTENT_ID_PARAMS: dict[tuple[str, str], str] = {
    ("giveItem", "id"): "items",
    ("removeItem", "id"): "items",
    ("pickup", "itemId"): "items",
    ("shopPurchase", "itemId"): "items",
    ("inventoryDiscard", "itemId"): "items",
    ("giveRule", "id"): "rules",
    ("grantRuleLayer", "ruleId"): "rules",
    ("giveFragment", "id"): "fragments",
    ("updateQuest", "id"): "quests",
    ("startEncounter", "id"): "encounters",
    ("startCutscene", "id"): "cutscenes",
    ("startWaterMinigame", "id"): "water_minigames",
    ("startSugarWheelMinigame", "id"): "sugar_wheel_minigames",
    ("startPaperCraftMinigame", "id"): "paper_craft_minigames",
    ("startPressureHold", "id"): "pressure_holds",
    ("playSignalCue", "id"): "signal_cues",
    ("activatePlane", "id"): "planes",
    ("openShop", "shopId"): "shops",
    ("startDialogueGraph", "graphId"): "dialogue_graphs",
    ("setFlag", "key"): "__flag__",
    ("appendFlag", "key"): "__flag__",
    ("addFlagValue", "key"): "__flag__",
    ("setSmell", "scent"): "smells",
    ("revealDocument", "documentId"): "documents",
    ("playBgm", "id"): "bgm",
    ("playSfx", "id"): "sfx",
    ("stopSceneAmbient", "id"): "ambient",
    ("setScenarioPhase", "scenarioId"): "scenarios",
    ("startScenario", "scenarioId"): "scenarios",
    ("activateScenario", "scenarioId"): "scenarios",
    ("completeScenario", "scenarioId"): "scenarios",
    ("addArchiveEntry", "entryId"): "archive_entries",
    ("emitNarrativeSignal", "signal"): "narrative_signals",
    # 叙事活计生命周期（S1）：目标是活计图；宇宙沿用 narrative 条件叶的图 id 集合
    ("startNarrativeRun", "graphId"): "narrative_graph_ids",
    ("resetNarrativeRun", "graphId"): "narrative_graph_ids",
    ("revertNarrativeRun", "graphId"): "narrative_graph_ids",
    ("activateNarrativeRun", "graphId"): "narrative_graph_ids",
    ("loadNarrativePackage", "packageId"): "narrative_package_ids",
    ("unloadNarrativePackage", "packageId"): "narrative_package_ids",
}

# 跨字段收窄:(action, 作用域参数, 被收窄参数) → (scoped 映射名, 允许空串, 标签宇宙)
SCOPED_PARAM_RULES: list[tuple[str, str, str, str, bool, str | None]] = [
    ("switchScene", "targetScene", "targetSpawnPoint", "scene_spawns", True, None),
    ("changeScene", "targetScene", "targetSpawnPoint", "scene_spawns", True, None),
    ("setZoneEnabled", "sceneId", "zoneId", "scene_zones", False, None),
    ("persistZoneEnabled", "sceneId", "zoneId", "scene_zones", False, None),
    ("persistHotspotEnabled", "sceneId", "hotspotId", "scene_hotspots", False, "hotspots"),
    ("setHotspotDisplayImage", "sceneId", "hotspotId", "scene_hotspots", False, "hotspots"),
    ("tempSetHotspotDisplayFacing", "sceneId", "hotspotId", "scene_hotspots", False, "hotspots"),
    ("setEntityField", "sceneId", "entityId", "scene_entities", False, "scene_entities"),
    ("setSceneEntityPosition", "sceneId", "entityId", "scene_entities", False, "scene_entities"),
    # moveEntityTo.sceneId 是编辑器复现地图用的 hint,但填了就该和 target 一致
    ("moveEntityTo", "sceneId", "target", "scene_actors", False, "actors"),
    ("addArchiveEntry", "bookType", "entryId", "archive_by_booktype", False, "archive_entries"),
]

# 编辑器控件类型 → JSON 原始类型约束(str/flag_val 不约束,避免误报)
_WIDGET_JSON_TYPE: dict[str, dict] = {
    "int": {"type": "number"},
    "float": {"type": "number"},
    "bool": {"type": "boolean"},
}

# 脚手架占位值:必填参数按控件类型给默认
_SNIPPET_DEFAULTS = {"int": 0, "float": 0, "bool": True}

_CONDITION_HOST_KEY_PATTERN = "[cC]onditions?$"

# 编辑器对"可选未填"的引用写空串(faceTarget、targetSpawnPoint 实测存在),这些宇宙允许 ""
_EMPTY_OK_UNIVERSES = {"spawn_points", "actors", "emote_subjects"}


def _with_labels(values: list[str], labels: dict[str, str] | None) -> dict:
    node: dict = {"enum": values}
    if labels and any(v in labels for v in values):
        node["enumDescriptions"] = [
            "(未填,走默认)" if v == "" else labels.get(v, "") for v in values
        ]
    return node


def _flag_key_schema(ud: UniverseData) -> dict | None:
    static = ud.ids.get("flag_static_keys") or []
    prefixes = ud.ids.get("flag_prefixes") or []
    branches: list[dict] = []
    if static:
        branches.append(_with_labels(sorted(static), ud.labels.get("flag_static_keys")))
    if prefixes:
        alt = "|".join(re.escape(p) for p in sorted(prefixes))
        branches.append({"type": "string", "pattern": f"^(?:{alt})"})
    if not branches:
        return None
    return branches[0] if len(branches) == 1 else {"anyOf": branches}


def _universe_schema(name: str, ud: UniverseData) -> dict | None:
    if name == "__flag__":
        return _flag_key_schema(ud)
    ids = ud.ids.get(name) or []
    if not ids:
        return None  # 宇宙为空(文件缺失/形状意外)→ 不注入枚举
    values = sorted(set(ids))
    if name in _EMPTY_OK_UNIVERSES:
        values = ["", *values]
    return _with_labels(values, ud.labels.get(name))


def _param_universe(spec: LanguageSpec, action_type: str, param: str) -> str | None:
    kind = (spec.entity_ref_params.get(action_type) or {}).get(param)
    if kind is not None:
        return REF_KIND_UNIVERSE.get(kind)
    return CONTENT_ID_PARAMS.get((action_type, param))


def _scoped_variants(ud: UniverseData, action_type: str) -> list[dict]:
    """按 SCOPED_PARAM_RULES 生成 params 内的跨字段 if/then。"""
    variants: list[dict] = []
    for act, scope_param, target_param, map_name, allow_empty, label_uni in SCOPED_PARAM_RULES:
        if act != action_type:
            continue
        mapping = ud.scoped.get(map_name) or {}
        labels = ud.labels.get(label_uni) if label_uni else None
        for scope_value in sorted(mapping):
            values = list(mapping[scope_value])
            if allow_empty:
                values = ["", *values]
            variants.append({
                "if": {"properties": {scope_param: {"const": scope_value}}, "required": [scope_param]},
                "then": {"properties": {target_param: _with_labels(values, labels)}},
            })
    return variants


def _params_schema(spec: LanguageSpec, ud: UniverseData, action_type: str) -> dict | None:
    """单个 action 的 params 对象 schema;没有任何可校验信息时返回 None。"""
    manifest = spec.param_manifest.get(action_type)
    widget_kinds = dict(spec.param_schemas.get(action_type) or [])
    param_names: list[str] = []
    for name in list(widget_kinds) + (
        (manifest["required"] + manifest["optional"]) if manifest else []
    ) + list(spec.entity_ref_params.get(action_type) or {}):
        if name not in param_names:
            param_names.append(name)

    properties: dict[str, dict] = {}
    for name in param_names:
        uni = _param_universe(spec, action_type, name)
        prop = _universe_schema(uni, ud) if uni else None
        if prop is None:
            prop = _WIDGET_JSON_TYPE.get(widget_kinds.get(name, ""), None)
        if prop is not None:
            properties[name] = dict(prop)

    required = list(manifest["required"]) if manifest else []
    scoped = _scoped_variants(ud, action_type)
    if not properties and not required and not scoped:
        return None
    schema: dict = {"type": "object"}
    if properties:
        schema["properties"] = properties
    if required:
        schema["required"] = required
    if scoped:
        schema["allOf"] = scoped
    return schema


def _action_snippets(spec: LanguageSpec) -> list[dict]:
    """每个内容可用 action 一条补全脚手架:必填参数带占位符。"""
    snippets: list[dict] = []
    skip = spec.debug_only_action_types | spec.legacy_action_types
    widget_of = spec.param_schemas
    for t in sorted(set(spec.action_types) - skip):
        manifest = spec.param_manifest.get(t) or {"required": [], "optional": []}
        widgets = dict(widget_of.get(t) or [])
        params: dict = {}
        tab = 1
        for p in manifest["required"]:
            kind = widgets.get(p, "str")
            if kind in _SNIPPET_DEFAULTS:
                params[p] = _SNIPPET_DEFAULTS[kind]
            else:
                params[p] = f"${{{tab}}}"
                tab += 1
        desc = ("必填: " + ", ".join(manifest["required"])) if manifest["required"] else "无必填参数"
        if manifest.get("optional"):
            desc += " | 可选: " + ", ".join(manifest["optional"])
        snippets.append({
            "label": t,
            "description": desc,
            "body": {"type": t, "params": params},
        })
    return snippets


def _condition_snippets(spec: LanguageSpec) -> list[dict]:
    leaf_bodies: dict[str, dict] = {
        "flag": {"flag": "$1", "value": True},
        "quest": {"quest": "$1", "questStatus": spec.quest_statuses[0] if spec.quest_statuses else "Active"},
        "scenario": {"scenario": "$1", "phase": "$2", "status": "$3"},
        "scenarioLine": {"scenarioLine": "$1",
                         "lineStatus": spec.scenario_line_statuses[0] if spec.scenario_line_statuses else "active"},
        "narrative": {"narrative": "$1", "state": "$2"},
        "narrativeCount": {"narrativeCount": "$1", "exitState": "$2", "op": ">=", "value": 1},
        "plane": {"plane": "$1"},
    }
    snippets = [
        {"label": f"条件: {k}", "body": [body]}
        for k, body in leaf_bodies.items() if k in set(spec.condition_leaves)
    ]
    snippets.append({"label": "条件: any(或)", "body": [{"any": []}]})
    snippets.append({"label": "条件: not(非)", "body": [{"not": {"flag": "$1", "value": True}}]})
    return snippets


def _action_def(spec: LanguageSpec, ud: UniverseData) -> dict:
    all_types = sorted(set(spec.action_types) | set(spec.param_manifest))
    variants: list[dict] = []
    for t in all_types:
        params_schema = _params_schema(spec, ud, t)
        if params_schema is None:
            continue
        variants.append({
            "if": {"properties": {"type": {"const": t}}, "required": ["type"]},
            "then": {"properties": {"params": params_schema}},
        })
    return {
        "type": "object",
        "required": ["type"],
        "properties": {"type": {"enum": all_types}},
        "allOf": variants,
    }


def _condition_expr(spec: LanguageSpec, ud: UniverseData) -> dict:
    ref = {"$ref": "#/definitions/conditionExpr"}

    def leaf(required: list[str], props: dict[str, dict | None], extra: dict | None = None) -> dict:
        node: dict = {
            "type": "object",
            "required": required,
            "properties": {k: (dict(v) if v else {}) for k, v in props.items()},
        }
        if extra:
            node.update(extra)
        return node

    flag_key = _flag_key_schema(ud)
    branches: list[dict] = [
        leaf(["all"], {"all": {"type": "array", "items": ref}}),
        leaf(["any"], {"any": {"type": "array", "items": ref}}),
        leaf(["not"], {"not": ref}),
    ]
    modeled = set(spec.condition_leaves)
    if "flag" in modeled:
        branches.append(leaf(["flag"], {
            "flag": flag_key,
            "op": {"enum": spec.flag_ops} if spec.flag_ops else None,
            "value": {"type": ["string", "number", "boolean"]},
        }))
    if "quest" in modeled:
        status = {"enum": spec.quest_statuses} if spec.quest_statuses else None
        branches.append(leaf(
            ["quest"],
            {"quest": _universe_schema("quests", ud), "questStatus": status, "status": status},
            # 无状态字段的 quest 叶运行时恒 false,当作者错拦下
            {"anyOf": [{"required": ["questStatus"]}, {"required": ["status"]}]},
        ))
    if "scenario" in modeled:
        # scenario 确定时 phase 收窄到该 scenario 声明的 phases
        phase_variants = [
            {"if": {"properties": {"scenario": {"const": sid}}, "required": ["scenario"]},
             "then": {"properties": {"phase": {"enum": phases}}}}
            for sid, phases in sorted((ud.scoped.get("scenario_phases") or {}).items()) if phases
        ]
        branches.append(leaf(
            ["scenario", "phase", "status"],
            {
                "scenario": _universe_schema("scenarios", ud),
                "phase": {"type": "string"},
                "status": {"type": "string"},
            },
            {"allOf": phase_variants} if phase_variants else None,
        ))
    if "scenarioLine" in modeled:
        # scenarioLine 引用的就是 scenarios.json 的 id(ScenarioStateManager.getLineLifecycleState)
        branches.append(leaf(["scenarioLine", "lineStatus"], {
            "scenarioLine": _universe_schema("scenarios", ud) or {"type": "string"},
            "lineStatus": {"enum": spec.scenario_line_statuses} if spec.scenario_line_statuses else None,
        }))
    if "narrative" in modeled:
        # 图枚举 = narrative_graphs.json 定义处(mainGraph + elements[].graph);
        # @owner/@scene 相对 token 与模板占位({{…}})走 pattern 分支
        graph_enum = _universe_schema("narrative_graph_ids", ud)
        narrative_prop = {
            "anyOf": [
                *( [graph_enum] if graph_enum else [] ),
                {"type": "string", "pattern": "^@(owner|scene)$"},
                {"type": "string", "pattern": "\\{\\{"},
            ],
        } if graph_enum else {"type": "string"}
        # 图确定时 state 收窄到该图声明的 states——静态抓悬垂叙事引用
        state_variants = [
            {"if": {"properties": {"narrative": {"const": gid}}, "required": ["narrative"]},
             "then": {"properties": {"state": {"enum": states}}}}
            for gid, states in sorted((ud.scoped.get("narrative_states") or {}).items()) if states
        ]
        branches.append(leaf(
            ["narrative", "state"],
            {
                "narrative": narrative_prop,
                "state": {"type": "string"},
                "reached": {"type": "boolean"},
            },
            {"allOf": state_variants} if state_variants else None,
        ))
    if "narrativeCount" in modeled:
        # 活计结算计数叶（叙事运行实例化 S1）：目标须活计图（validator 裁决）、
        # exitState 为该图出口（缺省=全部出口合计）、op 缺省 '>='
        count_graph_enum = _universe_schema("narrative_graph_ids", ud)
        branches.append(leaf(
            ["narrativeCount", "value"],
            {
                "narrativeCount": count_graph_enum or {"type": "string"},
                "exitState": {"type": "string"},
                "op": {"enum": ["==", "!=", ">", ">=", "<", "<="]},
                "value": {"type": "number"},
            },
        ))
    if "plane" in modeled:
        branches.append(leaf(["plane"], {"plane": _universe_schema("planes", ud)}))
    # 提取到未建模叶子时(extract 已出 warning)加一条兜底,免得新叶子全量报错
    for extra_leaf in modeled - {"flag", "quest", "scenario", "scenarioLine", "narrative", "narrativeCount", "plane"}:
        branches.append(leaf([extra_leaf], {extra_leaf: {}}))
    return {"anyOf": branches}


def build_schema(spec: LanguageSpec, ud: UniverseData) -> dict:
    action_shape = {
        "type": "object",
        "required": ["type", "params"],
        "properties": {"type": {"type": "string"}, "params": {"type": "object"}},
    }
    walk_ref = {"$ref": "#/definitions/walk"}

    object_pattern_props: dict[str, dict] = {
        _CONDITION_HOST_KEY_PATTERN: {"$ref": "#/definitions/conditionHost"},
    }
    if ud.action_host_keys:
        host_alt = "|".join(re.escape(k) for k in ud.action_host_keys)
        object_pattern_props[f"^(?:{host_alt})$"] = {
            "items": {
                "allOf": [walk_ref],
                "defaultSnippets": _action_snippets(spec),
            },
        }

    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "GameDraft 数据语言(生成物,勿手改)",
        "description": (
            "由 tools/json_lang/build.py 从权威代码与真实数据现场生成;"
            "方向永远是 代码→schema。发现枚举过期请重跑生成器,不要编辑本文件。"
        ),
        "definitions": {
            "walk": {
                "allOf": [
                    {"if": action_shape, "then": {"$ref": "#/definitions/actionDef"}},
                    {
                        "if": {"type": "object"},
                        "then": {
                            "patternProperties": object_pattern_props,
                            "additionalProperties": walk_ref,
                        },
                        "else": {
                            "if": {"type": "array"},
                            "then": {"items": walk_ref},
                        },
                    },
                ],
            },
            "conditionHost": {
                "anyOf": [
                    {"$ref": "#/definitions/conditionExpr"},
                    {"type": "array", "items": {"$ref": "#/definitions/conditionExpr"}},
                    {"not": {"type": ["object", "array"]}},
                ],
                "defaultSnippets": _condition_snippets(spec),
            },
            "actionDef": _action_def(spec, ud),
            "conditionExpr": _condition_expr(spec, ud),
        },
        "allOf": [walk_ref],
    }
