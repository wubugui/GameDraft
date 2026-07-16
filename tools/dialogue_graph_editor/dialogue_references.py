"""对话图「被引用」反查：给定一张对话图 id，找出全项目里引用它的实体。

纯字典入参、无 Qt 依赖，方便单测。对话 id = 图文件名（如 ``寻狗_看两尸``，与场景/动作里的
``graphId`` 引用值一致）。

引用来源（全部覆盖）：
- 场景 NPC：``npc.dialogueGraphId``
- 场景热点：``hotspot.data.graphId``（inspect 型）
- 场景热点/区域/场景级动作：``startDialogueGraph``/``playScriptedDialogue`` 等的 ``params.graphId``（递归）
- Scenario：``scenarios.json`` 里 scenario/phase 的 ``dialogueGraphIds``
- 叙事图：``dialogueBlackbox`` 元素的 ``refId``
- 其它对话图：图内节点动作里 ``graphId`` 跳到本图

坑：场景条件里的 ``narrative``/``state`` 指叙事图**不是** dialogue graphId；而 ``graphId`` /
``dialogueGraphId`` 键在场景实体子树里一律是对话引用，可放心按键名递归收集。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# 场景实体列表字段 → (kind, 中文类别标签)
_SCENE_ENTITY_FIELDS: dict[str, tuple[str, str]] = {
    "npcs": ("npc", "NPC"),
    "hotspots": ("hotspot", "热点"),
    "zones": ("zone", "区域"),
}


@dataclass(frozen=True)
class Referrer:
    """一条引用记录。``nav`` = (主窗方法名, 参数元组)，供双击时防御式分派。"""

    category: str  # 地图实体 / Scenario / 叙事图 / 其它对话
    label: str  # 行主标题
    detail: str  # 行副标题（场景 id / 引用方式等）
    nav: tuple[str, tuple[Any, ...]]
    scene_id: str = ""  # 地图实体按场景分组用；其它类别为空


def _ref_id(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def subtree_references_dialogue(node: Any, target: str) -> bool:
    """节点子树里是否出现对 ``target`` 对话图的引用（graphId/dialogueGraphId/dialogueGraphIds）。"""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("graphId", "dialogueGraphId") and _ref_id(value) == target:
                return True
            if key == "dialogueGraphIds" and isinstance(value, list):
                if target in [_ref_id(x) for x in value]:
                    return True
            if subtree_references_dialogue(value, target):
                return True
        return False
    if isinstance(node, list):
        return any(subtree_references_dialogue(item, target) for item in node)
    return False


def _entity_label(entity: dict, fallback_id: str) -> str:
    for key in ("name", "label", "title"):
        val = _ref_id(entity.get(key))
        if val:
            return val
    return fallback_id


def _scan_scenes(target: str, scenes: dict[str, Any]) -> list[Referrer]:
    out: list[Referrer] = []
    if not isinstance(scenes, dict):
        return out
    for scene_id_raw, scene in scenes.items():
        if not isinstance(scene, dict):
            continue
        scene_id = _ref_id(scene_id_raw)
        # 具名实体：NPC / 热点 / 区域
        for field_name, (kind, kind_label) in _SCENE_ENTITY_FIELDS.items():
            for entity in scene.get(field_name) or []:
                if not isinstance(entity, dict):
                    continue
                if not subtree_references_dialogue(entity, target):
                    continue
                eid = _ref_id(entity.get("id"))
                if not eid:
                    continue
                out.append(
                    Referrer(
                        category="地图实体",
                        label=_entity_label(entity, eid),
                        detail=f"{kind_label} · {eid}",
                        nav=("navigate_to_scene_entity", (kind, eid, scene_id)),
                        scene_id=scene_id,
                    )
                )
        # 场景级引用（不挂在具名实体上的动作等）：扫场景其余键
        scene_level = {k: v for k, v in scene.items() if k not in _SCENE_ENTITY_FIELDS}
        if subtree_references_dialogue(scene_level, target):
            out.append(
                Referrer(
                    category="地图实体",
                    label=scene_id,
                    detail="场景级动作",
                    nav=("_on_navigate_to_source", ("scene", scene_id, "")),
                    scene_id=scene_id,
                )
            )
    return out


def _scan_scenarios(target: str, scenarios_catalog: Any) -> list[Referrer]:
    out: list[Referrer] = []
    if not isinstance(scenarios_catalog, dict):
        return out
    for scenario in scenarios_catalog.get("scenarios") or []:
        if not isinstance(scenario, dict):
            continue
        if not subtree_references_dialogue(scenario, target):
            continue
        sid = _ref_id(scenario.get("id"))
        if not sid:
            continue
        out.append(
            Referrer(
                category="Scenario",
                label=sid,
                detail=_ref_id(scenario.get("description")) or "Scenario",
                nav=("navigate_to_scenario_catalog", (sid,)),
            )
        )
    return out


def _scan_narrative(target: str, narrative_graphs: Any) -> list[Referrer]:
    out: list[Referrer] = []
    if not isinstance(narrative_graphs, dict):
        return out
    for comp in narrative_graphs.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        main_graph = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
        main_graph_id = _ref_id(main_graph.get("id"))
        for element in comp.get("elements") or []:
            if not isinstance(element, dict):
                continue
            if _ref_id(element.get("kind")) != "dialogueBlackbox":
                continue
            if _ref_id(element.get("refId")) != target:
                continue
            label = _ref_id(element.get("label")) or _ref_id(element.get("id")) or target
            out.append(
                Referrer(
                    category="叙事图",
                    label=label,
                    detail=f"编排 {_ref_id(comp.get('id'))}",
                    nav=("navigate_to_narrative_state", (main_graph_id, "")),
                )
            )
    return out


def _scan_other_dialogues(target: str, other_dialogues: Any) -> list[Referrer]:
    out: list[Referrer] = []
    if not isinstance(other_dialogues, dict):
        return out
    for other_id_raw, graph in other_dialogues.items():
        other_id = _ref_id(other_id_raw)
        if not other_id or other_id == target:
            continue
        if not subtree_references_dialogue(graph, target):
            continue
        out.append(
            Referrer(
                category="其它对话",
                label=other_id,
                detail="对话里跳转到本图",
                nav=("navigate_to_dialogue_graph", (other_id,)),
            )
        )
    return out


def find_dialogue_referrers(
    graph_id: str,
    *,
    scenes: dict[str, Any] | None = None,
    scenarios_catalog: Any = None,
    narrative_graphs: Any = None,
    other_dialogues: dict[str, Any] | None = None,
) -> list[Referrer]:
    """反查引用了 ``graph_id`` 这张对话图的全部实体。空 target 返回空。"""
    target = _ref_id(graph_id)
    if not target:
        return []
    referrers: list[Referrer] = []
    referrers += _scan_scenes(target, scenes or {})
    referrers += _scan_scenarios(target, scenarios_catalog)
    referrers += _scan_narrative(target, narrative_graphs)
    referrers += _scan_other_dialogues(target, other_dialogues or {})
    return referrers


# 类别在树里的展示顺序
CATEGORY_ORDER: list[str] = ["地图实体", "Scenario", "叙事图", "其它对话"]


def group_by_category(referrers: list[Referrer]) -> "dict[str, list[Referrer]]":
    """按类别分组并保持 CATEGORY_ORDER 顺序（构树用）。"""
    grouped: dict[str, list[Referrer]] = {}
    for ref in referrers:
        grouped.setdefault(ref.category, []).append(ref)
    return {cat: grouped[cat] for cat in CATEGORY_ORDER if cat in grouped}
