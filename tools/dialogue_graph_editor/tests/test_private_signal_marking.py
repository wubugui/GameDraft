"""私有信号在**发射端**要一眼认得出（标记 + 提示）。

为什么这道护栏值得存在：私有信号（`signals[].scope == 'private'`）按发射方 owner
定向投递，缺 owner 上下文运行时**当场丢弃**（fail-loud，绝不回落成全局广播）。
对话图本身无状态、owner 是调用那一刻带进来的——同一张图挂在有实体的热点上就正常推、
挂在没有实体上下文的容器上就一声不响地丢。策划在挑信号那一刻看不出任何区别，
等跑起来才发现"怎么没反应"。

真相源：src/core/NarrativeStateManager.ts、src/core/narrativeGraphValidation.ts
（`validatePrivateSignalListeners`），机制卡 agent_docs/runtime/mechanisms/private-narrative-signal.md。
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QLabel, QWidget, QVBoxLayout

from tools.dialogue_graph_editor.graph_analysis import (
    PRIVATE_SIGNAL_MARK,
    PRIVATE_SIGNAL_TOOLTIP,
    collect_private_signal_ids,
)
from tools.dialogue_graph_editor.node_inspector import (
    NodeInspector,
    mark_private_signal_fields,
)
from tools.editor.shared.action_editor import NarrativeSignalPickerField

_PROJECT_ROOT = Path(__file__).resolve().parents[3]

_REGISTRY = {
    "signals": [
        {"id": "sig_box_taken", "label": "箱子被拿了", "scope": "private"},
        {"id": "sig_chapter_done", "label": "这一章完了"},
        {"id": "sig_explicit_global", "scope": "global"},
    ]
}


class _FakeModel:
    """只提供信号面：私有标记要的就是登记表这一处，别的都不该被牵连进来。"""

    def __init__(self, narrative_graphs: dict) -> None:
        self.narrative_graphs = narrative_graphs

    def narrative_signal_rows(self) -> list[tuple[str, str]]:
        return [
            (str(row.get("label") or row["id"]), row["id"])
            for row in self.narrative_graphs.get("signals") or []
        ]


class PrivateSignalRegistryTests(unittest.TestCase):
    def test_only_scope_private_counts(self) -> None:
        assert collect_private_signal_ids(_REGISTRY) == {"sig_box_taken"}

    def test_junk_shapes_never_raise_and_never_invent_a_private_signal(self) -> None:
        # 半截数据是编辑器里的常态；读不出来就当没有，绝不把普通信号误标成私有
        # （误标的代价：作者以为"只推自己那一个"，实际一发推倒全部同名监听）。
        for junk in (None, [], {}, {"signals": 5}, {"signals": [None, 7, "x"]},
                     {"signals": [{"scope": "private"}]},          # 没 id
                     {"signals": [{"id": "  ", "scope": "private"}]},
                     {"signals": [{"id": "s", "scope": "Private"}]},  # 大小写不是同一个词
                     {"signals": [{"id": "s", "scope": None}]}):
            assert collect_private_signal_ids(junk) == set(), junk


class PrivateSignalMarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def _host(self, *signals: str) -> tuple[QWidget, list[NarrativeSignalPickerField]]:
        host = QWidget()
        lay = QVBoxLayout(host)
        fields = []
        for sig in signals:
            f = NarrativeSignalPickerField(_FakeModel(_REGISTRY), sig, host)
            lay.addWidget(f)
            fields.append(f)
        return host, fields

    def _mark_of(self, field: NarrativeSignalPickerField) -> QLabel | None:
        return field.findChild(QLabel, "gdPrivateSignalMark")

    def test_only_the_private_row_gets_a_mark(self) -> None:
        host, (private, plain) = self._host("sig_box_taken", "sig_chapter_done")
        mark_private_signal_fields(host, {"sig_box_taken"})

        mk = self._mark_of(private)
        assert mk is not None and mk.text() == PRIVATE_SIGNAL_MARK
        assert mk.isVisibleTo(private)
        assert self._mark_of(plain) is None, "全局信号那一行不该长出任何标记"
        host.deleteLater()

    def test_the_note_lands_on_what_the_mouse_actually_hovers(self) -> None:
        """提示要落到只读框上——那才是鼠标停留的地方；只挂在外层容器上等于没挂。"""
        host, (private,) = self._host("sig_box_taken")
        mark_private_signal_fields(host, {"sig_box_taken"})

        assert PRIVATE_SIGNAL_TOOLTIP in private.toolTip()
        lines = private.findChildren(type(private._line))
        assert lines, "信号字段的只读框不见了：上游换了结构，标记落点要跟着改"
        assert all(PRIVATE_SIGNAL_TOOLTIP in w.toolTip() for w in lines)
        # 原本的提示（当前信号显示名）必须留着，不能被说明顶掉
        assert "箱子被拿了" in private._line.toolTip()
        host.deleteLater()

    def test_marking_twice_does_not_stack_up(self) -> None:
        """动作行每次编辑都重来一遍，装饰必须幂等：否则一行右边会排出一串「私有」。"""
        host, (private,) = self._host("sig_box_taken")
        for _ in range(3):
            mark_private_signal_fields(host, {"sig_box_taken"})

        assert len(private.findChildren(QLabel, "gdPrivateSignalMark")) == 1
        assert private.toolTip().count(PRIVATE_SIGNAL_TOOLTIP) == 1
        assert private._line.toolTip().count(PRIVATE_SIGNAL_TOOLTIP) == 1
        host.deleteLater()

    def test_turning_private_off_takes_the_mark_and_the_note_away(self) -> None:
        """改回全局信号后还挂着「私有」= 比不标更坏：它在教人一个假的投递面。"""
        host, (field,) = self._host("sig_box_taken")
        mark_private_signal_fields(host, {"sig_box_taken"})
        mark_private_signal_fields(host, set())

        mk = self._mark_of(field)
        assert mk is not None and not mk.isVisibleTo(field)
        assert PRIVATE_SIGNAL_TOOLTIP not in field.toolTip()
        assert PRIVATE_SIGNAL_TOOLTIP not in field._line.toolTip()
        host.deleteLater()


class InspectorWiringTests(unittest.TestCase):
    """检查器打开一个发私有信号的 runActions 节点，标记要自己长出来。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def _inspector(self) -> NodeInspector:
        return NodeInspector(
            lambda: ["n_emit"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: _FakeModel(_REGISTRY),
            dialogue_graph_id_getter=lambda: "对话_测试",
        )

    def test_emit_row_of_a_private_signal_is_marked_on_open(self) -> None:
        inspector = self._inspector()
        inspector.set_node("n_emit", {
            "type": "runActions",
            "actions": [{"type": "emitNarrativeSignal", "params": {"signal": "sig_box_taken"}}],
            "next": "",
        })
        fields = inspector.findChildren(NarrativeSignalPickerField)
        assert fields, "runActions 里的发射行没有信号字段：落点变了"
        assert any(f.findChild(QLabel, "gdPrivateSignalMark") is not None for f in fields)
        assert any(PRIVATE_SIGNAL_TOOLTIP in f.toolTip() for f in fields)
        inspector.deleteLater()

    def test_a_global_signal_row_stays_clean(self) -> None:
        inspector = self._inspector()
        inspector.set_node("n_emit", {
            "type": "runActions",
            "actions": [{"type": "emitNarrativeSignal", "params": {"signal": "sig_chapter_done"}}],
            "next": "",
        })
        for f in inspector.findChildren(NarrativeSignalPickerField):
            assert f.findChild(QLabel, "gdPrivateSignalMark") is None
            assert PRIVATE_SIGNAL_TOOLTIP not in f.toolTip()
        inspector.deleteLater()

    def test_marking_never_touches_what_gets_saved(self) -> None:
        """只加标记与提示：往返出来的内容一字不改。

        ⚠ 比较前剔掉空值参数：ActionEditor 的 `_OMIT_WHEN_ABSENT_AND_DEFAULT` 登记了
        `sourceType`/`sourceId` 却漏了 `ownerType`/`ownerId`，于是打开一个发信号的节点
        再保存，会凭空注入 `"ownerType": "", "ownerId": ""`。那是 tools/editor 侧既有的
        往返缺口（与本标记无关），这里不替它兜底、也不让它把本探针染红。
        """
        node = {
            "type": "runActions",
            "actions": [{"type": "emitNarrativeSignal", "params": {"signal": "sig_box_taken"}}],
            "next": "n_next",
        }
        inspector = self._inspector()
        inspector.set_node("n_emit", dict(node))
        got = inspector.get_node()
        for act in got.get("actions") or []:
            act["params"] = {k: v for k, v in (act.get("params") or {}).items() if v != ""}
        assert got == node
        inspector.deleteLater()


if __name__ == "__main__":
    unittest.main()
