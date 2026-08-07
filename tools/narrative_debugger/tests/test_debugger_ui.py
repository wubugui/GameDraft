"""界面护栏：这四条都是"看着没坏、其实工具废了一半"的那种回归。

1. 中间栏不许再出现吃掉几百像素的死 spacer（曾经是 348px 的纯空白）
2. 左栏每行必须带图名，且刷新标记之后图名还在（最容易被 setText 抹掉）
3. 搜索：图名和状态名一起匹配，命中过滤 + 高亮，清空复原
4. 手动缩放之后重绘不许把比例推回去（自动记点每存一个点就重绘一次）
"""
from __future__ import annotations

from pathlib import Path

import pytest
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QSpacerItem

from tools.narrative_debugger.hub import DebugHub
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_debugger.savepoints import SavepointStore
from tools.narrative_debugger.ui.main_window import ROLE_HEADER, ROLE_KEY, MainWindow

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def app() -> QApplication:
    return QApplication.instance() or QApplication([])


@pytest.fixture()
def window(app: QApplication, tmp_path: Path) -> MainWindow:
    index = NarrativeIndex(REPO_ROOT)
    index.load()
    # 存档点落到 tmp_path，别往真项目里写
    hub = DebugHub(index, port=5299)
    store = SavepointStore(tmp_path, index.fingerprint, index.graph_fingerprints)
    win = MainWindow(index, hub, store, REPO_ROOT)
    win.resize(1360, 820)
    win.show()
    app.processEvents()
    app.processEvents()
    yield win
    win.hub.stop()
    win.close()


def _visible_rows(win: MainWindow) -> list[str]:
    return [
        win.beat_list.item(i).text()
        for i in range(win.beat_list.count())
        if not win.beat_list.item(i).isHidden()
    ]


def _highlighted(win: MainWindow) -> list[str]:
    out = []
    for i in range(win.beat_list.count()):
        item = win.beat_list.item(i)
        if item.background().style() != Qt.BrushStyle.NoBrush:
            out.append(item.text())
    return out


# ---- 1. 中间栏不许有死空白 ------------------------------------------------


def test_center_column_has_no_dead_spacer(window: MainWindow) -> None:
    layout = window.graph.parentWidget().layout()
    spacers = [
        layout.itemAt(i)
        for i in range(layout.count())
        if isinstance(layout.itemAt(i), QSpacerItem)
    ]
    tall = [s for s in spacers if s.geometry().height() > 40]
    assert not tall, f"中间栏又冒出吃高度的 spacer：{[s.geometry().height() for s in tall]}px"


def test_graph_takes_the_free_height(window: MainWindow) -> None:
    """图区必须把中间栏剩下的高度吃掉，而不是被上限焊死、余量堆成空白。"""
    column = window.graph.parentWidget().height()
    assert window.graph.height() > column * 0.5, (
        f"图区只占了中间栏 {window.graph.height()}/{column}，剩下的又变成空白了"
    )
    assert window.graph.zoom >= 1.0, f"自动比例掉到 {window.graph.zoom}，字要糊"


# ---- 2. 左栏每行带图名 ----------------------------------------------------


def test_every_row_carries_its_graph_name(window: MainWindow) -> None:
    rows = [
        window.beat_list.item(i)
        for i in range(window.beat_list.count())
        if window.beat_list.item(i).data(ROLE_KEY)
    ]
    assert len(rows) > 100
    for item in rows:
        graph_id = str(item.data(ROLE_KEY)).rpartition(".")[0]
        assert f"〔{window._short_graph_label(graph_id)}〕" in item.text(), (
            f"这行没带图名：{item.text()}"
        )
        # 括号里的注解不进正文（会把状态名挤出屏幕），但必须留在 tooltip 里
        assert window.index.graph_labels[graph_id] in str(item.data(Qt.ItemDataRole.UserRole + 4))


def test_marks_refresh_keeps_the_graph_name(window: MainWindow) -> None:
    """刷标记走的是 setText，拿 node.display 重算的话图名每次都会被抹掉一次。"""
    before = _visible_rows(window)
    window._refresh_beats_marks()
    window._refresh_beats_marks()
    assert _visible_rows(window) == before


