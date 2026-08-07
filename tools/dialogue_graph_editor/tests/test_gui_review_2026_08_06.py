"""GUI 专项审查（2026-08-06）修复的护栏。

锁的都是「策划根本没法用」那一档：
- 主编辑器里 Ctrl+Z 撤销不了图对话，反而静默回退别的编辑器的改动；
- 会丢数据的弹窗按钮是英文（Discard = 丢弃全部未保存改动）；
- 分支/选项在检查器里没编号，而画布与校验消息都按数据下标说话；
- 校验条目双击无反应，拿到「分支 1 恒命中」只能回去一条条数；
- 结构化条件树被锁死 180px 高，滚动条套滚动条。
"""
from __future__ import annotations

import copy
import json
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QMessageBox, QScrollArea

from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
from tools.dialogue_graph_editor.graph_document import list_graph_files
from tools.editor import theme as app_theme
from tools.editor.editors.dialogue_graph_editor_tab import DialogueGraphEditorTab
from tools.editor.project_model import ProjectModel

from ._qt_dialog_stubs import _SilencedBoxes

_ROOT = Path(__file__).resolve().parents[3]


class UndoHookTests(unittest.TestCase):
    """图对话 tab 必须有 editor_undo/editor_redo。

    缺钩子不是「Ctrl+Z 没反应」而是更糟：主窗回落到**全局** ProjectModel 撤销栈，
    于是策划在图对话里按 Ctrl+Z，图纹丝不动（他会连按几次），每按一次都在悄悄
    回退场景/任务编辑器里的改动。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    def test_tab_exposes_undo_hooks_and_uses_its_own_stack(self) -> None:
        tab = DialogueGraphEditorTab(self._pm)
        self.addCleanup(tab.deleteLater)
        self.assertTrue(callable(getattr(tab, "editor_undo", None)))
        self.assertTrue(callable(getattr(tab, "editor_redo", None)))
        self.assertIsNot(tab._panel._undo_stack, self._pm.undo_stack)

    def test_undo_hits_the_dialogue_stack_not_the_global_one(self) -> None:
        tab = DialogueGraphEditorTab(self._pm)
        self.addCleanup(tab.deleteLater)
        panel = tab._panel
        path = next(
            p for p in list_graph_files(_ROOT)
            if any(
                isinstance(v, dict) and v.get("type") == "line"
                for v in (json.loads(p.read_text(encoding="utf-8")).get("nodes") or {}).values()
            )
        )
        panel._load_path(path)
        for _ in range(12):
            self._app.processEvents()
        nid = next(
            k for k, v in panel._model.nodes.items()
            if isinstance(v, dict) and v.get("type") == "line"
        )
        panel.focus_node_by_id(nid)
        for _ in range(12):
            self._app.processEvents()
        before = panel._model.nodes[nid].get("next")
        global_before = self._pm.undo_stack.index()

        panel._inspector._topology_refs["next_edit"].setText((before or "") + "ZZZ")
        for _ in range(12):
            self._app.processEvents()
        self.assertNotEqual(panel._model.nodes[nid].get("next"), before)

        tab.editor_undo()
        for _ in range(12):
            self._app.processEvents()
        self.assertEqual(panel._model.nodes[nid].get("next"), before, "撤销没落到图对话自己的栈上")
        self.assertEqual(
            self._pm.undo_stack.index(), global_before,
            "撤销动了全局 ProjectModel 栈——那会静默回退别的编辑器的改动",
        )


class ChineseDialogButtonsTests(unittest.TestCase):
    """会丢数据的弹窗按钮必须是中文。`Discard` = 丢弃全部未保存改动。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_standard_buttons_are_translated(self) -> None:
        app_theme.apply_application_theme(self._app, app_theme.THEME_MODERN)
        for _ in range(3):
            self._app.processEvents()
        box = QMessageBox()
        box.setStandardButtons(
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Cancel
            | QMessageBox.StandardButton.Discard
        )
        texts = [b.text().replace("&", "") for b in box.buttons()]
        for t in texts:
            self.assertFalse(
                t.isascii(), f"弹窗按钮仍是英文：{texts}（Discard 会丢掉全部未保存改动）"
            )


