"""断点特性的 Python 侧护栏。

这几条都是"看着接上了、其实按下去什么都不发生"或"面板在谎报状态"的那种回归——
TS 侧只覆盖了引擎闸，面板与存储这一半此前一条测试都没有。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from PySide6.QtCore import QEvent, Qt
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import QApplication

from tools.narrative_debugger.breakpoints import BreakpointStore
from tools.narrative_debugger.hub import DebugHub
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_debugger.savepoints import SavepointStore
from tools.narrative_debugger.ui.main_window import ROLE_KEY, MainWindow

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def window(app: QApplication, tmp_path: Path):
    index = NarrativeIndex(REPO_ROOT)
    index.load()
    hub = DebugHub(index, port=5298)
    store = SavepointStore(tmp_path, index.fingerprint, index.graph_fingerprints)
    win = MainWindow(index, hub, store, REPO_ROOT)
    # 断点落 tmp_path，绝不往真工程里写（conftest 的只读护栏之外再加一道）
    win.breakpoints = BreakpointStore(tmp_path)
    win._refresh_breakpoints(push=False)
    win.show()
    app.processEvents()
    yield win
    win.hub.stop()
    win.close()


def _first_state_row(win: MainWindow) -> tuple[int, str, str]:
    for i in range(win.beat_list.count()):
        key = str(win.beat_list.item(i).data(ROLE_KEY) or "")
        if "." in key:
            graph_id, state_id = key.split(".", 1)
            return i, graph_id, state_id
    raise AssertionError("左栏里一条状态行都没有")


# ---------------- 存储 ----------------

def test_store_roundtrip_and_persists(tmp_path: Path) -> None:
    store = BreakpointStore(tmp_path)
    assert store.items() == []
    assert store.toggle("g", "s") is True
    store.set_trigger_filter("g", "s", "signal:开门")
    store.set_enabled("g", "s", False)

    again = BreakpointStore(tmp_path)     # 重开调试器
    assert [b.key for b in again.items()] == ["g#s"]
    assert again.items()[0].trigger_contains == "signal:开门"
    assert again.items()[0].enabled is False
    # 停用的断点不下发给游戏侧（游戏侧只认 enabled）
    assert again.to_wire() == [
        {"graphId": "g", "stateId": "s", "enabled": False, "triggerContains": "signal:开门"},
    ]
    assert store.toggle("g", "s") is False
    assert BreakpointStore(tmp_path).items() == []


def test_store_survives_broken_file(tmp_path: Path) -> None:
    path = tmp_path / BreakpointStore(tmp_path).path.relative_to(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{不是合法 json", encoding="utf-8")
    assert BreakpointStore(tmp_path).items() == []     # 坏文件不该把调试器带崩


def test_store_reads_wire_style_keys(tmp_path: Path) -> None:
    """手写/旧版文件可能是驼峰键，读得进来才不会"断点全没了"。"""
    p = BreakpointStore(tmp_path).path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps([{"graphId": "g", "stateId": "s"}]), encoding="utf-8")
    assert [b.key for b in BreakpointStore(tmp_path).items()] == ["g#s"]


# ---------------- hub ----------------

def test_hub_ingests_paused(app: QApplication, tmp_path: Path) -> None:
    index = NarrativeIndex(REPO_ROOT)
    index.load()
    hub = DebugHub(index, port=5297)
    got: list[dict] = []
    hub.breakpointHit.connect(got.append)
    hub._ingest({"kind": "paused", "hit": {"graphId": "g", "stateId": "s"}})
    assert got == [{"graphId": "g", "stateId": "s"}]
    hub._ingest({"kind": "paused"})            # 缺 hit 不该抛
    assert len(got) == 1


# ---------------- 面板 ----------------

def test_right_click_marks_the_row_in_the_main_list(window: MainWindow) -> None:
    """断点标记必须落在策划真正在看的那一栏，不能只在下面 120px 的小列表里。"""
    row, graph_id, state_id = _first_state_row(window)
    before = window.beat_list.item(row).text()
    window._toggle_breakpoint(graph_id, state_id)
    after = window.beat_list.item(row).text()
    assert "⏻" not in before and "⏻" in after
    window._toggle_breakpoint(graph_id, state_id)
    assert "⏻" not in window.beat_list.item(row).text()


def test_delete_key_removes_breakpoint(window: MainWindow) -> None:
    """tooltip 承诺了 Delete，就必须真能删（曾经只 installEventFilter 没实现 eventFilter）。"""
    _row, graph_id, state_id = _first_state_row(window)
    window._toggle_breakpoint(graph_id, state_id)
    window.bp_list.setCurrentRow(0)
    assert window.bp_list.count() == 1
    QApplication.sendEvent(
        window.bp_list,
        QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Delete, Qt.KeyboardModifier.NoModifier),
    )
    assert window.bp_list.count() == 0


def test_double_click_stops_following_the_game(window: MainWindow) -> None:
    """不关跟随的话，游戏一发 state.changed 镜头立刻被拽回当前拍，像"工具抽风"。"""
    _row, graph_id, state_id = _first_state_row(window)
    window._toggle_breakpoint(graph_id, state_id)
    window.follow_btn.setChecked(True)
    window._on_bp_double_clicked(window.bp_list.item(0))
    assert window.follow_btn.isChecked() is False


def test_pause_state_machine(window: MainWindow) -> None:
    _row, graph_id, state_id = _first_state_row(window)
    assert window.bp_continue_btn.isEnabled() is False

    window._on_breakpoint_hit(
        {"graphId": graph_id, "stateId": state_id, "triggerKey": "signal:x", "concurrent": 1})
    assert window.bp_continue_btn.isEnabled() is True
    assert "⏸" in window.bp_status.text()

    window._on_bp_continue()
    assert window.bp_continue_btn.isEnabled() is False
    assert "⏸" not in window.bp_status.text()


def test_concurrent_chains_are_reported(window: MainWindow) -> None:
    """多条链一起断着时必须说出来——点一下继续会把它们一起放行。"""
    _row, graph_id, state_id = _first_state_row(window)
    window._on_breakpoint_hit(
        {"graphId": graph_id, "stateId": state_id, "triggerKey": "signal:x", "concurrent": 3})
    assert "还有 2 条链" in window.bp_status.text()


def test_step_arms_visibly_and_clear_disarms(window: MainWindow) -> None:
    """单步是**全局**武装；不显示出来的话策划十分钟后会被毫无预兆地冻住。"""
    window._on_bp_step()
    assert window._step_armed is True
    assert "单步已武装" in window.bp_status.text()

    window._on_bp_clear()          # 「清空」＝收工，武装态必须跟着解
    assert window._step_armed is False
    assert "单步已武装" not in window.bp_status.text()


def test_disconnect_clears_the_paused_banner(window: MainWindow) -> None:
    """断住时关掉游戏页签：游戏侧自己解冻了，面板不能继续谎报"⏸ 断在 X"。"""
    _row, graph_id, state_id = _first_state_row(window)
    window._on_breakpoint_hit({"graphId": graph_id, "stateId": state_id, "triggerKey": "x"})
    assert "⏸" in window.bp_status.text()
    window._on_connection(False)
    assert "⏸" not in window.bp_status.text()
    assert window.bp_continue_btn.isEnabled() is False


def test_trigger_filter_shows_up_in_the_list(window: MainWindow) -> None:
    """按触发源过滤此前是条死链（数据/协议/运行时都有，界面没入口）。"""
    _row, graph_id, state_id = _first_state_row(window)
    window._toggle_breakpoint(graph_id, state_id)
    window.breakpoints.set_trigger_filter(graph_id, state_id, "signal:开门")
    window._refresh_breakpoints(push=False)
    assert "仅 signal:开门" in window.bp_list.item(0).text()
    assert window.breakpoints.to_wire()[0]["triggerContains"] == "signal:开门"
