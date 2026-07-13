"""全项目场景实体（npc / hotspot / zone / 出生点）引用扫描与重构引擎（迁移 / 改名 / 安全删除）。

四类的引用形态：npc/hotspot 有裸引用（最危险,详见下）+ 场景限定引用;zone 的入站引用
（setZoneEnabled / persistZoneEnabled）全部 sceneId+zoneId 限定,spawn 的入站引用
（transition 热点 data、switchScene/changeScene 动作）全部 targetScene 限定——后两类
迁移/改名时引用可 100% 机械改写,只有几何（polygon / 坐标）需要人工在目标场景重画。

与 ``signal_refactor.py`` 同范式：只改 ProjectModel 内存数据并标脏，**零磁盘写入**，
落盘仍走主编辑器 Save All；任何前置校验失败在修改前抛 ``EntityRefactorError``，
不产生半改状态。对话图改动经 ``signal_refactor`` 的暂存面（``dialogue_graph_edits``
/ ``dialogue_stubs`` 脏桶）。

实体引用存在**两套寻址**（运行时语义，勿混）：
- 裸 id（actor / emote_subject / npc / owner / 软 speaker）：运行时只在**当前场景**
  解析，找不到静默跳过——这是迁移最危险的一类，扫描按"可达场景分析"分级报告；
- 场景限定（sceneId + entityId / hotspotId）：跨场景稳定寻址，迁移时可机械改写跟随。

``ENTITY_REF_PARAMS`` 是"哪个 action 的哪个参数是实体/场景/出生点引用"的**单一登记
面**（运行时散在 ActionRegistry、编辑器散在 action_editor 各 UI 分支、校验散在
validator——本表把口径收拢一处，validator 与重构引擎共同消费）。新增含实体引用参数
的 action 时必须在此登记，parity 测试（test_entity_refactor.py）会拦漏登记。

改写策略（rename）——按歧义分级，宁可少改也不错改：
- 实体 id 只有场景内唯一性，同 id 可合法出现在多张地图。裸引用无场景限定时到底指谁
  是歧义的：id 全局唯一 → 全部改写；否则只改写"上下文可证明指向本实体"的引用
  （场景限定引用、本场景 JSON 内裸引用、可达场景集 ⊆ {本场景} 的对话图），其余
  留在报告里交人工。
- ``showDialogue.speaker`` / ``startDialogueGraph.npcId`` 是软引用（未命中回退显示
  名），只在 id 全局唯一时跟随改写。

撤销：rename 记录改写作用域（scope），撤销按同一作用域反向改写；move 撤销 = 反向
迁移 + 场景限定引用改回；delete 撤销 = 按记录的位置重插 def。
"""

from __future__ import annotations

import copy
import re
from typing import Any, Callable, Iterator

from . import signal_refactor as _sig


class EntityRefactorError(ValueError):
    """重构前置校验失败（不存在 / 撞名 / 参数非法等），不产生任何修改。"""


ENTITY_KINDS = ("npc", "hotspot", "zone")   # list 通道(scene 的 npcs/hotspots/zones 数组)
SPAWN_KIND = "spawn"                        # dict 通道(scene.spawnPoints;default 顶层键不参与)
ALL_KINDS = (*ENTITY_KINDS, SPAWN_KIND)
# npc/hotspot 互为 emote 目标命名空间,撞名互拒;zone/spawn 各自独立命名空间
_COLLISION_KINDS: dict[str, tuple[str, ...]] = {
    "npc": ("npc", "hotspot"), "hotspot": ("npc", "hotspot"), "zone": ("zone",),
}

# 裸 id 引用种类（value 语义）：
#   actor         npc | player | _cut_ 临时演员（运行时按当前场景解析）
#   emote_subject actor 基础上还可命中当前场景 hotspot
#   npc           仅 npc
#   npc_soft      软引用：未命中回退为显示名（只在全局唯一时改写）
#   owner         叙事 wrapper 绑定，种类由同 action 的 ownerType 决定
#   scene         场景 id（全局有效）
#   scene_hint    编辑器复现地图用的场景 id，运行时忽略（moveEntityTo.sceneId）
#   spawn         出生点键，属于同 action 的 targetScene
#   scene_entity  实体 id，由同 action 的 sceneId + entityKind 限定
#   scene_hotspot 热点 id，由同 action 的 sceneId 限定
#   scene_zone    zone id，由同 action 的 sceneId 限定
ENTITY_REF_PARAMS: dict[str, dict[str, str]] = {
    "playNpcAnimation": {"target": "actor"},
    "setEntityEnabled": {"target": "actor"},
    "moveEntityTo": {"target": "actor", "sceneId": "scene_hint"},
    "faceEntity": {"target": "actor", "faceTarget": "actor"},
    "persistNpcEntityEnabled": {"target": "actor"},
    "persistNpcAt": {"target": "actor"},
    "persistNpcAnimState": {"target": "actor"},
    "persistPlayNpcAnimation": {"target": "actor"},
    "showEmote": {"target": "emote_subject"},
    "showEmoteAndWait": {"target": "emote_subject"},
    "showSpeechBubble": {"target": "emote_subject"},
    "showSpeechBubbleAndWait": {"target": "emote_subject"},
    "stopNpcPatrol": {"npcId": "npc"},
    "persistNpcDisablePatrol": {"npcId": "npc"},
    "persistNpcEnablePatrol": {"npcId": "npc"},
    "startDialogueGraph": {"npcId": "npc_soft", "ownerId": "owner"},
    "switchScene": {"targetScene": "scene", "targetSpawnPoint": "spawn"},
    "changeScene": {"targetScene": "scene", "targetSpawnPoint": "spawn"},
    "playScriptedDialogue": {"scriptedNpcId": "npc_soft"},
    "setZoneEnabled": {"zoneId": "scene_zone", "sceneId": "scene"},
    "persistZoneEnabled": {"zoneId": "scene_zone", "sceneId": "scene"},
    "setEntityField": {"entityId": "scene_entity", "sceneId": "scene"},
    "setSceneEntityPosition": {"entityId": "scene_entity", "sceneId": "scene"},
    "setHotspotDisplayImage": {"hotspotId": "scene_hotspot", "sceneId": "scene"},
    "tempSetHotspotDisplayFacing": {"hotspotId": "scene_hotspot", "sceneId": "scene"},
    "persistHotspotEnabled": {"hotspotId": "scene_hotspot", "sceneId": "scene"},
}

# 裸引用按 value 匹配实体 id 时，各 kind 允许命中的实体种类
_BARE_KIND_SCOPE: dict[str, tuple[str, ...]] = {
    "actor": ("npc",),
    "emote_subject": ("npc", "hotspot"),
    "npc": ("npc",),
    "npc_soft": ("npc",),
}

_TAG_NPC_RE_TMPL = r"\[tag:npc:{}\]"


# --------------------------------------------------------------------------- #
# 通用走访基元
# --------------------------------------------------------------------------- #

