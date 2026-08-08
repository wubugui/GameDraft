"""多个游戏页签 + 切换调试对象的护栏。

这几条全是"看着能切、其实留下一个冻死的页签"或"两个页签的事搅在一条时间线里"
那种回归——旧版是 1:1，新开页签直接把旧的踢掉，改成多挂之后风险全在交接那一下。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from tools.narrative_debugger.hub import DebugHub
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_debugger.savepoints import SavepointStore
from tools.narrative_debugger.tests.fake_game import (
    connect_game,
    disconnect_game,
    send_batch,
    snapshot_item,
)
from tools.narrative_debugger.ui.main_window import MainWindow

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def hub(app: QApplication) -> DebugHub:
    index = NarrativeIndex(REPO_ROOT)
    index.load()
    return DebugHub(index, port=5296)


# ---------------- hub ----------------


def test_two_tabs_both_stay_connected(hub: DebugHub) -> None:
    """旧版会把先连的那个踢掉；现在两个都留着，只是当前只调一个。"""
    first = connect_game(hub, "tab-1")
    second = connect_game(hub, "tab-2")
    assert not first.closed, "旧页签不该被踢掉"
    assert [t["id"] for t in hub.targets()] == ["tab-1", "tab-2"]
    # 新开的那个就是人正看着的
    assert hub.active_target_id == "tab-2"
    assert second is not None


def test_switching_away_disarms_the_old_tab(hub: DebugHub) -> None:
    """切走的页签必须当场撤断点 + 放行。

    不放行的话它可能正停在某一拍上，而「继续」此刻发给了另一个页签——
    那个页签就只能关掉重开。
    """
    first = connect_game(hub, "tab-1")
    connect_game(hub, "tab-2")
    commands = first.commands()
    assert "setBreakpoints" in commands
    assert "disarmStep" in commands
    assert "continue" in commands
    # 后台页签还在存点的话，档会以另一个页签的名义落盘
    assert "setAutoSavepoints" in commands


def test_commands_only_go_to_the_active_tab(hub: DebugHub) -> None:
    first = connect_game(hub, "tab-1")
    second = connect_game(hub, "tab-2")
    first.sent.clear()
    second.sent.clear()
    hub.send_command({"command": "emitSignal", "signal": "x"})
    assert [m.get("command") for m in second.sent] == ["emitSignal"]
    assert first.sent == []


def test_background_tab_does_not_write_the_timeline(hub: DebugHub) -> None:
    """后台页签照样在跑，但它的事不许混进当前这条时间线。"""
    first = connect_game(hub, "tab-1")
    connect_game(hub, "tab-2")
    send_batch(hub, first, {"kind": "playerAction", "action": "hotspot", "label": "后台那一下"})
    assert all("后台那一下" not in entry.headline for entry in hub.timeline)


def test_background_snapshot_still_labels_the_picker(hub: DebugHub) -> None:
    """下拉里得说得出后台那个页签在哪个场景，否则两行长得一模一样，没法挑。"""
    first = connect_game(hub, "tab-1")
    connect_game(hub, "tab-2")
    send_batch(hub, first, snapshot_item("teahouse"))
    labels = [t["label"] for t in hub.targets()]
    assert any("teahouse" in label or "茶馆" in label for label in labels)


def test_each_tab_keeps_its_own_timeline(hub: DebugHub) -> None:
    first = connect_game(hub, "tab-1")
    send_batch(hub, first, {"kind": "playerAction", "action": "hotspot", "label": "第一个页签"})
    assert len(hub.timeline) == 1
    connect_game(hub, "tab-2")
    assert hub.timeline == [], "切过去应该是新页签自己的（空）时间线"
    hub.set_active_target("tab-1")
    assert len(hub.timeline) == 1, "切回来还得是原来那一条"


def test_closing_the_active_tab_falls_back_to_another(hub: DebugHub) -> None:
    connect_game(hub, "tab-1")
    second = connect_game(hub, "tab-2")
    dropped: list[bool] = []
    hub.connectionChanged.connect(dropped.append)
    disconnect_game(hub, second)
    assert hub.active_target_id == "tab-1"
    assert dropped == [], "还有页签连着就不该报『游戏断了』"


def test_last_tab_closing_reports_disconnected(hub: DebugHub) -> None:
    only = connect_game(hub, "tab-1")
    dropped: list[bool] = []
    hub.connectionChanged.connect(dropped.append)
    disconnect_game(hub, only)
    assert dropped == [False]
    assert hub.active_target_id == ""
    assert hub.state.connected is False


def test_reconnect_of_the_same_tab_does_not_steal_focus(hub: DebugHub) -> None:
    """调试器重启后所有页签会一起重连；同一个 clientId 不该在清单里冒出第二行。"""
    connect_game(hub, "tab-1")
    connect_game(hub, "tab-2")
    hub.set_active_target("tab-1")
    connect_game(hub, "tab-2")  # tab-2 重连
    assert [t["id"] for t in hub.targets()] == ["tab-1", "tab-2"]
    assert hub.active_target_id == "tab-1", "重连不该把人从正在调的页签上拽走"


def test_no_game_connected_reads_as_disconnected(hub: DebugHub) -> None:
    assert hub.state.connected is False
    assert hub.timeline == []
    assert hub.targets() == []
    assert hub.send_command({"command": "ping"}) is False


# ---------------- 面板 ----------------


@pytest.fixture()
def window(app: QApplication, hub: DebugHub, tmp_path: Path) -> MainWindow:
    store = SavepointStore(tmp_path, hub.index.fingerprint, hub.index.graph_fingerprints)
    win = MainWindow(hub.index, hub, store, REPO_ROOT)
    win.show()
    app.processEvents()
    yield win
    win.hub.stop()
    win.close()


def test_picker_lists_every_tab_and_marks_the_active_one(window: MainWindow, app: QApplication) -> None:
    connect_game(window.hub, "tab-1")
    connect_game(window.hub, "tab-2")
    app.processEvents()
    ids = [window.target_picker.itemData(i) for i in range(window.target_picker.count())]
    assert ids == ["tab-1", "tab-2"]
    assert window.target_picker.currentData() == "tab-2"


def test_picking_a_tab_switches_the_hub(window: MainWindow, app: QApplication) -> None:
    connect_game(window.hub, "tab-1")
    connect_game(window.hub, "tab-2")
    app.processEvents()
    index = window.target_picker.findData("tab-1")
    window.target_picker.setCurrentIndex(index)
    window._on_target_picked(index)
    assert window.hub.active_target_id == "tab-1"


def test_switching_pushes_breakpoints_to_the_new_tab(window: MainWindow, app: QApplication) -> None:
    """刚切过去的页签一个断点都没有（切走时被撤干净了），不补发就是"列着断点却谁也不断"。"""
    first = connect_game(window.hub, "tab-1")
    connect_game(window.hub, "tab-2")
    app.processEvents()
    first.sent.clear()
    window._on_target_picked(window.target_picker.findData("tab-1"))
    app.processEvents()
    assert "setBreakpoints" in first.commands()


def test_picker_says_so_when_nothing_is_connected(window: MainWindow) -> None:
    assert window.target_picker.count() == 1
    assert window.target_picker.itemData(0) == ""
    assert "没有游戏" in window.target_picker.itemText(0)
