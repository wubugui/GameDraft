"""「信号关系」窗的护栏，全部从**用户真会点的入口**进（按钮、双击、勾选框）。

这一族问题的形状是"看着有、点了没用"：筛选把要看的那条挡住了、圆点不跟着运行时变、
游戏没连上还亮着发信号按钮、主窗重读数据后窗里还是旧关系。model 层全绿抓不到，
只有从入口点下去才会现原形。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from PySide6.QtCore import QUrl
from PySide6.QtWidgets import QApplication

from tools.narrative_debugger.hub import DebugHub
from tools.narrative_debugger.humanize import TimelineEntry
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_debugger.savepoints import SavepointStore
from tools.narrative_debugger.ui.main_window import ROLE_TIMELINE_SIGNAL, MainWindow
from tools.narrative_debugger.ui.signal_xref_window import LIVE_MARK, MAYBE_MARK, ROLE_SIGNAL

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def window(app: QApplication, tmp_path: Path) -> MainWindow:
    index = NarrativeIndex(REPO_ROOT)
    index.load()
    hub = DebugHub(index, port=5298)
    store = SavepointStore(tmp_path, index.fingerprint, index.graph_fingerprints)
    win = MainWindow(index, hub, store, REPO_ROOT)
    win.show()
    app.processEvents()
    yield win
    if win._xref_window is not None:
        win._xref_window.close()
    win.hub.stop()
    win.close()


def _open(win: MainWindow, app: QApplication):
    win.xref_btn.click()          # 用户真按的那颗按钮
    app.processEvents()
    return win._xref_window


def _rows(dialog) -> list[str]:
    return [str(dialog.listing.item(i).data(ROLE_SIGNAL) or "") for i in range(dialog.listing.count())]


def _pick(dialog, signal: str) -> None:
    dialog.show_signal(signal)


def _push_timeline(win: MainWindow, entry: TimelineEntry) -> None:
    """照 hub 自己的写法往时间线塞一条（append + 发信号），不打私有方法的桩。"""
    win.hub.timeline.append(entry)
    win.hub.timelineAppended.emit(entry)


def test_button_opens_the_window_and_lists_real_signals(window, app):
    dialog = _open(window, app)
    assert dialog is not None and dialog.isVisible()
    rows = _rows(dialog)
    assert len(rows) > 20, "真实工程里信号不止这么点，扫描八成没跑起来"
    assert "beishi_lg_accepted" in rows


def test_details_show_both_sides_of_a_real_signal(window, app):
    dialog = _open(window, app)
    _pick(dialog, "beishi_lg_accepted")
    html = dialog.detail.toHtml()
    assert "谁发的" in html and "谁在听" in html
    assert "对话图" in html, "发送方那一栏必须点名是哪张对话图"
    assert "转移" in html or "→" in html


def test_reopening_keeps_the_window_and_switches_signal(window, app):
    dialog = _open(window, app)
    _pick(dialog, "beishi_lg_accepted")
    window._open_signal_xref("beishi_hired")
    app.processEvents()
    assert window._xref_window is dialog, "重复开不许造第二个窗"
    assert dialog._current == "beishi_hired"


def test_show_signal_clears_filters_that_would_hide_it(window, app):
    """从时间线点进来时，正在生效的筛选不许把要看的那条挡住（点了没反应最气人）。"""
    dialog = _open(window, app)
    dialog.search.setText("绝不可能匹配任何东西的字串")
    app.processEvents()
    assert _rows(dialog) == []
    _pick(dialog, "beishi_lg_accepted")
    assert dialog._current == "beishi_lg_accepted"
    assert dialog.search.text() == ""


def test_live_dot_follows_the_runtime_state(window, app):
    dialog = _open(window, app)
    card = next(c for c in dialog._cards() if c.listeners)
    listener = card.listeners[0]

    window.hub.state.connected = True
    window.hub.state.active_states = {listener.graph_id: listener.from_state}
    dialog.refresh_runtime()
    app.processEvents()

    row = next(
        dialog.listing.item(i) for i in range(dialog.listing.count())
        if str(dialog.listing.item(i).data(ROLE_SIGNAL) or "") == card.signal
    )
    assert row.text().startswith(LIVE_MARK), "有人正等着这一下时必须亮起来"
    _pick(dialog, card.signal)
    assert "正等着这一下" in dialog.detail.toHtml()

    window.hub.state.active_states = {}
    dialog.refresh_runtime()
    app.processEvents()
    row = next(
        dialog.listing.item(i) for i in range(dialog.listing.count())
        if str(dialog.listing.item(i).data(ROLE_SIGNAL) or "") == card.signal
    )
    assert not row.text().startswith(LIVE_MARK), "没人等了就得灭掉，不能一直亮着"


def test_only_live_filter_keeps_just_the_actionable_ones(window, app):
    dialog = _open(window, app)
    card = next(c for c in dialog._cards() if c.listeners)
    listener = card.listeners[0]
    window.hub.state.connected = True
    window.hub.state.active_states = {listener.graph_id: listener.from_state}
    dialog.refresh_runtime()

    dialog.only_live.setChecked(True)
    app.processEvents()
    rows = _rows(dialog)
    assert card.signal in rows
    assert all(dialog._live_listener_count(dialog.xref.card(s)) > 0 for s in rows)


def test_problem_filter_only_keeps_mismatched_signals(window, app):
    dialog = _open(window, app)
    dialog.only_problem.setChecked(True)
    app.processEvents()
    for signal in _rows(dialog):
        card = dialog.xref.card(signal)
        assert any(d.severity in ("error", "warning") for d in card.diagnostics)


def test_fire_button_is_disabled_until_the_game_is_connected(window, app):
    dialog = _open(window, app)
    card = next(c for c in dialog._cards() if c.listeners)
    _pick(dialog, card.signal)
    window.hub.state.connected = False
    dialog.refresh_runtime()
    assert not dialog.fire_btn.isEnabled()
    assert "没连上" in dialog.fire_btn.toolTip()

    window.hub.state.connected = True
    dialog.refresh_runtime()
    assert dialog.fire_btn.isEnabled()


def test_draft_signal_can_never_be_fired(window, app):
    dialog = _open(window, app)
    window.hub.state.connected = True
    if "__draft__" not in _rows(dialog):
        pytest.skip("这份数据里没有草稿占位信号")
    _pick(dialog, "__draft__")
    dialog.refresh_runtime()
    assert not dialog.fire_btn.isEnabled(), "运行时拒发草稿信号，按钮不该给人点"
    assert "草稿" in dialog.fire_btn.toolTip()


def test_focus_button_moves_the_main_graph_without_touching_the_game(window, app):
    dialog = _open(window, app)
    card = next(
        c for c in dialog._cards()
        if c.listeners and f"{c.listeners[0].graph_id}.{c.listeners[0].from_state}" in window.index.states
    )
    _pick(dialog, card.signal)
    sent: list = []
    window.hub.send_command = lambda *a, **k: sent.append(a)  # type: ignore[assignment]

    dialog.focus_btn.click()
    app.processEvents()
    listener = card.listeners[0]
    assert window.graph.focus_key == f"{listener.graph_id}.{listener.from_state}"
    assert sent == [], "只挪镜头，绝不给游戏发命令"


def test_clicking_a_listener_link_focuses_that_beat(window, app):
    """详情里的接收方是可点链接。图 id 常带中文，链接必须原样往返（曾担心被转义）。"""
    dialog = _open(window, app)
    card = next(
        c for c in dialog._cards()
        if c.listeners and f"{c.listeners[0].graph_id}.{c.listeners[0].from_state}" in window.index.states
    )
    _pick(dialog, card.signal)
    listener = card.listeners[0]
    key = f"{listener.graph_id}.{listener.from_state}"
    assert f"focus:{key}" in dialog.detail.toHtml(), "接收方那一行必须是能点的链接"
    dialog.detail.anchorClicked.emit(QUrl(f"focus:{key}"))
    app.processEvents()
    assert window.graph.focus_key == key


def test_unknown_focus_link_says_so_instead_of_silently_doing_nothing(window, app):
    dialog = _open(window, app)
    dialog.detail.anchorClicked.emit(QUrl("focus:图不存在.态不存在"))
    app.processEvents()
    assert "找不到" in window.hint_label.text()


def test_focus_button_is_disabled_when_nobody_listens(window, app):
    dialog = _open(window, app)
    orphan = next((c for c in dialog._cards() if not c.listeners), None)
    if orphan is None:
        pytest.skip("这份数据里没有零监听信号")
    _pick(dialog, orphan.signal)
    assert not dialog.focus_btn.isEnabled()


def test_timeline_double_click_opens_that_signal(window, app):
    _push_timeline(window, TimelineEntry(
        at="12:00:00", headline="打出了信号", detail="", verdict="ok", signal="beishi_hired",
    ))
    app.processEvents()
    item = window.timeline_list.item(window.timeline_list.count() - 1)
    assert str(item.data(ROLE_TIMELINE_SIGNAL) or "") == "beishi_hired"
    window._on_timeline_double_clicked(item)
    app.processEvents()
    assert window._xref_window is not None
    assert window._xref_window._current == "beishi_hired"


def test_session_history_shows_up_in_the_card(window, app):
    dialog = _open(window, app)
    _pick(dialog, "beishi_hired")
    assert "还没出现过" in dialog.detail.toHtml()
    _push_timeline(window, TimelineEntry(
        at="12:00:01", headline="打出了信号", detail="走到了下一拍", verdict="ok", signal="beishi_hired",
    ))
    app.processEvents()
    assert "走到了下一拍" in dialog.detail.toHtml()


def test_reload_data_refreshes_the_open_window(window, app):
    dialog = _open(window, app)
    _pick(dialog, "beishi_hired")
    before = dialog.xref
    window._reload_data()
    app.processEvents()
    assert dialog.xref is not before, "主窗重读数据后，窗里的关系必须跟着换新"
    assert dialog._current == "beishi_hired", "换新不许把人踢回列表头"


def _synthetic_xref(*, conditions=None, run=False):
    """合成一份索引，打真实数据里暂时没有的形状（带条件的信号转移 / 活计图监听）。"""
    from tools.narrative_xref import build_index
    from tools.narrative_xref.sources import XrefSource

    graph = {
        "id": "flow_test", "label": "测试线",
        "initialState": "s_a",
        "states": {"s_a": {"label": "起点"}, "s_b": {"label": "终点"}},
        "transitions": [{
            "id": "t1", "from": "s_a", "to": "s_b", "signal": "sig_test",
            **({"conditions": conditions} if conditions else {}),
        }],
    }
    if run:
        graph["run"] = {"repeatable": True}
    src = XrefSource(origin="test")
    src.narrative = {
        "schemaVersion": 2, "signals": [{"id": "sig_test"}],
        "compositions": [{"id": "comp_test", "label": "测试编排", "mainGraph": graph, "elements": []}],
    }
    return build_index(src)


def test_condition_gated_listener_is_never_reported_as_ready(window, app):
    """条件挡着 = 打出去照样不动。报成「正等着这一下」会把人送去改一个没坏的发射端——
    这个窗存在的唯一理由就是回答这句话，答反了比不做更糟。"""
    dialog = _open(window, app)
    dialog.set_indexes(_synthetic_xref(conditions=[{"flag": "有路引"}]), window.index)
    window.hub.state.connected = True
    window.hub.state.active_states = {"flow_test": "s_a"}
    dialog.refresh_runtime()
    _pick(dialog, "sig_test")

    card = dialog.xref.card("sig_test")
    assert dialog._live_listener_count(card) == 0
    html = dialog.detail.toHtml()
    assert "正等着这一下" not in html
    assert "还挂着条件" in html
    row = next(
        dialog.listing.item(i) for i in range(dialog.listing.count())
        if str(dialog.listing.item(i).data(ROLE_SIGNAL) or "") == "sig_test"
    )
    assert row.text().startswith(MAYBE_MARK), "不确定就用半亮的点，别拿实心点骗人"


def test_suspended_run_graph_is_not_reported_as_ready(window, app):
    """挂起的活计一个信号都不接（运行时 listScannableGraphEntries 只扫当前激活的那个）。"""
    dialog = _open(window, app)
    dialog.set_indexes(_synthetic_xref(run=True), window.index)
    window.hub.state.connected = True
    window.hub.state.active_states = {"flow_test": "s_a"}

    window.hub.state.activated_archetype = "别的活计"
    dialog.refresh_runtime()
    _pick(dialog, "sig_test")
    assert dialog._live_listener_count(dialog.xref.card("sig_test")) == 0
    assert "挂起" in dialog.detail.toHtml()

    window.hub.state.activated_archetype = "flow_test"
    dialog.refresh_runtime()
    assert dialog._live_listener_count(dialog.xref.card("sig_test")) == 1
    assert "正等着这一下" in dialog.detail.toHtml()


def test_disconnected_game_never_shows_live_dots(window, app):
    """断线之后圆点说的是十分钟前的世界，一律降级；「只看现在能推动的」也没意义。"""
    dialog = _open(window, app)
    card = next(c for c in dialog._cards() if c.listeners)
    listener = card.listeners[0]
    window.hub.state.connected = True
    window.hub.state.active_states = {listener.graph_id: listener.from_state}
    dialog.refresh_runtime()

    window.hub.state.connected = False
    dialog.refresh_runtime()
    marks = [dialog.listing.item(i).text()[0] for i in range(dialog.listing.count())]
    assert LIVE_MARK not in marks
    assert not dialog.only_live.isEnabled()
    assert "游戏没连上" in dialog.tip.text()


def test_show_signal_that_is_not_in_the_index_says_so_and_clears_the_card(window, app):
    """索引里没有那条信号时，绝不能把上一条的卡片留着——那会让「就当这件事发生了」打错信号。"""
    dialog = _open(window, app)
    _pick(dialog, "beishi_hired")
    assert dialog._current == "beishi_hired"

    assert dialog.show_signal("这条信号根本不存在") is False
    assert dialog._current == ""
    assert "这份扫描里没有信号" in dialog.detail.toHtml()
    assert not dialog.fire_btn.isEnabled(), "没选中任何信号时不许还能发"

    # 游戏推来一次状态更新（真实场景：人看完红字转头去玩，回来时窗已经刷过好几轮）。
    # 红字必须还在——被悄悄换成第一条信号的卡，就等于给了个看着正确的错答案，
    # 而且「就当这件事发生了」会打在别人身上。
    window.hub.state.connected = True
    window.hub.state.active_states = {"随便一张图": "随便一拍"}
    dialog.refresh_runtime()
    app.processEvents()
    assert dialog._current == "", "刷新一次就把红字顶掉 = 这条修复只活了一拍"
    assert "这份扫描里没有信号" in dialog.detail.toHtml()
    assert not dialog.fire_btn.isEnabled()

    # 用户自己去挑一条，才算离开这个现场
    real = next(c.signal for c in dialog._cards() if c.listeners)
    assert dialog.show_signal(real) is True
    assert dialog._current == real
    dialog.refresh_runtime()
    assert dialog._current == real


def test_reloading_data_retries_the_signal_that_was_missing(window, app):
    """「重新读一遍数据」正是为了刚加的信号：抱着旧的"查无此名"不放，
    等于逼人重开窗口才看得见它。"""
    dialog = _open(window, app)
    assert dialog.show_signal("sig_test") is False, "现在的数据里还没有它"
    assert dialog._missing == "sig_test"

    # 换一份「重新读」出来的数据，里面正好有它 → 自动补上，不用重开窗口
    dialog.set_indexes(_synthetic_xref(), window.index)
    assert dialog._missing == "", "换数据后要重试，不许抱着旧的查无此名不放"
    assert dialog._current == "sig_test"
    assert "这份扫描里没有信号" not in dialog.detail.toHtml()

    # 换的那份数据里仍然没有 → 如实继续报查无此名（重试过了，答案没变）
    dialog.show_signal("依旧不存在的信号")
    dialog.set_indexes(_synthetic_xref(), window.index)
    assert dialog._missing == "依旧不存在的信号"
    assert "这份扫描里没有信号" in dialog.detail.toHtml()


def test_timeline_double_click_on_unknown_signal_reports_it(window, app):
    _push_timeline(window, TimelineEntry(
        at="12:00:02", headline="打出了信号", detail="", verdict="ok", signal="幽灵信号_不在索引里",
    ))
    app.processEvents()
    item = window.timeline_list.item(window.timeline_list.count() - 1)
    window._on_timeline_double_clicked(item)
    app.processEvents()
    assert "不在当前这份扫描里" in window.hint_label.text()


def test_mcp_signal_info_says_the_same_thing_as_the_window(app, tmp_path):
    """agent 经 MCP 看到的两侧，必须与策划屏幕上那个窗一模一样。

    以前 MCP 走调试器自己的索引，把黑盒 `meta.emits` 的**声明**也算成 emitters——
    agent 于是会指着一个界面上根本不存在的"发射端"跟人对话。
    """
    from tools.narrative_debugger.mcp_server import NarrativeMcpServer
    from tools.narrative_xref import build_index, from_disk

    server = NarrativeMcpServer(REPO_ROOT, 5211)
    xref = build_index(from_disk(REPO_ROOT))
    derived = next(c.signal for c in xref.overview() if c.kind == "derived")
    for signal in ("beishi_lg_accepted", "beishi_hired", derived):
        card = xref.card(signal)
        info = server._signal_info(signal)
        reals = [e for e in card.emitters if e.channel != "upstream"]
        assert [e["source"] for e in info["emitters"]] == [e.container_id for e in reals]
        assert info["emitterCount"] == card.real_emitter_count, (
            f"{signal}: MCP 说发 {info['emitterCount']}，界面说发 {card.real_emitter_count}")
        assert len(info["upstream"]) == len(card.emitters) - len(reals)
        assert [l["transition"] for l in info["listeners"]] == [l.transition_id for l in card.listeners]
        assert [d["element"] for d in info["declarations"]] == [d.element_id for d in card.declarations]


def test_search_covers_both_sides_not_just_the_id(window, app):
    dialog = _open(window, app)
    card = next(c for c in dialog._cards() if c.emitters and c.emitters[0].container_label)
    needle = card.emitters[0].container_label
    dialog.search.setText(needle)
    app.processEvents()
    assert card.signal in _rows(dialog), "记不住 id 时要能靠「哪段戏发的」找到"