def _walk_ref_actions(node: Any, visit: Callable[[str, dict[str, Any]], None]) -> None:
    """深度遍历任意结构，对 type ∈ ENTITY_REF_PARAMS 且带 params dict 的节点调
    visit(action_type, params)。过场 step（kind:"action"）与普通 action 同形，天然覆盖。"""
    if isinstance(node, dict):
        act_type = str(node.get("type") or "").strip()
        params = node.get("params")
        if act_type in ENTITY_REF_PARAMS and isinstance(params, dict):
            visit(act_type, params)
        for value in node.values():
            _walk_ref_actions(value, visit)
    elif isinstance(node, list):
        for child in node:
            _walk_ref_actions(child, visit)


def _walk_strings(node: Any, visit: Callable[[dict | list, Any, str], None]) -> None:
    """深度遍历，对每个字符串值调 visit(container, key_or_index, value)（供 [tag:] 改写）。"""
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, str):
                visit(node, key, value)
            else:
                _walk_strings(value, visit)
    elif isinstance(node, list):
        for idx, child in enumerate(node):
            if isinstance(child, str):
                visit(node, idx, child)
            else:
                _walk_strings(child, visit)


def _scene_containers(scene: dict[str, Any]) -> Iterator[tuple[str, str, Any]]:
    """把场景 JSON 拆成 (容器种类, 容器 id, 节点) 走访单元：npc / hotspot / zone 逐个
    + 其余顶层字段合并为 'scene' 容器（onEnter 等）。"""
    for kind_key, kind in (("npcs", "npc"), ("hotspots", "hotspot"), ("zones", "zone")):
        for row in scene.get(kind_key) or []:
            if isinstance(row, dict):
                yield kind, str(row.get("id") or ""), row
    rest = {k: v for k, v in scene.items() if k not in ("npcs", "hotspots", "zones")}
    yield "scene", "", rest


def _entity_list_key(kind: str) -> str:
    if kind not in ENTITY_KINDS:
        raise EntityRefactorError(
            f"不支持的实体种类 {kind!r}（只支持 {' / '.join(ALL_KINDS)}）")
    return kind + "s"


# --------------------------------------------------------------------------- #
# 出生点（dict 通道）基元：scene.spawnPoints 键序保真;顶层默认 spawnPoint 不参与
# --------------------------------------------------------------------------- #

def _find_spawn(scene: dict[str, Any], key: str) -> tuple[int, Any] | None:
    sp = scene.get("spawnPoints")
    if isinstance(sp, dict) and key in sp:
        return list(sp).index(key), sp[key]
    return None


def _dict_insert_at(d: dict[str, Any], key: str, value: Any, index: int) -> None:
    """按位插键并保持其余键序（JSON 往返保真依赖 dict 键序）。"""
    items = list(d.items())
    items.insert(min(index, len(items)), (key, value))
    d.clear()
    d.update(items)


def _spawn_inbound_rewrite(
    model: Any, scene_id: str, key: str,
    *, new_key: str | None = None, new_scene: str | None = None, count_only: bool = False,
) -> list[dict[str, Any]]:
    """出生点入站引用的计数/改写：transition 热点 data + switchScene/changeScene 动作
    参数（场景树 / 内容资产 / 叙事图 / 对话图）。全部 targetScene 限定,零歧义。"""
    hits: list[dict[str, Any]] = []

    def rewrite_actions(node: Any) -> int:
        total = 0

        def visit(act_type: str, params: dict[str, Any]) -> None:
            nonlocal total
            if act_type not in ("switchScene", "changeScene"):
                return
            if str(params.get("targetScene") or "").strip() != scene_id \
                    or str(params.get("targetSpawnPoint") or "").strip() != key:
                return
            if not count_only:
                if new_scene:
                    params["targetScene"] = new_scene
                if new_key:
                    params["targetSpawnPoint"] = new_key
            total += 1
        _walk_ref_actions(node, visit)
        return total

    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        count = rewrite_actions(scene)
        for hs in scene.get("hotspots") or []:
            data = hs.get("data") if isinstance(hs, dict) else None
            if str((hs or {}).get("type") or "") == "transition" and isinstance(data, dict) \
                    and str(data.get("targetScene") or "").strip() == scene_id \
                    and str(data.get("targetSpawnPoint") or "").strip() == key:
                if not count_only:
                    if new_scene:
                        data["targetScene"] = new_scene
                    if new_key:
                        data["targetSpawnPoint"] = new_key
                count += 1
        if count:
            hits.append({"bucket": "scene", "itemId": str(sid), "count": count})
            if not count_only:
                model.mark_dirty("scene", str(sid))
    for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            count = rewrite_actions(node)
            if count:
                hits.append({"bucket": bucket, "itemId": item_id, "count": count})
                if not count_only:
                    model.mark_dirty(bucket, item_id if per_item else "")
    narrative = getattr(model, "narrative_graphs", None) or {}
    count = rewrite_actions(narrative)
    if count:
        hits.append({"bucket": "narrative_graphs", "itemId": "", "count": count})
        if not count_only:
            model.mark_dirty("narrative_graphs")
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        if count_only:
            count = rewrite_actions(doc)
            if count:
                hits.append({"bucket": "dialogue", "itemId": gid, "count": count})
            continue
        working = copy.deepcopy(doc)
        count = rewrite_actions(working)
        if count:
            bucket = _sig._stage_dialogue_doc(model, gid, working)
            hits.append({"bucket": bucket, "itemId": gid, "count": count})
    return hits


def _find_entity(scene: dict[str, Any], kind: str, entity_id: str) -> tuple[int, dict[str, Any]] | None:
    for idx, row in enumerate(scene.get(_entity_list_key(kind)) or []):
        if isinstance(row, dict) and str(row.get("id") or "").strip() == entity_id:
            return idx, row
    return None


def _scenes_defining(model: Any, kind: str, entity_id: str) -> list[str]:
    out = []
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if isinstance(scene, dict) and _find_entity(scene, kind, entity_id) is not None:
            out.append(str(sid))
    return sorted(out)


# --------------------------------------------------------------------------- #
# 对话图可达场景分析
# --------------------------------------------------------------------------- #

GLOBAL_REACH = "*"  # 图可从无场景上下文触发（narrative/过场/任务/清单…），可达集不封闭


