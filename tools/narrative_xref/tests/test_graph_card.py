"""「编排全貌」（图维度）与「它调的」目标扫描的护栏。

合成 fixture 打形状（区域推转移、场景实体读状态、状态动作调过场 / 说明卡 / 区域 / NPC），
真实工程打口径（CONTENT_ID_PARAMS 里每个宇宙都登记或明确排除；跑马梁那张图三组都不为空）。
"""

from __future__ import annotations

from pathlib import Path

from tools.narrative_xref import (
    EXCLUDED_UNIVERSES,
    TARGET_SPECS,
    build_index,
    from_disk,
)
from tools.narrative_xref.sources import AssetDoc, DialogueDoc, XrefSource
from tools.narrative_xref.targets import TargetContext, resolve_action_targets

REPO_ROOT = Path(__file__).resolve().parents[3]


def _source() -> XrefSource:
    src = XrefSource(origin="test")
    src.narrative = {
        "schemaVersion": 3,
        "signals": [{"id": "z_entered"}, {"id": "dlg_done"}],
        "compositions": [{
            "id": "comp",
            "label": "编排",
            "mainGraph": {"id": "flow_main", "label": "主线", "initialState": "s0",
                          "states": {"s0": {}, "s1": {"label": "接了活"}},
                          "transitions": [{"id": "m1", "from": "s0", "to": "s1", "signal": "state:wrap_a:done"}]},
            "elements": [{
                "id": "el_a", "kind": "wrapperGraph", "ownerType": "scene", "ownerId": "scene_a",
                "graph": {
                    "id": "wrap_a", "label": "甲图", "ownerType": "scene", "ownerId": "scene_a", "initialState": "idle",
                    "states": {
                        "idle": {"label": "闲着"},
                        "busy": {
                            "label": "忙着",
                            "onEnterActions": [
                                {"type": "startCutscene", "params": {"id": "cs_intro"}},
                                {"type": "showSystemNote", "params": {"noteId": "note_1"}},
                                {"type": "runActionsIf", "params": {"condition": {"flag": "x"}, "actions": [
                                    {"type": "persistZoneEnabled", "params": {"sceneId": "scene_a", "zoneId": "z_gate", "enabled": False}},
                                ]}},
                                {"type": "persistNpcEntityEnabled", "params": {"target": "npc_old", "enabled": True}},
                                {"type": "emitNarrativeSignal", "params": {"signal": "self_sig"}},
                                {"type": "setFlag", "params": {"key": "k", "value": True}},
                            ],
                        },
                        "done": {"label": "完事", "broadcastOnEnter": True},
                    },
                    "transitions": [
                        {"id": "t1", "from": "idle", "to": "busy", "signal": "z_entered"},
                        {"id": "t2", "from": "busy", "to": "done", "signal": "dlg_done"},
                        {"id": "t3", "from": "done", "to": "idle", "signal": "self_sig"},
                        {"id": "t4", "from": "idle", "to": "done", "signal": "__draft__", "trigger": "reactive",
                         "conditions": [{"narrative": "flow_main", "state": "s1"}]},
                    ],
                },
            }],
        }],
    }
    src.dialogues = [DialogueDoc("dlg_x", "public/assets/dialogues/graphs/dlg_x.json", {
        "id": "dlg_x", "meta": {"title": "某段戏"},
        "nodes": {"n1": {"id": "n1", "type": "runActions", "actions": [
            {"type": "emitNarrativeSignal", "params": {"signal": "dlg_done"}},
        ]}},
    })]
    src.assets = [AssetDoc("scenes", "scene", "scene_a", "场景", "public/assets/scenes/scene_a.json", {
        "id": "scene_a", "name": "甲场景",
        "zones": [
            {"id": "z_entry", "onEnter": [{"type": "emitNarrativeSignal", "params": {"signal": "z_entered"}}],
             "onStay": [{"type": "emitNarrativeSignal", "params": {"signal": "z_entered"}}]},
            {"id": "z_gate", "conditions": [{"narrative": "wrap_a", "state": "busy"}]},
        ],
        "npcs": [{"id": "npc_old", "name": "老汉", "conditionHidesEntity": True,
                  "conditions": [{"narrative": "wrap_a", "state": "done", "reached": True}]}],
        "hotspots": [],
    })]
    return src


