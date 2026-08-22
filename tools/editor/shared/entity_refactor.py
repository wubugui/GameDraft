"""全项目场景实体（npc / hotspot / zone / 出生点）引用扫描与重构引擎（迁移 / 改名 / 安全删除 / 复制）。

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
迁移 + 场景限定引用改回；delete 撤销 = 按记录的位置重插 def；duplicate 撤销 = 按
新 id 删副本。
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
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
#   bubble_speaker 头顶闲聊说话人:命中面同 emote_subject,另认 `character:<角色id>` 一档
#                 (角色不是实体引用,改实体名时天然不命中)
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
    "attachToSocket": {"target": "actor"},
    "detachFromSocket": {"target": "actor"},
    "setEntityEnabled": {"target": "actor"},
    # 头顶闲聊说话人：运行时走 resolveEmoteTarget（NPC / 热点 / player / 过场演员），
    # 所以命中面与 emote_subject 同宽；另外多认一档 `character:<角色id>`（不是实体引用，
    # 改实体名时天然不命中）。原先登记成 "actor" 会让热点改名跟不上这两个参数。
    "setBubbleLineSet": {"target": "bubble_speaker"},
    "clearBubbleLineSet": {"target": "bubble_speaker"},
    "moveEntityTo": {"target": "actor", "sceneId": "scene_hint"},
    "jumpEntityTo": {"target": "actor", "sceneId": "scene_hint"},
    "teleportEntityTo": {"target": "actor", "sceneId": "scene_hint"},
    "faceEntity": {"target": "actor", "faceTarget": "actor"},
    "cameraFollowActor": {"target": "actor"},
    "persistNpcEntityEnabled": {"target": "actor"},
    "persistNpcAt": {"target": "actor"},
    "persistNpcAnimState": {"target": "actor"},
    "persistPlayNpcAnimation": {"target": "actor"},
    # 角色阴影绑定（setEntityShadow）：target 命中面与 showEmote 完全一致
    # （player / NPC id / 裸热区 id）——刻意让作者写**裸** id，前缀形式会对重构隐形。
    "setEntityShadow": {"target": "emote_subject"},
    "showEmote": {"target": "emote_subject"},
    "showEmoteAndWait": {"target": "emote_subject"},
    "showSpeechBubble": {"target": "emote_subject"},
    "showSpeechBubbleAndWait": {"target": "emote_subject"},
    "stopNpcPatrol": {"npcId": "npc"},
    "persistNpcDisablePatrol": {"npcId": "npc"},
    "persistNpcEnablePatrol": {"npcId": "npc"},
    "startDialogueGraph": {"npcId": "npc_soft", "ownerId": "owner"},
    # emitNarrativeSignal 的显式 owner 逃生口（终审 H1）：ownerId 与 startDialogueGraph
    # 同款 "owner" 语义——按成对 ownerType 判实体类别后才级联改名/计数。
    "emitNarrativeSignal": {"ownerId": "owner"},
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
    # 日程覆盖把角色钉在某场景：scene 是场景引用（改场景名要跟随）。
    # characterId 指向 character_registry 的角色、不是场景实体，故不在本表登记。
    "setNpcScheduleOverride": {"scene": "scene"},
}

# 裸引用按 value 匹配实体 id 时，各 kind 允许命中的实体种类
_BARE_KIND_SCOPE: dict[str, tuple[str, ...]] = {
    "actor": ("npc",),
    "emote_subject": ("npc", "hotspot"),
    "bubble_speaker": ("npc", "hotspot"),
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



def _iter_bubble_entity_speakers(model: Any) -> Iterator[tuple[dict[str, Any], dict[str, Any], list[str]]]:
    """产出 (台词本, speaker, 钉死的场景列表)：只收 `speaker.kind=entity` 的条目。"""
    bl = getattr(model, "bubble_lines", None)
    sets = bl.get("lineSets") if isinstance(bl, dict) else None
    if not isinstance(sets, list):
        return
    for c in sets:
        if not isinstance(c, dict):
            continue
        sp = c.get("speaker")
        if not isinstance(sp, dict) or sp.get("kind") != "entity":
            continue
        pinned = [str(s) for s in (c.get("scenes") or [])]
        yield c, sp, pinned


def _rewrite_bubble_line_speakers(
    model: Any, kind: str, old: str, new: str,
    *, scene_id: str = "", mode: str = "all", count_only: bool = False,
) -> int:
    """改写 `bubble_lines.json` 里 `lineSets[].speaker.id` 的实体引用。

    这是**数据文件自身**的实体引用，`ENTITY_REF_PARAMS`（action 参数登记面）够不到。
    不跟改的后果：改完名那组台词的说话人解析不到，运行时整组静默不说话
    （validate-data 会报 error，但要等到下次跑校验才发现，且重构撤销也回滚不了它）。

    `mode` 决定收哪一类引用，与 rename 的 qualified / global 两档一一对应：
    - ``qualified``：`scenes` 里含 `scene_id` 的条目。编辑器选点写出来的就是这种形状，
      场景已经钉死＝零歧义，**不看全局唯一性**照样机械跟随；
    - ``bare``：`scenes` 为空的老条目。与「全局裸面」同歧义，只在 id 全局唯一时才该调用；
    - ``all``：上面两类都算（扫描报告用，回答"有多少条指着它"）。

    `scenes` 非空但不含 `scene_id` 的条目一律跳过——那指的是**别的场景里的同名实体**。
    """
    if kind not in ("npc", "hotspot"):
        return 0
    total = 0
    for _c, sp, pinned in _iter_bubble_entity_speakers(model):
        if str(sp.get("id") or "").strip() != old:
            continue
        if pinned:
            if mode == "bare" or not scene_id or scene_id not in pinned:
                continue
        elif mode == "qualified":
            continue
        total += 1
        if not count_only:
            sp["id"] = new
    if total and not count_only:
        model.mark_dirty("bubble_lines")
    return total


def _rewrite_bubble_line_scene_pins(
    model: Any, kind: str, entity_id: str, old_scene: str, new_scene: str,
) -> int:
    """实体迁移时，把钉在 `old_scene` 的台词本 `scenes` 改钉到 `new_scene`。

    实体档说话人的 `scenes` 是「这个摆放在哪个场景」的记录（编辑器选点的产物），
    与 `sceneId` 限定引用同档：零歧义、可机械跟随。不跟改的话人搬走了、台词还钉在
    老场景，运行时永远解析不到＝整组静默不说话。
    """
    if kind not in ("npc", "hotspot"):
        return 0
    total = 0
    for c, sp, pinned in _iter_bubble_entity_speakers(model):
        if str(sp.get("id") or "").strip() != entity_id or old_scene not in pinned:
            continue
        # 就地按位置替换，保留其余场景与原顺序（多场景是老数据形状，不借机重排）
        c["scenes"] = [new_scene if s == old_scene else s for s in pinned]
        total += 1
    if total:
        model.mark_dirty("bubble_lines")
    return total

def _iter_quest_guidance(model: Any) -> Iterator[tuple[str, dict[str, Any]]]:
    """产出 (任务 id, 引导条目)：任务级 `guidance[]` + 目标级 `objectives[].guidance[]`。"""
    for q in (getattr(model, "quests", None) or []):
        if not isinstance(q, dict):
            continue
        qid = str(q.get("id") or "?")
        for g in (q.get("guidance") or []):
            if isinstance(g, dict):
                yield qid, g
        for obj in (q.get("objectives") or []):
            if not isinstance(obj, dict):
                continue
            for g in (obj.get("guidance") or []):
                if isinstance(g, dict):
                    yield qid, g


def _quest_guidance_hits(model: Any, kind: str, scene_id: str, entity_id: str) -> list[dict[str, Any]]:
    """扫描用：哪些任务的引导指着这个实体（按任务分组，带条数）。

    ⚠ 必须给到**任务粒度**，不能只回一个总数：重构确认弹窗要能告诉用户
    「是哪条任务的引导指着它」，否则删除/改名前根本没法判断风险。
    """
    hits: dict[str, int] = {}
    for quest_id, g in _iter_quest_guidance(model):
        if str(g.get("kind") or "") != "worldMarker":
            continue
        if str(g.get("entityKind") or "").strip() != kind:
            continue
        if str(g.get("entityId") or "").strip() != entity_id:
            continue
        if str(g.get("sceneId") or "").strip() != scene_id:
            continue
        hits[quest_id] = hits.get(quest_id, 0) + 1
    return [{"bucket": "quest", "itemId": qid, "count": n} for qid, n in hits.items()]


def _rewrite_quest_guidance_targets(
    model: Any, kind: str, old_scene: str, old_id: str,
    new_scene: str, new_id: str, *, count_only: bool = False,
) -> int:
    """改写任务引导（`quests.json` 的 worldMarker 目标）里的实体引用。

    这是**数据文件自身**的实体引用，`ENTITY_REF_PARAMS`（action 参数登记面）够不到——
    引导条目不是 action，没有 `type`/`params` 那层壳，`_walk_ref_actions` 看不见它。
    好在这处引用是**场景限定的**（sceneId + entityKind + entityId，与 setEntityField 同形），
    零歧义，可机械跟随，不必像 bubble_lines 的裸 speaker 那样只在全局唯一时才改。

    不跟改的后果：改完名/迁完场景，那条引导的箭头指向一个不存在的实体——运行时不报错，
    只是**引导默默不出现**（validate-data 会在下次跑时报 error，但重构撤销回滚不了它）。
    """
    if kind not in ALL_KINDS or kind == SPAWN_KIND:
        return 0
    total = 0
    for _qid, g in _iter_quest_guidance(model):
        if str(g.get("kind") or "") != "worldMarker":
            continue
        if str(g.get("entityKind") or "").strip() != kind:
            continue
        if str(g.get("entityId") or "").strip() != old_id:
            continue
        if str(g.get("sceneId") or "").strip() != old_scene:
            continue
        total += 1
        if not count_only:
            g["entityId"] = new_id
            g["sceneId"] = new_scene
    if total and not count_only:
        model.mark_dirty("quest")
    return total


def _count_tag_refs(node: Any, entity_id: str) -> int:
    pattern = re.compile(_TAG_NPC_RE_TMPL.format(re.escape(entity_id)))
    count = 0

    def visit(_container: Any, _key: Any, value: str) -> None:
        nonlocal count
        count += len(pattern.findall(value))
    _walk_strings(node, visit)
    return count


def _collect_tag_refs(model: Any, entity_id: str) -> list[dict[str, Any]]:
    """全项目 [tag:npc:id] 文本引用清单（scan 与 rename 的悬垂预判共同消费）。"""
    tag_hits: list[dict[str, Any]] = []
    for other_sid, other in (getattr(model, "scenes", None) or {}).items():
        count = _count_tag_refs(other, entity_id)
        if count:
            tag_hits.append({"bucket": "scene", "itemId": str(other_sid), "count": count})
    for attr, (bucket, _per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        count = _count_tag_refs(root, entity_id)
        if count:
            tag_hits.append({"bucket": bucket, "itemId": "", "count": count})
    for coll_attr, bucket in (("strings", "strings"), ("narrative_graphs", "narrative_graphs")):
        root = getattr(model, coll_attr, None)
        count = _count_tag_refs(root, entity_id) if root is not None else 0
        if count:
            tag_hits.append({"bucket": bucket, "itemId": "", "count": count})
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is not None:
            count = _count_tag_refs(doc, entity_id)
            if count:
                tag_hits.append({"bucket": "dialogue", "itemId": gid, "count": count})
    return tag_hits


def _iter_narrative_owner_bindings(narrative: Any) -> Iterator[tuple[str, str, dict[str, Any]]]:
    """叙事数据里承载 ownerType/ownerId 绑定的**两层**容器，产出 (where, label, obj)。

    - ``graph`` 层：运行时唯一真值（NarrativeStateManager 只加载 ``element.graph``）；
    - ``element`` 层：wrapper 元素上的镜像字段，叙事编辑器的「实体总览 / 绑定」优先读它
      （web 侧 ``element.ownerType ?? element.graph.ownerType``）。

    两层必须一起跟随改名——只改 graph 层会让编辑器改名后仍按旧 id 分组
    （2026-08-05 重构引擎全盘审查 P1-3）。
    """
    if not isinstance(narrative, dict):
        return
    for comp in narrative.get("compositions") or []:
        if not isinstance(comp, dict):
            continue
        for el in comp.get("elements") or []:
            if isinstance(el, dict) and ("ownerType" in el or "ownerId" in el):
                yield "element", str(el.get("id") or ""), el
    for graph in _sig._iter_graphs(narrative):
        yield "graph", str(graph.get("id") or ""), graph


def _owner_binding_hits(model: Any, kind: str, entity_id: str) -> list[dict[str, str]]:
    """叙事图 ownerType/ownerId 绑定（@owner wrapper 解析用）：图层 + 元素层镜像。"""
    hits: list[dict[str, str]] = []
    narrative = getattr(model, "narrative_graphs", None) or {}
    for where, label, obj in _iter_narrative_owner_bindings(narrative):
        if str(obj.get("ownerType") or "").strip() == kind \
                and str(obj.get("ownerId") or "").strip() == entity_id:
            # graphId 键名是对话框既有契约（entity_refactor_dialog 直接读），保持不变；
            # 元素层用 where 区分，避免两条同名行看起来像重复报告。
            hits.append({"graphId": label, "where": where})
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

    report["tagRefs"] = _collect_tag_refs(model, eid) if kind == "npc" else []
    tag_hits = report["tagRefs"]

    # 任务引导目标（quests.json 的 worldMarker）：场景限定引用，零歧义、可机械跟随。
    # 按任务分组给出，重构弹窗要能显示「是哪条任务的引导指着它」。
    report["questGuidance"] = _quest_guidance_hits(model, kind, sid, eid)

    # 头顶闲聊台词本的 speaker.id。钉死本场景的按 qualified 档机械跟随，没钉场景的
    # 与 globalRefs 同歧义规则；报告只回答"有多少条指着它"，故两类都算。
    report["bubbleLineSpeakers"] = _rewrite_bubble_line_speakers(
        model, kind, eid, "", scene_id=sid, mode="all", count_only=True,
    )

    report["totalRefs"] = (
        self_refs
        + sum(h["count"] for h in scene_local)
        + sum(h["count"] for h in qualified_hits)
        + sum(h["count"] for h in global_hits if h.get("note") != "otherSceneBare")
        + sum(h["count"] for h in dialogue_hits)
        + len(report["ownerBindings"])
        + sum(h["count"] for h in tag_hits)
        + sum(h["count"] for h in report["questGuidance"])
        + report["bubbleLineSpeakers"]
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


# 显式带 npcId 的说话人 kind：真实数据形状为 "sceneNpc"（types.ts DialogueGraphSpeaker，
# kind:'npc' 变体不带 npcId）；历史/宽松写法 kind:"npc"+npcId 保留兼容。
_SPEAKER_NPCID_KINDS = ("sceneNpc", "npc")


def _count_speaker_refs(doc: Any, entity_id: str) -> int:
    """对话图 speaker.npcId 软引用（kind=='sceneNpc'（含兼容 'npc'）且显式带 npcId）。"""
    count = 0
    if isinstance(doc, dict):
        speaker = doc.get("speaker")
        if isinstance(speaker, dict) and str(speaker.get("kind") or "") in _SPEAKER_NPCID_KINDS \
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
    guidance_moved = _rewrite_quest_guidance_targets(model, kind, src, eid, dst, eid)

    summary = {
        "op": "moveEntity", "kind": kind, "entityId": eid,
        "srcScene": src, "dstScene": dst, "srcIndex": src_index,
        "qualifiedRewritten": rewritten,
        # ⚠ 键名与 scan 报告的 `questGuidance` **刻意不同名**：那边是按任务分组的明细 list，
        # 这边是本次改写的条数 int。同名不同形状是下一个人照抄时必炸的陷阱。
        "questGuidanceRewritten": guidance_moved,
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
    # 台词本的 scenes 钉在哪个场景，同样是"零歧义、随实体走"的场景限定引用。
    # 放这里而不是 move_entity 里：撤销走的是本函数的反向调用，顺带就对称了。
    pins = _rewrite_bubble_line_scene_pins(model, kind, entity_id, old_scene, new_scene)
    if pins:
        hits.append({"bucket": "bubble_lines", "itemId": "", "count": pins})
    return hits


# --------------------------------------------------------------------------- #
# 改名（rename）
# --------------------------------------------------------------------------- #

def rename_entity(
    model: Any, scene_id: str, kind: str, old_id: str, new_id: str,
    *, follow_tag_refs: bool = False,
    _scope_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """场景内改实体 id，并按歧义分级策略改写引用（见模块 docstring）。

    ``follow_tag_refs``：与删除路径的硬拒口径对齐——非全局唯一的 npc id，若本次改名
    会移走全项目最后一个该 id 的 npc 实例且存在 [tag:npc:old] 文本引用，默认抛错
    （否则 tag 悬垂、保存门 validate_refs_for_save 卡整工程）；传 True 表示确认让
    tag 引用跟随改写（记入 scope，撤销按同一作用域反向回放）。

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
        # 非全局唯一（如与他场景热区/NPC 重名）时 tag 不随改名跟随；若本场景是唯一
        # 定义处（改名后旧 id 全项目再无 npc 实例）且存在 [tag:npc:old]，改完即卡保存
        # 门——与删除路径的硬拒口径对齐：默认拒绝，除非调用方确认 follow_tag_refs。
        tag_follow_forced = False
        if kind == "npc" and not unique_global and defined == [sid]:
            tag_hits = _collect_tag_refs(model, old)
            if tag_hits:
                if not follow_tag_refs:
                    spots = ", ".join(
                        f"{h['bucket']}:{h['itemId']}" for h in tag_hits[:5])
                    raise EntityRefactorError(
                        f"文本中存在 [tag:npc:{old}] 引用（{spots} 等），且本场景是全项目"
                        f"最后一个 npc {old!r}——该 id 因多场景/跨类重名不做全局改写，"
                        "直接改名会让这些 tag 悬垂并卡住整工程保存。"
                        "请选择「跟随改写 tag」（follow_tag_refs=True）或取消。")
                tag_follow_forced = True
        scope = {
            "uniqueGlobal": unique_global,
            "dialogueIds": dialogue_ids,
            "skippedDialogues": skipped_dialogues,
            "tagFollowForced": tag_follow_forced,
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

    # 2.6) 头顶闲聊台词本里**钉死了本场景**的说话人：与 qualified 同档（零歧义），
    #      不看全局唯一性照样跟随。没钉场景的那些留给下面的 uniqueGlobal 档。
    counts["bubbleLineSpeakersQualified"] = _rewrite_bubble_line_speakers(
        model, kind, old, new, scene_id=sid, mode="qualified")

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
        # 图层 + 元素层镜像一起跟随：只改图层会让叙事编辑器「实体总览/绑定」仍按旧 id
        # 分组（它优先读 element.ownerId），2026-08-05 审查 P1-3。
        for _where, _label, obj in _iter_narrative_owner_bindings(narrative):
            if str(obj.get("ownerType") or "").strip() == kind \
                    and str(obj.get("ownerId") or "").strip() == old:
                obj["ownerId"] = new
                owner_count += 1
        if count or owner_count:
            global_hits.append({"bucket": "narrative_graphs", "itemId": "",
                                "count": count + owner_count})
            model.mark_dirty("narrative_graphs")
        counts["global"] = global_hits
        counts["bubbleLineSpeakers"] = _rewrite_bubble_line_speakers(
            model, kind, old, new, mode="bare")
    else:
        counts["global"] = []
        counts["bubbleLineSpeakers"] = 0

    # 任务引导目标：场景限定引用，与 qualified 同档（零歧义机械跟随），
    # 不看 uniqueGlobal——它已经把场景写死了，不存在"指的是哪个同名实体"的歧义。
    # 键名与 scan 报告的 `questGuidance`（按任务分组的 list）刻意区分开，见 move_entity 的注释。
    counts["questGuidanceRewritten"] = _rewrite_quest_guidance_targets(model, kind, sid, old, sid, new)

    # [tag:npc:old] 文本引用（全局解析）：全局唯一时安全跟随；非唯一但调用方确认
    # 跟随（tagFollowForced，见上）时也改写——撤销按 scope 反向回放同一作用域。
    tag_follow = kind == "npc" and (
        bool(scope.get("uniqueGlobal")) or bool(scope.get("tagFollowForced")))
    tag_count = 0
    if tag_follow:
        # 全部场景（含本场景；他场景 [tag:npc:] 亦是全局解析面）
        for other_sid, other_scene in (getattr(model, "scenes", None) or {}).items():
            if other_scene is scene:
                continue
            hit = _rewrite_tag_refs(other_scene, old, new)
            if hit:
                tag_count += hit
                model.mark_dirty("scene", str(other_sid))
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
        narrative_root = getattr(model, "narrative_graphs", None) or {}
        hit = _rewrite_tag_refs(narrative_root, old, new)
        if hit:
            tag_count += hit
            model.mark_dirty("narrative_graphs")
    counts["tags"] = tag_count

    # 4) 对话图：作用域内的裸/speaker 引用；tag 跟随时全部图的 [tag:npc:] 一并改写
    #    （tag 是全局解析面，只改 dialogueIds 内的会留悬垂卡保存门）。
    dialogue_hits: list[dict[str, Any]] = []
    scoped_ids = list(scope["dialogueIds"])
    scoped_set = set(scoped_ids)
    gid_order = list(scoped_ids)
    if tag_follow:
        gid_order += [g for g in _sig._dialogue_graph_ids(model) if g not in scoped_set]
    for gid in gid_order:
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is None:
            continue
        working = copy.deepcopy(doc)
        count = 0
        if gid in scoped_set:
            count += _rewrite_bare_in_tree(working, sid, kind, old, new, include_soft=True)
            if kind == "npc":
                count += _rewrite_speaker_refs(working, old, new)
        if tag_follow:
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
        if isinstance(speaker, dict) and str(speaker.get("kind") or "") in _SPEAKER_NPCID_KINDS \
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
# 复制（duplicate）：同场景克隆 def + 全新 id，不触碰引用网
# --------------------------------------------------------------------------- #

def _offset_num(value: Any, delta: float) -> Any:
    """世界坐标平移并保留数值形态：整数结果写回 int（往返不引入 .0 噪声）。"""
    try:
        out = round(float(value) + delta, 1)
    except (TypeError, ValueError):
        return value
    return int(out) if float(out).is_integer() else out


def _offset_points(points: Any, dx: float, dy: float) -> None:
    """就地平移点列表：兼容 {"x","y"} dict 点与 [x, y] 数组点两种历史形状。"""
    if not isinstance(points, list):
        return
    for pt in points:
        if isinstance(pt, dict):
            if "x" in pt:
                pt["x"] = _offset_num(pt.get("x"), dx)
            if "y" in pt:
                pt["y"] = _offset_num(pt.get("y"), dy)
        elif isinstance(pt, list) and len(pt) >= 2:
            pt[0] = _offset_num(pt[0], dx)
            pt[1] = _offset_num(pt[1], dy)


def _probe_copy_id(scene: dict[str, Any], kind: str, base: str) -> str:
    """`原id_copy` 起步探测取号（撞了再 _copy_2/_copy_3…）；npc/hotspot 互为
    emote 目标命名空间，取号一起查（与 move/rename 的撞名互拒口径一致）。"""
    def taken(cand: str) -> bool:
        if kind == SPAWN_KIND:
            return _find_spawn(scene, cand) is not None
        return any(_find_entity(scene, other, cand) is not None
                   for other in _COLLISION_KINDS[kind])
    cand = f"{base}_copy"
    n = 2
    while taken(cand):
        cand = f"{base}_copy_{n}"
        n += 1
    return cand


def duplicate_entity(
    model: Any, scene_id: str, kind: str, entity_id: str,
    *, new_id: str | None = None, offset: tuple[float, float] = (40.0, 40.0),
) -> dict[str, Any]:
    """同场景复制实体 def（deepcopy + 全新 id + 几何整体平移 offset）。

    不触碰引用网：入站引用天然只指原实体；def 自带的出站引用在同场景全部保持有效。
    唯一剥离项是过场绑定（cutsceneIds / cutsceneOnly）——过场 present 步按 id 只驱动
    原实体，副本挂着绑定既无人驱动、cutsceneOnly 副本还会被常隐藏；剥离项记入
    summary["strippedCutsceneIds"] 交 UI 提示。溯源复合串（emitNarrativeSignal 的
    sourceId "场景:实体"）跟随新 id 改写（trace-only 零歧义）。撤销 = 按新 id 删副本。
    """
    sid = str(scene_id or "").strip()
    eid = str(entity_id or "").strip()
    scenes = getattr(model, "scenes", None) or {}
    scene = scenes.get(sid)
    if not isinstance(scene, dict):
        raise EntityRefactorError(f"场景 {sid!r} 不存在")
    dx, dy = float(offset[0]), float(offset[1])
    if kind == SPAWN_KIND:
        return _duplicate_spawn(model, sid, eid, new_id=new_id, dx=dx, dy=dy)
    found = _find_entity(scene, kind, eid)
    if found is None:
        raise EntityRefactorError(f"场景 {sid!r} 里没有 {kind} {eid!r}")
    if new_id is not None:
        new = str(new_id or "").strip()
        if not new or new == eid:
            raise EntityRefactorError("副本 id 为空或与原 id 相同")
        for other_kind in _COLLISION_KINDS[kind]:
            if _find_entity(scene, other_kind, new) is not None:
                raise EntityRefactorError(f"场景 {sid!r} 已有 id {new!r}（{other_kind}）")
    else:
        new = _probe_copy_id(scene, kind, eid)

    idx, row = found
    dup = copy.deepcopy(row)
    dup["id"] = new
    stripped = [str(c) for c in (dup.pop("cutsceneIds", None) or []) if str(c).strip()]
    dup.pop("cutsceneOnly", None)
    # 几何整体平移：x/y、zone polygon、世界系碰撞多边形、巡逻路点同幅跟随；
    # collisionPolygonLocal 是局部系（随 x/y 走），不动。
    if "x" in dup:
        dup["x"] = _offset_num(dup.get("x"), dx)
    if "y" in dup:
        dup["y"] = _offset_num(dup.get("y"), dy)
    _offset_points(dup.get("polygon"), dx, dy)
    _offset_points(dup.get("collisionPolygon"), dx, dy)
    patrol = dup.get("patrol")
    if isinstance(patrol, dict):
        _offset_points(patrol.get("route"), dx, dy)
    _rewrite_source_id_strings(dup, f"{sid}:{eid}", f"{sid}:{new}")
    # 紧挨原实体之后插入：保持作者期上下文局部性，JSON diff 最小
    scene[_entity_list_key(kind)].insert(idx + 1, dup)
    model.mark_dirty("scene", sid)
    return {
        "op": "duplicateEntity", "sceneId": sid, "kind": kind,
        "entityId": eid, "newId": new, "index": idx + 1,
        "strippedCutsceneIds": stripped,
    }


def _duplicate_spawn(
    model: Any, sid: str, key: str, *, new_id: str | None, dx: float, dy: float,
) -> dict[str, Any]:
    if key == "default":
        raise EntityRefactorError("默认出生点不参与复制（顶层 spawnPoint，非命名出生点）")
    scene = model.scenes[sid]
    found = _find_spawn(scene, key)
    if found is None:
        raise EntityRefactorError(f"场景 {sid!r} 没有出生点 {key!r}")
    if new_id is not None:
        new = str(new_id or "").strip()
        if not new or new == key or new == "default" \
                or _find_spawn(scene, new) is not None:
            raise EntityRefactorError(f"副本出生点键 {new!r} 为空 / 重复 / 非法")
    else:
        new = _probe_copy_id(scene, SPAWN_KIND, key)
    idx, value = found
    dup = copy.deepcopy(value)
    if isinstance(dup, dict):
        if "x" in dup:
            dup["x"] = _offset_num(dup.get("x"), dx)
        if "y" in dup:
            dup["y"] = _offset_num(dup.get("y"), dy)
    _dict_insert_at(scene["spawnPoints"], new, dup, idx + 1)
    model.mark_dirty("scene", sid)
    return {
        "op": "duplicateEntity", "sceneId": sid, "kind": SPAWN_KIND,
        "entityId": key, "newId": new, "index": idx + 1,
        "strippedCutsceneIds": [],
    }


# --------------------------------------------------------------------------- #
# 换种类（convert）：纯展示热点 → NPC，id 不变
# --------------------------------------------------------------------------- #

# 只对热点成立的动作：转成 NPC 后这些引用必然失效（NPC 没有 displayImage 通道）。
_HOTSPOT_ONLY_ACTION_PARAMS: dict[str, str] = {
    "setHotspotDisplayImage": "hotspotId",
    "tempSetHotspotDisplayFacing": "hotspotId",
    "persistHotspotEnabled": "hotspotId",
}

# 热点转 NPC 时逐字搬走的字段（两个 def 上同名同义）。
_HOTSPOT_TO_NPC_CARRY = (
    "planes", "cutsceneIds", "cutsceneOnly", "conditions", "conditionHidesEntity",
    "collisionPolygon", "collisionPolygonLocal", "castShadow", "rotation",
    "occlusionBlendFactor", "perspectiveScaleEnabled", "group",
    # 对话朝向两边同名同语义（DialogueFacing 四档），显式值原样搬；
    # **缺省不同**（热点 keep / NPC player），没写这个键的热点由下面显式补 keep 保住现状
    "dialogueFacing",
)

# 转换后不再有对应语义、必须丢弃的热点字段（逐项进报告，不静默吞）。
_HOTSPOT_TO_NPC_DROP = ("type", "data", "label", "autoTrigger", "displayImage")


def _classify_hotspot_payload(hotspot: dict[str, Any]) -> tuple[str, dict[str, str]]:
    """判定热点的交互载荷能不能无损搬到 NPC 上。

    口径镜像 ``src/utils/hotspotInteraction.ts#hotspotOffersPlayerInteraction``：
      - ``display``  inspect 且 data 为空 → 纯展示，转过去就是装饰 NPC；
      - ``graph``    inspect 且 **只有** graphId → NPC 的交互出口正是图对话，
                     graphId/entry 平移成 dialogueGraphId/dialogueGraphEntry，零损失；
      - ``blocked``  其它一切（正文浮层、inline actions、pickup/transition/encounter…）
                     → NPC 没有对应通道，转过去会**静默丢功能**，拒绝。
    """
    htype = str(hotspot.get("type") or "").strip()
    data = hotspot.get("data")
    data = data if isinstance(data, dict) else {}
    if htype != "inspect":
        return "blocked", {}
    text = str(data.get("text") or "").strip()
    graph = str(data.get("graphId") or "").strip()
    actions = data.get("actions")
    has_actions = isinstance(actions, list) and bool(actions)
    if text or has_actions:
        return "blocked", {}
    if graph:
        out = {"graphId": graph}
        entry = str(data.get("entry") or "").strip()
        if entry:
            out["entry"] = entry
        return "graph", out
    return "display", {}


def _hotspot_only_action_hits(model: Any, entity_id: str) -> list[dict[str, str]]:
    """全工程扫「转 NPC 后会死」的热点专用动作引用（走访面与 scan_entity_usages 同口径）。"""
    hits: list[dict[str, str]] = []

    def scan(bucket: str, item_id: str, node: Any) -> None:
        def visit(atype: str, params: dict[str, Any]) -> None:
            param = _HOTSPOT_ONLY_ACTION_PARAMS.get(atype)
            if param and str(params.get(param) or "").strip() == entity_id:
                hits.append({"bucket": bucket, "itemId": item_id, "action": atype})

        _walk_ref_actions(node, visit)

    for sid, scene in (getattr(model, "scenes", None) or {}).items():
        if isinstance(scene, dict):
            scan("scene", str(sid), scene)
    for attr, (bucket, _per_item) in _sig.CONDITION_SOURCES.items():
        if attr == "scenes":
            continue
        root = getattr(model, attr, None)
        if root is None:
            continue
        for item_id, node in _sig._iter_collection(root):
            scan(bucket, str(item_id), node)
    scan("narrative_graphs", "", getattr(model, "narrative_graphs", None) or {})
    for gid in _sig._dialogue_graph_ids(model):
        doc = _sig._load_dialogue_doc(model, gid)
        if doc is not None:
            scan("dialogueGraph", str(gid), doc)
    return hits


def _anim_bundle_world_aspect(model: Any, bundle_id: str) -> float | None:
    """动画包的世界宽高比（格像素比即世界比——静态包只写 worldHeight，宽由运行时推）。"""
    anim = (getattr(model, "animations", None) or {}).get(bundle_id)
    if not isinstance(anim, dict):
        return None
    try:
        cw = float(anim.get("cellWidth") or 0)
        ch = float(anim.get("cellHeight") or 0)
    except (TypeError, ValueError):
        return None
    if cw > 0 and ch > 0:
        return cw / ch
    return None


def _static_bundle_source_geometry(model: Any, bundle_id: str) -> dict[str, Any] | None:
    """读单帧静态包的 ``atlas.meta.json``，取源画布尺寸与内容框。

    只有静态包（``packMode == static_single_frame``）才有这两个数，它们是把
    「热点把整幅矩形拉伸到 worldWidth×worldHeight」换算成「NPC 按内容紧裁」的唯一依据。
    取不到就返回 None，调用方回落成按整幅矩形估算并告警——**不许悄悄按矩形算当成精确值**。
    """
    root = getattr(model, "animation_bundles_path", None)
    if root is None:
        return None
    try:
        meta_path = Path(root) / bundle_id / "atlas.meta.json"
        if not meta_path.is_file():
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return None
    if not isinstance(meta, dict) or meta.get("packMode") != "static_single_frame":
        return None
    canvas = meta.get("sourceCanvas")
    box = meta.get("sourceContentBox")
    if not isinstance(canvas, dict) or not isinstance(box, dict):
        return None
    try:
        out = {
            "width": float(canvas["width"]), "height": float(canvas["height"]),
            "x0": float(box["x0"]), "y0": float(box["y0"]),
            "x1": float(box["x1"]), "y1": float(box["y1"]),
        }
    except (KeyError, TypeError, ValueError):
        return None
    if out["width"] <= 0 or out["height"] <= 0 or out["x1"] <= out["x0"] or out["y1"] <= out["y0"]:
        return None
    return out


def _anim_bundle_world_height(model: Any, bundle_id: str) -> float | None:
    anim = (getattr(model, "animations", None) or {}).get(bundle_id)
    if not isinstance(anim, dict):
        return None
    try:
        h = float(anim.get("worldHeight") or 0)
    except (TypeError, ValueError):
        return None
    return h if h > 0 else None


def convert_hotspot_to_npc(
    model: Any, scene_id: str, hotspot_id: str, *,
    anim_file: str,
    name: str | None = None,
    interaction_range: float = 0.0,
    render_raw: bool | None = None,
    force: bool = False,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """把一个**纯展示**热点原地换成 NPC（id / 坐标 / 位面 / 条件 / 过场绑定全部保留）。

    为什么 id 必须不变：实体引用有裸 id 一路（``actor`` 只认 npc、``emote_subject``
    认 npc+hotspot），id 不变时——
      - 原来能命中的 ``emote_subject`` 引用继续命中（种类范围本来就含 npc）；
      - 原来命不中的 ``actor`` 引用反而开始命中（范围放宽，不会变坏）；
      - 场景限定引用（``setEntityField`` 的 sceneId+entityId）寻址不变。
    所以这个 op **不改写任何引用**，只把两处必然失效的东西拦在前面：
      1. 热点专用动作（``setHotspotDisplayImage`` 等）——NPC 没有 displayImage 通道；
      2. 带交互载荷的热点——NPC 的交互出口只有图对话，转过去会静默丢功能。

    尺寸换算：热点展示图是"把图拉伸到 worldWidth×worldHeight"（可非等比），NPC 是
    "按动画包 worldHeight 等比缩放，再乘实例 scale"。故 scale = 热点世界高 ÷ 包世界高，
    并把两者的宽高比差额报进 ``summary["warnings"]`` 交人目验——**这道差额程序不替人拍板**。

    返回 (summary, reverse_ops)；与其它 op 一样只改内存 + mark_dirty，零磁盘写。
    """
    sid = str(scene_id or "").strip()
    eid = str(hotspot_id or "").strip()
    scenes = getattr(model, "scenes", None) or {}
    scene = scenes.get(sid)
    if not isinstance(scene, dict):
        raise EntityRefactorError(f"场景 {sid!r} 不存在")
    found = _find_entity(scene, "hotspot", eid)
    if found is None:
        raise EntityRefactorError(f"场景 {sid!r} 里没有 hotspot {eid!r}")
    if _find_entity(scene, "npc", eid) is not None:
        raise EntityRefactorError(f"场景 {sid!r} 已有同 id 的 NPC {eid!r}（数据本就冲突，先处理重名）")

    idx, row = found
    display = row.get("displayImage")
    if not isinstance(display, dict) or not str(display.get("image") or "").strip():
        raise EntityRefactorError(
            f"hotspot {eid!r} 没有展示图；没有可视形体的热点转成 NPC 只会得到一个占位圆点")
    payload_kind, payload = _classify_hotspot_payload(row)
    if payload_kind == "blocked":
        raise EntityRefactorError(
            f"hotspot {eid!r} 带 NPC 接不住的交互载荷（type={row.get('type')!r}）；"
            "NPC 的交互出口只有图对话，转换会静默丢掉这份交互。"
            "请先把正文/inline actions 搬进一张图对话，或保留热点。")

    manifest = str(anim_file or "").strip()
    bundle = _anim_bundle_id_from_animfile(manifest)
    if not bundle:
        raise EntityRefactorError(f"animFile {anim_file!r} 不是合法动画包清单路径")
    animations = getattr(model, "animations", None) or {}
    if bundle not in animations:
        raise EntityRefactorError(
            f"动画包 {bundle!r} 不存在（public/resources/runtime/animation/{bundle}/anim.json）")

    dead_hits = _hotspot_only_action_hits(model, eid)
    if dead_hits and not force:
        spots = ", ".join(f"{h['bucket']}:{h['itemId']}({h['action']})" for h in dead_hits[:5])
        raise EntityRefactorError(
            f"仍有 {len(dead_hits)} 处热点专用动作指向 {eid!r}（{spots} 等），转成 NPC 后必然失效。"
            "先改掉这些动作，或走强制转换（force）并自行清理。")

    warnings: list[str] = []
    # ---- 尺寸/形变换算 -------------------------------------------------------
    def _num(value: Any, fallback: float) -> float:
        try:
            out = float(value)
        except (TypeError, ValueError):
            return fallback
        return out if math.isfinite(out) else fallback

    hs_scale = _num(row.get("scale"), 1.0)
    hs_w = _num(display.get("worldWidth"), 0.0)
    hs_h = _num(display.get("worldHeight"), 0.0)
    bundle_h = _anim_bundle_world_height(model, bundle)
    geometry = _static_bundle_source_geometry(model, bundle)
    faces_left = str(display.get("facing") or "").strip().lower() == "left"

    # 两套摆位口径不同，必须补偿：
    #   热点 = 把**整幅图**（含透明留白）拉伸到 worldWidth×worldHeight，锚点是这个矩形的底中；
    #   NPC  = 图已紧裁成格，锚点是**内容**的底中。
    # 源图底部若有 N% 透明留白，直接换过去角色会整体下沉 N%×worldHeight（实测码头人群
    # 留白 17% → 沉 68 个世界单位）。有 sourceCanvas/sourceContentBox 就精确补，没有就
    # 按整幅矩形估并告警——不许把估算当精确值。
    shown_height = hs_h * hs_scale
    shown_width = hs_w * hs_scale
    dx = dy = 0.0
    if geometry and hs_h > 0:
        img_w, img_h = geometry["width"], geometry["height"]
        x0, y0, x1, y1 = geometry["x0"], geometry["y0"], geometry["x1"], geometry["y1"]
        shown_height = (y1 - y0) / img_h * hs_h * hs_scale
        shown_width = (x1 - x0) / img_w * hs_w * hs_scale
        dy = -((img_h - y1) / img_h) * hs_h * hs_scale
        dx = (((x0 + x1) / 2 - img_w / 2) / img_w) * hs_w * hs_scale
        if faces_left:
            # 镜像是绕矩形中线做的，内容偏移随之反号
            dx = -dx
    elif hs_h > 0:
        warnings.append(
            f"动画包 {bundle} 不是单帧静态包（或缺 sourceCanvas/sourceContentBox），"
            "位置与大小按整幅矩形估算；源图若有透明留白，请在画布上重新对位")

    npc_scale: float | None = None
    if shown_height > 0 and bundle_h:
        npc_scale = round(shown_height / bundle_h, 4)
    elif shown_height > 0:
        warnings.append(
            f"动画包 {bundle} 的 anim.json 没有可用 worldHeight，无法换算实例 scale；请手工核对大小")

    bundle_aspect = _anim_bundle_world_aspect(model, bundle)
    if shown_width > 0 and shown_height > 0 and bundle_aspect:
        shown_aspect = shown_width / shown_height
        if abs(shown_aspect - bundle_aspect) / bundle_aspect > 0.02:
            warnings.append(
                f"热点展示图当前被拉成宽高比 {shown_aspect:.3f}，动画包是 {bundle_aspect:.3f}（等比）；"
                "转换后形体会回到等比，请在场景里目验")

    # ---- 组装 NPC def --------------------------------------------------------
    npc: dict[str, Any] = {"id": eid}
    npc_name = str(name if name is not None else (row.get("name") or "")).strip() or eid
    npc["name"] = npc_name
    npc["x"] = _offset_num(row.get("x"), dx) if dx else row.get("x")
    npc["y"] = _offset_num(row.get("y"), dy) if dy else row.get("y")
    npc["animFile"] = manifest
    if payload_kind == "graph":
        # inspect 图对话 → NPC 图对话：同一张图、同一个入口，只是触发方从热点变成 NPC。
        npc["dialogueGraphId"] = payload["graphId"]
        if payload.get("entry"):
            npc["dialogueGraphEntry"] = payload["entry"]
        if interaction_range <= 0:
            # 还能对话却把半径设成 0 = 玩家永远够不着，等于删了这段交互
            interaction_range = _num(row.get("interactionRange"), 50.0) or 50.0
    npc["interactionRange"] = (
        int(interaction_range) if float(interaction_range).is_integer() else float(interaction_range)
    )
    facing = str(display.get("facing") or "").strip().lower()
    if facing == "left":
        npc["initialFacing"] = "left"
    sort_band = str(display.get("spriteSort") or "").strip().lower()
    if sort_band in ("back", "front"):
        npc["spriteSort"] = sort_band
    if render_raw is not None:
        npc["renderRaw"] = bool(render_raw)
    if npc_scale is not None and npc_scale != 1.0:
        npc["scale"] = npc_scale
    for key in _HOTSPOT_TO_NPC_CARRY:
        if key in row:
            npc[key] = copy.deepcopy(row[key])
    # 对话朝向的**缺省值两边也相反**（热点缺省 keep 不转身、NPC 缺省 player 转向玩家）：
    # 同上，迁移只保持现状。只有真会进对话的（graph 载荷）才补这一条，纯展示的不啰嗦。
    if payload_kind == "graph" and "dialogueFacing" not in row:
        npc["dialogueFacing"] = "keep"
        warnings.append(
            "已显式写入 dialogueFacing=keep 保持热点原行为（NPC 缺省是进对话时转向玩家）；"
            "这是个会搭话的角色的话，可以改成 player")
    # 透视缩放的**缺省值两边相反**（热点缺省不参与、NPC 缺省参与），不显式写死就会
    # 在转换那一刻悄悄开始跟着深度缩放。迁移的职责是保持现状，要开由人后面自己开。
    if "perspectiveScaleEnabled" not in row:
        npc["perspectiveScaleEnabled"] = False
        warnings.append(
            "已显式写入 perspectiveScaleEnabled=false 保持热点原行为（NPC 缺省是参与透视缩放）；"
            "这是个站在街上的角色的话，可以改成 true")
    dropped = [key for key in _HOTSPOT_TO_NPC_DROP
               if key in row and not (key == "data" and payload_kind == "graph")]
    unknown = [
        key for key in row
        if key not in _HOTSPOT_TO_NPC_CARRY
        and key not in _HOTSPOT_TO_NPC_DROP
        and key not in ("id", "name", "x", "y", "scale", "interactionRange")
    ]
    if unknown:
        warnings.append(
            "以下热点字段没有 NPC 对应语义、已丢弃：" + "、".join(sorted(unknown)))

    # ---- 落数据 --------------------------------------------------------------
    hotspots = scene.setdefault("hotspots", [])
    hotspots.pop(idx)
    npcs = scene.setdefault("npcs", [])
    npc_index = len(npcs)
    npcs.append(npc)
    model.mark_dirty("scene", sid)

    summary = {
        "op": "convertHotspotToNpc",
        "sceneId": sid,
        "entityId": eid,
        "animFile": manifest,
        "bundleId": bundle,
        "npcIndex": npc_index,
        "hotspotIndex": idx,
        "payloadKind": payload_kind,
        "scale": npc_scale,
        "positionDelta": {"dx": round(dx, 2), "dy": round(dy, 2)},
        "droppedFields": dropped,
        "deadHotspotActionRefs": dead_hits,
        "warnings": warnings,
    }
    reverse_ops = [
        {"kind": "npcRemove", "sceneId": sid, "entityId": eid},
        {"kind": "entityInsert", "sceneId": sid, "entityKind": "hotspot",
         "index": idx, "row": copy.deepcopy(row)},
    ]
    return summary, reverse_ops


def _anim_bundle_id_from_animfile(ref: str) -> str:
    """``/resources/runtime/animation/<id>/anim.json`` → ``<id>``；裸 id 原样返回。"""
    text = str(ref or "").strip()
    if not text:
        return ""
    match = re.search(r"/animation/([^/]+)/", text.replace("\\", "/"))
    if match:
        return match.group(1)
    return text if "/" not in text else ""


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


def _apply_reverse_op(model: Any, scene: dict[str, Any], rec: dict[str, Any]) -> None:
    """执行一条 reverse op（delete / convert 共用；未知 kind 静默跳过，与旧行为一致）。"""
    kind = rec.get("kind")
    if kind == "entityInsert":
        rows = scene.setdefault(_entity_list_key(rec["entityKind"]), [])
        rows.insert(min(int(rec["index"]), len(rows)), copy.deepcopy(rec["row"]))
    elif kind == "spawnInsert":
        _dict_insert_at(scene.setdefault("spawnPoints", {}),
                        rec["key"], copy.deepcopy(rec["value"]), int(rec["index"]))
    elif kind == "npcRemove":
        found = _find_entity(scene, "npc", str(rec["entityId"]))
        if found is None:
            raise EntityRefactorError(
                f"场景 {rec.get('sceneId')!r} 里已找不到 NPC {rec['entityId']!r}，无法撤销")
        scene["npcs"].pop(found[0])


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
            desc = f"已撤销改名：{entry['newId']} 改回 {entry['oldId']}"
        elif op == "deleteEntity":
            for rec in reversed(entry.get("reverseOps") or []):
                scene = model.scenes.get(rec.get("sceneId"))
                if not isinstance(scene, dict):
                    raise EntityRefactorError(f"场景 {rec.get('sceneId')!r} 不存在")
                _apply_reverse_op(model, scene, rec)
                model.mark_dirty("scene", rec["sceneId"])
            desc = f"已撤销删除 {entry['entityId']}"
        elif op == "convertHotspotToNpc":
            for rec in reversed(entry.get("reverseOps") or []):
                scene = model.scenes.get(rec.get("sceneId"))
                if not isinstance(scene, dict):
                    raise EntityRefactorError(f"场景 {rec.get('sceneId')!r} 不存在")
                _apply_reverse_op(model, scene, rec)
                model.mark_dirty("scene", rec["sceneId"])
            desc = f"已撤销「热点转 NPC」：{entry['entityId']} 变回热点"
        elif op == "duplicateEntity":
            scene = model.scenes.get(entry["sceneId"])
            if not isinstance(scene, dict):
                raise EntityRefactorError(f"场景 {entry['sceneId']!r} 不存在")
            new = entry["newId"]
            if entry["kind"] == SPAWN_KIND:
                if _find_spawn(scene, new) is None:
                    raise EntityRefactorError(
                        f"场景 {entry['sceneId']!r} 里已找不到出生点副本 {new!r}")
                scene["spawnPoints"].pop(new)
            else:
                found = _find_entity(scene, entry["kind"], new)
                if found is None:
                    raise EntityRefactorError(
                        f"场景 {entry['sceneId']!r} 里已找不到副本 {entry['kind']} {new!r}")
                scene[_entity_list_key(entry["kind"])].pop(found[0])
            model.mark_dirty("scene", entry["sceneId"])
            desc = f"已撤销复制：删除副本 {new}"
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
        # 撤销目标撞名检查（与正向 move 的闸对称）：src 场景可能在迁移后又新建了同名出生点
        if _find_spawn(src_scene, eid) is not None:
            raise EntityRefactorError(
                f"撤销目标场景 {src!r} 已有出生点 {eid!r}；请先处理重名再撤销")
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
    # 撤销目标撞名检查（与正向 move 的闸对称）：src 场景可能在迁移后又建了同 id 实体
    for other_kind in _COLLISION_KINDS[kind]:
        if _find_entity(src_scene, other_kind, eid) is not None:
            raise EntityRefactorError(
                f"撤销目标场景 {src!r} 已有同 id 实体（{other_kind} {eid!r}）；请先处理重名再撤销")
    idx, row = found
    dst_scene[_entity_list_key(kind)].pop(idx)
    rows = src_scene.setdefault(_entity_list_key(kind), [])
    rows.insert(min(int(entry.get("srcIndex", len(rows))), len(rows)), row)
    _rewrite_source_id_strings(row, f"{dst}:{eid}", f"{src}:{eid}")
    model.mark_dirty("scene", src)
    model.mark_dirty("scene", dst)
    _rewrite_qualified_scene_refs(model, kind, eid, dst, src)
    _rewrite_quest_guidance_targets(model, kind, dst, eid, src, eid)
