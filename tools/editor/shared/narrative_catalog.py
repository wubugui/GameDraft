"""叙事图与对话图编排的共享查询（编辑器用）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.editor.shared.project_paths import ProjectPaths

from .character_dialogue import resolve_npc_dialogue_graph

_ENTITY_WRAPPER_OWNER_TYPES = frozenset({"npc", "hotspot", "zone", "quest", "scene"})
_CONTEXT_READABLE_OWNER_TYPES = frozenset({"flow", "scenario", "scene"})
_FORBIDDEN_CONTEXT_OWNER_TYPES = frozenset({"npc", "hotspot", "zone", "quest", "dialogue"})

# 派生广播信号前缀，镜像 narrative_state_editor.DERIVED_STATE_SIGNAL_PREFIX（:48）/
# 运行时 stateEnteredSignalKey。此处独立定义以免 shared 反向依赖 editors 层。
_DERIVED_STATE_SIGNAL_PREFIX = "state:"

# 内容资产中可能内嵌 action 树（含 emitNarrativeSignal）的顶层集合属性名。
# 对齐 validator._walk_action_defs 的各调用点：scenes(onEnter/hotspot.data.actions/zone.on*)、
# quests、encounters、cutscenes、pressure_holds、signal_cues、archive、各小游戏实例。
# _collect_emitted_signal_ids 深度遍历，故传整棵集合即可命中任意嵌套容器。
_EMIT_SOURCE_ATTRS = (
    "scenes",
    "quests",
    "encounters",
    "cutscenes",
    "pressure_holds",
    "signal_cues",
    "archive_characters",
    "archive_books",
    "archive_documents",
    # 见闻 firstViewActions = 真实发射面（LoreBookUI 执行动作树；与 signal_refactor.EMIT_SOURCE_BUCKETS 同源）
    "archive_lore",
    "water_minigames_instances",
    "sugar_wheel_instances",
    "paper_craft_instances",
    # 物件检视实例动作树同样由 ActionExecutor 真执行（ObjectExamineManager），是实发面。
    # 它在 signal_refactor 里属 READONLY_SOURCES（主编辑器只加载不保存）——目录要看得见
    # 它发的信号，重构则拒绝改写它，两张表的并集才等于本表（parity 测试锁定）。
    "object_examine_instances",
)


def _display_ref(name: str, item_id: str) -> str:
    name = str(name or "").strip()
    item_id = str(item_id or "").strip()
    return f"{name} ({item_id})" if name and name != item_id else item_id


def _graph_name(graph: dict[str, Any], fallback: str = "") -> str:
    return str(graph.get("label") or fallback or graph.get("id") or "").strip()


def load_narrative_graphs(project_root: Path) -> dict[str, Any] | None:
    path = ProjectPaths(project_root).data_dir / "narrative_graphs.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


# ── 对话图的叙事归属（owner）解算 ──────────────────────────────────────────────
#
# 权威口径在运行时：`src/core/actionOrigin.ts` 的 `resolveDialogueOwner`（四档优先级）
# 加上各个「来源注入点」。本文件是它的**静态镜像**：编辑器要在不跑游戏的前提下
# 算出"这张对话图被打开时 owner 会是谁"，ownerState 节点才有状态可选、校验才不误报。
#
# 两边由语义 parity 测试锁死：`tools/editor/tests/test_dialogue_owner_parity.py`。
# 新增任何一个运行时 owner 注入点，必须同步登记进下面的 _OWNER_ORIGIN_SOURCES。
#
# 运行时四档 → 编辑器三档的映射：运行时的第 4 档 ambient（场景 onEnter 窗口的
# `scene:<sceneId>`）在静态扫描里就是"场景 onEnter 这个来源"，与第 3 档 origin 合并。
# 运行时里这两档只在场景 onEnter 同时成立且取值相同，故合并不丢语义。

#: model 上直接携带 action 树、且有明确叙事 owner 的集合。
#: (属性名, ownerType, id 字段, 运行时注入点)
_OWNER_ORIGIN_SOURCES: tuple[tuple[str, str, str, str], ...] = (
    ("water_minigames_instances", "minigame", "id", "systems/waterMinigame/WaterMinigameScene.ts"),
    ("sugar_wheel_instances", "minigame", "id", "systems/sugarWheel/SugarWheelMinigameScene.ts"),
    ("paper_craft_instances", "minigame", "id", "systems/paperCraft/PaperCraftMinigameScene.ts"),
    ("object_examine_instances", "minigame", "id", "systems/objectExamine/ObjectExamineScene.ts"),
)

#: 任务里**真的**会被 ActionExecutor 以 quest owner 执行的两个字段（QuestManager.ts）。
#: 任务的其它 action 树不经这条路，故不给 quest owner——宁可少认，不可乱认。
_QUEST_OWNER_ACTION_FIELDS = ("acceptActions", "rewards")

#: 叙事图状态里以该图 owner 执行的两个字段（NarrativeStateManager.enterState）。
_NARRATIVE_STATE_ACTION_FIELDS = ("onEnterActions", "onExitActions")

#: 对话图 owner 经 runActions 链式顺延时的最大传播轮数（防环，图不多，够用）。
_OWNER_CHAIN_MAX_ROUNDS = 8


def _collect_start_dialogue_actions(node: Any, found: list[dict[str, Any]]) -> None:
    """递归收集任意嵌套结构里的 startDialogueGraph action（onEnter 含 runActions 等容器）。"""
    if isinstance(node, dict):
        if str(node.get("type", "")).strip() == "startDialogueGraph":
            found.append(node)
        for value in node.values():
            _collect_start_dialogue_actions(value, found)
    elif isinstance(node, list):
        for item in node:
            _collect_start_dialogue_actions(item, found)


def resolve_action_dialogue_owner(
    params: Any,
    origin_type: str = "",
    origin_id: str = "",
) -> tuple[str, str, str]:
    """`startDialogueGraph` 一条动作的 owner 归属，返回 (ownerType, ownerId, source)。

    镜像 `src/core/actionOrigin.ts::resolveDialogueOwner`：
    显式 ownerType+ownerId > npcId > 来源实体。**显式给了 ownerType 就绝不从别处捡
    ownerId**——跨命名空间借 id 会解出一个根本不存在的 owner，比没有 owner 更难查。
    """
    p = params if isinstance(params, dict) else {}
    p_type = str(p.get("ownerType", "") or "").strip()
    p_id = str(p.get("ownerId", "") or "").strip()
    npc_id = str(p.get("npcId", "") or "").strip()
    o_type = str(origin_type or "").strip()
    o_id = str(origin_id or "").strip()

    if p_type:
        return (p_type, p_id, "explicit") if p_id else ("", "", "none")
    if p_id and npc_id:
        return ("npc", p_id, "explicit")
    if npc_id:
        return ("npc", npc_id, "npcId")
    if p_id:
        return (o_type, p_id, "origin") if o_type else ("", "", "none")
    if o_type and o_id:
        return (o_type, o_id, "origin")
    return ("", "", "none")


class _StartSiteCollector:
    """扫描全工程的 startDialogueGraph 调用点，按对话图 id 汇总 owner。"""

    def __init__(self) -> None:
        self.sites: dict[str, list[dict[str, str]]] = {}
        self._seen: set[tuple[str, str, str, str]] = set()

    def add_binding(self, dialogue_id: str, owner_type: str, owner_id: str, detail: str) -> None:
        """实体字段直连（NPC.dialogueGraphId / hotspot.data.graphId）——运行时由
        InteractionCoordinator 直接带 owner 开图，不经动作参数。"""
        self._add(dialogue_id, owner_type, owner_id, detail, "entity")

    def add_action(
        self,
        action: dict[str, Any],
        detail: str,
        origin_type: str = "",
        origin_id: str = "",
    ) -> None:
        params = action.get("params") if isinstance(action.get("params"), dict) else {}
        dialogue_id = str(params.get("graphId", "") or "").strip()
        if not dialogue_id:
            return
        owner_type, owner_id, source = resolve_action_dialogue_owner(params, origin_type, origin_id)
        self._add(dialogue_id, owner_type, owner_id, detail, source)

    def scan_actions(
        self,
        node: Any,
        detail: str,
        origin_type: str = "",
        origin_id: str = "",
    ) -> None:
        found: list[dict[str, Any]] = []
        _collect_start_dialogue_actions(node, found)
        for act in found:
            self.add_action(act, detail, origin_type, origin_id)

    def _add(self, dialogue_id: str, owner_type: str, owner_id: str, detail: str, source: str) -> None:
        dialogue_id = str(dialogue_id or "").strip()
        if not dialogue_id:
            return
        owner_type = str(owner_type or "").strip()
        owner_id = str(owner_id or "").strip()
        key = (dialogue_id, owner_type, owner_id, detail)
        if key in self._seen:
            return
        self._seen.add(key)
        self.sites.setdefault(dialogue_id, []).append({
            "ownerType": owner_type,
            "ownerId": owner_id,
            "detail": detail,
            "source": source,
        })


def _scan_scene_start_sites(
    collector: _StartSiteCollector,
    scenes: Any,
    character_registry: Any = None,
) -> None:
    """`character_registry` 缺省 None = 只看摆放就地字段（历史行为，与空注册表等价）。"""
    if not isinstance(scenes, dict):
        return
    for scene_id, scene in scenes.items():
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs", []) or []:
            if not isinstance(npc, dict):
                continue
            npc_id = str(npc.get("id", "")).strip()
            if not npc_id:
                continue
            detail = f"npc:{scene_id}:{npc_id}"
            # 经角色注册表解引用：角色级绑定的图不在就地字段上（漏掉=这张图在清单里成孤儿）
            dialogue_id = resolve_npc_dialogue_graph(npc, character_registry)[0]
            if dialogue_id:
                # 运行时 InteractionCoordinator 以**裸** npc.def.id 查 wrapper owner，
                # 这里只登记裸 id：多登记一个 `场景:id` 别名会让编辑器认、运行时不认，
                # 正是要消灭的那类"编排看着通、跑起来静默 fallback"。
                # 历史数据里的限定形式由 validator 的 wrapper ownerId 检查负责报错。
                collector.add_binding(dialogue_id, "npc", npc_id, detail)
        for hotspot in scene.get("hotspots", []) or []:
            if not isinstance(hotspot, dict):
                continue
            hotspot_id = str(hotspot.get("id", "")).strip()
            if not hotspot_id:
                continue
            detail = f"hotspot:{scene_id}:{hotspot_id}"
            data = hotspot.get("data") if isinstance(hotspot.get("data"), dict) else {}
            dialogue_id = str(data.get("graphId", "")).strip()
            if dialogue_id:
                # 同 NPC：运行时用裸 hotspot.def.id，此处只登记裸 id
                collector.add_binding(dialogue_id, "hotspot", hotspot_id, detail)
            # 热区自己持有的动作批：InteractionCoordinator 以 hotspot owner 执行
            collector.scan_actions(data.get("actions"), f"{detail}:actions", "hotspot", hotspot_id)
        for zone in scene.get("zones", []) or []:
            if not isinstance(zone, dict):
                continue
            zone_id = str(zone.get("id", "")).strip()
            if not zone_id:
                continue
            # ZoneSystem 的 enter/stay/exit/act 批一律带 zone owner（zoneOrigin）
            collector.scan_actions(zone, f"zone:{scene_id}:{zone_id}", "zone", zone_id)
        # 场景根 onEnter：sceneEnterRunner 注入 scene owner（运行时 ambient 档同值）
        collector.scan_actions(scene.get("onEnter"), f"scene:{scene_id}:onEnter", "scene", str(scene_id))


def _iter_narrative_graphs(narrative: Any) -> list[tuple[dict[str, Any], str, str, str]]:
    """展平叙事图：返回 (graph, graphId, ownerType, ownerId)。"""
    out: list[tuple[dict[str, Any], str, str, str]] = []
    if not isinstance(narrative, dict):
        return out
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id", "")).strip():
            out.append((
                main,
                str(main.get("id", "")).strip(),
                str(main.get("ownerType", "") or "").strip(),
                str(main.get("ownerId", "") or "").strip(),
            ))
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            gid = str(graph.get("id", "")).strip()
            if not gid:
                continue
            out.append((
                graph,
                gid,
                str(element.get("ownerType") or graph.get("ownerType") or "").strip(),
                str(element.get("ownerId") or graph.get("ownerId") or "").strip(),
            ))
    for graph in narrative.get("graphs", []) or []:
        if isinstance(graph, dict) and str(graph.get("id", "")).strip():
            out.append((
                graph,
                str(graph.get("id", "")).strip(),
                str(graph.get("ownerType", "") or "").strip(),
                str(graph.get("ownerId", "") or "").strip(),
            ))
    return out


def _scan_narrative_start_sites(collector: _StartSiteCollector, narrative: Any) -> None:
    for graph, gid, owner_type, owner_id in _iter_narrative_graphs(narrative):
        states = graph.get("states")
        if not isinstance(states, dict):
            continue
        for state_id, state in states.items():
            if not isinstance(state, dict):
                continue
            for field in _NARRATIVE_STATE_ACTION_FIELDS:
                collector.scan_actions(
                    state.get(field),
                    f"narrative:{gid}:{state_id}:{field}",
                    owner_type,
                    owner_id,
                )


def _scan_quest_start_sites(collector: _StartSiteCollector, quests: Any) -> None:
    if not isinstance(quests, list):
        return
    for quest in quests:
        if not isinstance(quest, dict):
            continue
        quest_id = str(quest.get("id", "")).strip()
        if not quest_id:
            continue
        for field in _QUEST_OWNER_ACTION_FIELDS:
            collector.scan_actions(
                quest.get(field), f"quest:{quest_id}:{field}", "quest", quest_id,
            )


def _scan_model_origin_sources(collector: _StartSiteCollector, model: Any) -> None:
    for attr, owner_type, id_field, _runtime in _OWNER_ORIGIN_SOURCES:
        bucket = getattr(model, attr, None)
        if isinstance(bucket, dict):
            items = bucket.items()
        elif isinstance(bucket, list):
            items = [(str((it or {}).get(id_field, "")).strip(), it) for it in bucket if isinstance(it, dict)]
        else:
            continue
        for key, item in items:
            if not isinstance(item, dict):
                continue
            owner_id = str(item.get(id_field, "") or key or "").strip()
            if not owner_id:
                continue
            collector.scan_actions(item, f"{owner_type}:{owner_id}", owner_type, owner_id)


def _load_dialogue_graph_nodes(project_root: Path | None, model: Any) -> dict[str, Any]:
    """对话图 id → nodes（用于 runActions 链式顺延 owner）。含未保存的暂存编辑。"""
    graphs: dict[str, Any] = {}
    if project_root is not None:
        graphs_dir = ProjectPaths(project_root).dialogues_dir / "graphs"
        if graphs_dir.is_dir():
            for path in sorted(graphs_dir.glob("*.json")):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(data, dict):
                    continue
                gid = str(data.get("id", "") or path.stem).strip()
                if gid:
                    graphs[gid] = data.get("nodes")
    # 编辑器里改了还没写盘的图：以暂存版为准，否则策划刚接的线立刻"看不见"
    pending = getattr(model, "pending_dialogue_graph_edits", None)
    if isinstance(pending, dict):
        for gid, data in pending.items():
            if isinstance(data, dict):
                graphs[str(gid).strip()] = data.get("nodes")
    for gid in getattr(model, "pending_dialogue_graph_deletes", None) or ():
        graphs.pop(str(gid).strip(), None)
    return graphs


def _propagate_chain_owners(
    collector: _StartSiteCollector,
    dialogue_nodes: dict[str, Any],
) -> None:
    """对话图 A 的 runActions 里开对话图 B：B 继承 A 的 owner（运行时由
    GraphDialogueManager 把本段对话 owner 作为来源线程化下去）。反复传播到不动点。"""
    if not dialogue_nodes:
        return
    for _round in range(_OWNER_CHAIN_MAX_ROUNDS):
        before = sum(len(v) for v in collector.sites.values())
        for gid, nodes in dialogue_nodes.items():
            owners = [
                (s["ownerType"], s["ownerId"])
                for s in collector.sites.get(gid, [])
                if s.get("ownerType") and s.get("ownerId")
            ]
            found: list[dict[str, Any]] = []
            _collect_start_dialogue_actions(nodes, found)
            if not found:
                continue
            if owners:
                for owner_type, owner_id in owners:
                    for act in found:
                        collector.add_action(act, f"dialogue:{gid}:runActions", owner_type, owner_id)
            else:
                for act in found:
                    collector.add_action(act, f"dialogue:{gid}:runActions")
        if sum(len(v) for v in collector.sites.values()) == before:
            return


def dialogue_start_sites(
    model: Any,
    project_root: Path | None = None,
) -> dict[str, list[dict[str, str]]]:
    """全工程「这张对话图会从哪儿被打开、打开时 owner 是谁」。

    返回 对话图 id → [{ownerType, ownerId, detail, source}]；`ownerType` 为空表示
    这条调用点解不出 owner（运行时该图里的 ownerState 节点会走 missingWrapperNext）。
    """
    collector = _StartSiteCollector()
    _scan_scene_start_sites(
        collector, getattr(model, "scenes", None), getattr(model, "character_registry", None),
    )
    narrative = getattr(model, "narrative_graphs", None)
    if not isinstance(narrative, dict) and project_root is not None:
        narrative = load_narrative_graphs(project_root)
    _scan_narrative_start_sites(collector, narrative)
    _scan_quest_start_sites(collector, getattr(model, "quests", None))
    _scan_model_origin_sources(collector, model)
    _propagate_chain_owners(collector, _load_dialogue_graph_nodes(project_root, model))
    return collector.sites


def dialogue_owner_refs_from_scenes(
    scenes: dict[str, Any],
    character_registry: Any = None,
) -> dict[str, list[dict[str, str]]]:
    """仅扫场景的 owner 解算（历史入口，等价于 `dialogue_start_sites` 的场景部分）。

    传 `character_registry` 才能解析出角色级绑定的对话图；不传 = 只看就地字段。
    """
    collector = _StartSiteCollector()
    _scan_scene_start_sites(collector, scenes, character_registry)
    return _owner_refs_from_sites(collector.sites)


def _owner_refs_from_sites(
    sites: dict[str, list[dict[str, str]]],
) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    for dialogue_id, rows in sites.items():
        kept: list[dict[str, str]] = []
        seen: set[tuple[str, str, str]] = set()
        for row in rows:
            owner_type = row.get("ownerType", "")
            owner_id = row.get("ownerId", "")
            if not owner_type or not owner_id:
                continue
            key = (owner_type, owner_id, row.get("detail", ""))
            if key in seen:
                continue
            seen.add(key)
            kept.append({
                "ownerType": owner_type,
                "ownerId": owner_id,
                "detail": row.get("detail", ""),
            })
        if kept:
            out[dialogue_id] = kept
    return out


def dialogue_owner_refs(
    model: Any,
    project_root: Path | None = None,
) -> dict[str, list[dict[str, str]]]:
    """对话图 id → 能解出的 owner 列表（全工程口径，与运行时同一套优先级）。"""
    return _owner_refs_from_sites(dialogue_start_sites(model, project_root))


def _owner_state_wrapper_matches(
    narrative_data: dict[str, Any],
    owner_refs: list[dict[str, str]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for comp in narrative_data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id", "")).strip()
        main_graph = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
        comp_label = _graph_name(main_graph, comp_id)
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict) or str(element.get("kind", "")).strip() != "wrapperGraph":
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            graph_id = str(graph.get("id", "")).strip()
            if not graph_id:
                continue
            owner_type = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
            owner_id = str(element.get("ownerId") or graph.get("ownerId") or "").strip()
            if not owner_type or not owner_id:
                continue
            states_raw = graph.get("states")
            state_ids = sorted(states_raw.keys()) if isinstance(states_raw, dict) else []
            category = str(graph.get("category", "") or "").strip()
            element_id = str(element.get("id", "")).strip()
            element_label = str(element.get("label", "")).strip()
            graph_label = _graph_name(graph, element_label or graph_id)
            for ref in owner_refs:
                if owner_type != ref.get("ownerType") or owner_id != ref.get("ownerId"):
                    continue
                key = (graph_id, owner_type, owner_id)
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "graphId": graph_id,
                    "label": _display_ref(graph_label, graph_id),
                    "graphLabel": graph_label,
                    "ownerType": owner_type,
                    "ownerId": owner_id,
                    "stateIds": state_ids,
                    "category": category,
                    "compositionId": comp_id,
                    "compositionLabel": comp_label,
                    "elementId": element_id,
                    "elementLabel": element_label,
                })
    return out


def resolve_owner_wrapper_states(
    project_root: Path,
    model: Any,
    dialogue_graph_id: str,
) -> dict[str, Any]:
    """返回 { stateIds, wrappers, ambiguous, message, sites, ownerless } 供 OwnerStateNode Inspector 使用。

    `sites` = 全工程扫到的调用点（含解不出 owner 的），`ownerless` = 其中解不出的那些。
    解不出不再是死路：Inspector 仍可手选任意 wrapperGraph，这里只负责把「为什么解不出」
    如实说清楚，让策划知道该去补哪一处。
    """
    dialogue_graph_id = str(dialogue_graph_id or "").strip()
    narrative = load_narrative_graphs(project_root)
    sites = dialogue_start_sites(model, project_root).get(dialogue_graph_id, [])
    ownerless = [s for s in sites if not s.get("ownerType") or not s.get("ownerId")]
    base = {"sites": sites, "ownerless": ownerless}
    if not narrative:
        return {**base, "stateIds": [], "wrappers": [], "ambiguous": False,
                "message": "未找到 narrative_graphs.json"}
    refs = _owner_refs_from_sites({dialogue_graph_id: sites}).get(dialogue_graph_id, [])
    if not refs:
        if sites:
            where = "、".join(s.get("detail", "?") for s in sites[:3])
            more = f" 等 {len(sites)} 处" if len(sites) > 3 else ""
            msg = (
                f"该对话图有 {len(sites)} 处调用点（{where}{more}），但都解不出 owner："
                "调用处既没写 ownerType/ownerId，也没写 npcId，且所在实体本身没有叙事归属。"
                "补法二选一：在调用动作上填 ownerType/ownerId，或把它挂到有 wrapper 的实体上。"
            )
        else:
            msg = (
                "全工程没有任何地方打开该对话图（NPC/热区绑定、场景 onEnter、zone、"
                "叙事图状态动作、任务动作、小游戏结算、别的对话图接续都没有）。"
            )
        return {**base, "stateIds": [], "wrappers": [], "ambiguous": False, "message": msg}
    matches = _owner_state_wrapper_matches(narrative, refs)
    if not matches:
        owners = "、".join(sorted({f"{r['ownerType']}:{r['ownerId']}" for r in refs}))
        return {
            **base,
            "stateIds": [], "wrappers": [], "ambiguous": False,
            "message": f"owner 解出来了（{owners}），但这些 owner 上没有绑 wrapperGraph——请先在叙事编辑器给它建一个",
        }
    if len(matches) > 1:
        merged: list[str] = []
        for m in matches:
            for sid in m["stateIds"]:
                if sid not in merged:
                    merged.append(sid)
        return {
            **base,
            "stateIds": merged,
            "wrappers": matches,
            "ambiguous": True,
            "message": f"多个 wrapper 可能适用（{len(matches)} 个），state 列表为并集",
        }
    return {
        **base,
        "stateIds": list(matches[0]["stateIds"]),
        "wrappers": matches,
        "ambiguous": False,
        "message": f"wrapper {matches[0].get('label') or matches[0]['graphId']} ({matches[0]['ownerType']}:{matches[0]['ownerId']})",
    }


def list_entity_wrapper_graphs(project_root: Path) -> list[dict[str, Any]]:
    """全工程的实体类 wrapperGraph（npc/hotspot/zone/quest/scene…），供 OwnerStateNode
    在 owner 解不出时兜底手选——静态解不出不等于运行时没有 owner（显式 ownerType/ownerId、
    刚建还没接线的图都属这类），不能因此把策划卡死在"选不了"。"""
    narrative = load_narrative_graphs(project_root)
    out: list[dict[str, Any]] = []
    if not narrative:
        return out
    seen: set[str] = set()
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id", "")).strip()
        main_graph = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
        comp_label = _graph_name(main_graph, comp_id)
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict) or str(element.get("kind", "")).strip() != "wrapperGraph":
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            graph_id = str(graph.get("id", "")).strip()
            if not graph_id or graph_id in seen:
                continue
            owner_type = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
            if owner_type and owner_type not in _ENTITY_WRAPPER_OWNER_TYPES:
                continue
            seen.add(graph_id)
            states_raw = graph.get("states")
            element_label = str(element.get("label", "")).strip()
            graph_label = _graph_name(graph, element_label or graph_id)
            out.append({
                "graphId": graph_id,
                "label": _display_ref(graph_label, graph_id),
                "graphLabel": graph_label,
                "ownerType": owner_type,
                "ownerId": str(element.get("ownerId") or graph.get("ownerId") or "").strip(),
                "stateIds": sorted(states_raw.keys()) if isinstance(states_raw, dict) else [],
                "category": str(graph.get("category", "") or "").strip(),
                "compositionId": comp_id,
                "compositionLabel": comp_label,
                "elementId": str(element.get("id", "")).strip(),
                "elementLabel": element_label,
            })
    return out


def list_context_readable_graphs(project_root: Path) -> list[dict[str, str]]:
    """flow/scenario 类图，供 ContextStateNode graphId 下拉。"""
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            gid = str(main.get("id", "")).strip()
            otype = str(main.get("ownerType", "")).strip()
            if gid and gid not in seen and otype in _CONTEXT_READABLE_OWNER_TYPES:
                seen.add(gid)
                label = _display_ref(_graph_name(main, gid), gid)
                out.append({"graphId": gid, "label": f"{label} (main/{otype})"})
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            kind = str(element.get("kind", "")).strip()
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            gid = str(graph.get("id", "")).strip()
            if not gid or gid in seen:
                continue
            otype = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
            if kind == "scenarioSubgraph" or otype == "scenario":
                seen.add(gid)
                out.append({"graphId": gid, "label": f"{_display_ref(_graph_name(graph, str(element.get('label', '') or gid)), gid)} (scenario)"})
            elif otype == "flow":
                seen.add(gid)
                out.append({"graphId": gid, "label": f"{_display_ref(_graph_name(graph, gid), gid)} (flow)"})
    return out


def graph_states(project_root: Path, graph_id: str) -> list[str]:
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return []
    graph_id = str(graph_id or "").strip()
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id", "")).strip() == graph_id:
            states = main.get("states")
            return sorted(states.keys()) if isinstance(states, dict) else []
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            if str(graph.get("id", "")).strip() == graph_id:
                states = graph.get("states")
                return sorted(states.keys()) if isinstance(states, dict) else []
    for graph in narrative.get("graphs", []) or []:
        if isinstance(graph, dict) and str(graph.get("id", "")).strip() == graph_id:
            states = graph.get("states")
            return sorted(states.keys()) if isinstance(states, dict) else []
    return []


def graph_info(project_root: Path, graph_id: str) -> dict[str, Any] | None:
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return None
    graph_id = str(graph_id or "").strip()
    if not graph_id:
        return None
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id", "")).strip()
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id", "")).strip() == graph_id:
            states = main.get("states")
            return {
                "graphId": graph_id,
                "label": _display_ref(_graph_name(main, graph_id), graph_id),
                "kind": "mainGraph",
                "ownerType": str(main.get("ownerType", "")).strip(),
                "ownerId": str(main.get("ownerId", "")).strip(),
                "stateIds": sorted(states.keys()) if isinstance(states, dict) else [],
                "compositionId": comp_id,
            }
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            if str(graph.get("id", "")).strip() != graph_id:
                continue
            states = graph.get("states")
            return {
                "graphId": graph_id,
                "label": _display_ref(_graph_name(graph, str(element.get("label", "") or graph_id)), graph_id),
                "kind": str(element.get("kind", "")).strip(),
                "ownerType": str(element.get("ownerType") or graph.get("ownerType") or "").strip(),
                "ownerId": str(element.get("ownerId") or graph.get("ownerId") or "").strip(),
                "stateIds": sorted(states.keys()) if isinstance(states, dict) else [],
                "compositionId": comp_id,
                "elementId": str(element.get("id", "")).strip(),
            }
    for graph in narrative.get("graphs", []) or []:
        if isinstance(graph, dict) and str(graph.get("id", "")).strip() == graph_id:
            states = graph.get("states")
            return {
                "graphId": graph_id,
                "label": _display_ref(_graph_name(graph, graph_id), graph_id),
                "kind": "legacyGraph",
                "ownerType": str(graph.get("ownerType", "")).strip(),
                "ownerId": str(graph.get("ownerId", "")).strip(),
                "stateIds": sorted(states.keys()) if isinstance(states, dict) else [],
            }
    return None


# kind of a wrapperGraph owner → navigate() kind（镜像 web 侧 WRAPPER_OWNER_REGISTRY.navigationKind，
# appHelpers.ts:35-49；system 无导航目标故不在表内）。
_WRAPPER_OWNER_NAV_KIND = {
    "npc": "npc",
    "hotspot": "hotspot",
    "zone": "zone",
    "scene": "scene",
    "quest": "quest",
    "dialogue": "dialogue",
    "minigame": "minigame",
    "cutscene": "cutscene",
    "scenario": "scenario",
}


def _collect_narrative_leaves(expr: Any, out: set[str]) -> None:
    """递归收集条件树里的 narrative 叶子的图 id（叶子形如 {"narrative": <graphId>, "state": ...}）。

    只认 all/any（list）与 not（单条件）三个组合子；validator 的条件遍历耦合 Issue/ids，故此处自写。
    """
    if isinstance(expr, dict):
        for key in ("all", "any"):
            sub = expr.get(key)
            if isinstance(sub, list):
                for child in sub:
                    _collect_narrative_leaves(child, out)
        if "not" in expr:
            _collect_narrative_leaves(expr.get("not"), out)
        narrative = expr.get("narrative")
        if isinstance(narrative, str):
            gid = narrative.strip()
            if gid:
                out.add(gid)
    elif isinstance(expr, list):
        for child in expr:
            _collect_narrative_leaves(child, out)


def _collect_emitted_signal_ids(node: Any, out: set[str]) -> None:
    """递归收集任意嵌套结构里 type=='emitNarrativeSignal' 的 params.signal。

    照 _collect_narrative_leaves 的递归范式，但收 action 树里的实发信号；容器无关
    （runActions / chooseAction / randomBranch / enableRuleOffers.slots / addDelayedEvent …
    一律被深度遍历命中），故上层只需把整棵内容集合传进来。
    """
    if isinstance(node, dict):
        if str(node.get("type", "")).strip() == "emitNarrativeSignal":
            params = node.get("params")
            if isinstance(params, dict):
                sig = str(params.get("signal", "")).strip()
                if sig:
                    out.add(sig)
        for value in node.values():
            _collect_emitted_signal_ids(value, out)
    elif isinstance(node, list):
        for child in node:
            _collect_emitted_signal_ids(child, out)


def _iter_all_narrative_graphs(narrative_data: Any):
    """遍历全项目所有叙事图（各 composition 的 mainGraph + elements[].graph + 顶层 graphs）。"""
    if not isinstance(narrative_data, dict):
        return
    for comp in narrative_data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            yield main
        for element in comp.get("elements", []) or []:
            if isinstance(element, dict):
                graph = element.get("graph")
                if isinstance(graph, dict):
                    yield graph
    for graph in narrative_data.get("graphs", []) or []:
        if isinstance(graph, dict):
            yield graph


def _derived_broadcast_signals(narrative_data: Any) -> set[str]:
    """运行时自动广播的派生信号集：仅 broadcastOnEnter 的 state → state:<graphId>:<stateId>。"""
    out: set[str] = set()
    for graph in _iter_all_narrative_graphs(narrative_data):
        gid = str(graph.get("id", "")).strip()
        if not gid:
            continue
        states = graph.get("states")
        if not isinstance(states, dict):
            continue
        for sid, state in states.items():
            if isinstance(state, dict) and state.get("broadcastOnEnter") is True:
                out.add(f"{_DERIVED_STATE_SIGNAL_PREFIX}{gid}:{sid}")
    return out


def plane_membership_counts(model: Any) -> dict[str, int]:
    """全项目每个位面被多少场景实体（npc/hotspot/zone 的 planes 含它）归属。

    镜像 build_task_index 的 `planes ∩ 实体 planes` 反向（本文件 :527-532）。缺省无 planes
    字段=不计入任何具体位面；单实体内 planes 去重，避免重复项重复计数。返回 {planeId: count}，
    未被任何实体归属的位面不出现（web 侧按缺省即 0 处理）。
    """
    counts: dict[str, int] = {}
    scenes = getattr(model, "scenes", None)
    if not isinstance(scenes, dict):
        return counts
    for scene in scenes.values():
        if not isinstance(scene, dict):
            continue
        for field in ("npcs", "hotspots", "zones"):
            for entity in scene.get(field, []) or []:
                if not isinstance(entity, dict):
                    continue
                entity_planes = entity.get("planes")
                if not isinstance(entity_planes, list):
                    continue
                seen_here: set[str] = set()
                for raw in entity_planes:
                    name = str(raw).strip()
                    if name and name not in seen_here:
                        seen_here.add(name)
                        counts[name] = counts.get(name, 0) + 1
    return counts


def emitted_signal_ids(model: Any) -> list[str]:
    """全项目「实际发出」的信号 id 去重排序集。

    = 对话图（public/assets/dialogues/graphs/*）∪ 内容资产 action 树 ∪ 叙事图自身
    action 树（状态 onEnter/onExitActions 运行时真执行）里 emitNarrativeSignal.params.signal
    ∪ 派生广播 state:<g>:<s>（仅 broadcastOnEnter 的 state）。
    **不含** blackbox 的 meta.emits（那是「声明」非「实发」——纯字符串列表，深度遍历不会误收）。

    每次网页 loadAuthoringCatalog 调一次（非每帧），全项目线性扫（读一遍对话图目录 + 遍历
    内容集合），无 O(n^2)。
    """
    emitted: set[str] = set()

    # 1. 对话图：逐文件读盘、深度遍历 nodes[].actions[]。
    dialogues_path = getattr(model, "dialogues_path", None)
    if dialogues_path is not None:
        graphs_dir = Path(dialogues_path) / "graphs"
        if graphs_dir.is_dir():
            for path in sorted(graphs_dir.glob("*.json")):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                _collect_emitted_signal_ids(data, emitted)

    # 2. 内容资产 action 树（内存集合）。
    for attr in _EMIT_SOURCE_ATTRS:
        root = getattr(model, attr, None)
        if root is not None:
            _collect_emitted_signal_ids(root, emitted)

    # 3. 叙事图自身 action 树：状态 onEnter/onExitActions 由运行时
    #    NarrativeStateManager.runActions 真执行，是合法发射点（blackbox meta.emits
    #    为纯字符串列表，深度遍历不会误收）。
    narrative_data = getattr(model, "narrative_graphs", None)
    if narrative_data is not None:
        _collect_emitted_signal_ids(narrative_data, emitted)

    # 4. 派生广播信号。
    emitted |= _derived_broadcast_signals(narrative_data)

    return sorted(emitted)


def _find_composition(narrative_data: Any, composition_id: str) -> dict[str, Any] | None:
    if not isinstance(narrative_data, dict):
        return None
    for comp in narrative_data.get("compositions", []) or []:
        if isinstance(comp, dict) and str(comp.get("id", "")).strip() == composition_id:
            return comp
    return None


def build_task_index(model: Any, composition_id: str) -> dict[str, Any]:
    """一个 composition 的「任务总线」交叉引用。

    返回项的 id 全部按叙事编辑器 navigate(kind, id) 口径可直接透传（sceneEntities 用 navId="scene:entity"）。
    空作曲 / 找不到 → 返回各列表为空的合法结构，不抛。
    """
    composition_id = str(composition_id or "").strip()
    result: dict[str, Any] = {
        "compositionId": composition_id,
        "graphIds": [],
        "references": [],
        "planes": [],
        "sceneEntities": [],
        "quests": [],
    }
    comp = _find_composition(getattr(model, "narrative_graphs", None), composition_id)
    if comp is None:
        return result

    # ---- 单作曲图集 + 位面集（activePlane）------------------------------------
    graph_ids: list[str] = []
    graph_id_set: set[str] = set()
    plane_states: dict[str, list[str]] = {}

    def _absorb_graph(graph: Any) -> None:
        if not isinstance(graph, dict):
            return
        gid = str(graph.get("id", "")).strip()
        if gid and gid not in graph_id_set:
            graph_id_set.add(gid)
            graph_ids.append(gid)
        states = graph.get("states")
        if isinstance(states, dict):
            for sid, state in states.items():
                if not isinstance(state, dict):
                    continue
                plane = str(state.get("activePlane", "")).strip()
                if not plane:
                    continue
                bucket = plane_states.setdefault(plane, [])
                sid_str = str(sid)
                if sid_str not in bucket:
                    bucket.append(sid_str)

    _absorb_graph(comp.get("mainGraph"))
    for element in comp.get("elements", []) or []:
        if isinstance(element, dict):
            _absorb_graph(element.get("graph"))
    result["graphIds"] = graph_ids
    plane_set = set(plane_states.keys())

    # ---- 前向 references（elements → navigate 目标）--------------------------
    references: list[dict[str, str]] = []
    for element in comp.get("elements", []) or []:
        if not isinstance(element, dict):
            continue
        kind = str(element.get("kind", "")).strip()
        ref_id = str(element.get("refId", "")).strip()
        owner_id = str(element.get("ownerId", "")).strip()
        owner_type = str(element.get("ownerType", "")).strip()
        element_id = str(element.get("id", "")).strip()
        nav_kind = ""
        nav_id = ""
        if kind == "dialogueBlackbox" and ref_id:
            nav_kind, nav_id = "dialogue", ref_id
        elif kind == "scenarioSubgraph" and (ref_id or owner_id):
            nav_kind, nav_id = "scenario", ref_id or owner_id
        elif kind == "zoneBlackbox" and ref_id:
            nav_kind, nav_id = "zone", ref_id
        elif kind == "minigameBlackbox" and ref_id:
            nav_kind, nav_id = "minigame", ref_id
        elif kind == "cutsceneBlackbox" and ref_id:
            nav_kind, nav_id = "cutscene", ref_id
        elif kind == "wrapperGraph" and owner_id:
            mapped = _WRAPPER_OWNER_NAV_KIND.get(owner_type)
            if mapped:
                nav_kind, nav_id = mapped, owner_id
        if not nav_kind or not nav_id:
            continue
        label = str(element.get("label", "")).strip() or nav_id
        references.append({
            "kind": nav_kind,
            "id": nav_id,
            "label": label,
            "elementId": element_id,
        })
    result["references"] = references

    # ---- planes（各 state.activePlane 去重）----------------------------------
    plane_labels: dict[str, str] = {}
    for plane in getattr(model, "planes", None) or []:
        if isinstance(plane, dict):
            pid = str(plane.get("id", "")).strip()
            if pid:
                plane_labels[pid] = str(plane.get("label") or "").strip() or pid
    result["planes"] = [
        {"id": pid, "label": plane_labels.get(pid, pid), "states": list(states)}
        for pid, states in plane_states.items()
    ]

    # ---- 反向 sceneEntities（conditions 命中图集 / planes ∩ 位面集）----------
    scene_entities: list[dict[str, str]] = []
    seen_entity: set[tuple[str, str, str]] = set()
    scenes = getattr(model, "scenes", None)
    if isinstance(scenes, dict):
        for raw_scene_id, scene in scenes.items():
            if not isinstance(scene, dict):
                continue
            scene_id = str(raw_scene_id or "").strip()
            for kind, field in (("npc", "npcs"), ("hotspot", "hotspots"), ("zone", "zones")):
                for entity in scene.get(field, []) or []:
                    if not isinstance(entity, dict):
                        continue
                    entity_id = str(entity.get("id", "")).strip()
                    if not entity_id:
                        continue
                    via = ""
                    conditions = entity.get("conditions")
                    if conditions is not None:
                        leaves: set[str] = set()
                        _collect_narrative_leaves(conditions, leaves)
                        if leaves & graph_id_set:
                            via = "condition"
                    if not via:
                        entity_planes = entity.get("planes")
                        if isinstance(entity_planes, list):
                            names = {str(p).strip() for p in entity_planes}
                            if plane_set & names:
                                via = "plane"
                    if not via:
                        continue
                    dedupe_key = (kind, scene_id, entity_id)
                    if dedupe_key in seen_entity:
                        continue
                    seen_entity.add(dedupe_key)
                    label = str(entity.get("name") or entity.get("label") or "").strip() or entity_id
                    scene_entities.append({
                        "kind": kind,
                        "sceneId": scene_id,
                        "entityId": entity_id,
                        "navId": f"{scene_id}:{entity_id}",
                        "via": via,
                        "label": label,
                    })
    result["sceneEntities"] = scene_entities

    # ---- 反向 quests（条件镜像 ∪ wrapperGraph owner=quest）-------------------
    quests: list[dict[str, str]] = []
    quest_index: dict[str, int] = {}
    quest_titles: dict[str, str] = {}
    for quest in getattr(model, "quests", None) or []:
        if isinstance(quest, dict):
            qid = str(quest.get("id", "")).strip()
            if qid:
                quest_titles[qid] = str(quest.get("title") or quest.get("name") or "").strip() or qid

    def _add_quest(quest_id: str, via: str) -> None:
        quest_id = str(quest_id or "").strip()
        if not quest_id or quest_id in quest_index:
            return
        quest_index[quest_id] = len(quests)
        quests.append({
            "id": quest_id,
            "via": via,
            "label": quest_titles.get(quest_id, quest_id),
        })

    for quest in getattr(model, "quests", None) or []:
        if not isinstance(quest, dict):
            continue
        qid = str(quest.get("id", "")).strip()
        if not qid:
            continue
        leaves = set()
        for cond_field in ("preconditions", "completionConditions"):
            value = quest.get(cond_field)
            if value is not None:
                _collect_narrative_leaves(value, leaves)
        if leaves & graph_id_set:
            _add_quest(qid, "condition")
    for element in comp.get("elements", []) or []:
        if (
            isinstance(element, dict)
            and str(element.get("kind", "")).strip() == "wrapperGraph"
            and str(element.get("ownerType", "")).strip() == "quest"
        ):
            _add_quest(str(element.get("ownerId", "")).strip(), "wrapper")
    result["quests"] = quests

    return result


def is_context_graph_allowed(project_root: Path, graph_id: str) -> bool:
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return False
    graph_id = str(graph_id or "").strip()
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id", "")).strip() == graph_id:
            otype = str(main.get("ownerType", "")).strip()
            return otype in _CONTEXT_READABLE_OWNER_TYPES
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            if str(graph.get("id", "")).strip() != graph_id:
                continue
            otype = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
            kind = str(element.get("kind", "")).strip()
            if otype in _FORBIDDEN_CONTEXT_OWNER_TYPES:
                return False
            return kind == "scenarioSubgraph" or otype in _CONTEXT_READABLE_OWNER_TYPES
    return False