def dialogue_graph_scene_reach(model: Any) -> dict[str, set[str] | str]:
    """对话图 → 可达场景集。值为 set（封闭：只从这些场景触发）或 GLOBAL_REACH。

    触发面：npc.dialogueGraphId、hotspot data.graphId、场景动作树 startDialogueGraph
    → 该场景；scenarios.dialogueGraphIds、非场景内容资产 / 叙事图动作树的
    startDialogueGraph → GLOBAL；对话图内 startDialogueGraph 链式传播（不动点）。
    """
    reach: dict[str, set[str] | str] = {}

    def add(gid: str, sid: str | None) -> None:
        gid = str(gid or "").strip()
        if not gid:
            return
        if sid is None:
            reach[gid] = GLOBAL_REACH
            return
        cur = reach.get(gid)
        if cur == GLOBAL_REACH:
            return
        if cur is None:
            reach[gid] = {sid}
        else:
            cur.add(sid)

    def collect_start_graph(node: Any, sid: str | None) -> None:
        def visit(act_type: str, params: dict[str, Any]) -> None:
            if act_type == "startDialogueGraph":
                add(str(params.get("graphId") or ""), sid)
        _walk_ref_actions(node, visit)

    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        sid = str(sid)
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs") or []:
            if isinstance(npc, dict) and npc.get("dialogueGraphId"):
                add(str(npc["dialogueGraphId"]), sid)
        for hs in scene.get("hotspots") or []:
            if isinstance(hs, dict) and isinstance(hs.get("data"), dict) and hs["data"].get("graphId"):
                add(str(hs["data"]["graphId"]), sid)
        collect_start_graph(scene, sid)

    for row in getattr(model, "scenarios", None) or []:
        if isinstance(row, dict):
            for gid in row.get("dialogueGraphIds") or []:
                add(str(gid), None)

    for attr in _sig.CONDITION_SOURCES:
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is not None:
            collect_start_graph(root, None)
    collect_start_graph(getattr(model, "narrative_graphs", None) or {}, None)

    # 对话图 → 对话图 链式传播（不动点迭代；GLOBAL 吸收）
    edges: dict[str, set[str]] = {}
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        children: set[str] = set()

        def visit(act_type: str, params: dict[str, Any]) -> None:
            if act_type == "startDialogueGraph":
                child = str(params.get("graphId") or "").strip()
                if child:
                    children.add(child)
        _walk_ref_actions(doc, visit)
        if children:
            edges[gid] = children

    changed = True
    while changed:
        changed = False
        for gid, children in edges.items():
            src = reach.get(gid)
            if src is None:
                continue
            for child in children:
                cur = reach.get(child)
                if src == GLOBAL_REACH:
                    if cur != GLOBAL_REACH:
                        reach[child] = GLOBAL_REACH
                        changed = True
                else:
                    if cur == GLOBAL_REACH:
                        continue
                    if cur is None:
                        reach[child] = set(src)
                        changed = True
                    elif not src <= cur:
                        cur.update(src)
                        changed = True
    return reach


# --------------------------------------------------------------------------- #
# 扫描（scan）
# --------------------------------------------------------------------------- #

def _bare_hit(spec_kind: str, value: Any, kind: str, entity_id: str) -> bool:
    if not isinstance(value, str) or value.strip() != entity_id:
        return False
    return kind in _BARE_KIND_SCOPE.get(spec_kind, ())


def _qualified_hit(
    act_type: str, spec_kind: str, params: dict[str, Any],
    scene_id: str, kind: str, entity_id: str,
) -> bool:
    if str(params.get("sceneId") or "").strip() != scene_id:
        return False
    if spec_kind == "scene_entity":
        if str(params.get("entityKind") or "").strip().lower() != kind:
            return False
        return str(params.get("entityId") or "").strip() == entity_id
    if spec_kind == "scene_hotspot":
        return kind == "hotspot" and str(params.get("hotspotId") or "").strip() == entity_id
    if spec_kind == "scene_zone":
        return kind == "zone" and str(params.get("zoneId") or "").strip() == entity_id
    return False


def _count_entity_refs(
    node: Any, scene_id: str, kind: str, entity_id: str,
) -> tuple[int, int, int]:
    """返回 (裸引用数, 场景限定引用数, 软引用数)。"""
    bare = qualified = soft = 0

    def visit(act_type: str, params: dict[str, Any]) -> None:
        nonlocal bare, qualified, soft
        for param, spec_kind in ENTITY_REF_PARAMS[act_type].items():
            value = params.get(param)
            if spec_kind in ("scene_entity", "scene_hotspot", "scene_zone"):
                if _qualified_hit(act_type, spec_kind, params, scene_id, kind, entity_id):
                    qualified += 1
            elif spec_kind == "npc_soft":
                if _bare_hit(spec_kind, value, kind, entity_id):
                    soft += 1
            elif spec_kind == "owner":
                if str(params.get("ownerType") or "npc").strip() == kind \
                        and isinstance(value, str) and value.strip() == entity_id:
                    bare += 1
            elif spec_kind in _BARE_KIND_SCOPE:
                if _bare_hit(spec_kind, value, kind, entity_id):
                    bare += 1
    _walk_ref_actions(node, visit)
    return bare, qualified, soft


def _rewrite_source_id_strings(node: Any, old: str, new: str, *, count_only: bool = False) -> int:
    """emitNarrativeSignal 溯源字段 sourceId 的 "场景:实体" 复合串精确匹配改写。
    trace-only（不参与信号路由），带场景前缀零歧义，可放心机械改写。"""
    count = 0
    if isinstance(node, dict):
        if str(node.get("sourceId") or "") == old:
            if not count_only:
                node["sourceId"] = new
            count += 1
        for value in node.values():
            count += _rewrite_source_id_strings(value, old, new, count_only=count_only)
    elif isinstance(node, list):
        for child in node:
            count += _rewrite_source_id_strings(child, old, new, count_only=count_only)
    return count


def _rewrite_source_ids_project(model: Any, old: str, new: str, *, count_only: bool = False) -> int:
    total = 0
    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        count = _rewrite_source_id_strings(scene, old, new, count_only=count_only)
        if count and not count_only:
            model.mark_dirty("scene", str(sid))
        total += count
    for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            count = _rewrite_source_id_strings(node, old, new, count_only=count_only)
            if count and not count_only:
                model.mark_dirty(bucket, item_id if per_item else "")
            total += count
    narrative = getattr(model, "narrative_graphs", None) or {}
    count = _rewrite_source_id_strings(narrative, old, new, count_only=count_only)
    if count and not count_only:
        model.mark_dirty("narrative_graphs")
    total += count
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        if count_only:
            total += _rewrite_source_id_strings(doc, old, new, count_only=True)
            continue
        working = copy.deepcopy(doc)
        count = _rewrite_source_id_strings(working, old, new)
        if count:
            _sig._stage_dialogue_doc(model, gid, working)
        total += count
    return total


def _count_tag_refs(node: Any, entity_id: str) -> int:
    pattern = re.compile(_TAG_NPC_RE_TMPL.format(re.escape(entity_id)))
    count = 0

    def visit(_container: Any, _key: Any, value: str) -> None:
        nonlocal count
        count += len(pattern.findall(value))
    _walk_strings(node, visit)
    return count


def _owner_binding_hits(model: Any, kind: str, entity_id: str) -> list[dict[str, str]]:
    """叙事图 graph 级 ownerType/ownerId 绑定（@owner wrapper 解析用）。"""
    hits: list[dict[str, str]] = []
    for graph in _sig._iter_graphs(getattr(model, "narrative_graphs", None) or {}):
        if str(graph.get("ownerType") or "").strip() == kind \
                and str(graph.get("ownerId") or "").strip() == entity_id:
            hits.append({"graphId": str(graph.get("id") or "")})
    return hits