def test_graph_card_has_the_three_groups_and_downstream():
    index = build_index(_source())
    card = index.graph_card("wrap_a")
    assert card.exists and card.owner_type == "scene" and card.owner_id == "scene_a"

    # 推它的：区域进入/停留各一行（两个时刻）、对话图一行、反应式条件读主线一行、自推一行排最后
    kinds = [(p.transition_id, p.subject_kind_label, p.subject_id, p.moment, p.self_graph) for p in card.pushers]
    assert ("t1", "区域", "z_entry", "进入时", False) in kinds
    assert ("t1", "区域", "z_entry", "停留时", False) in kinds
    assert ("t2", "对话图", "dlg_x", "节点「n1」 · 动作 第 1 个", False) in kinds
    reactive = [p for p in card.pushers if p.transition_id == "t4"]
    assert reactive and reactive[0].ref_graph_id == "flow_main" and reactive[0].ref_state_label == "接了活"
    assert card.pushers[-1].self_graph and card.pushers[-1].transition_id == "t3"
    dialogue_push = next(p for p in card.pushers if p.transition_id == "t2")
    assert dialogue_push.subject_name == "某段戏"

    # 它管的：区域 z_gate 与 NPC 老汉，不含本图自己的条件
    subjects = {(r.state_id, r.subject_kind_label, r.subject_display, r.subject_effect) for r in card.readers}
    assert ("busy", "区域", "z_gate", "走进去有没有反应") in subjects
    assert ("done", "NPC", "老汉", "出不出现") in subjects

    # 它调的：过场 / 说明卡 / 嵌套 runActionsIf 里的区域 / 按 id 落到场景的 NPC；信号与 flag 不算
    targets = {(t.state_id, t.universe, t.target_id, t.scene_id) for t in card.targets}
    assert ("busy", "cutscenes", "cs_intro", "") in targets
    assert ("busy", "system_notes", "note_1", "") in targets
    assert ("busy", "zones", "z_gate", "scene_a") in targets
    assert ("busy", "npcs", "npc_old", "scene_a") in targets
    assert not any(t.universe in EXCLUDED_UNIVERSES for t in card.targets)
    npc_row = next(t for t in card.targets if t.universe == "npcs")
    assert npc_row.label == "老汉" and npc_row.file == "public/assets/scenes/scene_a.json" and npc_row.anchors == [["npcs", "npc_old"]]
    note_row = next(t for t in card.targets if t.universe == "system_notes")
    assert note_row.anchors == [["notes", "note_1"]] and note_row.where == "进入时动作 第 2 个"
    zone_row = next(t for t in card.targets if t.universe == "zones")
    assert zone_row.where.startswith("进入时动作 第 3 个")

    # 接它往下走的图：主线听 state:wrap_a:done
    assert [(l.graph_id, l.transition_id) for l in card.downstream] == [("flow_main", "m1")]

    # 序列化带全四组，状态卡也带 targets
    payload = card.to_dict()
    assert payload["pusherCount"] == len(card.pushers) and payload["targets"][0]["display"]
    state_payload = index.state_card("wrap_a", "busy").to_dict()
    assert state_payload["targetCount"] == len(card.targets)
    assert "graphs" in index.to_dict()


def test_missing_graph_card_is_honest():
    card = build_index(_source()).graph_card("nope")
    assert not card.exists and card.pushers == [] and card.to_dict()["exists"] is False


def test_walk_still_reports_emits_and_reads_with_targets_on():
    """挂上目标扫描不许改变发射 / 读状态两侧的口径（它只是多一条回调）。"""
    index = build_index(_source())
    assert {e.signal for rows in index.emitters.values() for e in rows} >= {"z_entered", "dlg_done", "self_sig", "state:wrap_a:done"}
    assert ("wrap_a", "busy") in index.state_reads and ("wrap_a", "done") in index.state_reads


