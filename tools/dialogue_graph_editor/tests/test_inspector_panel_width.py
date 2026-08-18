"""检查器必须能压进面板宽度——不许把整块顶出横向滚动条。

由来（2026-08-06）：主窗给检查器的默认宽度只有 280px（`setSizes([200, 820, 280])`），
而**七种节点类型全部超宽**（line 431 / switch 431 / contextState 494 …）。后果不是
"有点挤"，是**行尾的删除 / 上移 / 下移按钮被挤出可视区，策划根本点不到**，还得先横向
滚动才知道这条分支是什么。

常见成因，改表单时对着这张单子自检：
- 摘要用普通 QLabel（`wordWrap=False` 时最小宽 = 整段文字宽）→ 用 `_ElidingLabel`；
- **顶宽的不一定是表单**：顶部「节点 id：… 类型：…」那条曾是富文本 QLabel，最小宽 = 整行
  文字宽，且 `wordWrap=True` 对富文本不生效 —— 一个 24 字的 node id 就把面板顶到 316px，
  而报错写的是节点类型名，看着像刚加的控件闯的祸（2026-08-17 踩过整整一轮）；
- 说明写进控件文案（`多拍连续对白（每句点击继续；存为 lines 数组）`）→ 说明进 tooltip；
- 一行塞下拉 + 输入框 + 选择器 + 五个操作按钮 → 拆两行；
- QComboBox 的 minimumSizeHint 不吃 minimumContentsLength → 必须 `setMaximumWidth` 封顶；
- QGroupBox 的标题也算最小宽 → 标题只留名字。
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.dialogue_graph_editor.node_inspector import (
    INSPECTOR_PANEL_WIDTH,
    NodeInspector,
)
from tools.editor import theme as app_theme
from tools.editor.project_model import ProjectModel

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_SPK = {"kind": "npc", "npcName": "义庄管事"}

#: 每种节点都用"内容偏满"的样子测——空节点当然窄，撑不出真实问题。
_FIXTURES = {
    "line": {
        "type": "line", "speaker": _SPK,
        "text": "二狗？黄秉文家那条？前日还见它在河边转悠。",
        "next": "n_ask", "portrait": {"emotion": "平静"},
    },
    "line_multi": {
        "type": "line", "speaker": _SPK, "text": "一", "next": "n_ask",
        "lines": [
            {"speaker": _SPK, "text": "二狗？黄秉文家那条？"},
            {"speaker": {"kind": "player"}, "text": "河边？哪一段？"},
        ],
    },
    "runActions": {
        "type": "runActions", "next": "n_next",
        "actions": [{"type": "setFlag", "params": {"key": "见过管事", "value": True}}],
    },
    # 带 promptLine 的 choice 必须单列一条：真实数据里很常见，而它比裸 choice
    # 多出一整个立绘选择块（两个下拉同排），正是把面板顶到 502px 的那一款。
    "choice_with_prompt": {
        "type": "choice",
        "promptLine": {
            "speaker": _SPK, "text": "你要问哪一样？", "portrait": {"emotion": "平静"},
        },
        "options": [{"id": "a", "text": "去河边看看", "next": "n_river"}],
    },
    "choice": {
        "type": "choice",
        "options": [
            {"id": "a", "text": "去河边看看", "next": "n_river"},
            {"id": "b", "text": "先问问价", "next": "n_price", "costCoins": 10,
             "requireFlag": "见过管事", "disabledClickHint": "得先见过管事"},
        ],
    },
    "switch": {
        "type": "switch", "defaultNext": "n_d",
        "cases": [
            {"conditions": [{"narrative": "flow_xungou_main", "state": "等看进山路"}], "next": "n_a"},
            {"conditions": [{"flag": "见过管事", "value": True}, {"plane": "yin"}], "next": "n_b"},
            {"conditions": [{"scenario": "s", "phase": "p", "status": "done"}], "next": "n_c"},
        ],
    },
    "ownerState": {
        "type": "ownerState", "defaultNext": "n_b",
        "cases": [{"state": "read", "next": "n_a"}],
    },
    "contextState": {
        "type": "contextState", "graphId": "wrap_读人_儿子", "defaultNext": "n_b",
        "cases": [{"state": "s1", "next": "n_a"}],
    },
    "end": {"type": "end"},
}


class InspectorPanelWidthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def test_every_node_type_fits_the_default_panel_width(self) -> None:
        """必须**逐个主题**量：主题样式表的内边距会把最小宽再顶高 30~45px。

        只在"没上主题"的默认样式下量是假绿——实测无主题时全部达标，
        换上 modern/light/dark 后立刻有四种节点超宽。
        """
        too_wide: list[str] = []
        themes = [app_theme.THEME_MODERN, app_theme.THEME_LIGHT, app_theme.THEME_DARK]
        orig_theme = app_theme.current_theme_id()
        self.addCleanup(app_theme.apply_application_theme, self._app, orig_theme)
        for theme_id in themes:
            app_theme.apply_application_theme(self._app, theme_id)
            for _ in range(3):
                self._app.processEvents()
            too_wide.extend(self._measure(theme_id))
        self.assertEqual(
            too_wide,
            [],
            "下列节点类型会把检查器顶出横向滚动条（行尾按钮点不到）：\n  "
            + "\n  ".join(too_wide),
        )

    def test_expanded_condition_rows_also_fit(self) -> None:
        """展开态也要量：折叠列表当然窄，条件行根本没建出来。

        实测漏洞：switch fixture 有 3 条分支 → 全部折叠 → scenario 条件叶那一行
        （类型下拉 + 值下拉 + 值控件）从没被量到，实际超宽 13–16px、行尾删除按钮被切。
        """
        node = {
            "type": "switch", "defaultNext": "n_d",
            "cases": [{
                "conditions": [
                    {"scenario": "s", "phase": "p", "status": "done", "outcome": 3},
                    {"flag": "f", "op": ">=", "value": 3},
                    {"narrative": "g", "state": "st", "reached": True},
                ],
                "next": "n_a",
            }],
        }
        orig_theme = app_theme.current_theme_id()
        self.addCleanup(app_theme.apply_application_theme, self._app, orig_theme)
        too_wide: list[str] = []
        for theme_id in (app_theme.THEME_MODERN, app_theme.THEME_LIGHT, app_theme.THEME_DARK):
            app_theme.apply_application_theme(self._app, theme_id)
            for _ in range(3):
                self._app.processEvents()
            insp = NodeInspector(
                lambda: ["n_a", "n_d"],
                project_root=_PROJECT_ROOT,
                project_model_getter=lambda: self._pm,
            )
            self.addCleanup(insp.deleteLater)
            insp.resize(INSPECTOR_PANEL_WIDTH, 900)
            insp.set_node("probe_expanded", node)
            for _ in range(6):
                self._app.processEvents()
            # 单条分支默认展开；把每条条件也展开，量最坏情况
            for cr in insp._topology_refs["case_rows"][0]["cond_rows"]:
                if cr["collapsed"]:
                    cr["toggle"].click()
            for _ in range(6):
                self._app.processEvents()
            need = insp.minimumSizeHint().width()
            if need > INSPECTOR_PANEL_WIDTH:
                too_wide.append(f"[{theme_id}] 展开的条件行: {need}px > {INSPECTOR_PANEL_WIDTH}px")
        self.assertEqual(
            too_wide, [],
            "展开条件叶后仍会顶出横向滚动条（行尾删除按钮被切）：\n  " + "\n  ".join(too_wide),
        )

    def _measure(self, theme_id: str) -> list[str]:
        too_wide: list[str] = []
        for name, node in _FIXTURES.items():
            insp = NodeInspector(
                lambda: ["n_a", "n_b", "n_c", "n_d", "n_ask", "n_river", "n_price", "n_next"],
                project_root=_PROJECT_ROOT,
                project_model_getter=lambda: self._pm,
                dialogue_graph_id_getter=lambda: "寻狗_义庄管事",
            )
            self.addCleanup(insp.deleteLater)
            insp.resize(INSPECTOR_PANEL_WIDTH, 700)
            insp.set_node(f"probe_{name}", node)
            for _ in range(6):
                self._app.processEvents()
            need = insp.minimumSizeHint().width()
            if need > INSPECTOR_PANEL_WIDTH:
                too_wide.append(
                    f"[{theme_id}] {name}: 最小宽 {need}px > 面板 {INSPECTOR_PANEL_WIDTH}px"
                )
        return too_wide

    def test_long_node_id_does_not_push_the_panel_wide(self) -> None:
        """顶部「节点 id：… 类型：…」也必须可省略——它装的是**数据来的** id，长度无上限。

        由来（2026-08-17）：上面那条护栏红在 `choice_with_prompt 316px`，成因却是
        fixture 自己造的 24 字 id `probe_choice_with_prompt` 顶宽了顶部那条富文本 QLabel，
        与 promptLine 的任何控件无关（换成 `n` 立刻降到 268px；`git stash` 掉当时的
        node_inspector 改动仍是 316px）。**护栏红着但指错人**，比不红更费人——
        下一个改检查器的人会以为是自己弄坏的。这里直接拿真实数据里那种长度量。
        """
        from tools.dialogue_graph_editor.node_inspector import _ElidingLabel

        long_id = "生态_歇口气_码头白天_搬运工_闲聊_02_问价钱_被打断"
        orig_theme = app_theme.current_theme_id()
        self.addCleanup(app_theme.apply_application_theme, self._app, orig_theme)
        too_wide: list[str] = []
        for theme_id in (app_theme.THEME_MODERN, app_theme.THEME_LIGHT, app_theme.THEME_DARK):
            app_theme.apply_application_theme(self._app, theme_id)
            for _ in range(3):
                self._app.processEvents()
            insp = NodeInspector(
                lambda: [long_id],
                project_root=_PROJECT_ROOT,
                project_model_getter=lambda: self._pm,
            )
            self.addCleanup(insp.deleteLater)
            insp.resize(INSPECTOR_PANEL_WIDTH, 700)
            insp.set_node(long_id, {"type": "end"})
            for _ in range(6):
                self._app.processEvents()
            self.assertIsInstance(insp._type_label, _ElidingLabel)
            self.assertIn(long_id, insp._type_label.toolTip(), "完整 id 必须能从 tooltip 看到")
            need = insp.minimumSizeHint().width()
            if need > INSPECTOR_PANEL_WIDTH:
                too_wide.append(f"[{theme_id}] 长 id 的顶部标签: {need}px > {INSPECTOR_PANEL_WIDTH}px")
        self.assertEqual(
            too_wide, [],
            "长 node id 把检查器顶出横向滚动条（顶部标签不可省略）：\n  " + "\n  ".join(too_wide),
        )

    def test_row_summaries_are_elidable_not_wall_pushing(self) -> None:
        """分支/选项/台词的摘要标签必须是可省略的那种，否则一行就把面板顶爆。"""
        from tools.dialogue_graph_editor.node_inspector import _ElidingLabel

        insp = NodeInspector(
            lambda: ["n_a", "n_d"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        insp.set_node("probe_sw", _FIXTURES["switch"])
        rows = insp._topology_refs["case_rows"]
        self.assertTrue(rows)
        for r in rows:
            lbl = r["summary_label"]
            self.assertIsInstance(lbl, _ElidingLabel)
            self.assertLessEqual(
                lbl.minimumSizeHint().width(), 60, "摘要标签的最小宽度必须很小"
            )
            self.assertTrue(lbl.toolTip(), "省略后完整内容必须能从 tooltip 看到")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