def scan_entity_usages(model: Any, scene_id: str, kind: str, entity_id: str) -> dict[str, Any]:
    """列出实体的全项目引用（重构预览用），不做任何修改。

    分组语义（对应迁移/改名时的处置类别）：
    - qualified   场景限定引用（sceneId+id）：迁移/改名可机械改写跟随；
    - selfRefs    实体自己 def 内的裸引用：随 def 一起走，天然跟随；
    - sceneLocal  本场景其它容器里的裸引用：迁移后悬垂（运行时静默跳过）；
    - dialogues   对话图裸引用，带可达场景集：reach ⊆ {本场景} 才可证明指向本实体；
    - globalRefs  叙事图/过场/任务等无场景上下文的裸引用：id 多场景重复时歧义;
    - ownerBindings 叙事图 wrapper 绑定（裸,同 globalRefs 歧义规则）;
    - tagRefs     玩家可见文本 [tag:npc:id]（全局解析,删除最后实例会卡保存门）。
    """
    sid = str(scene_id or "").strip()
    eid = str(entity_id or "").strip()
    scene = (getattr(model, "scenes", None) or {}).get(sid)
    if not isinstance(scene, dict):
        raise EntityRefactorError(f"场景 {sid!r} 不存在")
    if kind == SPAWN_KIND:
        return _scan_spawn_usages(model, sid, eid)
    found = _find_entity(scene, kind, eid)

    report: dict[str, Any] = {
        "sceneId": sid, "kind": kind, "entityId": eid,
        "exists": found is not None,
        "defIndex": found[0] if found else -1,
        "definedInScenes": _scenes_defining(model, kind, eid),
        "otherKindScenes": _scenes_defining(model, "hotspot" if kind == "npc" else "npc", eid),
    }

    self_refs = 0
    scene_local: list[dict[str, Any]] = []
    qualified_local = 0
    for c_kind, c_id, node in _scene_containers(scene):
        bare, qualified, soft = _count_entity_refs(node, sid, kind, eid, )
        npc_data = 0
        if c_kind == "hotspot" and kind == "npc" and isinstance(node.get("data"), dict) \
                and str(node["data"].get("npcId") or "").strip() == eid:
            npc_data = 1
        total = bare + soft + npc_data
        qualified_local += qualified
        if not total:
            continue
        if c_kind == kind and c_id == eid:
            self_refs += total
        else:
            scene_local.append({"container": c_kind, "id": c_id, "count": total})
    report["selfRefs"] = self_refs
    report["sceneLocal"] = scene_local

    # 其余场景 + 内容资产的场景限定/裸引用
    qualified_hits: list[dict[str, Any]] = []
    global_hits: list[dict[str, Any]] = []
    if qualified_local:
        qualified_hits.append({"bucket": "scene", "itemId": sid, "count": qualified_local})
    for other_sid, other in (getattr(model, "scenes", None) or {}).items():
        other_sid = str(other_sid)
        if other_sid == sid or not isinstance(other, dict):
            continue
        bare, qualified, soft = _count_entity_refs(other, sid, kind, eid)
        if qualified:
            qualified_hits.append({"bucket": "scene", "itemId": other_sid, "count": qualified})
        if bare or soft:
            # 别的场景动作树里的裸引用运行时在【那个场景】解析，只有同名实体在场时
            # 才命中——对本实体而言不构成引用，但同 id 歧义值得在报告里点名。
            global_hits.append({
                "bucket": "scene", "itemId": other_sid, "count": bare + soft,
                "note": "otherSceneBare",
            })

    for attr, (bucket, _per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            bare, qualified, soft = _count_entity_refs(node, sid, kind, eid)
            if qualified:
                qualified_hits.append({"bucket": bucket, "itemId": item_id, "count": qualified})
            if bare or soft:
                global_hits.append({"bucket": bucket, "itemId": item_id, "count": bare + soft})
    narrative = getattr(model, "narrative_graphs", None) or {}
    bare, qualified, soft = _count_entity_refs(narrative, sid, kind, eid)
    if qualified:
        qualified_hits.append({"bucket": "narrative_graphs", "itemId": "", "count": qualified})
    if bare or soft:
        global_hits.append({"bucket": "narrative_graphs", "itemId": "", "count": bare + soft})
    report["qualified"] = qualified_hits
    report["globalRefs"] = global_hits

    reach_map = dialogue_graph_scene_reach(model)
    dialogue_hits: list[dict[str, Any]] = []
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        d_bare, _d_qual, d_soft = _count_entity_refs(doc, sid, kind, eid)
        speaker = _count_speaker_refs(doc, eid) if kind == "npc" else 0
        count = d_bare + d_soft + speaker
        if not count:
            continue
        reach = reach_map.get(gid)
        dialogue_hits.append({
            "graphId": gid, "count": count,
            "reach": sorted(reach) if isinstance(reach, set) else (reach or "untriggered"),
        })
    report["dialogues"] = dialogue_hits

    report["ownerBindings"] = _owner_binding_hits(model, kind, eid)

    tag_hits: list[dict[str, Any]] = []
    if kind == "npc":
        for other_sid, other in (getattr(model, "scenes", None) or {}).items():
            count = _count_tag_refs(other, eid)
            if count:
                tag_hits.append({"bucket": "scene", "itemId": str(other_sid), "count": count})
        for attr, (bucket, _per_item) in _sig.CONDITION_SOURCES.items():
            if attr == "scenes":
                continue
            root = getattr(model, attr, None)
            if root is None:
                continue
            count = _count_tag_refs(root, eid)
            if count:
                tag_hits.append({"bucket": bucket, "itemId": "", "count": count})
        for coll_attr, bucket in (("strings", "strings"), ("narrative_graphs", "narrative_graphs")):
            root = getattr(model, coll_attr, None)
            count = _count_tag_refs(root, eid) if root is not None else 0
            if count:
                tag_hits.append({"bucket": bucket, "itemId": "", "count": count})
        for gid in _sig._dialogue_graph_ids(model):
            doc = _sig._load_dialogue_doc(model, gid)
            if doc is not None:
                count = _count_tag_refs(doc, eid)
                if count:
                    tag_hits.append({"bucket": "dialogue", "itemId": gid, "count": count})
    report["tagRefs"] = tag_hits

    report["totalRefs"] = (
        self_refs
        + sum(h["count"] for h in scene_local)
        + sum(h["count"] for h in qualified_hits)
        + sum(h["count"] for h in global_hits if h.get("note") != "otherSceneBare")
        + sum(h["count"] for h in dialogue_hits)
        + len(report["ownerBindings"])
        + sum(h["count"] for h in tag_hits)
    )

    # emitNarrativeSignal 溯源复合串 "场景:实体"（trace-only,不进 totalRefs）
    report["traceRefs"] = _rewrite_source_ids_project(model, f"{sid}:{eid}", "", count_only=True)

    # 迁移时需人工重定位/复核的实体自带字段
    if found is not None:
        row = found[1]
        if kind == "zone":
            needs = ["polygon 多边形（源场景世界坐标，需在目标场景重画）"]
            if str(row.get("zoneKind") or "") == "depth_floor" or row.get("floorOffsetBoost"):
                needs.append("floorOffsetBoost / depth_floor（叠加在源场景深度图公式上，换图即失义）")
        else:
            needs = ["x/y 坐标"]
            if kind == "npc" and isinstance(row.get("patrol"), dict) and row["patrol"].get("route"):
                needs.append("patrol.route 途经点（源场景世界坐标）")
            if row.get("collisionPolygon") and not row.get("collisionPolygonLocal"):
                needs.append("collisionPolygon（世界坐标模式）")
            if row.get("renderRaw"):
                needs.append("renderRaw（贴图烤自源场景背景）")
            if row.get("cutsceneIds"):
                needs.append(f"cutsceneIds {row['cutsceneIds']!r}（过场按场景 staging）")
        if row.get("planes"):
            needs.append(f"planes {row['planes']!r}（目标场景是否会激活该位面）")
        report["needsReview"] = needs
    return report


def _scan_spawn_usages(model: Any, sid: str, key: str) -> dict[str, Any]:
    """出生点引用扫描：入站引用全部 targetScene 限定，归入 qualified（可机械改写）。"""
    scene = model.scenes[sid]
    found = _find_spawn(scene, key)
    hits = _spawn_inbound_rewrite(model, sid, key, count_only=True)
    return {
        "sceneId": sid, "kind": SPAWN_KIND, "entityId": key,
        "exists": found is not None,
        "defIndex": found[0] if found else -1,
        "definedInScenes": [sid] if found else [],
        "otherKindScenes": [],
        "selfRefs": 0, "sceneLocal": [], "dialogues": [],
        "qualified": hits, "globalRefs": [], "ownerBindings": [], "tagRefs": [],
        "traceRefs": 0,
        "totalRefs": sum(h["count"] for h in hits),
        "needsReview": ["坐标（迁移后需在目标场景重新点选）"] if found else [],
    }


def _count_speaker_refs(doc: Any, entity_id: str) -> int:
    """对话图 speaker.npcId 软引用（kind=='npc' 且显式带 npcId 的节点）。"""
    count = 0
    if isinstance(doc, dict):
        speaker = doc.get("speaker")
        if isinstance(speaker, dict) and str(speaker.get("kind") or "") == "npc" \
                and str(speaker.get("npcId") or "").strip() == entity_id:
            count += 1
        for value in doc.values():
            count += _count_speaker_refs(value, entity_id)
    elif isinstance(doc, list):
        for child in doc:
            count += _count_speaker_refs(child, entity_id)
    return count


# --------------------------------------------------------------------------- #
# 迁移（move）
# --------------------------------------------------------------------------- #

def move_entity(
    model: Any, src_scene: str, kind: str, entity_id: str, dst_scene: str,
    *, position: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """把实体从 src 场景迁到 dst 场景（def 整体搬 + sceneId 限定引用机械改写跟随）。

    裸引用**不**自动改写（详见 scan 分组语义），报告里列出交人工；position 未给时
    保留原坐标（作者需在目标场景重新摆位）。
    """
    src = str(src_scene or "").strip()
    dst = str(dst_scene or "").strip()
    eid = str(entity_id or "").strip()
    scenes = getattr(model, "scenes", None) or {}
    if src == dst:
        raise EntityRefactorError("源场景与目标场景相同")
    if not isinstance(scenes.get(src), dict):
        raise EntityRefactorError(f"源场景 {src!r} 不存在")
    if not isinstance(scenes.get(dst), dict):
        raise EntityRefactorError(f"目标场景 {dst!r} 不存在")
    if kind == SPAWN_KIND:
        return _move_spawn(model, src, eid, dst, position=position)
    found = _find_entity(scenes[src], kind, eid)
    if found is None:
        raise EntityRefactorError(f"场景 {src!r} 里没有 {kind} {eid!r}")
    for other_kind in _COLLISION_KINDS[kind]:
        if _find_entity(scenes[dst], other_kind, eid) is not None:
            raise EntityRefactorError(
                f"目标场景 {dst!r} 已有同 id 实体（{other_kind} {eid!r}）；请先重命名再迁移")

    report = scan_entity_usages(model, src, kind, eid)

    src_index, row = found
    scenes[src][_entity_list_key(kind)].pop(src_index)
    if position is not None and kind != "zone":
        row["x"], row["y"] = position[0], position[1]
    scenes[dst].setdefault(_entity_list_key(kind), []).append(row)
    # 溯源复合串跟随（trace-only,只动搬走的 def 自己带的）
    _rewrite_source_id_strings(row, f"{src}:{eid}", f"{dst}:{eid}")
    model.mark_dirty("scene", src)
    model.mark_dirty("scene", dst)

    rewritten = _rewrite_qualified_scene_refs(model, kind, eid, src, dst)

    summary = {
        "op": "moveEntity", "kind": kind, "entityId": eid,
        "srcScene": src, "dstScene": dst, "srcIndex": src_index,
        "qualifiedRewritten": rewritten,
        "danglingSceneLocal": report["sceneLocal"],
        "dialogues": report["dialogues"],
        "globalRefs": report["globalRefs"],
        "ownerBindings": report["ownerBindings"],
        "needsReview": report.get("needsReview") or [],
    }
    return summary


def _move_spawn(
    model: Any, src: str, key: str, dst: str,
    *, position: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """出生点迁移：键从 src.spawnPoints 搬到 dst.spawnPoints，全部入站引用
    （transition / switchScene / changeScene 的 targetScene+targetSpawnPoint）机械改写跟随。"""
    scenes = model.scenes
    if key == "default":
        raise EntityRefactorError("默认出生点不可迁移")
    found = _find_spawn(scenes[src], key)
    if found is None:
        raise EntityRefactorError(f"场景 {src!r} 没有出生点 {key!r}")
    if _find_spawn(scenes[dst], key) is not None:
        raise EntityRefactorError(f"目标场景 {dst!r} 已有出生点 {key!r}；请先重命名再迁移")

    report = _scan_spawn_usages(model, src, key)
    src_index, value = found
    scenes[src]["spawnPoints"].pop(key)
    if position is not None and isinstance(value, dict):
        value["x"], value["y"] = position[0], position[1]
    scenes[dst].setdefault("spawnPoints", {})[key] = value
    model.mark_dirty("scene", src)
    model.mark_dirty("scene", dst)
    rewritten = _spawn_inbound_rewrite(model, src, key, new_scene=dst)
    return {
        "op": "moveEntity", "kind": SPAWN_KIND, "entityId": key,
        "srcScene": src, "dstScene": dst, "srcIndex": src_index,
        "qualifiedRewritten": rewritten,
        "danglingSceneLocal": [], "dialogues": [], "globalRefs": [], "ownerBindings": [],
        "needsReview": report.get("needsReview") or [],
    }


def _rewrite_qualified_scene_refs(
    model: Any, kind: str, entity_id: str, old_scene: str, new_scene: str,
) -> list[dict[str, Any]]:
    """把全项目内 (sceneId==old_scene, 本实体) 的场景限定引用改写为 new_scene。"""
    hits: list[dict[str, Any]] = []

    def rewrite(act_type: str, params: dict[str, Any]) -> int:
        count = 0
        for param, spec_kind in ENTITY_REF_PARAMS[act_type].items():
            if spec_kind in ("scene_entity", "scene_hotspot", "scene_zone") \
                    and _qualified_hit(act_type, spec_kind, params, old_scene, kind, entity_id):
                params["sceneId"] = new_scene
                count += 1
        return count

    def apply(node: Any) -> int:
        total = 0

        def visit(act_type: str, params: dict[str, Any]) -> None:
            nonlocal total
            total += rewrite(act_type, params)
        _walk_ref_actions(node, visit)
        return total

    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        count = apply(scene)
        if count:
            hits.append({"bucket": "scene", "itemId": str(sid), "count": count})
            model.mark_dirty("scene", str(sid))
    for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            count = apply(node)
            if count:
                hits.append({"bucket": bucket, "itemId": item_id, "count": count})
                model.mark_dirty(bucket, item_id if per_item else "")
    narrative = getattr(model, "narrative_graphs", None) or {}
    count = apply(narrative)
    if count:
        hits.append({"bucket": "narrative_graphs", "itemId": "", "count": count})
        model.mark_dirty("narrative_graphs")
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        working = copy.deepcopy(doc)
        count = apply(working)
        if count:
            bucket = _sig._stage_dialogue_doc(model, gid, working)
            hits.append({"bucket": bucket, "itemId": gid, "count": count})
    return hits


# --------------------------------------------------------------------------- #
# 改名（rename）
# --------------------------------------------------------------------------- #

def rename_entity(
    model: Any, scene_id: str, kind: str, old_id: str, new_id: str,
    *, _scope_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """场景内改实体 id，并按歧义分级策略改写引用（见模块 docstring）。

    ``_scope_override`` 仅供撤销：按上次执行记录的作用域反向改写，不重新判定。
    """
    sid = str(scene_id or "").strip()
    old = str(old_id or "").strip()
    new = str(new_id or "").strip()
    scenes = getattr(model, "scenes", None) or {}
    scene = scenes.get(sid)
    if not isinstance(scene, dict):
        raise EntityRefactorError(f"场景 {sid!r} 不存在")
    if kind == SPAWN_KIND:
        return _rename_spawn(model, sid, old, new)
    found = _find_entity(scene, kind, old)
    if found is None:
        raise EntityRefactorError(f"场景 {sid!r} 里没有 {kind} {old!r}")
    if not new or new == old:
        raise EntityRefactorError("新 id 为空或与旧 id 相同")
    for other_kind in _COLLISION_KINDS[kind]:
        if _find_entity(scene, other_kind, new) is not None:
            raise EntityRefactorError(f"场景 {sid!r} 已有 id {new!r}（{other_kind}）")

    if _scope_override is not None:
        scope = dict(_scope_override)
    else:
        defined = _scenes_defining(model, kind, old)
        if kind == "npc":
            other_kind_scenes = _scenes_defining(model, "hotspot", old)
        elif kind == "hotspot":
            other_kind_scenes = _scenes_defining(model, "npc", old)
        else:
            other_kind_scenes = []
        unique_global = defined == [sid] and not other_kind_scenes
        reach_map = dialogue_graph_scene_reach(model)
        dialogue_ids: list[str] = []
        skipped_dialogues: list[str] = []
        for gid in _sig._dialogue_graph_ids(model):
            doc = _sig._load_dialogue_doc(model, gid)
            if doc is None:
                continue
            d_bare, _q, d_soft = _count_entity_refs(doc, sid, kind, old)
            speaker = _count_speaker_refs(doc, old) if kind == "npc" else 0
            if not (d_bare + d_soft + speaker):
                continue
            reach = reach_map.get(gid)
            if unique_global or (isinstance(reach, set) and reach <= {sid}):
                dialogue_ids.append(gid)
            else:
                skipped_dialogues.append(gid)
        scope = {
            "uniqueGlobal": unique_global,
            "dialogueIds": dialogue_ids,
            "skippedDialogues": skipped_dialogues,
        }

    row = found[1]
    row["id"] = new

    counts: dict[str, Any] = {}
    # 1) 本场景全部容器（含实体自身 def）裸引用 + data.npcId
    counts["sceneLocal"] = _rewrite_bare_in_tree(scene, sid, kind, old, new, include_soft=True)
    model.mark_dirty("scene", sid)

    # 2) 场景限定引用（sceneId==sid 的 entityId/hotspotId/zoneId）——全项目
    counts["qualified"] = _rewrite_qualified_id_refs(model, sid, kind, old, new)

    # 2.5) 溯源复合串 "场景:实体"（trace-only,带场景前缀零歧义,机械改写）
    counts["trace"] = _rewrite_source_ids_project(model, f"{sid}:{old}", f"{sid}:{new}")

    # 3) 全局裸面（叙事图动作树 + owner 绑定 + 内容资产）——仅全局唯一时
    if scope["uniqueGlobal"]:
        global_hits: list[dict[str, Any]] = []
        for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
            if attr == "scenes":
                continue
            root = getattr(model, attr, None)
            if root is None:
                continue
            for item_id, node in _sig._iter_collection(root):
                count = _rewrite_bare_in_tree(node, sid, kind, old, new, include_soft=True)
                if count:
                    global_hits.append({"bucket": bucket, "itemId": item_id, "count": count})
                    model.mark_dirty(bucket, item_id if per_item else "")
        narrative = getattr(model, "narrative_graphs", None) or {}
        count = _rewrite_bare_in_tree(narrative, sid, kind, old, new, include_soft=True)
        owner_count = 0
        for graph in _sig._iter_graphs(narrative):
            if str(graph.get("ownerType") or "").strip() == kind \
                    and str(graph.get("ownerId") or "").strip() == old:
                graph["ownerId"] = new
                owner_count += 1
        if count or owner_count:
            global_hits.append({"bucket": "narrative_graphs", "itemId": "",
                                "count": count + owner_count})
            model.mark_dirty("narrative_graphs")
        # [tag:npc:old] 文本引用（全局解析,唯一时安全跟随）
        tag_count = 0
        if kind == "npc":
            tag_count += _rewrite_tag_refs(scene, old, new)
            for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
                if attr == "scenes":
                    continue
                root = getattr(model, attr, None)
                if root is None:
                    continue
                for item_id, node in _sig._iter_collection(root):
                    hit = _rewrite_tag_refs(node, old, new)
                    if hit:
                        tag_count += hit
                        model.mark_dirty(bucket, item_id if per_item else "")
            for extra_attr, extra_bucket in (("strings", "strings"),):
                root = getattr(model, extra_attr, None)
                if root is not None:
                    hit = _rewrite_tag_refs(root, old, new)
                    if hit:
                        tag_count += hit
                        model.mark_dirty(extra_bucket)
            hit = _rewrite_tag_refs(narrative, old, new)
            if hit:
                tag_count += hit
                model.mark_dirty("narrative_graphs")
        counts["global"] = global_hits
        counts["tags"] = tag_count
    else:
        counts["global"] = []
        counts["tags"] = 0

    # 4) 对话图（作用域内的）
    dialogue_hits: list[dict[str, Any]] = []
    for gid in scope["dialogueIds"]:
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        working = copy.deepcopy(doc)
        count = _rewrite_bare_in_tree(working, sid, kind, old, new, include_soft=True)
        if kind == "npc":
            count += _rewrite_speaker_refs(working, old, new)
            if scope["uniqueGlobal"]:
                count += _rewrite_tag_refs(working, old, new)
        if count:
            bucket = _sig._stage_dialogue_doc(model, gid, working)
            dialogue_hits.append({"graphId": gid, "count": count, "bucket": bucket})
    counts["dialogues"] = dialogue_hits

    return {
        "op": "renameEntity", "sceneId": sid, "kind": kind,
        "oldId": old, "newId": new, "scope": scope, "counts": counts,
    }


def _rename_spawn(model: Any, sid: str, old: str, new: str) -> dict[str, Any]:
    """出生点改名：键序保真重命名 + 全部入站引用机械改写（零歧义）。"""
    scene = model.scenes[sid]
    if old == "default" or new == "default":
        raise EntityRefactorError("默认出生点名不可参与改名")
    if _find_spawn(scene, old) is None:
        raise EntityRefactorError(f"场景 {sid!r} 没有出生点 {old!r}")
    if not new or new == old:
        raise EntityRefactorError("新键名为空或与旧键相同")
    if _find_spawn(scene, new) is not None:
        raise EntityRefactorError(f"场景 {sid!r} 已有出生点 {new!r}")

    sp = scene["spawnPoints"]
    scene["spawnPoints"] = {(new if k == old else k): v for k, v in sp.items()}
    model.mark_dirty("scene", sid)
    hits = _spawn_inbound_rewrite(model, sid, old, new_key=new)
    return {
        "op": "renameEntity", "sceneId": sid, "kind": SPAWN_KIND,
        "oldId": old, "newId": new,
        "scope": {"uniqueGlobal": True, "dialogueIds": [], "skippedDialogues": []},
        "counts": {"sceneLocal": 0, "qualified": hits, "global": [], "tags": 0,
                   "trace": 0, "dialogues": []},
    }


def _rewrite_bare_in_tree(
    node: Any, scene_id: str, kind: str, old: str, new: str, *, include_soft: bool,
) -> int:
    count = 0

    def visit(act_type: str, params: dict[str, Any]) -> None:
        nonlocal count
        for param, spec_kind in ENTITY_REF_PARAMS[act_type].items():
            value = params.get(param)
            if spec_kind == "owner":
                if str(params.get("ownerType") or "npc").strip() == kind \
                        and isinstance(value, str) and value.strip() == old:
                    params[param] = new
                    count += 1
            elif spec_kind == "npc_soft":
                if include_soft and _bare_hit(spec_kind, value, kind, old):
                    params[param] = new
                    count += 1
            elif spec_kind in _BARE_KIND_SCOPE:
                if _bare_hit(spec_kind, value, kind, old):
                    params[param] = new
                    count += 1
    _walk_ref_actions(node, visit)
    count += _rewrite_npc_data_refs(node, kind, old, new)
    return count


def _rewrite_npc_data_refs(node: Any, kind: str, old: str, new: str) -> int:
    """npc 型热点的 data.npcId 引用。"""
    if kind != "npc":
        return 0
    count = 0
    if isinstance(node, dict):
        data = node.get("data")
        if str(node.get("type") or "") == "npc" and isinstance(data, dict) \
                and str(data.get("npcId") or "").strip() == old:
            data["npcId"] = new
            count += 1
        for value in node.values():
            count += _rewrite_npc_data_refs(value, kind, old, new)
    elif isinstance(node, list):
        for child in node:
            count += _rewrite_npc_data_refs(child, kind, old, new)
    return count


def _rewrite_qualified_id_refs(model: Any, scene_id: str, kind: str, old: str, new: str) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []

    def apply(node: Any) -> int:
        total = 0

        def visit(act_type: str, params: dict[str, Any]) -> None:
            nonlocal total
            for param, spec_kind in ENTITY_REF_PARAMS[act_type].items():
                if spec_kind in ("scene_entity", "scene_hotspot", "scene_zone") \
                        and _qualified_hit(act_type, spec_kind, params, scene_id, kind, old):
                    params[param] = new
                    total += 1
        _walk_ref_actions(node, visit)
        return total

    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if not isinstance(scene, dict):
            continue
        count = apply(scene)
        if count:
            hits.append({"bucket": "scene", "itemId": str(sid), "count": count})
            model.mark_dirty("scene", str(sid))
    for attr, (bucket, per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            count = apply(node)
            if count:
                hits.append({"bucket": bucket, "itemId": item_id, "count": count})
                model.mark_dirty(bucket, item_id if per_item else "")
    narrative = getattr(model, "narrative_graphs", None) or {}
    count = apply(narrative)
    if count:
        hits.append({"bucket": "narrative_graphs", "itemId": "", "count": count})
        model.mark_dirty("narrative_graphs")
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        working = copy.deepcopy(doc)
        count = apply(working)
        if count:
            bucket = _sig._stage_dialogue_doc(model, gid, working)
            hits.append({"bucket": bucket, "itemId": gid, "count": count})
    return hits


def _rewrite_speaker_refs(doc: Any, old: str, new: str) -> int:
    count = 0
    if isinstance(doc, dict):
        speaker = doc.get("speaker")
        if isinstance(speaker, dict) and str(speaker.get("kind") or "") == "npc" \
                and str(speaker.get("npcId") or "").strip() == old:
            speaker["npcId"] = new
            count += 1
        for value in doc.values():
            count += _rewrite_speaker_refs(value, old, new)
    elif isinstance(doc, list):
        for child in doc:
            count += _rewrite_speaker_refs(child, old, new)
    return count


def _rewrite_tag_refs(node: Any, old: str, new: str) -> int:
    pattern = re.compile(_TAG_NPC_RE_TMPL.format(re.escape(old)))
    replacement = f"[tag:npc:{new}]"
    count = 0

    def visit(container: Any, key: Any, value: str) -> None:
        nonlocal count
        replaced, n = pattern.subn(replacement, value)
        if n:
            container[key] = replaced
            count += n
    _walk_strings(node, visit)
    return count


# --------------------------------------------------------------------------- #
# 安全删除（delete）——不级联清理引用，悬垂交校验器
# --------------------------------------------------------------------------- #

def delete_entity(
    model: Any, scene_id: str, kind: str, entity_id: str, *, force: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """从场景删除实体 def。有引用需 force；**不级联**删除引用动作（那是语义决定，
    留给作者——悬垂由 validator 报告）。例外：[tag:npc:id] 文本引用且这是全项目最后
    一个该 id 实例时硬拒（保存门 validate_refs_for_save 会 raise，整工程存不了）。
    返回 (summary, reverse_ops)。"""
    sid = str(scene_id or "").strip()
    eid = str(entity_id or "").strip()
    report = scan_entity_usages(model, sid, kind, eid)
    if not report["exists"]:
        raise EntityRefactorError(f"场景 {sid!r} 里没有 {kind} {eid!r}")

    if kind == "npc" and report["tagRefs"]:
        last_instance = report["definedInScenes"] == [sid]
        if last_instance:
            spots = ", ".join(f"{h['bucket']}:{h['itemId']}" for h in report["tagRefs"][:5])
            raise EntityRefactorError(
                f"文本中存在 [tag:npc:{eid}] 引用（{spots} 等），且这是全项目最后一个 "
                f"{eid!r}——删除后整工程无法保存。请先改文本再删。")

    refs = report["totalRefs"] - report["selfRefs"]
    if refs and not force:
        raise EntityRefactorError(
            f"{kind} {eid!r} 仍有 {refs} 处外部引用；确认走强制删除（force）才可删除。"
            "删除不会级联清理这些引用，它们将悬垂并由数据校验报告。")

    scene = model.scenes[sid]
    summary = {
        "op": "deleteEntity", "sceneId": sid, "kind": kind, "entityId": eid,
        "danglingRefs": refs, "report": report,
    }
    if kind == SPAWN_KIND:
        if eid == "default":
            raise EntityRefactorError("默认出生点不可删除")
        idx, value = _find_spawn(scene, eid)
        scene["spawnPoints"].pop(eid)
        model.mark_dirty("scene", sid)
        reverse_ops = [{"kind": "spawnInsert", "sceneId": sid,
                        "index": idx, "key": eid, "value": copy.deepcopy(value)}]
        return summary, reverse_ops
    idx, row = _find_entity(scene, kind, eid)
    scene[_entity_list_key(kind)].pop(idx)
    model.mark_dirty("scene", sid)
    reverse_ops = [{"kind": "entityInsert", "sceneId": sid, "entityKind": kind,
                    "index": idx, "row": copy.deepcopy(row)}]
    return summary, reverse_ops


# --------------------------------------------------------------------------- #
# 撤销日志（独立于信号重构日志）
# --------------------------------------------------------------------------- #

JOURNAL_ATTR = "entity_refactor_journal"
_JOURNAL_CAP = 20


def push_journal(model: Any, entry: dict[str, Any]) -> int:
    journal = getattr(model, JOURNAL_ATTR, None)
    if journal is None:
        journal = []
        setattr(model, JOURNAL_ATTR, journal)
    journal.append(entry)
    del journal[:-_JOURNAL_CAP]
    return len(journal)


def journal_size(model: Any) -> int:
    return len(getattr(model, JOURNAL_ATTR, None) or [])


def undo_last(model: Any) -> dict[str, Any]:
    """撤销最近一次实体重构。move=反向迁移；rename=按记录作用域反向改名；
    delete=按位重插。"""
    journal = getattr(model, JOURNAL_ATTR, None) or []
    if not journal:
        return {"ok": False, "reason": "没有可撤销的实体重构操作"}
    entry = journal[-1]
    op = entry.get("op")
    try:
        if op == "moveEntity":
            _undo_move(model, entry)
            desc = (f"已撤销迁移：{entry['kind']} {entry['entityId']} "
                    f"{entry['dstScene']} → {entry['srcScene']}")
        elif op == "renameEntity":
            rename_entity(
                model, entry["sceneId"], entry["kind"], entry["newId"], entry["oldId"],
                _scope_override=entry["scope"],
            )
            desc = f"已撤销改名 {entry['oldId']} → {entry['newId']}"
        elif op == "deleteEntity":
            for rec in reversed(entry.get("reverseOps") or []):
                scene = model.scenes.get(rec.get("sceneId"))
                if not isinstance(scene, dict):
                    raise EntityRefactorError(f"场景 {rec.get('sceneId')!r} 不存在")
                if rec.get("kind") == "entityInsert":
                    rows = scene.setdefault(_entity_list_key(rec["entityKind"]), [])
                    rows.insert(min(int(rec["index"]), len(rows)), copy.deepcopy(rec["row"]))
                elif rec.get("kind") == "spawnInsert":
                    _dict_insert_at(scene.setdefault("spawnPoints", {}),
                                    rec["key"], copy.deepcopy(rec["value"]), int(rec["index"]))
                else:
                    continue
                model.mark_dirty("scene", rec["sceneId"])
            desc = f"已撤销删除 {entry['entityId']}"
        else:
            return {"ok": False, "reason": f"未知实体重构操作 {op!r}"}
    except EntityRefactorError as exc:
        return {"ok": False, "reason": f"撤销失败（数据已变化）：{exc}"}
    except Exception as exc:  # noqa: BLE001 - 撤销边界统一软失败
        return {"ok": False, "reason": f"撤销失败：{exc}"}
    journal.pop()
    return {"ok": True, "description": desc, "journalSize": len(journal)}


def _undo_move(model: Any, entry: dict[str, Any]) -> None:
    scenes = getattr(model, "scenes", None) or {}
    src, dst = entry["srcScene"], entry["dstScene"]
    kind, eid = entry["kind"], entry["entityId"]
    dst_scene = scenes.get(dst)
    src_scene = scenes.get(src)
    if not isinstance(dst_scene, dict) or not isinstance(src_scene, dict):
        raise EntityRefactorError("源/目标场景已不存在")
    if kind == SPAWN_KIND:
        found = _find_spawn(dst_scene, eid)
        if found is None:
            raise EntityRefactorError(f"目标场景 {dst!r} 里已找不到出生点 {eid!r}")
        _idx, value = found
        dst_scene["spawnPoints"].pop(eid)
        _dict_insert_at(src_scene.setdefault("spawnPoints", {}),
                        eid, value, int(entry.get("srcIndex", 0)))
        model.mark_dirty("scene", src)
        model.mark_dirty("scene", dst)
        _spawn_inbound_rewrite(model, dst, eid, new_scene=src)
        return
    found = _find_entity(dst_scene, kind, eid)
    if found is None:
        raise EntityRefactorError(f"目标场景 {dst!r} 里已找不到 {kind} {eid!r}")
    idx, row = found
    dst_scene[_entity_list_key(kind)].pop(idx)
    rows = src_scene.setdefault(_entity_list_key(kind), [])
    rows.insert(min(int(entry.get("srcIndex", len(rows))), len(rows)), row)
    _rewrite_source_id_strings(row, f"{dst}:{eid}", f"{src}:{eid}")
    model.mark_dirty("scene", src)
    model.mark_dirty("scene", dst)
    _rewrite_qualified_scene_refs(model, kind, eid, dst, src)
