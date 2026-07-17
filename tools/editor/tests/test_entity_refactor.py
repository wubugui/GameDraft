"""实体重构引擎（shared/entity_refactor.py）契约测试。

覆盖：引用清单 parity（防新增 action 漏登记）、可达场景分析（触发面 + 链式传播 +
GLOBAL 吸收）、扫描分组、迁移（def 搬运 + sceneId 限定引用改写 + 撞名闸 + 撤销
复原）、改名（歧义分级作用域 + [tag:npc] 跟随 + 撤销按记录作用域回放）、安全删除
（force 门 + tag 最后实例硬拒 + 不级联 + 按位重插撤销）。全程零磁盘写入。
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from tools.editor.shared.entity_refactor import (
    ENTITY_REF_PARAMS,
    GLOBAL_REACH,
    EntityRefactorError,
    delete_entity,
    dialogue_graph_scene_reach,
    duplicate_entity,
    move_entity,
    push_journal,
    rename_entity,
    scan_entity_usages,
    undo_last,
)


# --------------------------------------------------------------------------- #
# parity：单一登记面不许漂移
# --------------------------------------------------------------------------- #

# 这些参数名一旦出现在 action 的参数表里，就意味着它是实体/场景/出生点引用，
# 必须在 ENTITY_REF_PARAMS 登记（新 action 漏登记 → 重构/校验双双看不见它）。
_REF_PARAM_NAMES = frozenset({
    "target", "npcId", "faceTarget", "targetScene", "targetSpawnPoint",
    "entityId", "hotspotId", "ownerId", "zoneId", "scriptedNpcId",
})

# 参数名撞车但语义不是场景实体引用的豁免（临时演员 id / 定义自身）
_EXEMPT: frozenset[tuple[str, str]] = frozenset()


def test_manifest_keys_are_registered_action_types() -> None:
    from tools.editor.shared.action_editor import ACTION_TYPES
    unknown = set(ENTITY_REF_PARAMS) - set(ACTION_TYPES)
    assert not unknown, f"ENTITY_REF_PARAMS 登记了不存在的 action：{sorted(unknown)}"


def test_param_schemas_ref_params_all_registered() -> None:
    from tools.editor.shared.action_editor import _PARAM_SCHEMAS
    missing: list[str] = []
    for act_type, schema in _PARAM_SCHEMAS.items():
        for param, _widget in schema:
            if param not in _REF_PARAM_NAMES or (act_type, param) in _EXEMPT:
                continue
            if param not in ENTITY_REF_PARAMS.get(act_type, {}):
                missing.append(f"{act_type}.{param}")
    assert not missing, (
        f"以下引用型参数未在 ENTITY_REF_PARAMS 登记：{missing}；"
        "新增含实体/场景引用的 action 必须同步登记（迁移重构与校验共同消费这张表）"
    )


def test_custom_branch_actions_pinned() -> None:
    """不走 _PARAM_SCHEMAS 的自定义分支 action，手工钉死在登记面里。"""
    for act, params in {
        "setEntityField": ("entityId", "sceneId"),
        "setSceneEntityPosition": ("entityId", "sceneId"),
        "setHotspotDisplayImage": ("hotspotId", "sceneId"),
        "tempSetHotspotDisplayFacing": ("hotspotId", "sceneId"),
        "persistHotspotEnabled": ("hotspotId", "sceneId"),
        "startDialogueGraph": ("npcId", "ownerId"),
        "playScriptedDialogue": ("scriptedNpcId",),
        "setZoneEnabled": ("zoneId", "sceneId"),
        "persistZoneEnabled": ("zoneId", "sceneId"),
    }.items():
        for param in params:
            assert param in ENTITY_REF_PARAMS.get(act, {}), f"{act}.{param} 未登记"


# --------------------------------------------------------------------------- #
# fixture
# --------------------------------------------------------------------------- #

def _act(act_type: str, **params) -> dict:
    return {"type": act_type, "params": params}


class FakeModel:
    """引擎消费面的最小模型：两场景 + 叙事图 + 过场 + 对话图磁盘面 + 暂存面。"""

    def __init__(self, dialogues_path: Path | None = None) -> None:
        self.scenes = {
            "甲村": {
                "npcs": [
                    {"id": "npc_张三", "name": "张三", "x": 100, "y": 200,
                     "dialogueGraphId": "对话_张三",
                     "patrol": {"route": [{"x": 1, "y": 2}]}},
                    {"id": "npc_重名", "name": "甲村重名", "x": 0, "y": 0},
                ],
                "hotspots": [
                    {"id": "hs_摊位", "type": "npc", "x": 5, "y": 6,
                     "data": {"npcId": "npc_张三"}},
                ],
                "zones": [
                    {"id": "z_门口", "onEnter": [
                        _act("showSpeechBubble", target="npc_张三", text="喂"),
                        _act("startDialogueGraph", graphId="对话_门口"),
                        _act("emitNarrativeSignal", signal="sig_entered",
                             sourceType="zone", sourceId="甲村:z_门口"),
                    ], "polygon": [[0, 0], [1, 0], [1, 1]]},
                ],
                "spawnPoints": {"entry": {"x": 10, "y": 20}, "back": {"x": 30, "y": 40}},
            },
            "乙镇": {
                "npcs": [{"id": "npc_重名", "name": "乙镇重名", "x": 0, "y": 0}],
                "hotspots": [
                    {"id": "T_去甲村", "type": "transition", "x": 1, "y": 1,
                     "data": {"targetScene": "甲村", "targetSpawnPoint": "entry"}},
                ],
                "zones": [],
                "spawnPoints": {},
            },
        }
        self.cutscenes = [
            {"id": "cut_1", "steps": [
                {"kind": "action", **_act("setSceneEntityPosition",
                                          sceneId="甲村", entityKind="npc",
                                          entityId="npc_张三", x=1, y=2)},
                {"kind": "action", **_act("moveEntityTo", target="npc_张三",
                                          sceneId="甲村", x=3, y=4)},
            ]},
        ]
        self.quests = [
            {"id": "q1", "onComplete": [
                _act("persistHotspotEnabled", sceneId="甲村", hotspotId="hs_摊位",
                     enabled=False),
                _act("setZoneEnabled", sceneId="甲村", zoneId="z_门口", enabled=False),
                _act("switchScene", targetScene="甲村", targetSpawnPoint="entry"),
            ], "title": "找[tag:npc:npc_张三]问话"},
        ]
        self.narrative_graphs = {
            "schemaVersion": 3,
            "compositions": [{
                "id": "comp1",
                "mainGraph": {"id": "flow_main", "initialState": "s0",
                              "states": {"s0": {"id": "s0"}}, "transitions": []},
                "elements": [{
                    "id": "w1", "kind": "wrapperGraph",
                    "graph": {"id": "wrap_张三", "ownerType": "npc", "ownerId": "npc_张三",
                              "initialState": "u",
                              "states": {"u": {"id": "u", "onEnterActions": [
                                  _act("persistNpcAnimState", target="npc_张三", state="sit"),
                              ]}},
                              "transitions": []},
                }],
            }],
        }
        self.pending_dialogue_stubs: dict[str, dict] = {}
        self.pending_dialogue_graph_edits: dict[str, dict] = {}
        self.dialogues_path = dialogues_path
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, bucket: str, item: str = "") -> None:
        self.dirty.append((bucket, item))


def _write_graph(graphs_dir: Path, gid: str, doc: dict) -> None:
    (graphs_dir / f"{gid}.json").write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@pytest.fixture()
def model(tmp_path: Path) -> FakeModel:
    graphs_dir = tmp_path / "graphs"
    graphs_dir.mkdir()
    _write_graph(graphs_dir, "对话_张三", {
        "id": "对话_张三", "entry": "n1",
        "nodes": {"n1": {
            "id": "n1",
            # 真实数据形状：显式带 npcId 的说话人 kind 为 "sceneNpc"（types.ts
            # DialogueGraphSpeaker）；kind:"npc" 变体根本不带 npcId（跟随说话 NPC）。
            "speaker": {"kind": "sceneNpc", "npcId": "npc_张三"},
            "runActions": [_act("playNpcAnimation", target="npc_张三", state="wave")],
        }},
    })
    _write_graph(graphs_dir, "对话_门口", {
        "id": "对话_门口", "entry": "n1",
        "nodes": {"n1": {"id": "n1", "runActions": [
            _act("startDialogueGraph", graphId="对话_链尾"),
        ]}},
    })
    _write_graph(graphs_dir, "对话_链尾", {
        "id": "对话_链尾", "entry": "n1",
        "nodes": {"n1": {"id": "n1", "runActions": [
            _act("showEmote", target="npc_张三", emote="?"),
        ]}},
    })
    _write_graph(graphs_dir, "对话_重名", {
        "id": "对话_重名", "entry": "n1",
        "nodes": {"n1": {"id": "n1", "runActions": [
            _act("playNpcAnimation", target="npc_重名", state="idle"),
        ]}},
    })
    return FakeModel(dialogues_path=tmp_path)


# --------------------------------------------------------------------------- #
# 可达场景分析
# --------------------------------------------------------------------------- #

def test_reach_scene_triggers_and_chaining(model: FakeModel) -> None:
    reach = dialogue_graph_scene_reach(model)
    assert reach["对话_张三"] == {"甲村"}          # npc.dialogueGraphId
    assert reach["对话_门口"] == {"甲村"}          # zone 动作树 startDialogueGraph
    assert reach["对话_链尾"] == {"甲村"}          # 对话图链式传播

def test_reach_global_absorbs(model: FakeModel) -> None:
    model.quests[0]["onComplete"].append(_act("startDialogueGraph", graphId="对话_门口"))
    reach = dialogue_graph_scene_reach(model)
    assert reach["对话_门口"] == GLOBAL_REACH
    assert reach["对话_链尾"] == GLOBAL_REACH      # GLOBAL 沿链吸收


# --------------------------------------------------------------------------- #
# 扫描
# --------------------------------------------------------------------------- #

def test_scan_groups(model: FakeModel) -> None:
    rep = scan_entity_usages(model, "甲村", "npc", "npc_张三")
    assert rep["exists"] and rep["definedInScenes"] == ["甲村"]
    assert {h["id"] for h in rep["sceneLocal"]} == {"hs_摊位", "z_门口"}
    # quest 里的 persistHotspotEnabled 指向的是热点 hs_摊位,不属于本 npc 的引用
    assert rep["qualified"] == [{"bucket": "cutscene", "itemId": "cut_1", "count": 1}]
    hs_rep = scan_entity_usages(model, "甲村", "hotspot", "hs_摊位")
    assert hs_rep["qualified"] == [{"bucket": "quest", "itemId": "q1", "count": 1}]
    assert {d["graphId"] for d in rep["dialogues"]} == {"对话_张三", "对话_链尾"}
    assert rep["ownerBindings"] == [{"graphId": "wrap_张三"}]
    assert rep["tagRefs"] == [{"bucket": "quest", "itemId": "", "count": 1}]
    # 裸引用全局面：过场 moveEntityTo.target + 叙事图动作树 persistNpcAnimState
    assert {h["bucket"] for h in rep["globalRefs"]} == {"cutscene", "narrative_graphs"}


def test_scan_ambiguous_id_lists_both_scenes(model: FakeModel) -> None:
    rep = scan_entity_usages(model, "甲村", "npc", "npc_重名")
    assert rep["definedInScenes"] == ["乙镇", "甲村"]


# --------------------------------------------------------------------------- #
# 迁移
# --------------------------------------------------------------------------- #

def test_move_transfers_def_and_rewrites_qualified(model: FakeModel) -> None:
    snap = copy.deepcopy(model.scenes["甲村"]["npcs"][0])
    summary = move_entity(model, "甲村", "npc", "npc_张三", "乙镇")
    assert not any(n["id"] == "npc_张三" for n in model.scenes["甲村"]["npcs"])
    moved = [n for n in model.scenes["乙镇"]["npcs"] if n["id"] == "npc_张三"]
    assert moved and moved[0] == snap  # def 原样搬运（坐标保留待重摆）
    # sceneId 限定引用跟随改写
    assert model.cutscenes[0]["steps"][0]["params"]["sceneId"] == "乙镇"
    assert model.quests[0]["onComplete"][0]["params"]["sceneId"] == "甲村"  # hs_摊位 没搬,不动
    assert {(h["bucket"], h["itemId"]) for h in summary["qualifiedRewritten"]} \
        == {("cutscene", "cut_1")}
    # 裸引用不动、进报告
    assert {h["id"] for h in summary["danglingSceneLocal"]} == {"hs_摊位", "z_门口"}
    assert "patrol.route 途经点（源场景世界坐标）" in summary["needsReview"]


def test_move_position_override(model: FakeModel) -> None:
    move_entity(model, "甲村", "npc", "npc_张三", "乙镇", position=(7.5, 8))
    moved = next(n for n in model.scenes["乙镇"]["npcs"] if n["id"] == "npc_张三")
    assert (moved["x"], moved["y"]) == (7.5, 8)


def test_move_collision_and_missing_raise(model: FakeModel) -> None:
    with pytest.raises(EntityRefactorError, match="已有同 id"):
        move_entity(model, "甲村", "npc", "npc_重名", "乙镇")
    with pytest.raises(EntityRefactorError, match="没有"):
        move_entity(model, "乙镇", "npc", "npc_张三", "甲村")
    with pytest.raises(EntityRefactorError, match="相同"):
        move_entity(model, "甲村", "npc", "npc_张三", "甲村")
    # 撞名/失败前置于任何修改：数据无半改
    assert any(n["id"] == "npc_张三" for n in model.scenes["甲村"]["npcs"])


def test_move_undo_restores_everything(model: FakeModel) -> None:
    snap_scenes = copy.deepcopy(model.scenes)
    snap_cutscenes = copy.deepcopy(model.cutscenes)
    summary = move_entity(model, "甲村", "npc", "npc_张三", "乙镇")
    push_journal(model, summary)
    result = undo_last(model)
    assert result["ok"], result
    assert model.scenes == snap_scenes
    assert model.cutscenes == snap_cutscenes
    # 位置恢复到原 index（张三仍在重名之前）
    assert [n["id"] for n in model.scenes["甲村"]["npcs"]] == ["npc_张三", "npc_重名"]


# --------------------------------------------------------------------------- #
# 改名
# --------------------------------------------------------------------------- #

def test_rename_unique_rewrites_all_surfaces(model: FakeModel) -> None:
    summary = rename_entity(model, "甲村", "npc", "npc_张三", "npc_张三丰")
    assert summary["scope"]["uniqueGlobal"] is True
    # def / data.npcId / zone 裸引用 / 限定引用 / 叙事 owner / tag / 对话图全跟随
    assert model.scenes["甲村"]["npcs"][0]["id"] == "npc_张三丰"
    assert model.scenes["甲村"]["hotspots"][0]["data"]["npcId"] == "npc_张三丰"
    assert model.scenes["甲村"]["zones"][0]["onEnter"][0]["params"]["target"] == "npc_张三丰"
    assert model.cutscenes[0]["steps"][0]["params"]["entityId"] == "npc_张三丰"
    assert model.cutscenes[0]["steps"][1]["params"]["target"] == "npc_张三丰"
    wrap = model.narrative_graphs["compositions"][0]["elements"][0]["graph"]
    assert wrap["ownerId"] == "npc_张三丰"
    assert wrap["states"]["u"]["onEnterActions"][0]["params"]["target"] == "npc_张三丰"
    assert model.quests[0]["title"] == "找[tag:npc:npc_张三丰]问话"
    staged = model.pending_dialogue_graph_edits
    assert staged["对话_张三"]["nodes"]["n1"]["speaker"]["npcId"] == "npc_张三丰"
    assert staged["对话_链尾"]["nodes"]["n1"]["runActions"][0]["params"]["target"] == "npc_张三丰"


def test_scan_counts_scenenpc_speaker(model: FakeModel) -> None:
    """真实数据形状：speaker.kind=='sceneNpc' 的 npcId 必须被扫描计入 dialogues。"""
    rep = scan_entity_usages(model, "甲村", "npc", "npc_张三")
    d = next(d for d in rep["dialogues"] if d["graphId"] == "对话_张三")
    # playNpcAnimation.target(1) + speaker.npcId(1) = 2
    assert d["count"] == 2


def test_rename_rewrites_scenenpc_and_compat_npc_speaker(model: FakeModel, tmp_path: Path) -> None:
    """改名同时改写 sceneNpc 形状与兼容 kind:'npc'+npcId 形状的 speaker.npcId。"""
    # 追加一张用兼容形状的对话图，可达集限本场景（挂到甲村某 hotspot）
    graphs_dir = tmp_path / "graphs"
    _write_graph(graphs_dir, "对话_兼容", {
        "id": "对话_兼容", "entry": "n1",
        "nodes": {"n1": {"id": "n1",
                         "speaker": {"kind": "npc", "npcId": "npc_张三"}}},
    })
    model.scenes["甲村"]["hotspots"].append(
        {"id": "hs_看板", "type": "inspect", "x": 0, "y": 0,
         "data": {"graphId": "对话_兼容"}})
    rename_entity(model, "甲村", "npc", "npc_张三", "npc_张三丰")
    staged = model.pending_dialogue_graph_edits
    assert staged["对话_张三"]["nodes"]["n1"]["speaker"]["npcId"] == "npc_张三丰"
    assert staged["对话_兼容"]["nodes"]["n1"]["speaker"]["npcId"] == "npc_张三丰"


def test_rename_ambiguous_id_keeps_global_surfaces(model: FakeModel) -> None:
    """id 在多场景重复：只改写可证明指向本实体的引用，全局面与他场景引用不动。"""
    model.quests[0]["onComplete"].append(
        _act("playNpcAnimation", target="npc_重名", state="idle"))
    summary = rename_entity(model, "甲村", "npc", "npc_重名", "npc_甲村专名")
    assert summary["scope"]["uniqueGlobal"] is False
    assert model.scenes["甲村"]["npcs"][1]["id"] == "npc_甲村专名"
    assert model.scenes["乙镇"]["npcs"][0]["id"] == "npc_重名"  # 别家的不动
    # 全局面（任务动作树）不改写
    assert model.quests[0]["onComplete"][-1]["params"]["target"] == "npc_重名"
    # 对话_重名 可达集为空（无触发面）→ 不可证明 → 跳过并列入报告
    assert summary["scope"]["skippedDialogues"] == ["对话_重名"]
    assert "对话_重名" not in model.pending_dialogue_graph_edits


def test_rename_tag_asymmetry_hard_rejects_then_follows(model: FakeModel) -> None:
    """非全局唯一 + 本场景是最后一个 npc 实例 + 有 [tag:npc:id]：默认硬拒；
    follow_tag_refs=True 时跟随改写。与删除路径的硬拒口径对齐。"""
    # 甲村独有 npc_共名，但乙镇有同 id 的 hotspot → unique_global=False、last_instance=True
    model.scenes["甲村"]["npcs"].append({"id": "npc_共名", "x": 0, "y": 0})
    model.scenes["乙镇"]["hotspots"].append(
        {"id": "npc_共名", "type": "inspect", "x": 0, "y": 0})
    model.quests[0]["title"] = "找[tag:npc:npc_共名]问话"
    with pytest.raises(EntityRefactorError, match="tag:npc"):
        rename_entity(model, "甲村", "npc", "npc_共名", "npc_共名新")
    # 数据无半改：名字未变
    assert any(n["id"] == "npc_共名" for n in model.scenes["甲村"]["npcs"])
    # 确认跟随后：id 改、tag 一起改
    summary = rename_entity(
        model, "甲村", "npc", "npc_共名", "npc_共名新", follow_tag_refs=True)
    assert summary["scope"]["tagFollowForced"] is True
    assert model.quests[0]["title"] == "找[tag:npc:npc_共名新]问话"
    assert model.scenes["乙镇"]["hotspots"][-1]["id"] == "npc_共名"  # 他场景同 id 实体不动
    # 撤销按 scope 回放，tag 还原
    push_journal(model, summary)
    assert undo_last(model)["ok"]
    assert model.quests[0]["title"] == "找[tag:npc:npc_共名]问话"


def test_rename_collision_raises_before_mutation(model: FakeModel) -> None:
    snap = copy.deepcopy(model.scenes)
    with pytest.raises(EntityRefactorError, match="已有 id"):
        rename_entity(model, "甲村", "npc", "npc_张三", "npc_重名")
    with pytest.raises(EntityRefactorError, match="已有 id"):
        rename_entity(model, "甲村", "npc", "npc_张三", "hs_摊位")  # 跨 kind 也拒
    assert model.scenes == snap


def test_rename_undo_replays_recorded_scope(model: FakeModel) -> None:
    snap_scenes = copy.deepcopy(model.scenes)
    snap_quests = copy.deepcopy(model.quests)
    snap_narrative = copy.deepcopy(model.narrative_graphs)
    summary = rename_entity(model, "甲村", "npc", "npc_张三", "npc_张三丰")
    push_journal(model, summary)
    result = undo_last(model)
    assert result["ok"], result
    assert model.scenes == snap_scenes
    assert model.quests == snap_quests
    assert model.narrative_graphs == snap_narrative
    # 对话图暂存面：回改后语义等于磁盘原文
    staged = model.pending_dialogue_graph_edits
    assert staged["对话_张三"]["nodes"]["n1"]["speaker"]["npcId"] == "npc_张三"


# --------------------------------------------------------------------------- #
# 安全删除
# --------------------------------------------------------------------------- #

def test_delete_requires_force_when_referenced(model: FakeModel) -> None:
    # npc_张三 有 tag 引用且是最后实例 → 永远硬拒（force 也不行）
    with pytest.raises(EntityRefactorError, match="tag:npc"):
        delete_entity(model, "甲村", "npc", "npc_张三", force=True)
    # 去掉 tag 后：无 force 拒、有 force 删且不级联
    model.quests[0]["title"] = "找人问话"
    with pytest.raises(EntityRefactorError, match="force"):
        delete_entity(model, "甲村", "npc", "npc_张三")
    summary, reverse_ops = delete_entity(model, "甲村", "npc", "npc_张三", force=True)
    assert not any(n["id"] == "npc_张三" for n in model.scenes["甲村"]["npcs"])
    # 不级联：引用原样留下（悬垂交校验器）
    assert model.scenes["甲村"]["hotspots"][0]["data"]["npcId"] == "npc_张三"
    assert summary["danglingRefs"] > 0
    push_journal(model, {**summary, "reverseOps": reverse_ops})
    result = undo_last(model)
    assert result["ok"], result
    assert [n["id"] for n in model.scenes["甲村"]["npcs"]] == ["npc_张三", "npc_重名"]


def test_delete_unreferenced_needs_no_force(model: FakeModel) -> None:
    model.scenes["乙镇"]["npcs"].append({"id": "npc_路人", "x": 1, "y": 2})
    summary, _ops = delete_entity(model, "乙镇", "npc", "npc_路人")
    assert summary["danglingRefs"] == 0


# --------------------------------------------------------------------------- #
# zone：入站引用全 sceneId 限定 + sourceId 溯源串跟随
# --------------------------------------------------------------------------- #

def test_zone_move_rewrites_qualified_and_trace(model: FakeModel) -> None:
    snap = copy.deepcopy(model.scenes)
    snap_quests = copy.deepcopy(model.quests)
    summary = move_entity(model, "甲村", "zone", "z_门口", "乙镇")
    moved = next(z for z in model.scenes["乙镇"]["zones"] if z["id"] == "z_门口")
    # setZoneEnabled 的 sceneId 限定引用跟随
    assert model.quests[0]["onComplete"][1]["params"]["sceneId"] == "乙镇"
    assert {(h["bucket"], h["itemId"]) for h in summary["qualifiedRewritten"]} == {("quest", "q1")}
    # 溯源复合串跟随（def 自带）
    emit = next(a for a in moved["onEnter"] if a["type"] == "emitNarrativeSignal")
    assert emit["params"]["sourceId"] == "乙镇:z_门口"
    assert any("polygon" in item for item in summary["needsReview"])
    push_journal(model, summary)
    assert undo_last(model)["ok"]
    assert model.scenes == snap and model.quests == snap_quests


def test_zone_rename_rewrites_qualified_and_trace(model: FakeModel) -> None:
    snap = copy.deepcopy(model.scenes)
    summary = rename_entity(model, "甲村", "zone", "z_门口", "z_大门")
    assert model.quests[0]["onComplete"][1]["params"]["zoneId"] == "z_大门"
    zone = next(z for z in model.scenes["甲村"]["zones"] if z["id"] == "z_大门")
    emit = next(a for a in zone["onEnter"] if a["type"] == "emitNarrativeSignal")
    assert emit["params"]["sourceId"] == "甲村:z_大门"
    assert summary["counts"]["trace"] == 1
    push_journal(model, summary)
    assert undo_last(model)["ok"]
    assert model.scenes == snap


# --------------------------------------------------------------------------- #
# 出生点：入站 transition / switchScene 全量机械改写 + dict 键序保真
# --------------------------------------------------------------------------- #

def test_spawn_move_rewrites_all_inbound(model: FakeModel) -> None:
    snap = copy.deepcopy(model.scenes)
    snap_quests = copy.deepcopy(model.quests)
    summary = move_entity(model, "甲村", "spawn", "entry", "乙镇")
    assert "entry" in model.scenes["乙镇"]["spawnPoints"]
    assert "entry" not in model.scenes["甲村"]["spawnPoints"]
    # transition data 与 switchScene 动作双双跟随
    t = model.scenes["乙镇"]["hotspots"][0]["data"]
    assert (t["targetScene"], t["targetSpawnPoint"]) == ("乙镇", "entry")
    sw = model.quests[0]["onComplete"][2]["params"]
    assert (sw["targetScene"], sw["targetSpawnPoint"]) == ("乙镇", "entry")
    push_journal(model, summary)
    assert undo_last(model)["ok"]
    assert model.scenes == snap and model.quests == snap_quests
    # dict 键序保真（entry 仍在 back 之前）
    assert list(model.scenes["甲村"]["spawnPoints"]) == ["entry", "back"]


def test_spawn_rename_rewrites_inbound(model: FakeModel) -> None:
    snap = copy.deepcopy(model.scenes)
    summary = rename_entity(model, "甲村", "spawn", "entry", "front_gate")
    assert list(model.scenes["甲村"]["spawnPoints"]) == ["front_gate", "back"]  # 键序保真
    assert model.scenes["乙镇"]["hotspots"][0]["data"]["targetSpawnPoint"] == "front_gate"
    assert model.quests[0]["onComplete"][2]["params"]["targetSpawnPoint"] == "front_gate"
    push_journal(model, summary)
    assert undo_last(model)["ok"]
    assert model.scenes == snap


def test_spawn_guards(model: FakeModel) -> None:
    with pytest.raises(EntityRefactorError, match="默认出生点"):
        move_entity(model, "甲村", "spawn", "default", "乙镇")
    with pytest.raises(EntityRefactorError, match="已有出生点"):
        model.scenes["乙镇"]["spawnPoints"]["entry"] = {"x": 0, "y": 0}
        move_entity(model, "甲村", "spawn", "entry", "乙镇")
    del model.scenes["乙镇"]["spawnPoints"]["entry"]
    # 有引用的出生点删除需 force;撤销按位重插
    with pytest.raises(EntityRefactorError, match="force"):
        delete_entity(model, "甲村", "spawn", "entry")
    snap = copy.deepcopy(model.scenes)
    summary, reverse_ops = delete_entity(model, "甲村", "spawn", "entry", force=True)
    assert summary["danglingRefs"] == 2
    push_journal(model, {**summary, "reverseOps": reverse_ops})
    assert undo_last(model)["ok"]
    assert model.scenes == snap
    assert list(model.scenes["甲村"]["spawnPoints"]) == ["entry", "back"]


# --------------------------------------------------------------------------- #
# 脏桶正确性
# --------------------------------------------------------------------------- #

def test_dirty_buckets_on_move(model: FakeModel) -> None:
    move_entity(model, "甲村", "npc", "npc_张三", "乙镇")
    assert ("scene", "甲村") in model.dirty and ("scene", "乙镇") in model.dirty
    assert ("cutscene", "") in model.dirty  # sceneId 改写标脏（cutscenes 非 per-item）


# --------------------------------------------------------------------------- #
# validator 可达性检查回归探针（真实工程 + 暂存注入，零磁盘写入）
# --------------------------------------------------------------------------- #

def test_validator_reachability_fires_on_cross_scene_ref() -> None:
    """可达集封闭的对话图里注入"可达集外场景独有 npc"的硬引用 → 必须出 warning。
    这是实体迁移场景后的头号静默失败面，此探针防这条防线被无声破坏。"""
    from tools.editor.project_model import ProjectModel
    from tools.editor.validator import validate
    from tools.editor.shared import signal_refactor as sig
    from tools.editor.shared.entity_refactor import dialogue_graph_scene_reach

    root = Path(__file__).resolve().parents[3]
    if not (root / "public" / "assets" / "scenes").is_dir():
        pytest.skip("真实工程数据不可用")
    m = ProjectModel()
    m.load_project(root)
    reach_map = dialogue_graph_scene_reach(m)
    pick = None
    for gid, reach in sorted(reach_map.items()):
        if not isinstance(reach, set) or not reach:
            continue
        # 找一个只定义在可达集之外场景的 npc（全局存在、可达场景没有）
        for sid, scene in m.scenes.items():
            if str(sid) in reach or not isinstance(scene, dict):
                continue
            for npc in scene.get("npcs") or []:
                nid = str((npc or {}).get("id") or "").strip()
                if not nid:
                    continue
                in_reach = any(
                    any(str(n.get("id") or "") == nid for n in (m.scenes[r].get("npcs") or []))
                    for r in reach if isinstance(m.scenes.get(r), dict))
                if not in_reach:
                    pick = (gid, nid)
                    break
            if pick:
                break
        if pick:
            break
    if pick is None:
        pytest.skip("找不到可构造的跨场景引用组合")
    gid, nid = pick
    doc = sig._load_dialogue_doc(m, gid)
    node = next(iter(doc["nodes"].values()))
    node.setdefault("runActions", []).append(
        {"type": "showEmote", "params": {"target": nid, "emote": "?"}})
    m.pending_dialogue_graph_edits[gid] = doc
    hits = [i for i in validate(m)
            if i.data_type == "dialogue" and i.item_id == gid and "可达场景" in i.message]
    assert hits, f"注入 {gid} → {nid} 的跨场景硬引用后，可达性检查未开火"


# --------------------------------------------------------------------------- #
# 复制（duplicate）
# --------------------------------------------------------------------------- #

def test_duplicate_npc_deepcopy_offset_insert(model: FakeModel) -> None:
    summary = duplicate_entity(model, "甲村", "npc", "npc_张三")
    assert summary["op"] == "duplicateEntity"
    assert summary["newId"] == "npc_张三_copy"
    npcs = model.scenes["甲村"]["npcs"]
    # 紧挨原实体之后插入
    assert [n["id"] for n in npcs[:2]] == ["npc_张三", "npc_张三_copy"]
    orig, dup = npcs[0], npcs[1]
    # 坐标整体平移且保持 int 形态（数值往返保真）
    assert (dup["x"], dup["y"]) == (140, 240)
    assert isinstance(dup["x"], int) and isinstance(dup["y"], int)
    # 巡逻路点同幅平移
    assert dup["patrol"]["route"] == [{"x": 41, "y": 42}]
    # 出站引用保留（同场景复制天然有效）
    assert dup["dialogueGraphId"] == "对话_张三"
    # deepcopy 独立：改副本嵌套结构不得污染原实体
    dup["patrol"]["route"][0]["x"] = 999
    assert orig["patrol"]["route"] == [{"x": 1, "y": 2}]
    assert ("scene", "甲村") in model.dirty


def test_duplicate_id_probing_respects_cross_kind_namespace(model: FakeModel) -> None:
    # npc/hotspot 互为 emote 目标命名空间：探测取号必须跨类避让
    model.scenes["甲村"]["npcs"].append({"id": "hs_摊位_copy", "x": 0, "y": 0})
    summary = duplicate_entity(model, "甲村", "hotspot", "hs_摊位")
    assert summary["newId"] == "hs_摊位_copy_2"


def test_duplicate_strips_cutscene_bindings(model: FakeModel) -> None:
    hs = model.scenes["甲村"]["hotspots"][0]
    hs["cutsceneIds"] = ["cut_1"]
    hs["cutsceneOnly"] = True
    summary = duplicate_entity(model, "甲村", "hotspot", "hs_摊位")
    dup = model.scenes["甲村"]["hotspots"][1]
    assert dup["id"] == summary["newId"]
    assert "cutsceneIds" not in dup and "cutsceneOnly" not in dup
    assert summary["strippedCutsceneIds"] == ["cut_1"]
    # 原实体绑定不动
    assert hs["cutsceneIds"] == ["cut_1"] and hs["cutsceneOnly"] is True


def test_duplicate_zone_translates_polygon_and_trace(model: FakeModel) -> None:
    summary = duplicate_entity(model, "甲村", "zone", "z_门口")
    dup = model.scenes["甲村"]["zones"][1]
    assert dup["id"] == summary["newId"] == "z_门口_copy"
    # 数组点形状的 polygon 也要整体平移
    assert dup["polygon"] == [[40, 40], [41, 40], [41, 41]]
    # 溯源复合串 "场景:实体" 跟随副本新 id（trace-only 零歧义）
    emits = [a for a in dup["onEnter"] if a["type"] == "emitNarrativeSignal"]
    assert emits and emits[0]["params"]["sourceId"] == "甲村:z_门口_copy"
    orig_emits = [a for a in model.scenes["甲村"]["zones"][0]["onEnter"]
                  if a["type"] == "emitNarrativeSignal"]
    assert orig_emits[0]["params"]["sourceId"] == "甲村:z_门口"
    # 其余出站引用原样保留
    assert any(a["type"] == "showSpeechBubble" and a["params"]["target"] == "npc_张三"
               for a in dup["onEnter"])


def test_duplicate_spawn_inserts_after_original(model: FakeModel) -> None:
    summary = duplicate_entity(model, "甲村", "spawn", "entry")
    sps = model.scenes["甲村"]["spawnPoints"]
    assert list(sps) == ["entry", "entry_copy", "back"]
    assert sps["entry_copy"] == {"x": 50, "y": 60}
    assert summary["newId"] == "entry_copy"


def test_duplicate_explicit_new_id_and_collision(model: FakeModel) -> None:
    summary = duplicate_entity(model, "甲村", "npc", "npc_张三", new_id="npc_李四")
    assert summary["newId"] == "npc_李四"
    with pytest.raises(EntityRefactorError):
        duplicate_entity(model, "甲村", "npc", "npc_张三", new_id="npc_重名")
    with pytest.raises(EntityRefactorError):
        duplicate_entity(model, "甲村", "npc", "npc_张三", new_id="npc_张三")
    # 撞名闸在修改前抛出：列表不得残留半改状态
    assert [n["id"] for n in model.scenes["甲村"]["npcs"]
            if n["id"].startswith("npc_张三")] == ["npc_张三"]


def test_duplicate_guards(model: FakeModel) -> None:
    with pytest.raises(EntityRefactorError):
        duplicate_entity(model, "甲村", "npc", "不存在")
    with pytest.raises(EntityRefactorError):
        duplicate_entity(model, "不存在", "npc", "npc_张三")
    with pytest.raises(EntityRefactorError):
        duplicate_entity(model, "甲村", "spawn", "default")


def test_duplicate_undo_removes_copy(model: FakeModel) -> None:
    summary = duplicate_entity(model, "甲村", "npc", "npc_张三")
    push_journal(model, summary)
    before = copy.deepcopy(model.scenes["甲村"]["npcs"][0])
    result = undo_last(model)
    assert result["ok"], result
    ids = [n["id"] for n in model.scenes["甲村"]["npcs"]]
    assert "npc_张三_copy" not in ids
    assert model.scenes["甲村"]["npcs"][0] == before
    # journal 已弹空
    assert undo_last(model)["ok"] is False


def test_duplicate_spawn_undo(model: FakeModel) -> None:
    summary = duplicate_entity(model, "甲村", "spawn", "entry")
    push_journal(model, summary)
    result = undo_last(model)
    assert result["ok"], result
    assert list(model.scenes["甲村"]["spawnPoints"]) == ["entry", "back"]


def test_validator_flags_duplicate_entity_ids_in_scene() -> None:
    """场景内实体 id 重复（含 npc↔hotspot 跨类撞名）必须出 error——这是复制类
    操作写错时的静默灾难面（画布图元键覆盖 / 属性按 id 首匹配串台），此前零检查。"""
    from tools.editor.project_model import ProjectModel
    from tools.editor.tests.save_test_utils import write_minimal_loadable_project
    from tools.editor.validator import validate
    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as td:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        sid = next(iter(m.scenes))
        sc = m.scenes[sid]
        sc["npcs"] = [{"id": "撞", "x": 0, "y": 0}, {"id": "撞", "x": 1, "y": 1}]
        sc["hotspots"] = [{"id": "跨类", "type": "inspect", "x": 0, "y": 0,
                           "interactionRange": 50, "data": {"text": ""}}]
        sc["npcs"].append({"id": "跨类", "x": 2, "y": 2})
        sc["zones"] = [{"id": "z重", "polygon": [{"x": 0, "y": 0}]},
                       {"id": "z重", "polygon": [{"x": 1, "y": 1}]}]
        hits = [i for i in validate(m)
                if i.data_type == "scene" and i.item_id == sid
                and "重复" in i.message and i.severity == "error"]
        dup_msgs = "\n".join(i.message for i in hits)
        assert any("撞" in msg for msg in dup_msgs.splitlines()), dup_msgs
        assert any("跨类" in msg for msg in dup_msgs.splitlines()), dup_msgs
        assert any("z重" in msg for msg in dup_msgs.splitlines()), dup_msgs
