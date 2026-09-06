"""共享扫描引擎的护栏。

合成 fixture 打**形状**（真实数据里暂时没有的形状照样得对），真实工程打**口径**
（与 narrative_catalog.emitted_signal_ids 对账，两侧漂了就红）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.narrative_xref import (
    CHANNEL_BROADCAST,
    DIAG_REACTIVE_ONLY,
    DIAG_STATE_MISSING,
    DIAG_STATE_NO_WAY_IN,
    DIAG_UNREACHABLE,
    CHANNEL_UPSTREAM,
    DIAG_BROADCAST_OFF,
    DIAG_DECLARED_ONLY,
    DIAG_DRAFT,
    DIAG_NO_EMITTER,
    DIAG_NO_LISTENER,
    DIAG_ORPHAN,
    DIAG_UNREGISTERED,
    KIND_AUTHOR,
    KIND_DERIVED,
    KIND_DRAFT,
    KIND_UNKNOWN,
    build_index,
    from_disk,
)
from tools.narrative_xref import scan as scan_mod
from tools.narrative_xref.sources import (
    ASSET_SPECS,
    CONDITION_EXTRA_SPECS,
    READONLY_ATTRS,
    AssetDoc,
    DialogueDoc,
    XrefSource,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def emit(signal: str, source_id: str = "", owner_type: str = "", owner_id: str = "") -> dict:
    params = {"signal": signal}
    if source_id:
        params.update({"sourceType": "dialogue", "sourceId": source_id})
    # 半对 owner 参数是真实会写出来的形状（作者填一半就跑去别处），测试要能造出来
    if owner_type:
        params["ownerType"] = owner_type
    if owner_id:
        params["ownerId"] = owner_id
    return {"type": "emitNarrativeSignal", "params": params}


def make_source(**kwargs) -> XrefSource:
    src = XrefSource(origin="test")
    src.narrative = kwargs.get("narrative", {})
    src.dialogues = kwargs.get("dialogues", [])
    src.assets = kwargs.get("assets", [])
    return src


def narrative_with(**kwargs) -> dict:
    """一份最小可用的 narrative_graphs：一个编排、一张主图。"""
    states = kwargs.get("states", {"s_a": {"label": "开局"}, "s_b": {"label": "接了活"}})
    transitions = kwargs.get("transitions", [])
    elements = kwargs.get("elements", [])
    signals = kwargs.get("signals", [])
    return {
        "schemaVersion": 1,
        "signals": signals,
        "compositions": [{
            "id": "comp_1",
            "label": "第一单",
            "mainGraph": {
                "id": "flow_main",
                "label": "主线",
                "initialState": kwargs.get("initial", "s_a"),
                "states": states,
                "transitions": transitions,
            },
            "elements": elements,
        }],
    }


# --------------------------------------------------------------------------- #
# 镜像对账
# --------------------------------------------------------------------------- #

def test_asset_specs_mirror_catalog_registry():
    """发射面登记表必须与目录口径同源——漏一个数据域 = 那域发的信号从此隐身。"""
    from tools.editor.shared.narrative_catalog import _EMIT_SOURCE_ATTRS

    assert set(ASSET_SPECS) == set(_EMIT_SOURCE_ATTRS), (
        f"仅在 xref 表：{set(ASSET_SPECS) - set(_EMIT_SOURCE_ATTRS)}；"
        f"仅在目录表：{set(_EMIT_SOURCE_ATTRS) - set(ASSET_SPECS)}"
    )


def test_readonly_attrs_mirror_refactor_engine():
    from tools.editor.shared.signal_refactor import READONLY_SOURCES

    assert set(READONLY_ATTRS) == set(READONLY_SOURCES)


def test_condition_face_mirrors_the_refactor_engine():
    """条件面（读状态那一侧）比发射面宽。漏一域 = 面板少算成"没人读"，
    于是"发了没人听"缺掉缓解句，策划会去"修"一个本来正常的广播。"""
    from tools.editor.shared.signal_refactor import CONDITION_SOURCES, READONLY_SOURCES

    # 重构引擎的条件面只列**可写**数据域（只读面单列，命中即拒绝改写）；xref 是只读扫描，
    # 两边都要看得见，所以对账口径是 可写 ∪ 只读。
    ours = set(ASSET_SPECS) | set(CONDITION_EXTRA_SPECS)
    authority = set(CONDITION_SOURCES) | set(READONLY_SOURCES)
    assert ours == authority, (
        f"仅在 xref：{ours - authority}；仅在重构引擎：{authority - ours}"
    )


def test_reference_shapes_mirror_the_refactor_engine():
    """五种引用形状必须与权威走访器同款——这正是 2026-08-05 漏 ownerState/contextState
    踩过的坑（扫描少算成 0 处，级联静默漏改）。语义级对账：拿同一份合成数据，
    两边都要认出同样多的引用。"""
    from tools.editor.shared import signal_refactor as sr

    assert set(scan_mod.GRAPH_PARAM_ACTIONS) == set(sr._GRAPH_PARAM_ACTION_TYPES)
    assert set(scan_mod.DIALOGUE_STATE_NODES) == set(sr._DIALOGUE_STATE_NODE_TYPES)

    payload = {
        "leaf": {"narrative": "g", "state": "s"},
        "count": {"narrativeCount": "g", "exitState": "s"},
        "setState": {"type": "setNarrativeState", "params": {"graphId": "g", "stateId": "s"}},
        "revert": {"type": "revertNarrativeRun", "params": {"graphId": "g", "stateId": "s"}},
        "owner": {"type": "ownerState", "wrapperGraphId": "g", "cases": [{"state": "s"}, {"state": "other"}]},
        "context": {"type": "contextState", "graphId": "g", "cases": [{"state": "s"}]},
        # 陷阱：encounters 里的 narrative 是旁白正文，不该被当成图引用
        "prose": {"narrative": "旧木箱的锁已经锈得不成样子……"},
    }
    authority = sr._walk_narrative_refs(payload, sr._state_ref_visitor("g", "s", None))

    commands: list[tuple[str, str]] = []
    reads: list[tuple[str, str]] = []
    scan_mod._walk(
        payload, "", [], [], [], "", None, [],
        lambda *_a: None,
        lambda gid, sid, _hit: commands.append((gid, sid)),
        lambda gid, sid, _hit: reads.append((gid, sid)),
    )
    hits = commands + reads
    ours = [pair for pair in hits if pair == ("g", "s")]
    assert len(ours) == authority, f"xref 认出 {len(ours)} 处，权威走访器认出 {authority} 处：{hits}"
    assert not any(gid.startswith("旧木箱") for gid, _ in hits), "旁白正文不该被当成图引用"
    # 分流不能错：只有 setNarrativeState 真的 enterState（会广播）→ 算"能让它发生的路"；
    # 活计四件套与条件叶只是"引用了这个状态"。两边互串时总数不变，只有分开数才抓得到。
    assert commands == [("g", "s")], f"只 setNarrativeState 该进 command，实际 {commands}"
    assert [p for p in reads if p == ("g", "s")] == [("g", "s")] * (authority - 1), (
        f"其余四种该进 read，实际 {reads}")
    # ownerState 的另一个分支（同一张图、别的状态）也要各记一条，别只认第一条 case
    assert ("g", "other") in reads


def test_subtree_sources_keep_the_pointer_pointing_at_the_real_file_location():
    """模型侧存的是文件子树（map_config.json 的 nodes 数组），指针必须补回那一段，
    否则跳转落到文件根上的错位置；两个来源也会因此漂。"""
    nodes = [{"id": "map_1", "visibleIf": {"narrative": "flow_main", "state": "s_b"}}]
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("map_nodes", "mapNode", "", "地图节点",
                         "public/assets/data/map_config.json", nodes, False,
                         scan_emits=False, pointer_prefix="/nodes")],
    ))
    read = index.state_reads[("flow_main", "s_b")][0]
    assert read.pointer == "/nodes/0/visibleIf"
    assert read.file == "public/assets/data/map_config.json"


def test_condition_only_sources_never_contribute_emitters():
    """条件面比发射面宽，但它**不算发射**——算进去就与 emitted_signal_ids 的权威口径打架。"""
    rules = {"rules": [{"id": "r_1", "onLearn": [emit("sig_should_not_count")]}]}
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("rules_data", "rule", "", "规矩", "public/assets/data/rules.json",
                         rules, False, scan_emits=False)],
    ))
    assert index.card("sig_should_not_count").real_emitter_count == 0


# --------------------------------------------------------------------------- #
# 发送方
# --------------------------------------------------------------------------- #

def test_dialogue_emitter_carries_jumpable_location():
    doc = {
        "id": "对话_接活",
        "nodes": {
            "c_jie": {"type": "runActions", "actions": [emit("sig_a", "对话_接活")], "next": "n_line"},
            "n_line": {"type": "line", "text": "行，这活我接了。"},
        },
    }
    index = build_index(make_source(
        narrative=narrative_with(signals=[{"id": "sig_a", "label": "接活了"}]),
        dialogues=[DialogueDoc("对话_接活", "public/assets/dialogues/graphs/对话_接活.json", doc)],
    ))
    card = index.card("sig_a")
    assert card.kind == KIND_AUTHOR
    assert card.label == "接活了"
    assert len(card.emitters) == 1
    e = card.emitters[0]
    assert e.kind_label == "对话图"
    assert e.container_id == "对话_接活"
    assert e.pointer == "/nodes/c_jie/actions/0"
    assert e.file.endswith("对话_接活.json")
    assert "节点「c_jie」" in e.where and "动作 第 1 个" in e.where
    assert "留痕来源" in e.note


def test_dialogue_emitter_picks_up_nearby_line():
    doc = {
        "id": "对话_答应",
        "nodes": {"n1": {"type": "line", "text": "那就这么定了。", "actions": [emit("sig_a")]}},
    }
    index = build_index(make_source(
        narrative=narrative_with(), dialogues=[DialogueDoc("对话_答应", "d.json", doc)],
    ))
    assert "那就这么定了。" in index.card("sig_a").emitters[0].context


def test_scene_emitter_anchors_point_at_the_entity():
    scene = {
        "id": "yizhuang",
        "hotspots": [
            {"id": "hs_door", "name": "义庄门", "onInteract": [emit("sig_door")]},
        ],
    }
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("scenes", "scene", "yizhuang", "场景",
                         "public/assets/scenes/yizhuang.json", scene)],
    ))
    e = index.card("sig_door").emitters[0]
    assert e.container_id == "yizhuang"
    assert e.pointer == "/hotspots/0/onInteract/0"
    assert e.anchors == [["", "yizhuang"], ["hotspots", "hs_door"]]
    assert "热点「hs_door」" in e.where
    assert "交互时" in e.where


def test_whole_file_collection_uses_outermost_anchor_as_item_id():
    quests = [
        {"id": "q_1", "title": "第一单"},
        {"id": "q_2", "title": "第二单", "onComplete": [emit("sig_done")]},
    ]
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)],
    ))
    e = index.card("sig_done").emitters[0]
    assert e.container_id == "q_2"          # 主编辑器跳转引擎认的 outer_id
    assert e.pointer == "/1/onComplete/0"
    assert e.anchors[0] == ["", "q_2"]
    assert "完成时" in e.where
    # 行首标题已经写过条目 id 了，位置串里不再重复一遍
    assert not e.where.startswith("「q_2」"), e.where


def test_readonly_data_plane_is_marked_so_the_ui_can_say_it_cannot_jump():
    """物件检视这类只读面：目录要看得见它发的信号，但界面不能给一颗必然失败的跳转按钮。"""
    inst = {"id": "oe_1", "steps": [{"id": "s1", "actions": [emit("sig_x")]}]}
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("object_examine_instances", "minigame", "oe_1", "物件检视",
                         "public/assets/data/object_examine/oe_1.json", inst, True)],
    ))
    e = index.card("sig_x").emitters[0]
    assert e.readonly is True
    assert e.to_dict()["readonly"] is True


def test_writable_data_planes_are_not_marked_readonly():
    quests = [{"id": "q_1", "onComplete": [emit("sig_x")]}]
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)],
    ))
    assert index.card("sig_x").emitters[0].readonly is False


def test_narrative_state_action_emitter_is_its_own_channel():
    narrative = narrative_with(states={
        "s_a": {"label": "开局", "onEnterActions": [emit("sig_enter")]},
    })
    index = build_index(make_source(narrative=narrative))
    e = index.card("sig_enter").emitters[0]
    assert e.container_kind == "narrativeGraph"
    assert "状态「s_a」" in e.where or "状态「开局」" in e.where
    assert e.pointer == "/compositions/0/mainGraph/states/s_a/onEnterActions/0"
    # 叙事图内的行必须带画布坐标：没有它就退回文件跳转，而 narrative_graphs.json 的
    # 文件跳转对这类指针只会"打开叙事状态机页"——你本来就在那一页，等于按钮坏了。
    assert (e.composition_id, e.graph_id, e.state_id) == ("comp_1", "flow_main", "s_a")


def test_declaration_is_never_counted_as_a_real_emitter():
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_x"}],
        elements=[{"id": "el_1", "kind": "dialogueBlackbox", "label": "门口拦活",
                   "refId": "对话_拦活", "meta": {"emits": ["sig_x"]}}],
    )
    card = build_index(make_source(narrative=narrative)).card("sig_x")
    assert card.real_emitter_count == 0
    assert len(card.declarations) == 1
    assert card.declarations[0].pointer == "/compositions/0/elements/0/meta/emits/0"
    assert [d.code for d in card.diagnostics] == [DIAG_DECLARED_ONLY]


# --------------------------------------------------------------------------- #
# 接收方
# --------------------------------------------------------------------------- #

def test_listener_carries_states_and_conditions_in_plain_words():
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        transitions=[{
            "id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_x",
            "conditions": [{"narrative": "flow_main", "state": "s_a"}],
            "priority": 3,
        }],
    )
    listener = build_index(make_source(narrative=narrative)).card("sig_x").listeners[0]
    assert listener.graph_label == "主线"
    assert listener.composition_label == "第一单"
    assert (listener.from_label, listener.to_label) == ("开局", "接了活")
    assert listener.priority == 3
    assert listener.conditions == ["「主线」正停在「开局」"]
    assert listener.pointer == "/compositions/0/mainGraph/transitions/0"


def test_reactive_transition_is_not_a_listener():
    """反应式转移靠条件自评估，signal 字段是占位——算成接收方就是凭空造接线。"""
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_x", "trigger": "reactive"}],
    )
    card = build_index(make_source(narrative=narrative)).card("sig_x")
    assert card.listeners == []


def test_subgraph_element_transitions_are_found_too():
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        elements=[{
            "id": "el_sub", "kind": "scenarioSubgraph", "label": "听书",
            "graph": {
                "id": "scenario_tingshu", "label": "听书",
                "initialState": "idle",
                "states": {"idle": {"label": "没开始"}, "done": {"label": "听完了"}},
                "transitions": [{"id": "t_done", "from": "idle", "to": "done", "signal": "sig_x"}],
            },
        }],
    )
    listener = build_index(make_source(narrative=narrative)).card("sig_x").listeners[0]
    assert listener.graph_id == "scenario_tingshu"
    assert listener.element_id == "el_sub"
    assert listener.pointer == "/compositions/0/elements/0/graph/transitions/0"


# --------------------------------------------------------------------------- #
# 派生信号（state:图:态）
# --------------------------------------------------------------------------- #

def test_derived_signal_lists_broadcast_and_what_causes_it():
    narrative = narrative_with(
        states={"s_a": {"label": "开局"}, "s_b": {"label": "接了活", "broadcastOnEnter": True}},
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_x"}],
        signals=[{"id": "sig_x"}],
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_b")
    assert card.kind == KIND_DERIVED
    assert card.source_state_label == "接了活"
    channels = [e.channel for e in card.emitters]
    assert channels.count(CHANNEL_BROADCAST) == 1
    assert channels.count(CHANNEL_UPSTREAM) == 1          # 那条上游转移
    assert card.real_emitter_count == 1                    # 上游不计进"真发射"
    upstream = [e for e in card.emitters if e.channel == CHANNEL_UPSTREAM][0]
    assert "开局 → 接了活" in upstream.where
    assert "收到信号「sig_x」时走" in upstream.context


def test_initial_state_broadcast_is_flagged_as_a_no_op_not_listed_as_a_cause():
    """初始状态勾了「进入时广播」= 白勾：注册图/start/reset 都直接 set activeStates，
    不走 enterState、不广播。以前这里报"开局就会发"，是对着运行时撒谎。"""
    narrative = narrative_with(
        states={"s_a": {"label": "开局", "broadcastOnEnter": True}}, initial="s_a",
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_a")
    assert not any(e.kind_label == "初始状态" for e in card.emitters)
    diag = [d for d in card.diagnostics if d.code == DIAG_BROADCAST_OFF]
    assert diag and "并不会广播" in diag[0].message
    # 界面直出纯文本：文案里不许有 markdown 星号（Qt/React 都会原样显示）
    assert "**" not in diag[0].message


def test_derived_signal_flags_broadcast_not_enabled():
    narrative = narrative_with(
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "state:flow_main:s_b"}],
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_b")
    assert DIAG_BROADCAST_OFF in [d.code for d in card.diagnostics]
    assert card.diagnostics[0].severity == "error"


def test_derived_signal_flags_missing_state():
    card = build_index(make_source(narrative=narrative_with())).card("state:flow_main:nope")
    codes = [d.code for d in card.diagnostics]
    assert DIAG_BROADCAST_OFF in codes


def test_derived_signal_shows_condition_readers_of_the_state():
    """广播只被条件叶消费是已知噪声，清单必须让人一眼看出来，而不是干报"没人听"。"""
    narrative = narrative_with(states={"s_a": {"label": "开局"}, "s_b": {"label": "接了活", "broadcastOnEnter": True}})
    quests = [{"id": "q_1", "requires": {"all": [{"narrative": "flow_main", "state": "s_b"}]}}]
    index = build_index(make_source(
        narrative=narrative,
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)],
    ))
    card = index.card("state:flow_main:s_b")
    assert len(card.state_reads) == 1
    assert card.state_reads[0].container_id == "q_1"
    no_listener = [d for d in card.diagnostics if d.code == DIAG_NO_LISTENER][0]
    assert "条件在读这个状态" in no_listener.message


def test_set_narrative_state_action_counts_as_a_cause():
    narrative = narrative_with(states={"s_b": {"label": "接了活", "broadcastOnEnter": True}})
    quests = [{"id": "q_1", "onComplete": [
        {"type": "setNarrativeState", "params": {"graphId": "flow_main", "stateId": "s_b"}},
    ]}]
    card = build_index(make_source(
        narrative=narrative,
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)],
    )).card("state:flow_main:s_b")
    causes = [e for e in card.emitters if e.channel == CHANNEL_UPSTREAM]
    assert len(causes) == 1
    assert causes[0].container_id == "q_1"
    assert "调试专用" in causes[0].note


# --------------------------------------------------------------------------- #
# 诊断
# --------------------------------------------------------------------------- #

def test_dangling_listen_is_reported():
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_x"}],
    )
    card = build_index(make_source(narrative=narrative)).card("sig_x")
    assert [d.code for d in card.diagnostics] == [DIAG_NO_EMITTER]


def test_emitted_but_nobody_listens_is_reported():
    doc = {"id": "d", "nodes": {"n": {"type": "runActions", "actions": [emit("sig_x")]}}}
    card = build_index(make_source(
        narrative=narrative_with(signals=[{"id": "sig_x"}]),
        dialogues=[DialogueDoc("d", "d.json", doc)],
    )).card("sig_x")
    assert [d.code for d in card.diagnostics] == [DIAG_NO_LISTENER]


def test_orphan_wording_depends_on_whether_it_was_registered():
    """同一张卡不能上一句说"没登记"、下一句说"登记了却没人用"。"""
    typo = build_index(make_source(narrative=narrative_with())).card("我随手打错的名字")
    assert typo.kind == KIND_UNKNOWN
    orphan = [d for d in typo.diagnostics if d.code == DIAG_ORPHAN][0]
    assert "查无此名" in orphan.message and "登记了却" not in orphan.message
    # 「没登记」与「查无此名」是同一件事，不并排说两遍
    assert [d.code for d in typo.diagnostics] == [DIAG_ORPHAN]

    registered = build_index(make_source(
        narrative=narrative_with(signals=[{"id": "sig_x"}]))).card("sig_x")
    assert "登记了却没人发" in [d.message for d in registered.diagnostics][0]


def test_condition_text_uses_labels_even_for_graphs_scanned_later():
    """条件人话要等全部图扫完再渲染：急着渲染时前向引用的图还没进目录，
    同一块面板会一半中文名、一半原始 id。"""
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_x",
                      "conditions": [{"narrative": "scenario_later", "state": "done"}]}],
        elements=[{
            "id": "el_later", "kind": "scenarioSubgraph", "label": "后面才扫到的图",
            "graph": {
                "id": "scenario_later", "label": "听书",
                "initialState": "idle",
                "states": {"idle": {"label": "没开始"}, "done": {"label": "听完了"}},
                "transitions": [],
            },
        }],
    )
    listener = build_index(make_source(narrative=narrative)).card("sig_x").listeners[0]
    assert listener.conditions == ["「听书」正停在「听完了」"], listener.conditions


def test_state_read_rows_carry_anchors_so_they_can_be_located():
    quests = [{"id": "q_1", "requires": {"all": [{"narrative": "flow_main", "state": "s_b"}]}}]
    index = build_index(make_source(
        narrative=narrative_with(states={"s_b": {"label": "接了活", "broadcastOnEnter": True}}),
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)],
    ))
    read = index.card("state:flow_main:s_b").state_reads[0]
    assert read.anchors and read.anchors[0][1] == "q_1"


def test_unregistered_signal_is_flagged_but_still_listed():
    doc = {"id": "d", "nodes": {"n": {"type": "runActions", "actions": [emit("sig_ghost")]}}}
    index = build_index(make_source(
        narrative=narrative_with(
            transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_ghost"}]),
        dialogues=[DialogueDoc("d", "d.json", doc)],
    ))
    card = index.card("sig_ghost")
    assert card.kind == KIND_UNKNOWN
    assert [d.code for d in card.diagnostics] == [DIAG_UNREGISTERED]
    assert "sig_ghost" in index.all_signal_ids()


def test_orphan_registered_signal_is_flagged():
    card = build_index(make_source(narrative=narrative_with(signals=[{"id": "sig_x"}]))).card("sig_x")
    assert [d.code for d in card.diagnostics] == [DIAG_ORPHAN]


def test_draft_signal_says_it_is_a_placeholder_and_nothing_else():
    narrative = narrative_with(
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "__draft__"}])
    card = build_index(make_source(narrative=narrative)).card("__draft__")
    assert card.kind == KIND_DRAFT
    assert [d.code for d in card.diagnostics] == [DIAG_DRAFT]
    assert card.diagnostics[0].severity == "info"


def test_draft_signal_sorts_last_in_the_catalogue():
    narrative = narrative_with(
        signals=[{"id": "zz_last"}],
        transitions=[{"id": "t1", "from": "s_a", "to": "s_b", "signal": "__draft__"}])
    assert build_index(make_source(narrative=narrative)).all_signal_ids()[-1] == "__draft__"


# --------------------------------------------------------------------------- #
# 私有信号（scope）与宿主身份
# --------------------------------------------------------------------------- #

def test_private_scope_travels_from_the_registry_onto_the_card():
    """注册表标了 private，卡上就必须看得出来。

    丢掉 scope 的后果不是"少一个字段"：私有信号只投递给发射方 owner 拥有的 wrapper 图，
    与全局信号的投递面差着天，而两者在界面上会长得一模一样。
    """
    narrative = narrative_with(signals=[
        {"id": "sig_box_taken", "label": "箱子被拿了", "scope": "private"},
    ])
    card = build_index(make_source(narrative=narrative)).card("sig_box_taken")
    assert card.scope == "private"
    assert card.is_private is True
    payload = card.to_dict()
    assert payload["scope"] == "private" and payload["private"] is True


def test_global_and_absent_scope_are_both_not_private():
    """缺省 = 全局。`scope` 原样带出，**不替作者补默认值**。

    未登记的信号根本没有这一栏；硬填 'global' 会让"没登记"与"登记了是全局"在界面上
    长成同一个样子，而前者是校验会一直报的问题。
    """
    narrative = narrative_with(signals=[
        {"id": "sig_global", "scope": "global"},
        {"id": "sig_plain"},
    ])
    index = build_index(make_source(narrative=narrative))
    assert index.card("sig_global").scope == "global"
    assert index.card("sig_global").is_private is False
    assert index.card("sig_plain").scope == ""
    assert index.card("sig_plain").is_private is False
    ghost = index.card("sig_never_heard_of")
    assert ghost.scope == "" and ghost.is_private is False


def test_emitter_shows_the_owner_binding_written_at_the_emit_point():
    """`ownerType` + `ownerId` = 数据里唯一静态看得见的宿主身份，卡上必须标出来。

    私有信号按发射方 owner 定向投递；owner 绝大多数由发射点上下文隐式带进来（扫不出来），
    显式那对参数是作者能写、也是 xref 唯一能看见的一档。
    """
    doc = {"id": "d", "nodes": {"n": {"type": "runActions", "actions": [
        emit("sig_box_taken", "d", owner_type="hotspot", owner_id="义庄:hs_箱子"),
    ]}}}
    index = build_index(make_source(
        narrative=narrative_with(signals=[{"id": "sig_box_taken", "scope": "private"}]),
        dialogues=[DialogueDoc("d", "d.json", doc)],
    ))
    e = index.card("sig_box_taken").emitters[0]
    assert e.owner_bound is True
    assert (e.owner_type, e.owner_id) == ("hotspot", "义庄:hs_箱子")
    assert "带宿主身份：hotspot:义庄:hs_箱子" in e.note
    assert "留痕来源" in e.note, "留痕来源与宿主身份是两回事，不许互相顶掉"
    payload = e.to_dict()
    assert payload["ownerBound"] is True
    assert payload["ownerType"] == "hotspot" and payload["ownerId"] == "义庄:hs_箱子"


def test_half_an_owner_binding_is_not_dressed_up_as_bound():
    """只填一半 = 运行时**整对丢弃**、退回来源上下文那一档。

    照单显示半对参数等于告诉作者"定向已经钉好了"，而实际那一发会落到别的 owner 上，
    或者缺 owner 被当场丢掉。判据必须与 ActionRegistry 逐字一致。
    """
    doc = {"id": "d", "nodes": {"n": {"type": "runActions", "actions": [
        emit("sig_half", owner_type="hotspot"),          # 只有类型
        emit("sig_half_2", owner_id="义庄:hs_箱子"),      # 只有 id
    ]}}}
    index = build_index(make_source(
        narrative=narrative_with(), dialogues=[DialogueDoc("d", "d.json", doc)],
    ))
    for sid in ("sig_half", "sig_half_2"):
        e = index.card(sid).emitters[0]
        assert e.owner_bound is False, sid
        assert (e.owner_type, e.owner_id) == ("", ""), sid
        assert "宿主身份" not in e.note, sid


def test_owner_binding_predicate_matches_the_runtime_typescript():
    """口径护栏：`ownerType && ownerId ? 参数 : origin` 这一条判据必须与运行时同源。

    两处各写一份的后果就是同一份数据在 xref 与游戏里给出相反的投递面。
    """
    ts = (REPO_ROOT / "src/core/ActionRegistry.ts").read_text(encoding="utf-8")
    assert "paramOwnerType && paramOwnerId ? paramOwnerType" in ts, (
        "运行时的 owner 覆盖判据变了：scan._owner_binding 的「两个都填才算」必须跟着改"
    )
    assert scan_mod._owner_binding({"params": {"ownerType": "npc", "ownerId": "x"}}) == ("npc", "x")
    assert scan_mod._owner_binding({"params": {"ownerType": "npc"}}) == ("", "")
    assert scan_mod._owner_binding({"params": {}}) == ("", "")
    assert scan_mod._owner_binding(None) == ("", "")


# --------------------------------------------------------------------------- #
# 稳定性 / 健壮性
# --------------------------------------------------------------------------- #

def test_scan_is_deterministic():
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        transitions=[
            {"id": "t2", "from": "s_a", "to": "s_b", "signal": "sig_x"},
            {"id": "t1", "from": "s_b", "to": "s_a", "signal": "sig_x"},
        ],
    )
    first = build_index(make_source(narrative=narrative)).card("sig_x").to_dict()
    second = build_index(make_source(narrative=narrative)).card("sig_x").to_dict()
    assert first == second
    assert [l["transitionId"] for l in first["listeners"]] == ["t1", "t2"]


# 坏数据不许把面板炸掉——编辑器里半截数据是常态（手改坏的、老格式、别的工具写坏的）。
# ⚠ 这组参数**必须原样进扫描**：早先版本写成 `junk if isinstance(junk, dict) else {}`，
# 把 None/[]/""/0 四个全塌缩成同一个空 dict，6 个 case 实际只测了 3 种形状；
# 加上一条恒真断言（all_signal_ids 按构造必返 list），整条测试是空的——
# 而真正会抛的 `{"compositions": 5}` 那族当时全都没盖到（2026-08-07 独立审查坐实）。
@pytest.mark.parametrize("junk", [
    None, [], "", 0, 3.5, True,
    {"compositions": "nope"},
    {"compositions": [None, 3]},
    {"compositions": 5},                                    # 非可迭代：曾 TypeError
    {"graphs": 7},
    {"signals": "nope"},
    {"compositions": [{"id": "c", "mainGraph": {"id": "g", "states": {}, "transitions": 3}}]},
    {"compositions": [{"id": "c", "mainGraph": {"id": "g", "states": {}}, "elements": 9}]},
    {"compositions": [{"id": "c", "mainGraph": {"id": "g", "states": "nope"}}]},
    {"compositions": [{"id": "c", "mainGraph": {"id": "g", "states": {},
                                                "transitions": [{"id": "t", "priority": "高"}]}}]},
])
def test_broken_shapes_never_raise(junk):
    index = build_index(make_source(narrative=junk))
    assert index.card("whatever").signal == "whatever"
    assert index.overview() == [] or all(c.signal for c in index.overview())
    # 真扫过一遍才算数：坏结构下 all_signal_ids 至少得是可用的空集，而不是抛出来
    assert isinstance(index.all_signal_ids(), list)


def test_self_referencing_and_very_deep_data_never_raise():
    """内存里的结构可能自引用（编辑器里手滑就能造出来）；递归兜底闸要接住。"""
    cyclic: dict = {"nodes": {}}
    cyclic["nodes"]["self"] = cyclic
    deep: dict = {}
    cursor = deep
    for _ in range(2000):
        cursor["n"] = {}
        cursor = cursor["n"]
    for doc in (cyclic, deep):
        index = build_index(make_source(dialogues=[DialogueDoc("d", "d.json", doc)]))
        assert index.all_signal_ids() == []


def test_a_hit_below_the_depth_gate_still_gets_found():
    """闸是兜底不是省事：正常深度（十几层）的发射必须照常扫得到。"""
    node: dict = {"type": "runActions", "actions": [emit("sig_deep")]}
    for _ in range(20):
        node = {"wrap": node}
    index = build_index(make_source(dialogues=[DialogueDoc("d", "d.json", {"nodes": {"n": node}})]))
    assert index.card("sig_deep").real_emitter_count == 1


def test_signal_id_with_slash_keeps_pointer_escaped():
    doc = {"id": "d", "nodes": {"n/1": {"type": "runActions", "actions": [emit("sig_a")]}}}
    e = build_index(make_source(
        narrative=narrative_with(), dialogues=[DialogueDoc("d", "d.json", doc)],
    )).card("sig_a").emitters[0]
    assert e.pointer == "/nodes/n~11/actions/0"


def test_card_of_unknown_signal_is_empty_but_valid():
    card = build_index(make_source(narrative=narrative_with())).card("never_seen")
    assert card.emitters == [] and card.listeners == []
    assert card.to_dict()["emitterCount"] == 0


# --------------------------------------------------------------------------- #
# 真实工程：口径对账
# --------------------------------------------------------------------------- #

class _FakeModel:
    """给 narrative_catalog.emitted_signal_ids 用的只读壳（它只 getattr，不需要 Qt）。"""

    def __init__(self, root: Path) -> None:
        self.dialogues_path = root / "public" / "assets" / "dialogues"
        data = root / "public" / "assets" / "data"
        self.narrative_graphs = _read(data / "narrative_graphs.json", {})
        self.scenes = {
            p.stem: _read(p, {}) for p in sorted((root / "public" / "assets" / "scenes").glob("*.json"))
        }
        self.quests = _read(data / "quests.json", [])
        self.items = _read(data / "items.json", [])
        self.clues_registry = _read(data / "clues.json", {})
        self.encounters = _read(data / "encounters.json", [])
        self.cutscenes = _read(data / "cutscenes" / "index.json", [])
        self.pressure_holds = _read(data / "pressure_holds.json", [])
        self.signal_cues = _read(data / "signal_cues.json", [])
        self.archive_characters = _read(data / "archive" / "characters.json", [])
        self.archive_books = _read(data / "archive" / "books.json", [])
        self.archive_documents = _read(data / "archive" / "documents.json", [])
        self.archive_lore = _read(data / "archive" / "lore.json", {})
        for family, attr in (
            ("water_minigames", "water_minigames_instances"),
            ("sugar_wheel", "sugar_wheel_instances"),
            ("paper_craft", "paper_craft_instances"),
            ("object_examine", "object_examine_instances"),
        ):
            setattr(self, attr, _load_family(data / family))


def _read(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _load_family(base: Path) -> dict:
    out: dict[str, dict] = {}
    index = _read(base / "index.json", [])
    if not isinstance(index, list):
        return out
    for row in index:
        if not isinstance(row, dict):
            continue
        iid = str(row.get("id") or "").strip()
        name = row.get("file")
        if iid and isinstance(name, str):
            doc = _read(base / name, None)
            if isinstance(doc, dict):
                out[iid] = doc
    return out


@pytest.fixture(scope="module")
def real_index():
    return build_index(from_disk(REPO_ROOT))


def test_real_project_matches_catalog_emitted_signal_ids(real_index):
    """与 emitted-signal-catalog 的权威口径逐条对账（实发，不含黑盒声明）。"""
    from tools.editor.shared.narrative_catalog import emitted_signal_ids

    expected = set(emitted_signal_ids(_FakeModel(REPO_ROOT)))
    got = {c.signal for c in real_index.overview() if c.real_emitter_count > 0}
    assert got == expected, f"仅 xref 认为有人发：{got - expected}；仅目录认为有人发：{expected - got}"


def test_real_project_listeners_match_a_naive_transition_sweep(real_index):
    """接收方口径对账：全文件平扫一遍所有转移的 signal（排除反应式）。"""
    narrative = _read(REPO_ROOT / "public/assets/data/narrative_graphs.json", {})
    expected: dict[str, int] = {}
    for comp in narrative.get("compositions", []):
        graphs = [comp.get("mainGraph")] + [e.get("graph") for e in comp.get("elements", []) or []]
        for graph in graphs:
            if not isinstance(graph, dict):
                continue
            for t in graph.get("transitions", []) or []:
                sig = str(t.get("signal") or "").strip()
                if sig and str(t.get("trigger") or "") not in ("reactive", "reactiveAll", "reactiveAny"):
                    expected[sig] = expected.get(sig, 0) + 1
    got = {sig: len(rows) for sig, rows in real_index.listeners.items()}
    assert got == expected


def test_real_project_every_location_is_resolvable(real_index):
    """每条定位都要真能落到一个存在的文件 + 指针（否则界面上就是点不动的死行）。"""
    for card in real_index.overview():
        for e in card.emitters:
            if e.channel == CHANNEL_UPSTREAM and not e.file:
                continue
            assert e.file and (REPO_ROOT / e.file).is_file(), f"{card.signal}: {e.file}"
            assert e.pointer.startswith("/") or e.pointer == "", f"{card.signal}: {e.pointer!r}"
            assert _resolve_pointer(REPO_ROOT / e.file, e.pointer) is not None, (
                f"{card.signal} 的发送方指针解不出来：{e.file}#{e.pointer}")
        for l in card.listeners:
            assert _resolve_pointer(REPO_ROOT / l.file, l.pointer) is not None, (
                f"{card.signal} 的接收方指针解不出来：{l.file}#{l.pointer}")
        for r in card.state_reads:
            assert _resolve_pointer(REPO_ROOT / r.file, r.pointer) is not None, (
                f"{card.signal} 的读状态指针解不出来：{r.file}#{r.pointer}")


def _resolve_pointer(path: Path, pointer: str):
    node = _read(path, None)
    if node is None:
        return None
    for seg in [s.replace("~1", "/").replace("~0", "~") for s in pointer.split("/")[1:]]:
        if isinstance(node, list):
            if not seg.isdigit() or int(seg) >= len(node):
                return None
            node = node[int(seg)]
        elif isinstance(node, dict):
            if seg not in node:
                return None
            node = node[seg]
        else:
            return None
    return node


def test_real_project_scan_is_fast_enough_for_a_panel(real_index):
    """面板每次打开都会重扫；慢到秒级就没人用了。"""
    import time

    start = time.perf_counter()
    build_index(from_disk(REPO_ROOT))
    assert time.perf_counter() - start < 3.0


# --------------------------------------------------------------------------- #
# 审查打回的口径问题（2026-08-07 独立审查）
# --------------------------------------------------------------------------- #

def test_unwired_upstream_is_marked_not_dressed_up_as_a_path():
    """占位信号的上游转移运行时拒发。说成「收到信号 __draft__ 时走」＝给一条走不通的路。"""
    narrative = narrative_with(
        states={"s_a": {"label": "开局"}, "s_b": {"label": "接了活", "broadcastOnEnter": True}},
        transitions=[{"id": "t_draft", "from": "s_a", "to": "s_b", "signal": "__draft__"}],
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_b")
    ups = [e for e in card.emitters if e.channel == CHANNEL_UPSTREAM]
    assert len(ups) == 1
    assert ups[0].wired is False
    assert "还没接线" in ups[0].context
    assert "__draft__" not in ups[0].context, "别把占位信号名当成「要收到的信号」报出去"
    codes = [d.code for d in card.diagnostics]
    assert DIAG_UNREACHABLE in codes, "唯一进得来的路没接线时要明说这一拍到不了"


def test_reactive_upstream_is_still_a_real_path():
    """反过来：反应式转移的 signal 恒是占位，但线接在条件上——不许一并冤枉。"""
    narrative = narrative_with(
        states={"s_a": {"label": "开局"}, "s_b": {"label": "接了活", "broadcastOnEnter": True}},
        transitions=[{"id": "t_r", "from": "s_a", "to": "s_b", "signal": "__draft__",
                      "trigger": "reactive", "conditions": [{"flag": "f", "value": True}]}],
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_b")
    ups = [e for e in card.emitters if e.channel == CHANNEL_UPSTREAM]
    assert ups[0].wired is True
    assert "条件满足就自动走" in ups[0].context
    assert DIAG_UNREACHABLE not in [d.code for d in card.diagnostics]


def test_wiring_predicate_is_shared_with_the_debugger():
    """两个工具必须用同一条判据——各写一份的后果是同一份数据给出相反答案。"""
    from tools.narrative_debugger.model import Transition
    from tools.narrative_xref.model import transition_is_unwired

    for signal, trigger in (("__draft__", ""), ("__draft__", "reactive"), ("sig", ""), ("", "")):
        engine = transition_is_unwired(signal, trigger)
        debugger = Transition("g", "t", "a", "b", signal, trigger or "signal").is_unwired
        assert engine == debugger, f"{signal!r}/{trigger!r}: 引擎 {engine} vs 调试器 {debugger}"


def test_reactive_trigger_table_matches_the_runtime_typescript():
    """反应式触发表的真相源在 TS。Python 侧只留这一份（调试器 import 它），对着 TS 锁。"""
    import re

    source = (REPO_ROOT / "src" / "core" / "NarrativeStateManager.ts").read_text(encoding="utf-8")
    match = re.search(r"trigger\?:\s*((?:'[a-zA-Z]+'\s*\|\s*)+'[a-zA-Z]+')\s*;", source)
    assert match, "运行时的 trigger 联合类型必须保持可解析"
    runtime = {t.strip("' ") for t in match.group(1).split("|")} - {"signal"}
    from tools.narrative_xref.model import REACTIVE_TRIGGERS

    assert runtime == set(REACTIVE_TRIGGERS), f"TS {runtime} vs Python {set(REACTIVE_TRIGGERS)}"


def test_state_reads_inside_the_narrative_file_carry_canvas_coordinates():
    """读状态的引用有一半就写在 narrative_graphs.json 里（转移条件）。这类行必须能画布定位，
    否则「去看看」只会打开叙事状态机页——而人本来就在那一页。"""
    narrative = narrative_with(
        states={"s_a": {"label": "开局"}, "s_b": {"label": "接了活", "broadcastOnEnter": True}},
        transitions=[{"id": "t_c", "from": "s_a", "to": "s_a", "trigger": "reactive",
                      "signal": "__draft__",
                      "conditions": [{"narrative": "flow_main", "state": "s_b"}]}],
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_b")
    assert card.state_reads, "条件里读了它，必须列出来"
    read = card.state_reads[0]
    assert read.composition_id == "comp_1"
    assert read.host_graph_id == "flow_main"
    assert read.host_transition_id == "t_c"
    assert read.graph_id == "flow_main" and read.state_id == "s_b", "被读的那张图/态不许被覆盖"


def test_nameless_entries_fall_back_to_a_readable_name():
    """map_config 的节点没有 id：只认 id 的话标题是「地图节点「」」，等于让人自己猜。"""
    nodes = {"nodes": [{"name": "城门口", "unlockConditions": [{"narrative": "flow_main", "state": "s_a"}]}]}
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("map_nodes", "mapNode", "", "地图节点",
                         "public/assets/data/map_config.json", nodes, scan_emits=False)],
    ))
    read = index.state_reads[("flow_main", "s_a")][0]
    assert read.container_id == "城门口"
    assert "解锁条件" in read.where and "unlockConditions" not in read.where


def test_transition_index_survives_junk_elements_and_same_id_graphs():
    """读状态行的画布定位靠"指针下标 → 转移 id"。压缩列表会错位一格——
    那不是"跳不过去"，是**跳到别的转移上**（2026-08-07 复审坐实）。"""
    narrative = narrative_with(
        states={"s_a": {"label": "甲"}, "s_b": {"label": "乙", "broadcastOnEnter": True}},
        transitions=[
            None,                                                     # 坏元素也要占号
            {"id": "t1", "from": "s_a", "to": "s_a", "trigger": "reactive", "signal": "__draft__",
             "conditions": [{"narrative": "flow_main", "state": "s_b"}]},
            {"id": "t2", "from": "s_a", "to": "s_b", "signal": "sig"},
        ],
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_b")
    assert card.state_reads[0].host_transition_id == "t1", "错位一格就会定位到 t2"


def test_broadcast_state_with_no_way_in_is_reported():
    """1 条占位路会 warning，0 条路反而清白——那是诊断面的盲区。"""
    narrative = narrative_with(
        states={"s_a": {"label": "甲"}, "s_b": {"label": "乙", "broadcastOnEnter": True}},
        transitions=[{"id": "t", "from": "s_a", "to": "s_a", "signal": "state:flow_main:s_b"}],
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_b")
    assert DIAG_UNREACHABLE in [d.code for d in card.diagnostics]
    assert "没有任何路能进到这一拍" in " ".join(d.message for d in card.diagnostics)


def test_initial_state_is_not_reported_as_unreachable():
    """初始状态没有上游转移是正常的（图一激活就停在那儿），别误报。"""
    narrative = narrative_with(
        states={"s_a": {"label": "甲", "broadcastOnEnter": True}}, initial="s_a",
    )
    card = build_index(make_source(narrative=narrative)).card("state:flow_main:s_a")
    assert DIAG_UNREACHABLE not in [d.code for d in card.diagnostics]


# --------------------------------------------------------------------------- #
# 状态维度：这一拍怎么进来、去哪、谁在看着
# --------------------------------------------------------------------------- #

def test_state_card_answers_all_four_questions():
    narrative = narrative_with(
        states={"s_a": {"label": "开局"}, "s_b": {"label": "接了活", "broadcastOnEnter": True,
                                                 "onEnterActions": [emit("sig_enter")]}},
        transitions=[{"id": "t_in", "from": "s_a", "to": "s_b", "signal": "sig_go"},
                     {"id": "t_out", "from": "s_b", "to": "s_a", "signal": "sig_back"}],
        signals=[{"id": "sig_go"}, {"id": "sig_back"}, {"id": "sig_enter"}],
    )
    quests = [{"id": "q_1", "requires": {"narrative": "flow_main", "state": "s_b"}}]
    index = build_index(make_source(
        narrative=narrative,
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)],
    ))
    card = index.state_card("flow_main", "s_b")
    assert card.exists and card.broadcasts and not card.is_initial
    assert card.graph_label == "主线" and card.state_label == "接了活"
    assert [e.transition_id for e in card.ways_in] == ["t_in"]
    assert [l.transition_id for l in card.ways_out] == ["t_out"]
    assert {e.signal for e in card.emits} == {"sig_enter", "state:flow_main:s_b"}
    assert [r.container_id for r in card.readers] == ["q_1"]
    assert card.broadcast_signal == "state:flow_main:s_b"


def test_state_card_flags_a_beat_you_can_never_reach():
    narrative = narrative_with(states={"s_a": {"label": "开局"}, "s_b": {"label": "到不了"}})
    card = build_index(make_source(narrative=narrative)).state_card("flow_main", "s_b")
    assert DIAG_STATE_NO_WAY_IN in [d.code for d in card.diagnostics]
    assert DIAG_STATE_MISSING not in [d.code for d in card.diagnostics]


def test_state_card_flags_a_ghost_beat_that_is_referenced_but_absent():
    """被引用、图里却没有——引用它的条件会永远判不成立，这是最值钱的一条诊断。"""
    quests = [{"id": "q_1", "requires": {"narrative": "flow_main", "state": "根本没有这个态"}}]
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)],
    ))
    card = index.state_card("flow_main", "根本没有这个态")
    assert not card.exists
    assert [d.code for d in card.diagnostics] == [DIAG_STATE_MISSING]
    assert card.readers, "幽灵拍也要能看到是谁在引用它"
    assert ("flow_main", "根本没有这个态") in index.all_state_keys()


def test_initial_beat_is_not_flagged_for_having_no_way_in():
    card = build_index(make_source(narrative=narrative_with(initial="s_a"))).state_card("flow_main", "s_a")
    assert DIAG_STATE_NO_WAY_IN not in [d.code for d in card.diagnostics]


def test_state_readers_carry_where_they_live_not_where_they_point():
    """读状态那一行自带 graph_id（被读的那张图）。定位必须用 host_*，
    否则会跳到被读的图上去，而不是写着这条条件的那张图。"""
    narrative = narrative_with(
        states={"s_a": {"label": "开局"}, "s_b": {"label": "乙"}},
        transitions=[{"id": "t_c", "from": "s_a", "to": "s_a", "trigger": "reactive",
                      "signal": "__draft__",
                      "conditions": [{"narrative": "flow_main", "state": "s_b"}]}],
    )
    card = build_index(make_source(narrative=narrative)).state_card("flow_main", "s_b")
    read = card.readers[0]
    assert read.graph_id == "flow_main" and read.state_id == "s_b"     # 被读的
    assert read.host_graph_id == "flow_main" and read.host_transition_id == "t_c"  # 长在哪


def test_real_project_state_overview_is_complete_and_fast():
    import time

    index = build_index(from_disk(REPO_ROOT))
    start = time.perf_counter()
    cards = index.state_overview()
    assert time.perf_counter() - start < 1.0
    assert len(cards) > 150, "真实工程状态不止这么点"
    watched = [c for c in cards if c.readers]
    assert len(watched) > 50
    # 每张卡的定位都要能解析（跳不动的行 = 死按钮）
    for card in watched[:40]:
        for r in card.readers:
            assert r.file and (REPO_ROOT / r.file).is_file()


def test_reactive_transition_that_names_a_signal_is_shown_but_not_counted():
    """反应式转移不吃信号，但策划确实在 signal 字段里写了名字。

    只说"没人听"会让人对着自己写的名字发懵（真实数据上就撞到了：主线入口
    `Demo主线开始` 挂在一条 reactive 转移上）；算成监听又是骗人。单列一栏 + 一条诊断。
    """
    narrative = narrative_with(
        signals=[{"id": "sig_x"}],
        transitions=[{"id": "t_r", "from": "s_a", "to": "s_b", "signal": "sig_x",
                      "trigger": "reactive", "conditions": [{"flag": "f", "value": True}]}],
    )
    card = build_index(make_source(narrative=narrative)).card("sig_x")
    assert card.listeners == [], "反应式不算接收方"
    assert [l.transition_id for l in card.reactive_refs] == ["t_r"]
    codes = [d.code for d in card.diagnostics]
    assert DIAG_REACTIVE_ONLY in codes
    assert "反应式不吃信号" in " ".join(d.message for d in card.diagnostics)


def test_draft_signal_on_a_reactive_transition_is_not_listed_as_a_reference():
    """占位信号是反应式转移的**正常**写法，别把它列进"填了它"那一栏刷屏。"""
    narrative = narrative_with(
        transitions=[{"id": "t_r", "from": "s_a", "to": "s_b", "signal": "__draft__",
                      "trigger": "reactive", "conditions": [{"flag": "f", "value": True}]}],
    )
    card = build_index(make_source(narrative=narrative)).card("__draft__")
    assert card.reactive_refs == []


# --------------------------------------------------------------------------- #
# 引用要落到「世界里的那个东西」——策划盯的是实体与流程，不是 conditions[0]
# --------------------------------------------------------------------------- #

def test_scene_entity_reference_resolves_to_the_thing_in_the_world():
    scene = {
        "id": "雾津街头",
        "npcs": [{
            "id": "npc_零工工头", "name": "挑空担的汉子",
            "conditions": [{"narrative": "flow_main", "state": "s_b", "reached": True}],
            "conditionHidesEntity": True,
        }],
        "hotspots": [{
            "id": "T_出城", "label": "出城（河滩方向）",
            "conditions": [{"narrative": "flow_main", "state": "s_b"}],
        }],
        "zones": [{"id": "z_找活", "conditions": [{"not": {"narrative": "flow_main", "state": "s_b"}}]}],
    }
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("scenes", "scene", "雾津街头", "场景",
                         "public/assets/scenes/雾津街头.json", scene)],
    ))
    rows = {r.subject_kind: r for r in index.state_reads[("flow_main", "s_b")]}
    assert rows["npc"].subject_name == "挑空担的汉子"          # 名字，不是 id
    assert rows["npc"].subject_kind_label == "NPC"            # 类别说"NPC"，不是"场景"
    assert rows["npc"].subject_scene == "雾津街头"
    assert rows["npc"].subject_effect == "出不出现"            # conditionHidesEntity=true
    assert rows["npc"].reached is True

    assert rows["hotspot"].subject_name == "出城（河滩方向）"
    assert rows["hotspot"].subject_effect == "能不能互动"       # 没有 conditionHidesEntity
    assert rows["hotspot"].reached is False

    assert rows["zone"].subject_id == "z_找活"                 # 区域没名字，退回 id
    assert rows["zone"].negated is True, "被 not 包着——漏掉会把结论说反"


def test_every_reference_in_the_real_project_resolves_to_something():
    """一条都不许剩"没认出是什么"——那种行对策划等于没有。"""
    index = build_index(from_disk(REPO_ROOT))
    unresolved = [
        (r.container_kind, r.file, r.pointer)
        for rows in index.state_reads.values() for r in rows
        if not r.subject_kind or not r.subject_display
    ]
    assert not unresolved, f"这些引用落不到具体东西上：{unresolved[:5]}"


# --------------------------------------------------------------------------- #
# 状态维度审查打回的（2026-08-08）
# --------------------------------------------------------------------------- #

def test_broadcast_beat_lists_its_signal_once():
    """广播行由 _scan_graphs 造并自带坐标，推导式已经收了——再 extend 一次就整行重复。"""
    narrative = narrative_with(states={"s_b": {"label": "乙", "broadcastOnEnter": True}})
    card = build_index(make_source(narrative=narrative)).state_card("flow_main", "s_b")
    assert len(card.emits) == 1
    assert card.emits[0].signal == "state:flow_main:s_b"


def test_ways_out_never_dresses_up_an_unwired_placeholder():
    """出口那栏以前直接打 signal，把走不通的占位路说成「收到「__draft__」」。"""
    narrative = narrative_with(
        transitions=[{"id": "t", "from": "s_a", "to": "s_b", "signal": "__draft__"}])
    card = build_index(make_source(narrative=narrative)).state_card("flow_main", "s_a")
    assert card.ways_out[0].how == "这条路还没接线（占位信号，运行时不会发）"
    assert "__draft__" not in card.ways_out[0].how


def test_transition_how_is_computed_once_for_all_three_uis():
    narrative = narrative_with(transitions=[
        {"id": "t1", "from": "s_a", "to": "s_b", "signal": "sig"},
        {"id": "t2", "from": "s_a", "to": "s_b", "signal": "__draft__", "trigger": "reactive"},
        {"id": "t3", "from": "s_a", "to": "s_b", "signal": ""},
    ])
    hows = [l.how for l in build_index(make_source(narrative=narrative)).state_card("flow_main", "s_a").ways_out]
    assert hows == ["收到信号「sig」时走", "条件满足就自动走", "没接触发条件"]


def test_narrative_internal_reference_names_the_graph_not_the_transition():
    """转移是容器不是"东西"：标成「叙事图「t_2」」既没说是哪张图，t_2 也不是图。"""
    narrative = narrative_with(
        states={"s_a": {"label": "甲"}, "s_b": {"label": "乙"}},
        transitions=[{"id": "t_2", "from": "s_a", "to": "s_a", "trigger": "reactive",
                      "signal": "__draft__",
                      "conditions": [{"narrative": "flow_main", "state": "s_b"}]}])
    read = build_index(make_source(narrative=narrative)).state_card("flow_main", "s_b").readers[0]
    assert read.subject_display == "主线", "主体是那张图"
    assert read.subject_id == "flow_main"
    assert "转移「t_2」" in read.where, "转移号退到位置那一行"


def test_run_lifecycle_actions_do_not_invent_a_ghost_beat():
    """活计四件套没有 stateId：登记成状态引用会造出空 id 的幽灵拍 + 一条假 error。"""
    quests = [{"id": "q_1", "onComplete": [
        {"type": "startNarrativeRun", "params": {"graphId": "flow_main"}}]}]
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)]))
    assert all(sid for _gid, sid in index.all_state_keys()), "不许有空态 id 的幽灵拍"


def test_double_negation_is_not_reported_as_negated():
    """双重否定等于没否定。判成取反会把结论**说反**——最严重的错法。"""
    quests = [{"id": "q_1", "requires": {"not": {"not": {"narrative": "flow_main", "state": "s_b"}}}}]
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)]))
    assert index.state_reads[("flow_main", "s_b")][0].negated is False


def test_reached_false_is_not_read_as_reached():
    """`"reached": false` 是合法数据；用 `is not None` 会把它说成「到过」，
    调试器还会把本可判定的降级成「判不出来」。判据对齐运行时的 `=== true`。"""
    quests = [{"id": "q_1", "requires": {"narrative": "flow_main", "state": "s_b", "reached": False}}]
    index = build_index(make_source(
        narrative=narrative_with(),
        assets=[AssetDoc("quests", "quest", "", "任务", "public/assets/data/quests.json", quests)]))
    assert index.state_reads[("flow_main", "s_b")][0].reached is False


def test_every_reference_resolves_to_a_nameable_thing():
    """比旧护栏严：不只要求非空，还要求**不是靠兜底填出来的容器 id**。

    旧断言 `subject_kind and subject_display` 因为 `subject_id = container_id or …` 的兜底
    恒真，证明不了"落到了具体东西上"（审查坐实：转移 id 被当成主体时它照样绿）。
    """
    index = build_index(from_disk(REPO_ROOT))
    bad: list[str] = []
    for rows in index.state_reads.values():
        for r in rows:
            if not r.subject_kind_label:
                bad.append(f"{r.file}#{r.pointer} 没有类别")
            elif r.subject_kind == "narrative" and not r.subject_name:
                bad.append(f"{r.file}#{r.pointer} 叙事图引用没解析到图名")
            elif r.subject_kind in ("npc", "hotspot") and not (r.subject_name or r.subject_id):
                bad.append(f"{r.file}#{r.pointer} 场景实体既无名字也无 id")
    assert not bad, bad[:5]