def test_duplicate_state_names_are_now_distinguishable(window: MainWindow) -> None:
    """7 行都叫「未」是真实数据；带上图名之后不许再有整行重复。"""
    rows = [
        window.beat_list.item(i).text()
        for i in range(window.beat_list.count())
        if window.beat_list.item(i).data(ROLE_KEY)
    ]
    assert len(set(rows)) == len(rows), "还有整行文本完全一样的条目，分不出是哪张图的"


# ---- 3. 搜索 --------------------------------------------------------------


def test_search_matches_graph_name_and_keeps_the_group(window: MainWindow) -> None:
    window.beat_search.setText("偷鸡")
    rows = _visible_rows(window)
    assert rows, "搜图名一条都不剩"
    assert all("偷鸡" in r for r in rows), rows
    assert any(window.beat_list.item(i).data(ROLE_HEADER)
               for i in range(window.beat_list.count())
               if not window.beat_list.item(i).isHidden()), "分组标题被一起收掉了，剩下的行不知道是谁的"
    assert len(_highlighted(window)) == len(rows) - 1, "命中的状态行没高亮（标题行不算）"


def test_search_matches_state_name_across_graphs(window: MainWindow) -> None:
    window.beat_search.setText("未触发")
    rows = [r for r in _visible_rows(window) if "〔" in r]
    assert len(rows) >= 4, rows
    graphs = {r.split("〕")[0] for r in rows}
    assert len(graphs) >= 4, f"搜状态名应该横跨多张图，实际只有 {graphs}"


def test_search_says_where_it_actually_lives(window: MainWindow) -> None:
    """左栏一次只列一条线。光说"没搜到"会让人以为整个项目都没有。"""
    window.beat_search.setText("水鬼")
    assert _visible_rows(window) == []
    assert "码头" in window.search_count.text(), window.search_count.text()

    window.beat_search.setText("zzz压根不存在")
    assert "整个项目里都没有" in window.search_count.text()


def test_clearing_search_restores_everything(window: MainWindow) -> None:
    total = window.beat_list.count()
    window.beat_search.setText("偷鸡")
    assert len(_visible_rows(window)) < total
    window.beat_search.setText("")
    assert len(_visible_rows(window)) == total
    assert _highlighted(window) == []
    assert not window.search_count.isVisible()


def test_switching_line_reruns_the_filter(window: MainWindow) -> None:
    """换线会重填列表；筛子不重跑的话搜索框还写着字、列表却全放出来了。"""
    window.beat_search.setText("偷鸡")
    idx = window.comp_picker.findData("beishi_lingong_flow")
    assert idx >= 0
    window.comp_picker.setCurrentIndex(idx)
    assert _visible_rows(window) == [], "换线之后筛子没重跑"


# ---- 4. 缩放粘得住 --------------------------------------------------------


def test_manual_zoom_survives_a_redraw(window: MainWindow) -> None:
    """自动记点默认开着，每存一个点就重绘一次——重绘不能把人的视角推回去。"""
    window.graph.zoom_by(1.2)
    window.graph.zoom_by(1.2)
    zoomed = window.graph.zoom
    assert zoomed > 1.3

    window.graph.set_savepoints({"flow_xungou_main.s01"})
    window.graph.render_focus(window.graph.focus_key)
    assert window.graph.zoom == pytest.approx(zoomed), "重绘把手动缩放打回去了"

    window.graph.zoom_fit()
    window.graph.set_savepoints(set())
    window.graph.render_focus(window.graph.focus_key, force=True)
    assert window.graph.zoom != pytest.approx(zoomed), "点过「适应」之后应该恢复自动排比例"


def test_zoom_label_follows_the_view(window: MainWindow) -> None:
    window.graph.zoom_actual()
    assert window.zoom_label.text() == "100%"
    window.graph.zoom_by(1.2)
    assert window.zoom_label.text() == "120%"