class BranchNumberingAndNavTests(unittest.TestCase):
    """三个面（检查器 / 画布端口 / 校验消息）必须用同一套分支编号，且校验可双击定位。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    def _open_switch_graph(self):
        w = DialogueGraphEditorWidget(_ROOT, None, project_model=self._pm)
        self.addCleanup(w.deleteLater)
        w.resize(1300, 850)
        w.show()
        path = next(
            p for p in list_graph_files(_ROOT)
            if any(
                isinstance(v, dict) and v.get("type") == "switch" and len(v.get("cases") or []) >= 2
                for v in (json.loads(p.read_text(encoding="utf-8")).get("nodes") or {}).values()
            )
        )
        w._load_path(path)
        for _ in range(20):
            self._app.processEvents()
        nid = next(
            k for k, v in w._model.nodes.items()
            if isinstance(v, dict) and v.get("type") == "switch" and len(v.get("cases") or []) >= 2
        )
        return w, nid

    def test_branch_summaries_carry_the_data_index(self) -> None:
        w, nid = self._open_switch_graph()
        w.focus_node_by_id(nid)
        for _ in range(12):
            self._app.processEvents()
        rows = w._inspector._topology_refs["case_rows"]
        for i, r in enumerate(rows):
            self.assertTrue(
                r["summary_label"].fullText().startswith(f"{i}."),
                f"分支标题缺少序号：{r['summary_label'].fullText()!r}"
                "（画布端口与校验消息都按数据下标说话，检查器不能没有）",
            )

    def test_validation_item_double_click_jumps_and_expands(self) -> None:
        w, nid = self._open_switch_graph()
        raw = copy.deepcopy(w._model.nodes[nid])
        raw["cases"][1]["next"] = "不存在的节点X"
        w._model.set_node(nid, raw)
        w._refresh_validation_panel(flush_inspector=False)
        for _ in range(15):
            self._app.processEvents()

        target = None
        for i in range(w._validation_list.count()):
            it = w._validation_list.item(i)
            if it.data(Qt.ItemDataRole.UserRole) == nid:
                target = it
                break
        self.assertIsNotNone(target, "校验条目没带定位信息，双击等于死文本")
        self.assertEqual(target.data(Qt.ItemDataRole.UserRole + 1), 1, "没解析出分支下标")

        w._on_validation_item_double_clicked(target)
        for _ in range(15):
            self._app.processEvents()
        self.assertEqual(w._inspector.current_node_id(), nid)
        rows = w._inspector._topology_refs["case_rows"]
        self.assertFalse(rows[1]["collapsed"], "双击后应展开出问题的那条分支")

    def test_validation_messages_say_branch_not_case(self) -> None:
        """同一个面板里不许「分支 N」和「case N」混着用。"""
        from tools.dialogue_graph_editor.graph_document import validate_graph_tiered

        data = {
            "schemaVersion": 1, "id": "g", "entry": "sw",
            "nodes": {
                "sw": {"type": "switch", "cases": [{"next": "e"}, "坏的"], "defaultNext": "e"},
                "e": {"type": "end"},
            },
        }
        errors, warnings = validate_graph_tiered(data)
        joined = " ".join(errors + warnings)
        self.assertNotIn("case ", joined, f"仍在用英文 case 叫法：{errors + warnings}")
        self.assertIn("分支", joined)


class ConditionTreeHeightTests(unittest.TestCase):
    """结构化条件树的高度必须跟内容长，不许锁死 180px 让人从猫眼里看。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    def test_tree_grows_with_content(self) -> None:
        from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget

        small = ConditionExprTreeRootWidget(model_getter=lambda: self._pm)
        self.addCleanup(small.deleteLater)
        small.set_expr({"flag": "a", "value": True})
        for _ in range(6):
            self._app.processEvents()
        small_h = small.findChild(QScrollArea).minimumHeight()

        big = ConditionExprTreeRootWidget(model_getter=lambda: self._pm)
        self.addCleanup(big.deleteLater)
        big.set_expr({"any": [
            {"flag": "a", "value": True},
            {"not": {"flag": "b", "value": True}},
            {"all": [{"narrative": "g", "state": "s"}, {"plane": "yin"}]},
        ]})
        for _ in range(6):
            self._app.processEvents()
        big_scroll = big.findChild(QScrollArea)
        self.assertGreater(
            big_scroll.minimumHeight(), small_h,
            "条件树高度没跟着内容长——内容 700px 却只开 180px 的猫眼",
        )
        self.assertGreaterEqual(
            big_scroll.minimumHeight(), big._root.sizeHint().height(),
            "可视高度仍小于内容高度，还是要在内层滚",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class RowIndexConsistencyTests(unittest.TestCase):
    """检查器序号必须与写盘下标、校验消息始终对得上——**尤其在删行之后**。

    上一轮的实现从"加载时记的 junk 原下标"推算，而写盘走 `_reinsert_junk` 的
    `min(index, len(out))`：行数少于 junk 原下标时 junk 被贴到末尾，两边规则打架。
    后果比"没有编号"更坏：校验说「分支 2 的去向不存在」，策划打开标着 2. 的那条
    （完全正常），改一通存盘再校验——错误还在，而真正坏的那条标着 4.。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    def _node(self):
        return {
            "type": "switch", "defaultNext": "n_d",
            "cases": [
                {"conditions": [{"flag": "a", "value": True}], "next": "n_a"},
                {"conditions": [{"flag": "b", "value": True}], "next": "n_b"},
                {"conditions": [{"flag": "c", "value": True}], "next": "n_c"},
                "坏元素",
                {"conditions": [{"flag": "e", "value": True}], "next": "MISSING_TARGET"},
            ],
        }

    def _check(self, insp) -> None:
        """校验消息里的「分支 N」必须与检查器标着 N. 的那条是同一条。"""
        from tools.dialogue_graph_editor.graph_document import validate_graph_tiered
        from tools.dialogue_graph_editor.node_inspector import NodeInspector  # noqa: F401

        out = insp.get_node()
        graph = {
            "schemaVersion": 1, "id": "g", "entry": "root",
            "nodes": {"root": out, "n_a": {"type": "end"}, "n_b": {"type": "end"},
                      "n_c": {"type": "end"}, "n_d": {"type": "end"}},
        }
        errors, _w = validate_graph_tiered(graph)
        bad = [e for e in errors if "指向不存在" in e]
        if not bad:
            return
        n = int(bad[0].split("分支 ")[1].split(":")[0])
        titles = [r["summary_label"].fullText() for r in insp._topology_refs["case_rows"]]
        same = next((t for t in titles if t.startswith(f"{n}.")), None)
        self.assertIsNotNone(same, f"校验说分支 {n}，检查器里没有标着 {n}. 的行：{titles}")
        self.assertIn(
            "e=true", same,
            f"校验说的分支 {n} 与检查器标着 {n}. 的那条不是同一条：{same!r}\n"
            f"（校验消息 {bad[0]!r} 指的是 next=MISSING_TARGET 那条）",
        )

    def test_index_stays_consistent_across_deletes(self) -> None:
        from PySide6.QtWidgets import QMessageBox as _QMB
        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        orig_q = _QMB.question
        _QMB.question = staticmethod(lambda *a, **k: _QMB.StandardButton.Ok)
        self.addCleanup(lambda: setattr(_QMB, "question", orig_q))

        insp = NodeInspector(
            lambda: ["n_a", "n_b", "n_c", "n_d"],
            project_root=_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        insp.set_node("root", copy.deepcopy(self._node()))
        for _ in range(6):
            self._app.processEvents()
        self._check(insp)
        for _ in range(2):  # 连删两次，每次都要重新对得上
            insp._topology_refs["case_rows"][0]["btn_del"].click()
            for _ in range(6):
                self._app.processEvents()
            self._check(insp)


class EmptyStateAfterDeleteTests(unittest.TestCase):
    """删掉最后一条分支/选项之后，必须告诉策划"这个节点现在是死的"。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    def _delete_all_and_check_hint(self, node: dict, rows_key: str, keyword: str) -> None:
        from PySide6.QtWidgets import QLabel, QMessageBox as _QMB
        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        orig_q = _QMB.question
        orig_i = _QMB.information
        _QMB.question = staticmethod(lambda *a, **k: _QMB.StandardButton.Ok)
        _QMB.information = staticmethod(lambda *a, **k: None)
        self.addCleanup(lambda: setattr(_QMB, "question", orig_q))
        self.addCleanup(lambda: setattr(_QMB, "information", orig_i))

        insp = NodeInspector(
            lambda: ["n_a", "n_d"],
            project_root=_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        insp.set_node("n", copy.deepcopy(node))
        for _ in range(6):
            self._app.processEvents()
        while insp._topology_refs.get(rows_key):
            insp._topology_refs[rows_key][0]["btn_del"].click()
            for _ in range(6):
                self._app.processEvents()
        hints = [
            lb for lb in insp._body.findChildren(QLabel)
            if keyword in lb.text() and lb.isVisibleTo(insp._body)
        ]
        self.assertTrue(
            hints,
            f"删空之后没有任何提示（关键词 {keyword!r}）——策划不知道这个节点已经是死的",
        )

    def test_switch_shows_empty_hint_after_deleting_last_case(self) -> None:
        self._delete_all_and_check_hint(
            {"type": "switch", "defaultNext": "n_d",
             "cases": [{"conditions": [{"flag": "a", "value": True}], "next": "n_a"}]},
            "case_rows", "没有分支",
        )

    def test_choice_shows_empty_hint_after_deleting_last_option(self) -> None:
        self._delete_all_and_check_hint(
            {"type": "choice", "options": [{"id": "a", "text": "甲", "next": "n_a"}]},
            "option_rows", "没有选项",
        )


class RowHeaderParityTests(unittest.TestCase):
    """所有「可增删的列表行」必须用同一套行头（自适应 + 右键菜单），一个节点类型都不许落下。

    连续两轮都栽在同一件事上：switch 改好了，choice / line / 条件行 / ownerState /
    contextState 逐次被落下。表现是同一个面板两套手感——往里点一层，那两个方形按钮上
    印着谁也认不出的 `…`（其实是"插入空分支"，而空分支在运行时是恒命中的），右键也没菜单。
    这条测试逐个节点类型点名，新增节点类型时会被强制想到。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    #: 节点形态 → 期望至少有几个自适应行头（含条件行等嵌套层）
    _EXPECT = {
        "line_multi": 1,
        "choice": 1,
        "switch": 1,
        "switch_cond": 2,      # 分支行 + 条件行
        "ownerState": 1,
        "contextState": 1,
    }

    _NODES = {
        "line_multi": {
            "type": "line", "speaker": {"kind": "npc"}, "text": "一", "next": "n_a",
            "lines": [{"speaker": {"kind": "npc"}, "text": "一"},
                      {"speaker": {"kind": "player"}, "text": "二"}],
        },
        "choice": {"type": "choice",
                   "options": [{"id": "a", "text": "甲", "next": "n_a"}]},
        "switch": {"type": "switch", "defaultNext": "n_a",
                   "cases": [{"conditions": [{"flag": "f", "value": True}], "next": "n_a"}]},
        "switch_cond": {"type": "switch", "defaultNext": "n_a",
                        "cases": [{"conditions": [{"flag": "f", "value": True}], "next": "n_a"}]},
        "ownerState": {"type": "ownerState", "defaultNext": "n_a",
                       "cases": [{"state": "read", "next": "n_a"}]},
        "contextState": {"type": "contextState", "graphId": "g", "defaultNext": "n_a",
                         "cases": [{"state": "s1", "next": "n_a"}]},
    }

    def test_every_list_row_uses_the_shared_adaptive_header(self) -> None:
        from tools.dialogue_graph_editor.node_inspector import NodeInspector, _RowHeaderBar

        missing: list[str] = []
        for tag, node in self._NODES.items():
            insp = NodeInspector(
                lambda: ["n_a"],
                project_root=_ROOT,
                project_model_getter=lambda: self._pm,
            )
            self.addCleanup(insp.deleteLater)
            insp.resize(280, 800)
            insp.set_node("n", copy.deepcopy(node))
            for _ in range(6):
                self._app.processEvents()
            bars = insp.findChildren(_RowHeaderBar)
            want = self._EXPECT[tag]
            if len(bars) < want:
                missing.append(f"{tag}: 只有 {len(bars)} 个自适应行头，期望 ≥{want}")
            no_menu = [
                b for b in bars
                if b.contextMenuPolicy() != Qt.ContextMenuPolicy.CustomContextMenu
            ]
            if no_menu:
                missing.append(f"{tag}: {len(no_menu)} 个行头没有右键菜单")
        self.assertEqual(
            missing, [],
            "下列节点类型的列表行没接共享行头（同一面板两套手感）：\n  " + "\n  ".join(missing),
        )

    #: 有分支/选项列表的节点类型 → 取行的 refs 键。摘要必须带数据下标，
    #: 否则校验说「分支 N」时策划只能 1-based/0-based 猜着数（坏元素还占号）。
    _INDEXED = {
        "choice": "option_rows",
        "switch": "case_rows",
        "ownerState": "case_rows",
        "contextState": "case_rows",
    }

    def test_index_ignores_rows_that_will_not_be_written(self) -> None:
        """会被 getter 丢弃的行不许占号——否则它后面每一行的序号都错。

        ownerState/contextState 的 getter 刻意丢弃「新加但从未填写」的空行，而序号
        若按表单行位置算，这条空行就占了数据里根本不存在的号。「在此之后插入」是
        最常用的编辑动作之一，插完到填完之间**所有分支的序号都是错的**——序号本来
        就是为了解决"校验说分支 N 却找不到"才加的，不能在最常见的中间态里自己制造它。
        """
        from PySide6.QtWidgets import QMessageBox as _QMB
        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        orig_q = _QMB.question
        _QMB.question = staticmethod(lambda *a, **k: _QMB.StandardButton.Ok)
        self.addCleanup(lambda: setattr(_QMB, "question", orig_q))

        problems: list[str] = []
        for tag in ("ownerState", "contextState"):
            node = copy.deepcopy(self._NODES[tag])
            node["cases"] = [{"state": "s1", "next": "n_a"}, {"state": "s2", "next": "n_a"}]
            insp = NodeInspector(
                lambda: ["n_a"], project_root=_ROOT,
                project_model_getter=lambda: self._pm,
            )
            self.addCleanup(insp.deleteLater)
            insp.set_node("n", node)
            for _ in range(6):
                self._app.processEvents()
            insp._topology_refs["case_rows"][0]["btn_before"].click()
            for _ in range(6):
                self._app.processEvents()

            written = insp.get_node()["cases"]
            for r in insp._topology_refs["case_rows"]:
                text = r["summary_label"].fullText()
                if not text or not text[0].isdigit():
                    continue  # 未填行不给号，正确
                n = int(text.split(".")[0])
                body = text.split(". ", 1)[1].split("  →")[0].strip()
                if n >= len(written) or written[n].get("state", "") != body:
                    problems.append(
                        f"{tag}: 摘要标着 {n}. 的是 {body!r}，"
                        f"但写盘下标 {n} 是 "
                        f"{written[n].get('state') if n < len(written) else '（越界）'!r}"
                    )
        self.assertEqual(
            problems, [],
            "插入未填行之后序号与写盘对不上：\n  " + "\n  ".join(problems),
        )

    def test_every_branch_summary_carries_the_data_index(self) -> None:
        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        missing: list[str] = []
        for tag, key in self._INDEXED.items():
            insp = NodeInspector(
                lambda: ["n_a"], project_root=_ROOT,
                project_model_getter=lambda: self._pm,
            )
            self.addCleanup(insp.deleteLater)
            insp.set_node("n", copy.deepcopy(self._NODES[tag]))
            for _ in range(6):
                self._app.processEvents()
            rows = insp._topology_refs.get(key) or []
            if not rows:
                missing.append(f"{tag}: 取不到 {key}")
                continue
            for i, r in enumerate(rows):
                lbl = r.get("summary_label")
                if lbl is None:
                    missing.append(f"{tag}: 第 {i} 行没有摘要标签")
                    continue
                if not lbl.fullText().startswith(f"{i}."):
                    missing.append(
                        f"{tag}: 第 {i} 行摘要没带数据下标：{lbl.fullText()!r}"
                    )
        self.assertEqual(
            missing, [],
            "下列节点类型的摘要缺数据下标（校验说「分支 N」时对不上）：\n  "
            + "\n  ".join(missing),
        )

    def test_no_raw_enum_text_leaks_into_combos(self) -> None:
        """状态枚举必须显示中文；取值仍走 itemData，绝不因中文化写坏数据。"""
        from PySide6.QtWidgets import QComboBox

        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        raw = {"Inactive", "Active", "Completed", "pending", "active", "done", "locked",
               "player", "npc", "literal", "sceneNpc"}
        nodes = {
            "quest": {"type": "switch", "defaultNext": "n_a", "cases": [
                {"conditions": [{"quest": "q", "status": "Completed"}], "next": "n_a"}]},
            "scenario": {"type": "switch", "defaultNext": "n_a", "cases": [
                {"conditions": [{"scenario": "s", "phase": "p", "status": "locked"}],
                 "next": "n_a"}]},
        }
        leaked: list[str] = []
        for tag, node in nodes.items():
            insp = NodeInspector(
                lambda: ["n_a"], project_root=_ROOT,
                project_model_getter=lambda: self._pm,
            )
            self.addCleanup(insp.deleteLater)
            insp.set_node("n", copy.deepcopy(node))
            for _ in range(6):
                self._app.processEvents()
            for cb in insp._body.findChildren(QComboBox):
                for i in range(cb.count()):
                    if cb.itemText(i) in raw:
                        leaked.append(f"{tag}: 下拉里仍是纯英文枚举 {cb.itemText(i)!r}")
            self.assertEqual(
                insp.get_node(), node,
                f"{tag}: 中文化把数据写坏了（取值必须走 itemData 而不是显示文案）",
            )
        self.assertEqual(leaked, [], "\n  ".join(leaked))


class FitAllTests(unittest.TestCase):
    """「适应画布」必须真的把整张图放进视野，且连点多次不变。

    这条测试的写法本身是教训：上一轮给 fit_all 加「缩放下限」时，两轮验收都只断言了
    「单次调用后的缩放 ≥ 阈值」——两轮都放过了这个 P0：
      · `v.scale(...)` 解析到的是 **OdenGraphQt 重写的 `NodeViewer.scale`**，按框架内部
        `_scene_range` 累乘，而 `fitInView` 直写 QTransform，两者不在同一坐标账本上
        → 每点一次就在上一次基础上再乘一遍（实测 1.16→2.60→5.85→…→149.18）；
      · 加了下限之后大图根本装不下，「适应画布」这个名字在骗人。
    所以这里断言的是**语义**（全图在不在视野内、重复调用稳不稳），不是某个数值阈值。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    def test_fit_all_is_idempotent_and_shows_everything(self) -> None:
        biggest = sorted(
            list_graph_files(_ROOT),
            key=lambda p: -len(json.loads(p.read_text(encoding="utf-8")).get("nodes") or {}),
        )[:3]
        problems: list[str] = []
        for path in biggest:
            w = DialogueGraphEditorWidget(_ROOT, None, project_model=self._pm)
            self.addCleanup(w.deleteLater)
            w.resize(1300, 850)
            w.show()
            w._load_path(path)
            for _ in range(25):
                self._app.processEvents()
            viewer = w._oden._graph.viewer()

            scales = []
            for _ in range(5):
                w._oden.fit_all()
                for _ in range(6):
                    self._app.processEvents()
                scales.append(round(viewer.transform().m11(), 4))
            if len(set(scales)) != 1:
                problems.append(
                    f"{path.stem}: 连点 5 次「适应画布」缩放在变（指数累积）：{scales}"
                )
            visible = viewer.mapToScene(viewer.viewport().rect()).boundingRect()
            items = viewer.scene().itemsBoundingRect()
            if not visible.contains(items):
                problems.append(
                    f"{path.stem}: 适应之后全图仍不在视野内"
                    f"（可视 {visible.width():.0f}×{visible.height():.0f} / "
                    f"内容 {items.width():.0f}×{items.height():.0f}）"
                )
        self.assertEqual(problems, [], "\n  ".join(problems))


class DeleteBranchParityTests(unittest.TestCase):
    """六类列表行的删除手感必须一致：有内容才确认、允许删空、删空由校验提示。

    ownerState/contextState 原来是硬拦「至少保留一条状态分支」——用"让编辑进不去"
    来拦非法数据，与机制卡硬契约 §7 的取向相反，也让策划想清空重来时只能留一条占位。
    放开的前提是**删空不能静默**：校验得像 switch 那样说一句。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_ROOT)

    #: 六类可增删的列表行 → (节点形态, refs 键, 造两行的构造器)
    _SIX = {
        "line多拍": ("line_multi", "beat_rows"),
        "choice选项": ("choice2", "option_rows"),
        "switch分支": ("switch2", "case_rows"),
        "switch条件行": ("switch_cond2", None),
        "ownerState": ("ownerState2", "case_rows"),
        "contextState": ("contextState2", "case_rows"),
    }
    _SIX_NODES = {
        "line_multi": {"type": "line", "speaker": {"kind": "npc"}, "text": "一", "next": "n_a",
                       "lines": [{"speaker": {"kind": "npc"}, "text": "第一句"},
                                 {"speaker": {"kind": "npc"}, "text": "第二句"}]},
        "choice2": {"type": "choice", "options": [{"id": "a", "text": "甲", "next": "n_a"},
                                                  {"id": "b", "text": "乙", "next": "n_a"}]},
        "switch2": {"type": "switch", "defaultNext": "n_a", "cases": [
            {"conditions": [{"flag": "f1", "value": True}], "next": "n_a"},
            {"conditions": [{"flag": "f2", "value": True}], "next": "n_a"}]},
        "switch_cond2": {"type": "switch", "defaultNext": "n_a", "cases": [
            {"conditions": [{"flag": "f1", "value": True}, {"flag": "f2", "value": True}],
             "next": "n_a"}]},
        "ownerState2": {"type": "ownerState", "defaultNext": "n_a",
                        "cases": [{"state": "s1", "next": "n_a"}, {"state": "s2", "next": "n_a"}]},
        "contextState2": {"type": "contextState", "graphId": "g", "defaultNext": "n_a",
                          "cases": [{"state": "s1", "next": "n_a"}, {"state": "s2", "next": "n_a"}]},
    }

    def test_all_six_list_kinds_confirm_before_deleting_content(self) -> None:
        """六类都必须「有内容才二次确认、取消真的不删」——逐个点名。

        上一版的类文档写着"六类一致"，但测试只覆盖了 ownerState/contextState 两类，
        于是 line 多拍与 switch 条件行**有内容也不问一声**：写满字的一句台词、
        写好的一条条件，被 24px 图标误点一下就没了（Ctrl+Z 能救，但策划不一定知道）。
        """
        from PySide6.QtWidgets import QMessageBox as _QMB
        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        problems: list[str] = []
        for label, (fixture, refs_key) in self._SIX.items():
            asked: list[str] = []
            orig_q, orig_i = _QMB.question, _QMB.information
            _QMB.question = staticmethod(
                lambda *a, **k: (asked.append(str(a[2]) if len(a) > 2 else ""),
                                 _QMB.StandardButton.Cancel)[1]
            )
            _QMB.information = staticmethod(lambda *a, **k: None)
            try:
                insp = NodeInspector(
                    lambda: ["n_a"], project_root=_ROOT,
                    project_model_getter=lambda: self._pm,
                )
                self.addCleanup(insp.deleteLater)
                insp.set_node("n", copy.deepcopy(self._SIX_NODES[fixture]))
                for _ in range(6):
                    self._app.processEvents()
                if refs_key is None:  # switch 条件行
                    rows = insp._topology_refs["case_rows"][0]["cond_rows"]
                else:
                    rows = insp._topology_refs[refs_key]
                before = len(rows)
                self.assertGreaterEqual(before, 2, f"{label}: 夹具没造出两行")
                rows[0]["btn_del"].click()
                for _ in range(6):
                    self._app.processEvents()
                after = len(
                    insp._topology_refs["case_rows"][0]["cond_rows"]
                    if refs_key is None else insp._topology_refs[refs_key]
                )
                if not asked:
                    problems.append(f"{label}: 删有内容的一行时不问一声")
                elif after != before:
                    problems.append(f"{label}: 点了取消却还是删了（{before}→{after}）")
            finally:
                _QMB.question, _QMB.information = orig_q, orig_i
        self.assertEqual(
            problems, [],
            "下列列表行的删除手感与其余几类不一致：\n  " + "\n  ".join(problems),
        )

    def test_all_six_list_kinds_expose_insert_buttons(self) -> None:
        """六类的前插/后插都必须**从 record 点得到**，而不是只在界面上存在。

        switch 分支行曾是唯一没把这两个按钮登记进 `_topology_refs` 的一类：
        按钮本身是好的，但任何测试都够不着它。本项目里「够不着」已经连着栽过三次
        ——「删除本条件」100% 抛 NameError、`KeyError: 'beat_rows'`、以及这一条。
        插出来的空分支在运行时是恒命中的，出事代价不低，所以这里连点带验。
        """
        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        problems: list[str] = []
        for label, (fixture, refs_key) in self._SIX.items():
            for which in ("btn_before", "btn_after"):
                with _SilencedBoxes():
                    insp = NodeInspector(
                        lambda: ["n_a"], project_root=_ROOT,
                        project_model_getter=lambda: self._pm,
                    )
                    self.addCleanup(insp.deleteLater)
                    insp.set_node("n", copy.deepcopy(self._SIX_NODES[fixture]))
                    for _ in range(6):
                        self._app.processEvents()

                    def _rows() -> list:
                        if refs_key is None:  # switch 条件行
                            return insp._topology_refs["case_rows"][0]["cond_rows"]
                        return insp._topology_refs[refs_key]

                    rows = _rows()
                    btn = rows[0].get(which)
                    if btn is None:
                        problems.append(
                            f"{label}: 行记录里没有 {which}，测试够不着这个按钮"
                        )
                        continue
                    before = len(rows)
                    btn.click()
                    for _ in range(6):
                        self._app.processEvents()
                    after = len(_rows())
                    if after != before + 1:
                        problems.append(
                            f"{label}: 点 {which} 没有插出一行（{before}→{after}）"
                        )
        self.assertEqual(
            problems, [],
            "下列列表行的前插/后插按钮够不着或不生效：\n  " + "\n  ".join(problems),
        )

    def test_malformed_cases_do_not_silence_validation(self) -> None:
        """cases 被手改成标量时校验不许抛——抛了整块校验面板就不再刷新，
        策划看到的是「一条错误都没有」。"""
        from tools.dialogue_graph_editor.graph_document import validate_graph_tiered

        for t, extra in (("switch", {"defaultNext": "e"}),
                         ("ownerState", {"defaultNext": "e"}),
                         ("contextState", {"graphId": "g", "defaultNext": "e"})):
            for bad in (5, "x", {"a": 1}, {}):
                node = dict({"type": t, "cases": bad}, **extra)
                data = {"schemaVersion": 1, "id": "g", "entry": "n",
                        "nodes": {"n": node, "e": {"type": "end"}}}
                with self.subTest(type=t, bad=bad):
                    errors, _w = validate_graph_tiered(data)  # 不许抛
                    self.assertTrue(
                        any("数组" in e for e in errors),
                        f"{t} cases={bad!r} 没被报出来：{errors}",
                    )

    def test_state_branches_can_be_deleted_to_empty(self) -> None:
        from PySide6.QtWidgets import QMessageBox as _QMB
        from tools.dialogue_graph_editor.node_inspector import NodeInspector

        orig_q, orig_i = _QMB.question, _QMB.information
        _QMB.question = staticmethod(lambda *a, **k: _QMB.StandardButton.Ok)
        _QMB.information = staticmethod(lambda *a, **k: None)
        self.addCleanup(lambda: setattr(_QMB, "question", orig_q))
        self.addCleanup(lambda: setattr(_QMB, "information", orig_i))

        for tag, extra in (("ownerState", {}), ("contextState", {"graphId": "g"})):
            node = dict(
                {"type": tag, "defaultNext": "n_a",
                 "cases": [{"state": "s1", "next": "n_a"}]},
                **extra,
            )
            insp = NodeInspector(
                lambda: ["n_a"], project_root=_ROOT,
                project_model_getter=lambda: self._pm,
            )
            self.addCleanup(insp.deleteLater)
            insp.set_node("n", copy.deepcopy(node))
            for _ in range(6):
                self._app.processEvents()
            rows = insp._topology_refs["case_rows"]
            self.assertTrue(rows, f"{tag}: 取不到分支行")
            rows[0]["btn_del"].click()
            for _ in range(6):
                self._app.processEvents()
            self.assertEqual(
                insp._topology_refs["case_rows"], [],
                f"{tag}: 最后一条分支删不掉（硬拦仍在）",
            )
            self.assertEqual(insp.get_node()["cases"], [], f"{tag}: 删空没写进数据")

    def test_empty_state_branches_are_reported_not_silent(self) -> None:
        from tools.dialogue_graph_editor.graph_document import validate_graph_tiered

        for tag, extra in (("ownerState", {}), ("contextState", {"graphId": "g"})):
            node = dict({"type": tag, "cases": [], "defaultNext": "e"}, **extra)
            data = {"schemaVersion": 1, "id": "g", "entry": "n",
                    "nodes": {"n": node, "e": {"type": "end"}}}
            _e, warns = validate_graph_tiered(data)
            self.assertTrue(
                any("没有状态分支" in w for w in warns),
                f"{tag}: 删空之后校验一声不吭（放开删除的前提就是这句提示）",
            )

    def test_shipped_graphs_get_no_new_noise(self) -> None:
        from tools.dialogue_graph_editor.graph_document import (
            list_graph_files, load_json, validate_graph_tiered,
        )

        noisy: list[str] = []
        for path in list_graph_files(_ROOT):
            _e, warns = validate_graph_tiered(load_json(path))
            noisy.extend(f"{path.name}: {w}" for w in warns if "没有状态分支" in w)
        self.assertEqual(noisy, [], "新校验给现有数据添了噪音")