def test_every_content_id_universe_is_registered_or_excluded():
    """CONTENT_ID_PARAMS 新增一种内容 id 宇宙而这里没登记 = 那类目标静默少算。"""
    from tools.json_lang.schema_build import CONTENT_ID_PARAMS

    universes = set(CONTENT_ID_PARAMS.values())
    missing = sorted(u for u in universes if u not in TARGET_SPECS and u not in EXCLUDED_UNIVERSES)
    assert not missing, f"这些宇宙既没登记跳法也没明确排除：{missing}"


def test_target_resolution_shapes():
    ctx = TargetContext(
        labels={"items": {"i1": "半块饼"}, "planes": {"p1": "背尸位面"}},
        entities={"h1": [("scene_b", "hotspots", "门口")]},
        scene_labels={"scene_b": "乙场景"},
    )
    rows = resolve_action_targets("giveItem", {"id": "i1"}, ctx)
    assert [(r.universe, r.label, r.file, r.anchors) for r in rows] == [("items", "半块饼", "public/assets/data/items.json", [["items", "i1"]])]
    rows = resolve_action_targets("activatePlane", {"id": "p1"}, ctx)
    assert rows[0].nav_kind == "plane" and rows[0].label == "背尸位面"
    rows = resolve_action_targets("persistHotspotEnabled", {"sceneId": "scene_b", "hotspotId": "h1", "enabled": True}, ctx)
    assert rows[0].universe == "hotspots" and rows[0].label == "门口" and rows[0].scene_label == "乙场景"
    # player 不是世界里的实体；找不到的 target 也不算
    assert resolve_action_targets("showSpeechBubble", {"target": "player", "text": "x"}, ctx) == []
    assert resolve_action_targets("teleportEntityTo", {"target": "ghost", "x": 1, "y": 2}, ctx) == []
    # 只读工作台资产：列出来但标只读
    rows = resolve_action_targets("playVfx", {"effect": "fx_1"}, ctx)
    assert rows[0].readonly and rows[0].file == "public/assets/data/vfx/fx_1.json"
    # 切场景：目标是那个场景本身
    rows = resolve_action_targets("switchScene", {"targetScene": "scene_b", "targetSpawnPoint": "sp"}, ctx)
    assert [(r.universe, r.label, r.file) for r in rows] == [("scenes", "乙场景", "public/assets/scenes/scene_b.json")]


def test_real_project_ridge_graph_has_all_three_groups():
    """跑马梁那张图是本功能的标本：区域推它、场景实体读它、状态动作调说明卡与对话图。"""
    index = build_index(from_disk(REPO_ROOT))
    card = index.graph_card("wrapper_跑马梁_风火引路")
    assert card.exists
    assert any(p.subject_kind_label == "区域" and not p.self_graph for p in card.pushers)
    assert any(p.subject_kind_label == "对话图" for p in card.pushers)
    assert any(r.subject_kind_label == "NPC" for r in card.readers)
    universes = {t.universe for t in card.targets}
    assert {"system_notes", "dialogue_graphs"} <= universes
    note = next(t for t in card.targets if t.universe == "system_notes")
    assert note.label and note.label != note.target_id, "说明卡要翻成中文名"
    # 每一行都能落到某处：有文件、或有 navigate 路由、或是叙事图、或明说没有编辑页
    for t in card.targets:
        assert t.file or t.nav_kind or t.ref_graph_id or t.note, t


def test_real_project_graph_overview_is_fast_enough_for_a_panel():
    import time

    index = build_index(from_disk(REPO_ROOT))
    started = time.perf_counter()
    cards = index.graph_overview()
    elapsed = time.perf_counter() - started
    assert cards and elapsed < 2.0, f"图维度汇总耗时 {elapsed:.2f}s"
