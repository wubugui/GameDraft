"""编年史「世界」主标签：概览 HTML + 关系网络（NetworkX + 图元）。"""

from __future__ import annotations

import json
from html import escape as E
from pathlib import Path
from typing import Any

from PySide6.QtWidgets import (
    QLabel,
    QTabWidget,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim_v2.gui.chronicle_display import _wrap_page
from tools.chronicle_sim_v2.gui.world_graph_view import WorldGraphView
from tools.chronicle_sim_v2.gui.world_overview_html import build_world_overview_html


class WorldVizWidget(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self._run_dir: Path | None = None
        root = QVBoxLayout(self)
        self._sub = QTabWidget()
        self._sub.setDocumentMode(True)
        root.addWidget(self._sub, stretch=1)

        self.overview = QTextBrowser()
        self.overview.setReadOnly(True)
        self.overview.setOpenExternalLinks(True)
        self.overview.setMinimumHeight(420)

        graph_page = QWidget()
        g_lay = QVBoxLayout(graph_page)
        g_lay.setContentsMargins(0, 0, 0, 0)
        hint = QLabel(
            "左键拖动画布、滚轮缩放；可拖动节点；边侧白底为关系类型与强度；"
            "点边高亮，下方显示该条 JSON；点空白或 Esc 取消。"
            "蓝：角色；橙：势力；绿：地点；灰：未匹配 id。"
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#4a5568;font-size:12px;padding:4px 0;")
        g_lay.addWidget(hint)
        self.world_graph = WorldGraphView()
        self.world_graph.setMinimumHeight(400)
        g_lay.addWidget(self.world_graph, stretch=3)
        self.edge_detail = QTextBrowser()
        self.edge_detail.setReadOnly(True)
        self.edge_detail.setOpenExternalLinks(False)
        self.edge_detail.setMinimumHeight(120)
        self.edge_detail.setMaximumHeight(200)
        g_lay.addWidget(self.edge_detail, stretch=0)

        self._sub.addTab(self.overview, "概览")
        self._sub.addTab(graph_page, "关系网络")
        self.world_graph.world_edge_selected.connect(self._on_world_edge)
        self._placeholder_overview = _wrap_page(
            "世界", '<p class="muted">未加载 Run 或缺少 world/ 目录。</p>'
        )
        self.overview.setHtml(self._placeholder_overview)
        self._clear_edge_pane()

    def set_run_dir(self, run_dir: Path | None) -> None:
        self._run_dir = run_dir
        self._clear_edge_pane()
        if not run_dir or not (run_dir / "world").is_dir():
            self.overview.setHtml(self._placeholder_overview)
            self.world_graph.clear_graph()
            return
        self.overview.setHtml(build_world_overview_html(run_dir))
        self.world_graph.populate(run_dir)

    def _clear_edge_pane(self) -> None:
        self.edge_detail.setHtml(
            _wrap_page(
                "选中的边",
                "<p class='muted'>在图上点击某条有向边，将在此显示对应 JSON 记录。</p>",
            )
        )

    def _on_world_edge(self, index: int) -> None:
        d: dict[str, Any] | None = self.world_graph.raw_edge_at(index)
        if not d:
            self._clear_edge_pane()
            return
        raw = json.dumps(d, ensure_ascii=False, indent=2)
        inner = f"<h2>边记录 #{index + 1}</h2><pre class='raw'>{E(raw)}</pre>"
        self.edge_detail.setHtml(_wrap_page("边详情", inner))
