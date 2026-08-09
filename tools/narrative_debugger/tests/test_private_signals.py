"""私有信号在调试器里的四层护栏。

私有信号（`signals` 里 `scope:'private'`）只投给**发射方 owner 拥有的 wrapper 图**，
缺 owner 就被运行时 fail-loud 丢弃。调试器过去完全不认这回事：发出去静默没反应——
而"我这一下怎么没反应"正是这个工具存在的唯一理由。

真实工程数据里现在一条私有信号都没有（2026-08-09），所以这一族全用合成工程：
用真数据写这些断言，等第一条私有信号进来时它们才会开始跑，等于没有护栏。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from tools.narrative_debugger.hub import DebugHub
from tools.narrative_debugger.humanize import (
    PRIVATE_MARK,
    PRIVATE_NOTE,
    VERDICT_DANGLING,
    TraceTranslator,
    signal_phrase,
)
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_debugger.savepoints import SavepointStore
from tools.narrative_debugger.ui.main_window import MainWindow

PRIVATE = "箱子_被拿走"
GLOBAL = "全局_收工"


def _wrapper(
    el_id: str,
    graph_id: str,
    label: str,
    owner_id: str,
    *,
    extra_state: bool = False,
    owner_on: str = "both",
):
    """一张箱子 wrapper：available → taken，听那条私有信号。

    extra_state=True 时多挂一跳（拓扑不同），用来验"长得不一样的两跳不会被合并"。
    owner_on 照真实数据默认两份都写（编辑器同步写元素与图两处）；单写一处用来验回退。
    """
    states = {
        "available": {"id": "available", "label": "还在那儿"},
        "taken": {"id": "taken", "label": "被拿走了"},
    }
    transitions = [
        {"id": f"{graph_id}_t1", "from": "available", "to": "taken", "signal": PRIVATE},
    ]
    if extra_state:
        states["broken"] = {"id": "broken", "label": "砸烂了"}
        transitions.append(
            {"id": f"{graph_id}_t2", "from": "taken", "to": "broken", "signal": PRIVATE}
        )
    owner = {"ownerType": "hotspot", "ownerId": owner_id}
    return {
        "id": el_id,
        "kind": "wrapperGraph",
        "label": label,
        **(owner if owner_on in ("both", "element") else {}),
        "graph": {
            "id": graph_id,
            "label": label,
            "initialState": "available",
            "states": states,
            "transitions": transitions,
            **(owner if owner_on in ("both", "graph") else {}),
        },
    }


def _narrative_doc() -> dict:
    return {
        "schemaVersion": 1,
        "signals": [
            {"id": PRIVATE, "label": "箱子被拿走", "scope": "private"},
            {"id": GLOBAL, "label": "收工了"},
        ],
        "compositions": [
            {
                "id": "comp_demo",
                "label": "演示线",
                "mainGraph": {
                    "id": "flow_main",
                    "label": "演示主线",
                    "initialState": "a",
                    "states": {
                        "a": {"id": "a", "label": "开场"},
                        "b": {"id": "b", "label": "收工"},
                    },
                    # 主线（无 owner）也挂一条监听私有信号的转移：它是校验 error（死监听），
                    # owner 候选里绝不该出现——这条是这份数据里最重要的一枚探针。
                    "transitions": [
                        {"id": "t_main", "from": "a", "to": "b", "signal": GLOBAL},
                        {"id": "t_main_priv", "from": "a", "to": "b", "signal": PRIVATE},
                    ],
                },
                "elements": [
                    _wrapper("el_box_a", "wrap_box_a", "箱子甲 Wrapper", "hs_box_a"),
                    # 只写在图上（运行时的权威处）和只写在元素上（编辑器那份副本），两种都得认
                    _wrapper("el_box_b", "wrap_box_b", "箱子乙 Wrapper", "hs_box_b", owner_on="graph"),
                    _wrapper("el_box_c", "wrap_box_c", "箱子丙 Wrapper", "hs_box_c", owner_on="element"),
                    _wrapper("el_box_d", "wrap_box_d", "箱子丁 Wrapper", "hs_box_d", extra_state=True),
                    # 绑了 owner 但**不听**这条信号：候选里也不该有它
                    {
                        "id": "el_dog",
                        "kind": "wrapperGraph",
                        "label": "狗 Wrapper",
                        "ownerType": "npc",
                        "ownerId": "npc_dog",
                        "graph": {
                            "id": "wrap_dog",
                            "label": "狗",
                            "initialState": "idle",
                            "states": {"idle": {"id": "idle", "label": "在睡"},
                                       "gone": {"id": "gone", "label": "跑了"}},
                            "transitions": [
                                {"id": "dog_t1", "from": "idle", "to": "gone", "signal": GLOBAL},
                            ],
                        },
                    },
                ],
            }
        ],
    }


def _scene_doc() -> dict:
    return {
        "id": "riverside",
        "name": "河边",
        "hotspots": [
            {"id": "hs_box_a", "label": "河边的木箱（甲）"},
            {"id": "hs_box_b", "label": "河边的木箱（乙）"},
            {"id": "hs_box_c", "label": "河边的木箱（丙）"},
            {"id": "hs_box_d", "label": "河边的木箱（丁）"},
        ],
        "npcs": [],
        "zones": [],
    }


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    data_dir = tmp_path / "public/assets/data"
    data_dir.mkdir(parents=True)
    (data_dir / "narrative_graphs.json").write_text(
        json.dumps(_narrative_doc(), ensure_ascii=False), encoding="utf-8"
    )
    scenes_dir = tmp_path / "public/assets/scenes"
    scenes_dir.mkdir(parents=True)
    (scenes_dir / "riverside.json").write_text(
        json.dumps(_scene_doc(), ensure_ascii=False), encoding="utf-8"
    )
    return tmp_path


@pytest.fixture()
def index(project: Path) -> NarrativeIndex:
    ix = NarrativeIndex(project)
    ix.load()
    return ix


# ---- 数据面：scope 读得出来，owner 认得清 --------------------------------


def test_private_scope_is_read_from_the_signal_registry(index: NarrativeIndex) -> None:
    assert index.is_private_signal(PRIVATE)
    assert not index.is_private_signal(GLOBAL)
    assert not index.is_private_signal("压根不存在的信号")


def test_owner_candidates_are_only_the_wrappers_that_listen(index: NarrativeIndex) -> None:
    """候选＝**听这条信号的、绑了 owner 的图**。

    多列一个（不听它的狗）等于让人从一堆实体里瞎挑；少列一个就没法验那个箱子。
    主线那条死监听（无 owner）绝不能混进来——它永远收不到。
    """
    owners = index.private_signal_owners(PRIVATE)
    # 乙只写在图上、丙只写在元素上：两种写法都得认出来，否则那个箱子在面板上就消失了
    assert [o.owner_id for o in owners] == ["hs_box_a", "hs_box_b", "hs_box_c", "hs_box_d"]
    assert all(o.owner_type == "hotspot" for o in owners)
    assert "npc_dog" not in [o.owner_id for o in owners]


def test_owner_display_uses_the_entity_name_not_the_id(index: NarrativeIndex) -> None:
    text = index.owner_display("hotspot", "hs_box_a")
    assert "河边的木箱（甲）" in text and "河边" in text
    # 场景里没有的实体只能退回 id——不编一个名字出来
    assert "hs_不存在" in index.owner_display("hotspot", "hs_不存在")


def test_same_shape_wrappers_collapse_into_one_pattern(index: NarrativeIndex) -> None:
    """100 个箱子的监听面要收成一行，但长得不一样的那一跳不许被一起吞掉。"""
    rows = index.listeners[PRIVATE]
    patterns = index.aggregate_private_listeners(rows)
    by_count = sorted(p.count for p in patterns)
    # 甲乙丙同款 available→taken 收成 1 条（count=3）；
    # 丁多一个状态（拓扑不同）自成一条，它的 taken→broken 又是一条；主线那条自成一条。
    assert 3 in by_count, f"同款 wrapper 没收成一条：{[(p.count, p.graph_ids) for p in patterns]}"
    three = next(p for p in patterns if p.count == 3)
    assert set(three.graph_ids) == {"wrap_box_a", "wrap_box_b", "wrap_box_c"}
    assert all(p.count == 1 for p in patterns if p is not three)


# ---- 呈现面：说人话 ------------------------------------------------------


def test_signal_phrase_says_private_out_loud(index: NarrativeIndex) -> None:
    what, _ = signal_phrase(index, PRIVATE)
    assert PRIVATE_NOTE in what
    other, _ = signal_phrase(index, GLOBAL)
    assert PRIVATE_NOTE not in other


def test_no_owner_drop_reads_as_chinese_and_names_the_signal(index: NarrativeIndex) -> None:
    """运行时那条 fail-loud 丢弃，时间线上必须点名是哪条信号、为什么丢。"""
    translator = TraceTranslator(index)
    entry = translator.translate(
        {
            "type": "issue",
            "message": f'NarrativeStateManager: 私有信号 "{PRIVATE}" 的发射点没有 owner 上下文，已丢弃（私有信号只投递给发射方 owner 的 wrapper 图）',
            "payload": {"severity": "error", "code": "signal.private.noOwner"},
        },
        "12:00:00",
    )
    assert entry is not None
    assert PRIVATE in entry.headline and "被丢弃" in entry.headline
    assert "实体上下文" in entry.headline
    assert entry.verdict == VERDICT_DANGLING
    assert entry.signal == PRIVATE, "点得进「信号关系」窗才算接上"
    assert "NarrativeStateManager" not in entry.headline + entry.detail, "英文原文只该进 tooltip"


def test_the_paired_ignore_event_does_not_say_it_twice(index: NarrativeIndex) -> None:
    """同一次丢弃会来两条 trace（issue + signal.ignored）。时间线上只该出现一行。"""
    translator = TraceTranslator(index)
    assert translator.translate(
        {
            "type": "signal.ignored",
            "triggerKey": PRIVATE,
            "message": "private signal without owner context",
        },
        "12:00:00",
    ) is None


def test_owner_without_any_wrapper_graph_is_explained(index: NarrativeIndex) -> None:
    """另一种丢弃：owner 有了，但它名下一张 wrapper 图都没有（场景 onEnter 的 ambient owner）。"""
    translator = TraceTranslator(index)
    entry = translator.translate(
        {
            "type": "issue",
            "message": f'NarrativeStateManager: 私有信号 "{PRIVATE}" 的发射方 scene:riverside 没有任何 wrapper 图，已丢弃（该 owner 不该发这条私有信号）',
            "payload": {"severity": "error", "code": "signal.private.ownerNoGraph"},
        },
        "12:00:00",
    )
    assert entry is not None
    assert PRIVATE in entry.headline and "没有绑 wrapper 图" in entry.headline
    assert "scene:riverside" in entry.detail
    assert entry.verdict == VERDICT_DANGLING
    assert entry.signal == PRIVATE


# ---- 界面：发得出去，且发得对 --------------------------------------------


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def window(app: QApplication, index: NarrativeIndex, project: Path, tmp_path: Path) -> MainWindow:
    hub = DebugHub(index, port=5297)
    store = SavepointStore(tmp_path / "savepoints", index.fingerprint, index.graph_fingerprints)
    win = MainWindow(index, hub, store, project)
    win.hub.state.connected = True
    app.processEvents()
    yield win
    if win._xref_window is not None:
        win._xref_window.close()
    win.hub.stop()
    win.close()


def _select(win: MainWindow, signal: str) -> None:
    listing = win._signal_dialog_listing
    for i in range(listing.count()):
        if str(listing.item(i).data(Qt.ItemDataRole.UserRole) or "") == signal:
            listing.setCurrentRow(i)
            return
    raise AssertionError(f"「假装做了那一下」的清单里没有 {signal}")


def test_private_signals_are_marked_in_the_pick_list(window: MainWindow, app) -> None:
    dialog = window._build_signal_dialog()
    listing = window._signal_dialog_listing
    texts = {
        str(listing.item(i).data(Qt.ItemDataRole.UserRole) or ""): listing.item(i).text()
        for i in range(listing.count())
    }
    assert PRIVATE_MARK in texts[PRIVATE]
    assert PRIVATE_MARK not in texts[GLOBAL]
    dialog.close()


def test_owner_picker_only_shows_up_for_private_signals(window: MainWindow, app) -> None:
    dialog = window._build_signal_dialog()
    _select(window, GLOBAL)
    assert window._signal_owner_picker.count() == 0
    assert window._signal_fire_btn.isEnabled()

    _select(window, PRIVATE)
    picker = window._signal_owner_picker
    assert picker.count() == 4, "四个箱子都该能挑"
    assert "河边的木箱（甲）" in picker.itemText(0)
    assert picker.itemData(0) == ("hotspot", "hs_box_a")
    dialog.close()


def test_firing_a_private_signal_carries_the_owner(window: MainWindow, app) -> None:
    """这就是整件事的落点：不带 owner 发出去，运行时当场丢弃、界面一片安静。"""
    sent: list[dict] = []
    window.hub.send_command = lambda payload, *a, **k: sent.append(payload)  # type: ignore[assignment]

    dialog = window._build_signal_dialog()
    _select(window, PRIVATE)
    window._signal_owner_picker.setCurrentIndex(1)      # 箱子乙
    window._signal_fire_btn.click()
    app.processEvents()

    assert len(sent) == 1
    assert sent[0]["signal"] == PRIVATE
    assert sent[0]["ownerType"] == "hotspot"
    assert sent[0]["ownerId"] == "hs_box_b"
    dialog.close()


def test_firing_a_global_signal_is_unchanged(window: MainWindow, app) -> None:
    sent: list[dict] = []
    window.hub.send_command = lambda payload, *a, **k: sent.append(payload)  # type: ignore[assignment]

    dialog = window._build_signal_dialog()
    _select(window, GLOBAL)
    window._signal_fire_btn.click()
    app.processEvents()

    assert len(sent) == 1
    assert sent[0] == {
        "command": "emitSignal",
        "signal": GLOBAL,
        "sourceType": "debug",
        "sourceId": "narrative-debugger",
    }, "全局信号的发法必须一字不变"
    dialog.close()


def test_private_signal_with_no_owner_candidate_is_not_fired(app, tmp_path: Path) -> None:
    """没有任何绑 owner 的图听它：发出去必被丢弃，那就别让人按下去。"""
    doc = _narrative_doc()
    # 把箱子那几张 wrapper 的 owner 抹掉（两处都抹）：剩下的监听方全是无 owner 的死监听
    for el in doc["compositions"][0]["elements"]:
        for holder in (el, el.get("graph") or {}):
            holder.pop("ownerType", None)
            holder.pop("ownerId", None)
    data_dir = tmp_path / "public/assets/data"
    data_dir.mkdir(parents=True)
    (data_dir / "narrative_graphs.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

    ix = NarrativeIndex(tmp_path)
    ix.load()
    hub = DebugHub(ix, port=5296)
    store = SavepointStore(tmp_path / "sp", ix.fingerprint, ix.graph_fingerprints)
    win = MainWindow(ix, hub, store, tmp_path)
    win.hub.state.connected = True
    sent: list[dict] = []
    win.hub.send_command = lambda payload, *a, **k: sent.append(payload)  # type: ignore[assignment]
    try:
        dialog = win._build_signal_dialog()
        _select(win, PRIVATE)
        assert not win._signal_fire_btn.isEnabled()
        # 按钮禁用只是第一道；判据必须留在发射那一步自己手里
        win._fire_selected_signal(win._signal_dialog_listing, dialog)
        assert sent == [], "没有 owner 可挑时绝不能发一条注定被丢的信号"
        dialog.close()
    finally:
        hub.stop()
        win.close()


def test_mcp_emit_refuses_a_private_signal_without_owner(window: MainWindow, app) -> None:
    """agent 那一路同样不能静默丢：退回来还要告诉它能挑哪些 owner。"""
    sent: list[dict] = []
    window.hub.send_command = lambda payload, *a, **k: sent.append(payload)  # type: ignore[assignment]

    reply = window._handle_tool_command({"command": "emitNarrativeSignalByName", "signal": PRIVATE})
    assert reply is not None and reply["ok"] is False
    assert [o["ownerId"] for o in reply["owners"]][:2] == ["hs_box_a", "hs_box_b"]
    assert sent == []

    ok = window._handle_tool_command({
        "command": "emitNarrativeSignalByName",
        "signal": PRIVATE,
        "ownerType": "hotspot",
        "ownerId": "hs_box_c",
    })
    assert ok is not None and ok["ok"] is True
    assert sent[-1]["ownerId"] == "hs_box_c"


# ---- 「信号关系」窗：监听方聚合成一行模式 --------------------------------


def test_xref_window_folds_private_listeners_into_one_pattern(window: MainWindow, app) -> None:
    assert window._open_signal_xref(PRIVATE)
    app.processEvents()
    dialog = window._xref_window
    html = dialog.detail.toHtml()
    assert "所有绑此类 wrapper 的实体（3 张图）" in html, "同款 wrapper 没折叠成一行"
    assert "wrap_box_a、wrap_box_b、wrap_box_c" in html, "折叠掉的图必须列出来，别让人以为少扫了"
    assert PRIVATE_NOTE in html
    # 私有信号在这个窗里不给发：不挑 owner 发出去必被丢弃
    assert not dialog.fire_btn.isEnabled()
    assert "哪个实体发的" in dialog.fire_btn.toolTip()


def test_xref_window_leaves_global_signals_alone(window: MainWindow, app) -> None:
    assert window._open_signal_xref(GLOBAL)
    app.processEvents()
    dialog = window._xref_window
    html = dialog.detail.toHtml()
    assert "所有绑此类 wrapper 的实体" not in html
    assert PRIVATE_NOTE not in html
    assert dialog.fire_btn.isEnabled(), "全局信号照旧能发"
