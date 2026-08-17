"""叙事调试器的护栏测试：翻译层与索引必须对着真实项目数据成立。

这些断言故意咬住真实内容（寻狗 demo 主线），因为工具的全部价值就是"把工程口径
译成策划看得懂的话"——翻译一漂，工具就变回一堆 JSON。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.narrative_debugger.humanize import (
    DRAFT_SIGNAL,
    VERDICT_BLOCKED,
    VERDICT_DANGLING,
    VERDICT_OK,
    TraceTranslator,
    player_action_for,
    signal_phrase,
    waiting_items,
)
from tools.narrative_debugger.model import NarrativeIndex, broadcast_key
from tools.narrative_debugger.savepoints import SavepointStore

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def index() -> NarrativeIndex:
    ix = NarrativeIndex(REPO_ROOT)
    ix.load()
    return ix


def test_loads_real_project_data(index: NarrativeIndex) -> None:
    assert index.load_errors == []
    assert len(index.graphs) > 20
    assert len(index.states) > 100
    assert index.fingerprint


def test_mainline_beats_are_ordered_from_initial(index: NarrativeIndex) -> None:
    beats = [b for b in index.beats if b.graph_id == "flow_xungou_main"]
    assert beats, "主线拍子不该为空"
    # 2026-08 开场重构后主线初态是「未开始」（state_1，开机旗门控）；
    # 旧 s01_tingshu（听书完成）已并入 initial，锚点换成稳定里程碑。
    assert beats[0].state_id == "state_1"
    labels = [b.label for b in beats]
    assert "背崖墓尸完成" in labels


def test_broadcast_edges_link_subgraph_to_mainline(index: NarrativeIndex) -> None:
    """跨图因果边是这张图的灵魂：子图末态 → 主线下一拍。

    （听书那条 2026-08 起改走显式信号「主线_开局被赶出茶馆」，不再是广播边；
    换用梦→主线这条仍在的广播边当锚点。）
    """
    key = broadcast_key("scenario_梦待死之礼", "woken")
    listeners = index.listeners.get(key)
    assert listeners, f"{key} 应当被主线监听"
    assert any(t.graph_id == "flow_xungou_main" for t in listeners)


def test_neighborhood_stays_small_and_two_sided(index: NarrativeIndex) -> None:
    # 锚在两侧都已接线的 s02b_meng（s02_beishi 的上游 t_6 还是 __draft__ 占位，画不出前侧）
    hood = index.neighborhood("flow_xungou_main.s02b_meng", 2)
    assert 2 <= len(hood.nodes) <= 40, "邻域必须小到一眼能看完"
    assert any(d < 0 for d in hood.depth.values()), "要看得见前面是哪儿"
    assert any(d > 0 for d in hood.depth.values()), "要看得见后面是哪儿"


def test_player_action_drills_through_broadcast(index: NarrativeIndex) -> None:
    """主线出口几乎都是 state:子图:末态，必须一路追到玩家真正要做的动作。"""
    items = waiting_items(index, "flow_xungou_main", "s02b_meng")
    assert items
    assert items[0].action, "追不到玩家动作 = 对策划没用"
    # 具体动作的措辞集合与 humanize 对齐：对话/走位/点热点/进场景都算"玩家真动手那一下"
    assert any(v in items[0].action for v in ("对话", "走进", "点「", "进这个场景"))


def test_every_mainline_beat_can_explain_next_action(index: NarrativeIndex) -> None:
    """每个已接线的主线拍子都要能说出"玩家该干嘛"。

    `__draft__` 出口是编辑器的合法占位（还没接线），它有自己的说法，不算失败。
    纯条件门控的反应式出口（如「未开始」等开机旗）追不到玩家动作，
    但 blocked_by 说得出在等什么条件——那就是它的答案，也不算失败。
    """
    unresolved = []
    for beat in index.beats:
        if beat.graph_id != "flow_xungou_main":
            continue
        items = [i for i in waiting_items(index, beat.graph_id, beat.state_id) if i.signal != DRAFT_SIGNAL]
        if items and not any(i.action or i.blocked_by for i in items):
            unresolved.append(beat.label)
    assert not unresolved, f"这些拍子说不出玩家该干嘛：{unresolved}"


def test_draft_placeholder_reads_as_not_wired_yet(index: NarrativeIndex) -> None:
    what, _ = signal_phrase(index, DRAFT_SIGNAL)
    assert "还没接线" in what
    assert DRAFT_SIGNAL not in what, "内部占位标记不该摆到策划面前"


def test_conditions_render_as_labels_not_ids(index: NarrativeIndex) -> None:
    with_conditions = [t for t in index.transitions if t.has_conditions]
    assert with_conditions
    for t in with_conditions:
        text = index.describe_conditions(t.conditions)
        assert text
        assert "{" not in text, f"条件没翻译干净，漏了原始 JSON：{text}"


def test_dangling_signal_is_called_out(index: NarrativeIndex) -> None:
    translator = TraceTranslator(index)
    entry = translator.translate(
        {"type": "signal.processed", "triggerKey": "no_such_signal_xyz", "payload": {"matchedGraphIds": []}},
        "12:00:00",
    )
    assert entry is not None
    assert entry.verdict == VERDICT_DANGLING


def test_blocked_transition_names_the_missing_condition(index: NarrativeIndex) -> None:
    target = next(t for t in index.transitions if t.has_conditions)
    translator = TraceTranslator(index)
    entry = translator.translate(
        {
            "type": "transition.blocked",
            "triggerKey": target.signal,
            "graphId": target.graph_id,
            "transitionId": target.transition_id,
            "payload": {"failing": [0]},
        },
        "12:00:00",
    )
    assert entry is not None
    assert entry.verdict == VERDICT_BLOCKED
    assert "条件没过" in entry.detail
    assert "「" in entry.detail, "必须说出缺的是哪个条件"


def test_signal_and_result_merge_into_one_line(index: NarrativeIndex) -> None:
    """一个玩家动作在时间线上只能占一行。"""
    translator = TraceTranslator(index)
    received = translator.translate(
        {"type": "signal.received", "triggerKey": "tingshu_kicked"}, "12:00:00"
    )
    processed = translator.translate(
        {
            "type": "signal.processed",
            "triggerKey": "tingshu_kicked",
            "payload": {"matchedGraphIds": ["scenario_听书"]},
        },
        "12:00:01",
    )
    assert received is not None and processed is not None
    assert received.merge_key == processed.merge_key != ""
    assert processed.verdict == VERDICT_OK


def test_duplicate_unlistened_issue_is_suppressed(index: NarrativeIndex) -> None:
    translator = TraceTranslator(index)
    entry = translator.translate(
        {"type": "issue", "payload": {"code": "signal.unlistened", "message": "..."}}, "12:00:00"
    )
    assert entry is None, "悬垂已经有人话版了，不该再播一条英文"


def test_unknown_signal_is_not_invented(index: NarrativeIndex) -> None:
    action, where = player_action_for(index, "definitely_not_a_real_signal")
    assert action == "" and where == "", "查不到就得说查不到，不能编"


def test_savepoint_roundtrip_and_staleness(tmp_path: Path) -> None:
    store = SavepointStore(tmp_path, "fingerprint-a", {"g": "gfp-1"})
    payload = json.dumps({"version": 1, "systems": {"flagStore": {}}})
    store.capture("g.s", "某一拍", payload, graph_id="g", state_id="s", scene_id="茶馆")
    assert store.has("g.s")
    assert store.payload("g.s") == payload
    assert not store.is_stale("g.s")

    reopened = SavepointStore(tmp_path, "fingerprint-b", {"g": "gfp-2"})
    assert reopened.has("g.s")
    assert reopened.is_stale("g.s"), "这张图改过之后，它的旧档必须标记为可能对不上"

    assert reopened.delete("g.s")
    assert not reopened.has("g.s")


def test_editing_one_graph_does_not_stale_other_graphs(tmp_path: Path) -> None:
    """逐图指纹：改一个错别字不该让所有存档点集体变灰。

    策划一天改十几次 JSON，全局哈希会让他每跳一次都被弹窗问一遍。
    """
    store = SavepointStore(tmp_path, "file-v1", {"a": "afp-1", "b": "bfp-1"})
    store.capture("a.s1", "A 的一拍", "{}", graph_id="a", state_id="s1")
    store.capture("b.s1", "B 的一拍", "{}", graph_id="b", state_id="s1")

    # 只有 a 图改了
    after = SavepointStore(tmp_path, "file-v2", {"a": "afp-2", "b": "bfp-1"})
    assert after.is_stale("a.s1")
    assert not after.is_stale("b.s1"), "改 A 图不该把 B 图的存档点也标灰"


def test_drifted_flag_survives_reopen(tmp_path: Path) -> None:
    """补记的档（演出中存不上、等结束才补）必须一直带着标记。

    只在弹窗里写等于没写——策划天天在左栏双击回退，标记丢了他就会拿错的现场评效果。
    """
    store = SavepointStore(tmp_path, "fp", {"g": "gfp"})
    store.capture("g.s1", "补记的一拍", "{}", graph_id="g", state_id="s1", drifted=True)
    store.capture("g.s2", "干净的一拍", "{}", graph_id="g", state_id="s2")

    reopened = SavepointStore(tmp_path, "fp", {"g": "gfp"})
    assert reopened.get("g.s1").drifted is True
    assert reopened.get("g.s2").drifted is False


def test_savepoints_do_not_touch_player_save_slots(tmp_path: Path) -> None:
    store = SavepointStore(tmp_path, "fp")
    store.capture("a.b", "x", "{}")
    written = list(store.root.rglob("*"))
    assert written, "档要落在工具自己的目录里"
    assert all("gamedraft_save_" not in p.name for p in written)


def test_pressure_holds_and_minigames_are_translated(index: NarrativeIndex) -> None:
    """按住不放的压力条、小游戏都是玩家真的动手那一下，必须能说人话。"""
    kinds = {e.kind for emitters in index.emitters.values() for e in emitters}
    assert "pressureHold" in kinds, "压力条没扫进来"
    assert "minigame" in kinds, "小游戏没扫进来"
    holds = [e for emitters in index.emitters.values() for e in emitters if e.kind == "pressureHold"]
    assert any(e.scene for e in holds), "压力条要能说出在哪个场景按"


def test_most_exits_say_where(index: NarrativeIndex) -> None:
    """策划卡住时问的是"去哪儿"。绝大多数出口必须答得上来。"""
    total = with_place = 0
    for t in index.transitions:
        if t.signal == DRAFT_SIGNAL:
            continue
        for item in waiting_items(index, t.graph_id, t.from_state):
            if item.signal != t.signal:
                continue
            total += 1
            if item.action_where:
                with_place += 1
    assert total > 50
    # 当前实测 134/135（唯一漏的那条是内容里真实的悬垂信号，全项目没人发它）。
    # 阈值卡在 0.9：翻译层退化时要立刻红，而不是等策划回来骂。
    assert with_place / total > 0.9, f"只有 {with_place}/{total} 个出口说得出地点"


def test_draft_placeholder_edges_are_not_drawn(index: NarrativeIndex) -> None:
    """编辑器占位不是真路：画在图上会让人以为"前面还漏了一拍"。

    （state_1 如今是真设计的门控态、由反应式边接进 initial，会画、该画；
    换 state_4 当锚点：它两侧 t_5/t_6 都还是纯 __draft__ 信号边，不该被画。）
    """
    hood = index.neighborhood("flow_xungou_main.s02_beishi", 2)
    for node in hood.nodes.values():
        assert node.state_id != "state_4", "纯占位边（__draft__ 非反应式）不该出现在邻域图里"


def test_scene_view_lists_every_line_in_that_place(index: NarrativeIndex) -> None:
    """人站在一个场景里，这儿能推动的**每一条线和每个状态**都要列得出来。

    只列主线那十来拍远远不够：主线下面还挂着三十多张子图，策划要找的多半在里面。
    """
    groups = index.scene_graphs("雾津街头")
    assert len(groups) > 5, "雾津街头是主场景，不该只挂几条线"
    total = sum(len(nodes) for _, nodes in groups)
    assert total > 30, f"只列出 {total} 个状态，明显没列全"
    labels = {index.graph_labels.get(g, g) for g, _ in groups}
    assert any("背尸" in x for x in labels), "背尸那两单在雾津街头接活，必须列出来"


def test_scene_view_lists_graphs_owned_by_someone_standing_there(index: NarrativeIndex) -> None:
    """挂在本场景某个人/物身上的图，一律要出现在这个场景里。

    只靠"这个场景能打出哪些信号"反查是不够的：赌坊门卫那张图听的是别处发的信号
    （还有 __draft__ 占位），反查一条都出不来——人明明就站在雾津街头，
    他的戏却在按场景看里彻底失踪。
    """
    owned: dict[str, set[str]] = {}
    for gid, owner in index.graph_owners.items():
        if owner.scene and index.graph_states(gid):
            owned.setdefault(owner.scene, set()).add(gid)
    assert owned, "没有一张图解析出 owner 所在场景，这条护栏就白设了"
    for scene, gids in owned.items():
        listed = {g for g, _ in index.scene_graphs(scene)}
        missing = gids - listed
        assert not missing, f"「{scene}」里挂着这些图，按场景看却列不出来：{sorted(missing)}"


def test_composition_exposes_subgraphs_not_just_mainline(index: NarrativeIndex) -> None:
    """按线看要能下钻到子图——mainGraph 那十来拍只是骨架。"""
    graphs = index.graphs_in_composition("xungou_demo_main")
    assert len(graphs) > 20, f"主线下面挂着几十张子图，只找到 {len(graphs)} 张"
    states = sum(len(index.graph_states(g)) for g in graphs)
    beats = [b for b in index.beats if b.composition_id == "xungou_demo_main"]
    assert states > len(beats) * 5, "子图状态数应远多于主线拍子数"


def test_emitter_with_known_scene_wins(index: NarrativeIndex) -> None:
    """同一信号有多个发射端时（比如两根压力条，其中一根数据里没人启动），
    要挑答得出地点的那个——否则白白丢掉"在哪儿"。"""
    multi = [
        signal
        for signal, emitters in index.emitters.items()
        if len([e for e in emitters if e.kind in {"pressureHold", "dialogue", "zone"}]) > 1
    ]
    lost = []
    for signal in multi:
        emitters = [e for e in index.emitters[signal] if e.kind in {"pressureHold", "dialogue", "zone"}]
        if any(e.scene for e in emitters):
            _, where = signal_phrase(index, signal)
            if not where:
                lost.append(signal)
    assert not lost, f"这些信号本来查得到地点却没说出来：{lost}"


def test_player_actions_cover_the_main_verbs(index: NarrativeIndex) -> None:
    """策划的主力操作都要在时间线上有一行：点物、找人、走位、按条、小游戏。"""
    translator = TraceTranslator(index)
    for kind in ("hotspot", "npc", "dialogue", "zone", "pressureHold", "minigame"):
        entry = translator.player_action_entry(kind, "x", "12:00")
        assert entry is not None, f"{kind} 这类动作在时间线上没有说法"
        assert entry.headline


def test_signal_choices_are_distinguishable(index: NarrativeIndex) -> None:
    """「假装做了那一下」的列表里，同名动作要靠"会让什么往前走"区分开。"""
    seen: dict[str, int] = {}
    for signal in index.listeners:
        if signal == DRAFT_SIGNAL:
            continue
        action, where = player_action_for(index, signal)
        outcome = "；".join(
            f"{index.graph_labels.get(t.graph_id, t.graph_id)}:{t.to_state}"
            for t in index.listeners[signal][:2]
        )
        key = f"{action}|{where}|{outcome}"
        seen[key] = seen.get(key, 0) + 1
    duplicates = sum(count - 1 for count in seen.values() if count > 1)
    assert duplicates < 8, f"还有 {duplicates} 行是重样的，挑不出想要的那条"


# --------------------------------------------------------------------------- #
# 反应式转移不是"没接线"（2026-08-07）
#
# 只看 signal == __draft__ 就判"没接"，会把**反应式转移**一并冤枉掉：它压根不吃信号，
# signal 字段恒是占位，线接在 conditions 上。踩过：主线「闲逛A→闲逛B」写了条件，
# 因果图上不画、「在等」框还写"这条路还没接线"，而条件就打印在下一行。
# --------------------------------------------------------------------------- #

def _tiny_project(root: Path, transition: dict) -> NarrativeIndex:
    data_dir = root / "public" / "assets" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "narrative_graphs.json").write_text(json.dumps({
        "schemaVersion": 2,
        "signals": [],
        "compositions": [{
            "id": "comp", "label": "测试编排",
            "mainGraph": {
                "id": "flow_t", "label": "测试线", "ownerType": "flow",
                "initialState": "a",
                "states": {"a": {"id": "a", "label": "前一拍"}, "b": {"id": "b", "label": "后一拍"}},
                "transitions": [transition],
            },
            "elements": [],
        }],
    }, ensure_ascii=False), encoding="utf-8")
    index = NarrativeIndex(root)
    index.load()
    return index


def test_reactive_transition_is_not_treated_as_unwired(tmp_path: Path) -> None:
    index = _tiny_project(tmp_path, {
        "id": "t_r", "from": "a", "to": "b", "signal": DRAFT_SIGNAL, "trigger": "reactive",
        "conditions": [{"narrative": "flow_t", "state": "a"}],
    })
    assert index.predecessors("flow_t.b"), "接了条件的反应式转移必须画在因果图上"
    assert index.successors("flow_t.a"), "同上，正向也要有"
    item = waiting_items(index, "flow_t", "a")[0]
    assert "还没接线" not in item.what, item.what
    assert "自动" in item.what
    assert item.blocked_by, "条件要写出来（那才是这条路真正在等的东西）"


def test_plain_draft_transition_is_still_treated_as_unwired(tmp_path: Path) -> None:
    """真没接的（纯信号触发 + 占位信号）照旧不画、照旧说没接线——别把闸门一起拆了。"""
    index = _tiny_project(tmp_path, {"id": "t_d", "from": "a", "to": "b", "signal": DRAFT_SIGNAL})
    assert index.predecessors("flow_t.b") == []
    assert index.successors("flow_t.a") == []
    assert "还没接线" in waiting_items(index, "flow_t", "a")[0].what
