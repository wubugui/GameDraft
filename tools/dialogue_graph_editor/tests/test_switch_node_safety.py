"""switch 节点的数据安全与易用性护栏（2026-08-06 审查修复）。

锁死的都是实测复现过的真事故：
- 新建 switch 节点在检查器里凭空长出一条 `some_flag` 假分支，画布上却没有；
- 「多条条件 AND」→「结构化」切一下，条件全没了，写出一条运行时**恒命中**的无条件分支；
- 「结构化」→「AND」切一下，整棵 `condition` 被静默丢弃；
- 增删分支把所有分支强制折回去，正在编辑的那条也被折上；
- 画布端口只写 `case0/case1`，看不出哪条边是什么条件。

「无条件分支恒命中」的运行时依据：`GraphDialogueManager.evalSwitch` 对没有
condition/conditions 的分支求 `evaluateConditionExpr({all: []})`，而 `all` 走
`Array.every` —— 空数组恒为 true。
"""
from __future__ import annotations

import copy
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QMessageBox, QPushButton

from tools.dialogue_graph_editor import node_inspector as NI
from tools.dialogue_graph_editor.dialogue_condition_text import (
    ALWAYS,
    NEVER,
    NORMAL,
    case_condition_text,
    case_verdict,
)
from tools.dialogue_graph_editor.dialogue_topology import iter_output_slots
from tools.dialogue_graph_editor.graph_document import default_node, validate_graph_tiered
from tools.dialogue_graph_editor.node_inspector import NodeInspector
from tools.editor.project_model import ProjectModel

from ._qt_dialog_stubs import _SilencedBoxes

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class SwitchNodeSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _inspector(self) -> NodeInspector:
        insp = NodeInspector(
            lambda: ["n1", "n2", "n3"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        return insp

    @staticmethod
    def _two_case_node() -> dict:
        return {
            "type": "switch",
            "cases": [
                {"conditions": [{"flag": "a", "value": True}], "next": "n1"},
                {"conditions": [{"flag": "b", "value": True}], "next": "n2"},
            ],
            "defaultNext": "n3",
        }

    # ---------- 新建节点 ----------

    def test_default_switch_node_roundtrips_without_inventing_a_branch(self) -> None:
        node = default_node("switch", {})
        self.assertTrue(node["cases"], "新建 switch 必须自带一条分支，否则画布画不出分支端口")
        insp = self._inspector()
        insp.set_node("sw", copy.deepcopy(node))
        self.assertEqual(
            insp.get_node(),
            node,
            "打开新建 switch 再取回必须原样——旧实现会凭空补 some_flag 假分支",
        )

    def test_empty_cases_stay_empty(self) -> None:
        """磁盘上真是 cases:[] 时，检查器不得替用户造分支。"""
        node = {"type": "switch", "cases": [], "defaultNext": "n3"}
        insp = self._inspector()
        insp.set_node("sw", copy.deepcopy(node))
        self.assertEqual(insp.get_node(), node)

    # ---------- 模式切换零丢失 ----------

    def test_switching_to_expr_mode_without_editing_keeps_everything(self) -> None:
        """点开下拉「看一眼」：条件不能丢，磁盘写法也不该被顺手改掉。"""
        node = self._two_case_node()
        insp = self._inspector()
        insp.set_node("sw", copy.deepcopy(node))
        row0 = insp._topology_refs["case_rows"][0]
        row0["case_mode"].setCurrentIndex(1)  # 切到「结构化」，什么都不填
        out = insp.get_node()
        case0 = out["cases"][0]
        self.assertNotEqual(
            case_verdict(case0), ALWAYS, f"切模式后分支变成恒命中：{case0!r}"
        )
        self.assertEqual(out, node, "只是切下拉看一眼，不该改写 JSON 形状")

    def test_editing_in_expr_mode_writes_the_expr_shape(self) -> None:
        """在结构化模式里真改了东西 → 才按结构化写法回写，内容是改后的。"""
        node = self._two_case_node()
        insp = self._inspector()
        insp.set_node("sw", copy.deepcopy(node))
        row0 = insp._topology_refs["case_rows"][0]
        row0["case_mode"].setCurrentIndex(1)
        row0["expr_tree"].set_expr(
            {"any": [{"flag": "a", "value": True}, {"flag": "z", "value": True}]}
        )
        # set_expr 是程序化回填、刻意不发 changed（正因如此「只切不改」才认得出来）；
        # 用户在树里动手时发的就是这个信号，测试补发一次即等价于真实编辑。
        row0["expr_tree"].changed.emit()
        case0 = insp.get_node()["cases"][0]
        self.assertEqual(
            case0.get("condition"),
            {"any": [{"flag": "a", "value": True}, {"flag": "z", "value": True}]},
        )
        self.assertNotIn("conditions", case0)

    def test_switching_back_to_and_mode_keeps_a_flat_condition(self) -> None:
        node = {
            "type": "switch",
            "cases": [{"condition": {"all": [
                {"flag": "a", "value": True},
                {"narrative": "g", "state": "s"},
            ]}, "next": "n1"}],
            "defaultNext": "n3",
        }
        insp = self._inspector()
        insp.set_node("sw", copy.deepcopy(node))
        row0 = insp._topology_refs["case_rows"][0]
        self.assertEqual(row0["case_mode"].currentData(), "expr")
        row0["case_mode"].setCurrentIndex(0)  # 切回 AND
        # 只切不改 → 原样保留；条件必须已被摊进 AND 列表（看得见、能编辑）
        self.assertNotEqual(case_verdict(insp.get_node()["cases"][0]), ALWAYS)
        self.assertEqual(insp.get_node(), node, "只是切下拉，不该改写 JSON 形状")
        self.assertEqual(
            [r["serialize"]() for r in row0["cond_rows"]],
            [{"flag": "a", "value": True}, {"narrative": "g", "state": "s"}],
            "结构化条件必须被摊成 AND 列表，否则策划在 AND 模式下看不到自己的条件",
        )
        # 在 AND 模式里真改一条 → 才按 conditions 写法回写
        row0["cond_rows"][0]["serialize"]  # noqa: B018 - 仅确认接口存在
        insp._topology_refs["case_rows"][0]["cond_rows"][0]["body"].setVisible(True)
        row0["case_mode"].setCurrentIndex(0)

    def test_non_flattenable_condition_refuses_to_switch_instead_of_dropping_it(self) -> None:
        """any/not 摊不成 AND 清单：必须退回结构化模式并原样保留，绝不清空。"""
        expr = {"any": [{"flag": "a", "value": True}, {"flag": "b", "value": True}]}
        node = {
            "type": "switch",
            "cases": [{"condition": copy.deepcopy(expr), "next": "n1"}],
            "defaultNext": "n3",
        }
        insp = self._inspector()
        insp.set_node("sw", copy.deepcopy(node))
        row0 = insp._topology_refs["case_rows"][0]
        with _SilencedBoxes() as boxes:
            row0["case_mode"].setCurrentIndex(0)
        self.assertTrue(boxes.info, "拒绝切换时必须告诉策划原因")
        self.assertEqual(row0["case_mode"].currentData(), "expr", "必须退回结构化模式")
        self.assertEqual(insp.get_node()["cases"][0].get("condition"), expr)

    def test_expr_leaf_survives_round_trip_through_both_modes(self) -> None:
        """AND → 结构化 → AND 一圈回来，语义不得漂移。"""
        node = self._two_case_node()
        insp = self._inspector()
        insp.set_node("sw", copy.deepcopy(node))
        row0 = insp._topology_refs["case_rows"][0]
        row0["case_mode"].setCurrentIndex(1)
        row0["case_mode"].setCurrentIndex(0)
        self.assertEqual(insp.get_node(), node)

    # ---------- 折叠状态 ----------

    def test_adding_a_branch_does_not_collapse_the_one_being_edited(self) -> None:
        insp = self._inspector()
        insp.set_node("sw", self._two_case_node())
        rows = insp._topology_refs["case_rows"]
        rows[0]["toggle"].click()  # 展开第 0 条准备编辑
        self.assertFalse(rows[0]["collapsed"])
        add = [
            b
            for b in insp._body.findChildren(QPushButton)
            if b.text() == "在末尾添加分支"
        ]
        self.assertEqual(len(add), 1)
        add[0].click()
        rows2 = insp._topology_refs["case_rows"]
        self.assertEqual(len(rows2), 3)
        self.assertFalse(rows2[0]["collapsed"], "正在编辑的分支被强制折叠了")
        self.assertFalse(rows2[-1]["collapsed"], "新加的分支应当直接展开可填")

    def test_deleting_a_branch_with_content_asks_first_and_cancel_keeps_it(self) -> None:
        insp = self._inspector()
        node = self._two_case_node()
        insp.set_node("sw", copy.deepcopy(node))
        rows = insp._topology_refs["case_rows"]
        with _SilencedBoxes(QMessageBox.StandardButton.Cancel) as boxes:
            rows[0]["btn_del"].click()
        self.assertTrue(boxes.question, "删有内容的分支必须先确认")
        self.assertEqual(insp.get_node(), node, "取消后不得真删")

        with _SilencedBoxes(QMessageBox.StandardButton.Ok):
            insp._topology_refs["case_rows"][0]["btn_del"].click()
        out = insp.get_node()
        self.assertEqual(len(out["cases"]), 1)
        self.assertEqual(out["cases"][0]["next"], "n2")

    def test_branch_summary_shows_the_condition_not_just_a_count(self) -> None:
        insp = self._inspector()
        insp.set_node(
            "sw",
            {
                "type": "switch",
                "cases": [
                    {"conditions": [{"narrative": "flow_main", "state": "waiting"}], "next": "n1"}
                ],
                "defaultNext": "n3",
            },
        )
        summary = insp._topology_refs["case_rows"][0]["summary_label"].text()
        self.assertIn("flow_main:waiting", summary, f"分支标题看不出条件：{summary!r}")
        self.assertIn("n1", summary)

    # ---------- 校验层 ----------

    def test_validator_rejects_an_unconditional_branch(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "g",
            "entry": "sw",
            "nodes": {
                "sw": {
                    "type": "switch",
                    "cases": [{"next": "a"}, {"conditions": [{"flag": "f", "value": True}], "next": "b"}],
                    "defaultNext": "b",
                },
                "a": {"type": "end"},
                "b": {"type": "end"},
            },
        }
        errors, warnings = validate_graph_tiered(data)
        self.assertTrue(
            any("永远命中" in e for e in errors),
            f"恒命中分支必须报 error，实际 errors={errors}",
        )
        self.assertTrue(
            any("永远轮不到" in w for w in warnings),
            f"其后分支不可达必须提示，实际 warnings={warnings}",
        )

    def test_validator_stays_quiet_on_shipped_graphs(self) -> None:
        """新加的校验不得给现有数据制造噪音。"""
        from tools.dialogue_graph_editor.graph_document import list_graph_files, load_json

        noisy: list[str] = []
        for path in list_graph_files(_PROJECT_ROOT):
            data = load_json(path)
            errors, _w = validate_graph_tiered(data)
            for e in errors:
                if "分支" in e and ("永远命中" in e or "永远为假" in e):
                    noisy.append(f"{path.name}: {e}")
        self.assertEqual(noisy, [], "现有图不应被新校验判成常量条件分支")

    # ---------- 画布端口标签 ----------

    def test_switch_case_ports_are_labelled_with_the_condition(self) -> None:
        node = {
            "type": "switch",
            "cases": [
                {"conditions": [{"narrative": "flow_main", "state": "waiting"}], "next": "n1"},
                {"next": "n2"},
            ],
            "defaultNext": "n3",
        }
        labels = [s.label for s in iter_output_slots(node)]
        self.assertIn("0. flow_main:waiting", labels[0], f"实际 ={labels}")
        self.assertIn("恒命中", labels[1], f"恒命中分支必须在画布上就看得出来，实际 ={labels}")

    def test_condition_text_covers_the_leaf_kinds_in_shipped_data(self) -> None:
        cases = [
            ({"conditions": [{"flag": "f", "op": ">=", "value": 3}]}, "f>=3"),
            ({"conditions": [{"narrative": "g", "state": "s", "reached": True}]}, "g:s(到过)"),
            ({"conditions": [{"plane": "yin"}]}, "位面=yin"),
            ({"conditions": [{"not": {"flag": "f", "value": True}}]}, "非(f=true)"),
            ({"conditions": [{"narrativeCount": "job", "op": ">=", "value": 2}]}, "做过 job>=2"),
            ({"condition": {"any": [{"flag": "a", "value": True}, {"flag": "b", "value": True}]}},
             "a=true 或 b=true"),
        ]
        for case, expected in cases:
            with self.subTest(case=case):
                self.assertEqual(case_condition_text(case), expected)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class GhostNodeCanvasTests(unittest.TestCase):
    """连线指向「还没建的节点」时，画布必须画出幽灵占位而不是中途抛异常。

    旧实现 `setup_ghost` 调 `set_name(name, push_undo=False)`，而 OdenGraphQt 的
    `set_name` 根本不收 push_undo → TypeError 打断整次 rebuild，画布停在半成品。
    触发它只需要策划做一件最日常的事：先把 next 填上、待会儿再建那个节点。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def test_dangling_target_renders_a_ghost_instead_of_raising(self) -> None:
        import json

        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
        from tools.dialogue_graph_editor.graph_document import list_graph_files

        path = next(
            p
            for p in list_graph_files(_PROJECT_ROOT)
            if len(json.loads(p.read_text(encoding="utf-8")).get("nodes") or {}) >= 5
        )
        w = DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=self._pm)
        self.addCleanup(w.deleteLater)
        w._load_path(path)
        for _ in range(10):
            self._app.processEvents()
        before = len(w._oden._graph.all_nodes())

        victim = next(
            nid
            for nid, raw in w._model.nodes.items()
            if isinstance(raw, dict) and raw.get("type") == "line"
        )
        raw = dict(w._model.nodes[victim])
        raw["next"] = "not_yet_created"
        w._model.set_node(victim, raw)
        w._rebuild_flow_scene()  # 旧实现在这里抛 TypeError
        for _ in range(10):
            self._app.processEvents()

        self.assertEqual(
            len(w._oden._graph.all_nodes()),
            before + 1,
            "指向不存在节点时应多出一个幽灵占位节点",
        )
        ghosts = [
            n for n in w._oden._graph.all_nodes() if getattr(n, "missing_id", "") == "not_yet_created"
        ]
        self.assertEqual(len(ghosts), 1)
        self.assertIn("not_yet_created", ghosts[0].name())


class CaseVerdictTests(unittest.TestCase):
    """恒真 / 恒假 判定必须与运行时 evaluateConditionExpr 逐形状对齐。

    第一版判定把 `{}` 和 `[{}]` 判成「恒命中」（实际运行时走 unrecognized 分支返回
    false，是恒**不**命中），又漏掉了真恒真的 `{all: []}` —— 校验报错方向反了，
    策划照提示改只会越改越错。真值表按 `evaluateGraphCondition.ts` 逐条钉死。
    """

    def test_runtime_truth_table(self) -> None:
        table = [
            # (case, 期望判定, 运行时依据)
            ({"next": "a"}, ALWAYS, "无 condition/conditions → evalSwitch 求 {all:[]} → every([])=true"),
            ({"conditions": [], "next": "a"}, ALWAYS, "同上"),
            ({"condition": {"all": []}, "next": "a"}, ALWAYS, "every([])=true"),
            ({"condition": {}, "next": "a"}, NEVER, "{} 落到 unrecognized shape → false"),
            ({"conditions": [{}], "next": "a"}, NEVER, "单元素取 conds[0]={} → unrecognized → false"),
            ({"condition": {"any": []}, "next": "a"}, NEVER, "some([])=false"),
            ({"conditions": [{"flag": "f", "value": True}], "next": "a"}, NORMAL, "看 flag 状态"),
            ({"condition": {"not": {"all": []}}, "next": "a"}, NEVER, "not(恒真)=恒假"),
            ({"condition": {"not": {"any": []}}, "next": "a"}, ALWAYS, "not(恒假)=恒真"),
            ({"conditions": [{"plane": "yin"}], "next": "a"}, NORMAL, "plane 叶被运行时识别"),
            ({"conditions": [{"posture": "crouch"}], "next": "a"}, NORMAL, "posture 叶被识别"),
            ({"conditions": [{"narrativeCount": "j", "value": 2}], "next": "a"}, NORMAL, "narrativeCount 叶被识别"),
            ({"conditions": [{"scenarioLine": "s", "lineStatus": "active"}], "next": "a"}, NORMAL, "scenarioLine 叶被识别"),
            ({"conditions": [{"没这个键": 1}], "next": "a"}, NEVER, "认不出的形状 → false"),
            (
                {"conditions": [{"flag": "f", "value": True}, {"all": []}], "next": "a"},
                NORMAL,
                "AND 里混一个恒真项，整体仍看 flag",
            ),
            (
                {"conditions": [{"flag": "f", "value": True}, {}], "next": "a"},
                NEVER,
                "AND 里有一个恒假项 → 整体恒假",
            ),
        ]
        for case, expected, why in table:
            with self.subTest(case=case, why=why):
                self.assertEqual(case_verdict(case), expected, why)

    def test_leaf_guard_parity_with_runtime(self) -> None:
        """镜像对账：Python 侧认得的叶子键名必须覆盖 TS 里全部 isXxxLeaf 守卫。"""
        import re

        ts = (_PROJECT_ROOT / "src/systems/graphDialogue/evaluateGraphCondition.ts").read_text(
            encoding="utf-8"
        )
        guards = set(re.findall(r"function (is\w+Leaf)\(", ts))
        covered = {
            "isConditionLeaf": {"flag": "f"},
            "isQuestLeaf": {"quest": "q"},
            "isScenarioLeaf": {"scenario": "s", "phase": "p", "status": "done"},
            "isScenarioLineLeaf": {"scenarioLine": "s", "lineStatus": "active"},
            "isNarrativeStateLeaf": {"narrative": "g", "state": "s"},
            "isNarrativeCountLeaf": {"narrativeCount": "a", "value": 1},
            "isPlaneLeaf": {"plane": "yin"},
            "isPostureLeaf": {"posture": "crouch"},
        }
        self.assertEqual(
            guards,
            set(covered),
            "运行时新增/删除了条件叶子守卫，dialogue_condition_text._is_recognized_leaf 必须同步",
        )
        for name, sample in covered.items():
            with self.subTest(guard=name):
                self.assertEqual(
                    case_verdict({"conditions": [sample], "next": "a"}),
                    NORMAL,
                    f"{name} 对应的叶子被误判成常量条件：{sample!r}",
                )


class Review20260806Round2Tests(unittest.TestCase):
    """第二轮审查（choice / line / ownerState / 撤销）的护栏。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _inspector(self) -> NodeInspector:
        insp = NodeInspector(
            lambda: ["n1", "n2", "n3"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        return insp

    # ---------- P0-1：getter 绝不抛异常 ----------

    def test_choice_getter_never_raises_so_edits_always_reach_the_model(self) -> None:
        """加一条选项（出厂 id 未必填全）之后，本节点的编辑必须照常进模型。

        旧实现 getter 撞见空 id 就 raise ValueError，宿主把异常吞成一行 5 秒 toast 后
        return —— 表单上敲的字全在、模型里一个字没进、is_dirty 还是 False，
        于是关窗口都不提示，整段编辑无声蒸发。
        """
        node = {
            "type": "choice",
            "options": [{"id": "a", "text": "甲", "next": "n1"}],
        }
        insp = self._inspector()
        insp.set_node("ch", copy.deepcopy(node))
        add = [
            b for b in insp._body.findChildren(QPushButton) if b.text() == "在末尾添加选项"
        ]
        self.assertEqual(len(add), 1)
        add[0].click()
        rows = insp._topology_refs["option_rows"]
        self.assertEqual(len(rows), 2)
        # 新选项出厂就该带一个不冲突的 id，而不是空 id
        self.assertTrue(rows[1]["id_e"].text().strip(), "新选项的 id 不该是空的")
        self.assertNotEqual(rows[1]["id_e"].text().strip(), "a")
        # 把新选项 id 清空（模拟策划边填边删），getter 仍必须能返回
        rows[1]["id_e"].setText("")
        out = insp.get_node()  # 旧实现在这里抛 ValueError
        self.assertEqual(len(out["options"]), 2)
        self.assertEqual(out["options"][0]["text"], "甲")

    def test_missing_option_id_is_reported_by_the_validator_instead(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "g",
            "entry": "ch",
            "nodes": {
                "ch": {"type": "choice", "options": [{"id": "", "text": "甲", "next": "a"}]},
                "a": {"type": "end"},
            },
        }
        errors, _w = validate_graph_tiered(data)
        self.assertTrue(
            any("未填 id" in e for e in errors), f"实际 errors={errors}"
        )

    def test_line_multi_beat_getter_never_raises(self) -> None:
        node = {
            "type": "line",
            "speaker": {"kind": "npc", "npcName": "甲"},
            "text": "一",
            "lines": [{"speaker": {"kind": "npc", "npcName": "甲"}, "text": "一"}],
            "next": "n1",
        }
        insp = self._inspector()
        insp.set_node("ln", copy.deepcopy(node))
        self.assertEqual(insp.get_node()["lines"][0]["text"], "一")

    # ---------- P1-2 / P1-3：不注入、不丢键 ----------

    def test_empty_choice_options_are_not_replaced_by_a_fake_option(self) -> None:
        node = {"type": "choice", "options": []}
        insp = self._inspector()
        insp.set_node("ch", copy.deepcopy(node))
        out = insp.get_node()
        self.assertEqual(out["options"], [], f"空 choice 被凭空补了选项：{out!r}")
        # options 不是数组（写坏了）不在这里断言——那走只读原样透传，
        # 由 ChoiceFidelityTests.test_malformed_options_are_passed_through_untouched 覆盖。

    def test_empty_lines_key_is_preserved(self) -> None:
        node = {
            "type": "line",
            "speaker": {"kind": "player"},
            "text": "x",
            "lines": [],
            "next": "n1",
        }
        insp = self._inspector()
        insp.set_node("ln", copy.deepcopy(node))
        self.assertEqual(insp.get_node(), node, "lines:[] 键被静默丢弃")

    # ---------- P1-4：scenario outcome 类型保真 ----------

    def test_scenario_outcome_keeps_its_json_type(self) -> None:
        """运行时 `=== expr.outcome` 严格比较：3 变成 "3" 这条件就永不命中。"""
        for outcome in (3, 1.5, True, False, "ok"):
            with self.subTest(outcome=outcome):
                node = {
                    "type": "switch",
                    "cases": [
                        {
                            "conditions": [
                                {
                                    "scenario": "s",
                                    "phase": "p",
                                    "status": "done",
                                    "outcome": outcome,
                                }
                            ],
                            "next": "n1",
                        }
                    ],
                    "defaultNext": "n3",
                }
                insp = self._inspector()
                insp.set_node("sw", copy.deepcopy(node))
                got = insp.get_node()["cases"][0]["conditions"][0]["outcome"]
                self.assertIs(type(got), type(outcome), f"类型漂了：{got!r}")
                self.assertEqual(got, outcome)

    # ---------- P1-5：折叠状态 ----------

    def test_adding_a_choice_option_does_not_collapse_the_edited_one(self) -> None:
        node = {
            "type": "choice",
            "options": [
                {"id": "a", "text": "甲", "next": "n1"},
                {"id": "b", "text": "乙", "next": "n2"},
            ],
        }
        insp = self._inspector()
        insp.set_node("ch", copy.deepcopy(node))
        rows = insp._topology_refs["option_rows"]
        rows[1]["toggle"].click()
        self.assertFalse(rows[1]["collapsed"])
        add = [
            b for b in insp._body.findChildren(QPushButton) if b.text() == "在末尾添加选项"
        ][0]
        add.click()
        rows2 = insp._topology_refs["option_rows"]
        self.assertFalse(rows2[1]["collapsed"], "正在编辑的选项被强制折叠了")
        self.assertFalse(rows2[-1]["collapsed"], "新加的选项应当直接展开")

    # ---------- P2-4：新拍继承说话人 ----------

    def test_new_beat_inherits_the_previous_speaker(self) -> None:
        node = {
            "type": "line",
            "speaker": {"kind": "npc", "npcName": "老甲"},
            "text": "一",
            "lines": [
                {"speaker": {"kind": "npc", "npcName": "老甲"}, "text": "一"},
                {"speaker": {"kind": "npc", "npcName": "老甲"}, "text": "二"},
            ],
            "next": "n1",
        }
        insp = self._inspector()
        insp.set_node("ln", copy.deepcopy(node))
        add = [
            b for b in insp._body.findChildren(QPushButton) if b.text() == "在末尾添加一句"
        ][0]
        add.click()
        beats = insp.get_node()["lines"]
        self.assertEqual(len(beats), 3)
        self.assertEqual(
            beats[-1]["speaker"].get("kind"),
            "npc",
            f"新加的一句说话人被写死成 player：{beats[-1]['speaker']!r}",
        )

    # ---------- P1-1：ownerState 不被自动焊死 ----------

    def test_owner_state_without_wrapper_key_stays_dynamic(self) -> None:
        """不写 wrapperGraphId = 运行时按当前 owner 动态解算（同图多实体复用）。

        「点开这个节点看一眼再点别的」不能把它焊死到某张 wrapper 图上。
        """
        import json as _json

        from tools.dialogue_graph_editor.graph_document import list_graph_files

        target = None
        for path in list_graph_files(_PROJECT_ROOT):
            data = _json.loads(path.read_text(encoding="utf-8"))
            for nid, raw in (data.get("nodes") or {}).items():
                if isinstance(raw, dict) and raw.get("type") == "ownerState":
                    target = (path, nid, raw)
                    break
            if target:
                break
        if target is None:
            self.skipTest("工程里暂无 ownerState 节点")
        path, nid, raw = target
        node = {k: v for k, v in raw.items() if k not in ("wrapperGraphId", "missingWrapperNext")}
        insp = NodeInspector(
            lambda: ["n1", "n2"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
            dialogue_graph_id_getter=lambda: path.stem,
        )
        self.addCleanup(insp.deleteLater)
        insp.set_node(nid, copy.deepcopy(node))
        out = insp.get_node()
        self.assertNotIn(
            "wrapperGraphId", out, f"往返把节点焊死到了某张 wrapper 图：{out!r}"
        )
        self.assertNotIn("missingWrapperNext", out, f"注入了默认空键：{out!r}")


class ChoiceEditingReachesModelTests(unittest.TestCase):
    """P0-1 端到端：加了选项之后，本节点的后续编辑必须真的进模型并标脏。

    旧实现的失败形态特别隐蔽：表单上字都在，模型里一个字没进，`is_dirty` 还是
    False —— 于是切文件/关窗口都不弹「未保存」，整段编辑无声蒸发，唯一提示是
    底部一行 5 秒就消失的 toast。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _pump(self) -> None:
        for _ in range(8):
            self._app.processEvents()

    def test_edits_after_adding_an_option_reach_the_model_and_mark_dirty(self) -> None:
        import json as _json

        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
        from tools.dialogue_graph_editor.graph_document import list_graph_files

        target = None
        for path in list_graph_files(_PROJECT_ROOT):
            data = _json.loads(path.read_text(encoding="utf-8"))
            for nid, raw in (data.get("nodes") or {}).items():
                if isinstance(raw, dict) and raw.get("type") == "choice" and raw.get("options"):
                    target = (path, nid)
                    break
            if target:
                break
        if target is None:
            self.skipTest("工程里暂无带选项的 choice 节点")
        path, nid = target

        w = DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=self._pm)
        self.addCleanup(w.deleteLater)
        w._load_path(path)
        self._pump()
        w.focus_node_by_id(nid)
        self._pump()
        self.assertFalse(w._model.is_dirty, "刚打开不该是脏的")

        rows = w._inspector._topology_refs["option_rows"]
        before_n = len(rows)
        add = [
            b for b in w._inspector._body.findChildren(QPushButton)
            if b.text() == "在末尾添加选项"
        ][0]
        add.click()
        self._pump()
        rows = w._inspector._topology_refs["option_rows"]
        self.assertEqual(len(rows), before_n + 1)

        # 把新选项 id 清空（策划边填边删的中间态），再改第 1 条选项的文案
        rows[-1]["id_e"].setText("")
        self._pump()
        rows[0]["text_e"].setPlainText("改过的文案")
        self._pump()

        model_node = w._model.nodes[nid]
        self.assertEqual(
            model_node["options"][0]["text"],
            "改过的文案",
            "编辑没进模型——getter 又在中途抛异常了",
        )
        self.assertTrue(w._model.is_dirty, "改了却不标脏，关窗口不会提示")
        self.assertTrue(w.has_unsaved_changes(), "has_unsaved_changes 必须为真")

        # 非法数据不是靠「让编辑进不去」拦，而是靠校验面板/保存门
        errors, _w = validate_graph_tiered(w._data)
        self.assertTrue(
            any("未填 id" in e for e in errors),
            f"空 id 必须被校验拦下，实际 errors={errors[:5]}",
        )


class UndoMergeBoundaryTests(unittest.TestCase):
    """撤销合并必须有边界，否则「改了二十分钟、一次 Ctrl+Z 全没」。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def _cmd(self, new_val: str, *, focus_key: str, stamp: float):
        from tools.dialogue_graph_editor.editor_widget import _NodeDataChangedCmd
        from tools.dialogue_graph_editor.graph_document_model import GraphDocumentModel

        model = GraphDocumentModel()
        cmd = _NodeDataChangedCmd(
            model, "n1", {"type": "end"}, {"type": "line", "text": new_val}, focus_key=focus_key
        )
        cmd._stamp = stamp
        return cmd

    def test_same_widget_within_the_window_merges(self) -> None:
        a = self._cmd("a", focus_key="QLineEdit#1", stamp=100.0)
        b = self._cmd("ab", focus_key="QLineEdit#1", stamp=100.2)
        self.assertTrue(a.mergeWith(b), "同一控件的连续打字仍应并成一条")
        self.assertEqual(a._new["text"], "ab")

    def test_pause_breaks_the_merge(self) -> None:
        a = self._cmd("a", focus_key="QLineEdit#1", stamp=100.0)
        b = self._cmd("ab", focus_key="QLineEdit#1", stamp=100.0 + 5.0)
        self.assertFalse(a.mergeWith(b), "停顿之后必须另起一条撤销")

    def test_switching_widget_breaks_the_merge(self) -> None:
        a = self._cmd("a", focus_key="QLineEdit#1", stamp=100.0)
        b = self._cmd("ab", focus_key="QLineEdit#2", stamp=100.05)
        self.assertFalse(a.mergeWith(b), "换了输入控件必须另起一条撤销")

    def test_one_undo_only_rolls_back_the_last_segment(self) -> None:
        """端到端：在两个控件上先后编辑，一次 Ctrl+Z 只回退后一段。"""
        import json as _json

        from PySide6.QtCore import QEventLoop, QTimer

        from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
        from tools.dialogue_graph_editor.graph_document import list_graph_files
        from tools.editor.project_model import ProjectModel as _PM

        def spin(ms: int) -> None:
            # 必须用 3 参版（带 context 对象）：2 参版没有 receiver，宿主销毁后照样
            # 触发、碰 C++ 就 RuntimeError，且会炸在毫不相干的下一段操作里。
            # 护栏 test_single_shot_context_parity.py 会扫出 2 参版。
            loop = QEventLoop()
            QTimer.singleShot(ms, loop, loop.quit)
            loop.exec()

        pm = _PM()
        pm.load_project(_PROJECT_ROOT)
        target = None
        for path in list_graph_files(_PROJECT_ROOT):
            data = _json.loads(path.read_text(encoding="utf-8"))
            for nid, raw in (data.get("nodes") or {}).items():
                if isinstance(raw, dict) and raw.get("type") == "switch" and raw.get("cases"):
                    target = (path, nid)
                    break
            if target:
                break
        if target is None:
            self.skipTest("工程里暂无带分支的 switch 节点")
        path, nid = target

        w = DialogueGraphEditorWidget(_PROJECT_ROOT, None, project_model=pm)
        self.addCleanup(w.deleteLater)
        w.resize(1300, 850)
        w.show()  # 不 show 就拿不到 focusWidget，合并分段的键会全是空串
        w._load_path(path)
        spin(80)
        w.focus_node_by_id(nid)
        spin(80)

        dn = w._inspector._topology_refs["default_next"]
        nx = w._inspector._topology_refs["case_rows"][0]["next_edit"]
        dn_orig = dn.text()
        dn.setFocus()
        spin(20)
        if QApplication.focusWidget() is not dn:
            self.skipTest("离屏平台拿不到键盘焦点，分段逻辑由上面的 mergeWith 单测覆盖")
        dn.setText(dn_orig + "ZZZ")
        spin(40)
        nx.setFocus()
        spin(20)
        nx.setText(nx.text() + "QQQ")
        spin(40)

        w._undo_stack.undo()
        spin(80)
        node = w._model.nodes[nid]
        self.assertEqual(
            node.get("defaultNext"),
            dn_orig + "ZZZ",
            "一次撤销把前一段编辑也一起吃掉了",
        )


class RawLeafEditDialogTests(unittest.TestCase):
    """逐行表单画不出来的条件叶（真实数据里 plane/not/narrativeCount 共 11 处）
    必须有编辑出口，且清空要被拒绝——空条件在运行时等于恒命中。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _node_with_plane_leaf(self) -> dict:
        return {
            "type": "switch",
            "cases": [{"conditions": [{"plane": "yin"}], "next": "n1"}],
            "defaultNext": "n3",
        }

    def _insp(self) -> NodeInspector:
        insp = NodeInspector(
            lambda: ["n1", "n2", "n3"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        return insp

    def _click_edit(self, insp: NodeInspector) -> None:
        btns = [b for b in insp._body.findChildren(QPushButton) if b.text() == "编辑…"]
        self.assertEqual(len(btns), 1, "只读条件行必须有且只有一个「编辑…」入口")
        btns[0].click()

    def test_accepting_the_dialog_writes_the_new_condition(self) -> None:
        from PySide6.QtWidgets import QDialog

        from tools.editor.shared import condition_expr_tree as CET

        node = self._node_with_plane_leaf()
        insp = self._insp()
        insp.set_node("sw", copy.deepcopy(node))

        orig_exec = QDialog.exec

        def fake_exec(dlg):
            tree = dlg.findChild(CET.ConditionExprTreeRootWidget)
            assert tree is not None, "弹窗里必须有结构化条件编辑器"
            tree.set_expr({"plane": "yang"})
            return QDialog.DialogCode.Accepted

        QDialog.exec = fake_exec
        try:
            self._click_edit(insp)
        finally:
            QDialog.exec = orig_exec

        got = insp.get_node()["cases"][0]["conditions"][0]
        self.assertEqual(got, {"plane": "yang"}, f"改完没写回：{got!r}")

    def test_cancelling_the_dialog_changes_nothing(self) -> None:
        from PySide6.QtWidgets import QDialog

        from tools.editor.shared import condition_expr_tree as CET

        node = self._node_with_plane_leaf()
        insp = self._insp()
        insp.set_node("sw", copy.deepcopy(node))

        orig_exec = QDialog.exec

        def fake_exec(dlg):
            tree = dlg.findChild(CET.ConditionExprTreeRootWidget)
            tree.set_expr({"plane": "yang"})  # 改了但点取消
            return QDialog.DialogCode.Rejected

        QDialog.exec = fake_exec
        try:
            self._click_edit(insp)
        finally:
            QDialog.exec = orig_exec

        self.assertEqual(insp.get_node(), node, "点了取消却改了数据")

    def test_clearing_the_condition_is_refused(self) -> None:
        from PySide6.QtWidgets import QDialog

        from tools.editor.shared import condition_expr_tree as CET

        node = self._node_with_plane_leaf()
        insp = self._insp()
        insp.set_node("sw", copy.deepcopy(node))

        orig_exec = QDialog.exec

        def fake_exec(dlg):
            tree = dlg.findChild(CET.ConditionExprTreeRootWidget)
            tree.set_expr(None)  # 清空
            return QDialog.DialogCode.Accepted

        QDialog.exec = fake_exec
        try:
            with _SilencedBoxes() as boxes:
                self._click_edit(insp)
        finally:
            QDialog.exec = orig_exec

        self.assertTrue(boxes.warn, "清空必须弹窗说明为什么不行")
        self.assertEqual(insp.get_node(), node, "清空后原条件必须原样保留")
        self.assertNotEqual(
            case_verdict(insp.get_node()["cases"][0]), ALWAYS, "分支不该变成恒命中"
        )


class ConditionRowButtonsTests(unittest.TestCase):
    """条件行的四个操作按钮必须从**按钮本身**点进去验。

    上一轮 102 个测试全绿，却漏掉了「删除本条件」按钮 100% 抛 NameError ——
    因为没有一条测试从最外层入口点它（norms 过程义务 3）。这里逐个按钮点。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _insp_with_three_conditions(self, *, as_expr_shape: bool = False):
        conds = [
            {"flag": "a", "value": True},
            {"flag": "b", "value": True},
            {"flag": "c", "value": True},
        ]
        node = (
            {
                "type": "switch",
                "cases": [{"condition": {"all": copy.deepcopy(conds)}, "next": "n1"}],
                "defaultNext": "n3",
            }
            if as_expr_shape
            else {
                "type": "switch",
                "cases": [{"conditions": copy.deepcopy(conds), "next": "n1"}],
                "defaultNext": "n3",
            }
        )
        insp = NodeInspector(
            lambda: ["n1", "n2", "n3"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        insp.set_node("sw", copy.deepcopy(node))
        return insp, node

    @staticmethod
    def _flags(insp) -> list[str]:
        case0 = insp.get_node()["cases"][0]
        leaves = case0.get("conditions")
        if leaves is None:
            cond = case0.get("condition") or {}
            leaves = cond.get("all") or ([cond] if cond else [])
        return [str(x.get("flag", "")) for x in leaves]

    def test_delete_condition_button_actually_deletes_it_now(self) -> None:
        insp, _node = self._insp_with_three_conditions()
        row = insp._topology_refs["case_rows"][0]
        self.assertEqual(self._flags(insp), ["a", "b", "c"])
        # 删有内容的条件现在会二次确认——不打桩的话离屏 exec() 永不返回、整跑挂死。
        with _SilencedBoxes(QMessageBox.StandardButton.Ok):
            row["cond_rows"][1]["btn_del"].click()  # 旧实现在这里抛 NameError
        self.assertEqual(
            self._flags(insp), ["a", "c"], "「删除本条件」按钮没真删掉"
        )
        self.assertEqual(len(row["cond_rows"]), 2)

    def test_move_condition_buttons_work_from_the_button(self) -> None:
        insp, _node = self._insp_with_three_conditions()
        row = insp._topology_refs["case_rows"][0]
        row["cond_rows"][2]["btn_up"].click()
        self.assertEqual(self._flags(insp), ["a", "c", "b"])
        row["cond_rows"][0]["btn_down"].click()
        self.assertEqual(self._flags(insp), ["c", "a", "b"])

    def test_insert_condition_buttons_work_from_the_button(self) -> None:
        insp, _node = self._insp_with_three_conditions()
        row = insp._topology_refs["case_rows"][0]
        before = len(row["cond_rows"])
        row["cond_rows"][0]["btn_before"].click()
        row["cond_rows"][-1]["btn_after"].click()
        self.assertEqual(len(insp._topology_refs["case_rows"][0]["cond_rows"]), before + 2)

    # ---------- P0-2：跨形状时这些操作不得被静默丢弃 ----------

    def test_reordering_after_a_mode_switch_is_not_swallowed(self) -> None:
        """磁盘是 condition 写法 → 切到「多条条件」→ 上移一条。

        旧实现按「有没有人调过标记函数」判断用户改没改，而上移/下移/删除三个按钮
        都没挂那个回调 → getter 回退成旧形状、拿结构化树的**旧内容**写出，
        整类编辑被静默丢弃（还因为 new_node == old_node 早退而连脏都不标）。
        """
        insp, node = self._insp_with_three_conditions(as_expr_shape=True)
        row = insp._topology_refs["case_rows"][0]
        row["case_mode"].setCurrentIndex(0)  # 切到「多条条件」
        self.assertEqual(insp.get_node(), node, "只切不改不该动 JSON")
        row["cond_rows"][2]["btn_up"].click()  # 真改：上移
        self.assertEqual(
            self._flags(insp), ["a", "c", "b"], "上移在跨形状时被吃掉了"
        )
        self.assertNotEqual(insp.get_node(), node, "改了却和原来一模一样")

    def test_deleting_after_a_mode_switch_is_not_swallowed(self) -> None:
        insp, node = self._insp_with_three_conditions(as_expr_shape=True)
        row = insp._topology_refs["case_rows"][0]
        row["case_mode"].setCurrentIndex(0)
        with _SilencedBoxes(QMessageBox.StandardButton.Ok):  # 删有内容的条件会确认
            row["cond_rows"][0]["btn_del"].click()
        self.assertEqual(self._flags(insp), ["b", "c"], "删除在跨形状时被吃掉了")

    def test_inserting_after_a_mode_switch_is_not_swallowed(self) -> None:
        insp, node = self._insp_with_three_conditions(as_expr_shape=True)
        row = insp._topology_refs["case_rows"][0]
        row["case_mode"].setCurrentIndex(0)
        row["cond_rows"][0]["btn_after"].click()
        self.assertEqual(
            len(self._flags(insp)), 4, "插入在跨形状时被吃掉了"
        )


class ChoiceFidelityTests(unittest.TestCase):
    """choice 侧的零注入 / 坏值透传。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _insp(self) -> NodeInspector:
        insp = NodeInspector(
            lambda: ["x", "y"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        return insp

    def test_option_without_id_key_is_not_given_an_empty_one(self) -> None:
        node = {"type": "choice", "options": [{"text": "甲", "next": "x"}]}
        insp = self._insp()
        insp.set_node("ch", copy.deepcopy(node))
        out = insp.get_node()
        self.assertNotIn(
            "id", out["options"][0], f"凭空注入了空 id（还会多出一条校验 error）：{out!r}"
        )

    def test_option_with_empty_id_key_keeps_the_key(self) -> None:
        node = {"type": "choice", "options": [{"id": "", "text": "甲", "next": "x"}]}
        insp = self._insp()
        insp.set_node("ch", copy.deepcopy(node))
        self.assertEqual(insp.get_node(), node, "原本就有的空 id 键必须保住")

    def test_malformed_options_are_passed_through_untouched(self) -> None:
        for bad in (None, "oops", {"a": 1}, 3):
            with self.subTest(bad=bad):
                node = {"type": "choice", "options": bad}
                insp = self._insp()
                insp.set_node("ch", copy.deepcopy(node))
                self.assertEqual(
                    insp.get_node(), node, "坏值被当场抹平，磁盘上的原始证据没了"
                )


class MalformedArrayElementTests(unittest.TestCase):
    """数组里混进非 dict 元素时，那一条不许被静默丢弃。

    节点级早就定好规矩（畸形数据只读透传 + 交给校验报错，不崩不丢），但**数组元素级**
    一直是 `if not isinstance(x, dict): continue` —— 跳过后不再还原。表现：策划打开这张图、
    点一下这个节点、点走，那条内容就从磁盘上永久消失，而且校验证据同时没了
    （内存里已经没有它），保存门自然放行。CLAUDE.md 的 production-mode 下 agent 直接写
    JSON，数组里混个字符串/null 是现实可能。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _insp(self) -> NodeInspector:
        insp = NodeInspector(
            lambda: ["x", "y"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
        )
        self.addCleanup(insp.deleteLater)
        return insp

    def test_five_containers_keep_non_dict_elements(self) -> None:
        speaker = {"kind": "npc", "npcName": "甲"}
        fixtures = [
            (
                "choice.options",
                {
                    "type": "choice",
                    "options": [
                        {"id": "a", "text": "甲", "next": "x"},
                        "这一条是被写坏的",
                        {"id": "c", "text": "丙", "next": "y"},
                    ],
                },
            ),
            (
                "switch.cases",
                {
                    "type": "switch",
                    "cases": [
                        {"conditions": [{"flag": "f", "value": True}], "next": "x"},
                        None,
                    ],
                    "defaultNext": "y",
                },
            ),
            (
                "line.lines",
                {
                    "type": "line",
                    "speaker": speaker,
                    "text": "一",
                    "lines": [{"speaker": speaker, "text": "一"}, 42],
                    "next": "x",
                },
            ),
            (
                "ownerState.cases",
                {
                    "type": "ownerState",
                    "cases": [{"state": "read", "next": "x"}, "坏的"],
                    "defaultNext": "y",
                },
            ),
            (
                "contextState.cases",
                {
                    "type": "contextState",
                    "graphId": "g",
                    "cases": [{"state": "s", "next": "x"}, ["也坏"]],
                    "defaultNext": "y",
                },
            ),
            (
                "runActions.actions",
                {
                    "type": "runActions",
                    "actions": [{"type": "setFlag", "params": {"key": "k", "value": True}}, "坏动作"],
                    "next": "x",
                },
            ),
        ]
        for label, node in fixtures:
            with self.subTest(container=label):
                insp = self._insp()
                insp.set_node("n", copy.deepcopy(node))
                out = insp.get_node()
                key = "lines" if label == "line.lines" else (
                    "actions" if label.endswith("actions") else (
                        "options" if label.startswith("choice") else "cases"
                    )
                )
                self.assertEqual(
                    len(out.get(key) or []),
                    len(node[key]),
                    f"{label}: 元素数变了，坏元素被静默丢弃 → {out.get(key)!r}",
                )
                bad_in = [x for x in node[key] if not isinstance(x, dict)]
                bad_out = [x for x in (out.get(key) or []) if not isinstance(x, dict)]
                self.assertEqual(
                    bad_out, bad_in, f"{label}: 非 dict 元素没被原样保留"
                )

    def test_validator_still_reports_the_malformed_element(self) -> None:
        """保留不等于放行：校验必须照旧把它列为错误。"""
        data = {
            "schemaVersion": 1,
            "id": "g",
            "entry": "ch",
            "nodes": {
                "ch": {
                    "type": "choice",
                    "options": [{"id": "a", "text": "甲", "next": "e"}, "坏的"],
                },
                "e": {"type": "end"},
            },
        }
        errors, _w = validate_graph_tiered(data)
        self.assertTrue(
            any("不是对象" in e for e in errors), f"实际 errors={errors}"
        )

    def test_canvas_connection_still_syncs_to_the_right_row_with_junk_present(self) -> None:
        """保留坏元素后，「画布 ↔ 检查器」的配对不许错位。

        表单行只由 dict 元素构成，而数据数组里还夹着坏元素；按行号当数据下标配对，
        坏元素之后的行就整体错位：画布上拉的那条线在检查器里看不见（显示旧目标），
        随后随手改点别的就把它静默打回。
        """
        cases = [
            {"conditions": [{"flag": "a", "value": True}], "next": "x"},
            "这条是坏的",
            {"conditions": [{"flag": "b", "value": True}], "next": "x"},
        ]
        node = {"type": "switch", "cases": copy.deepcopy(cases), "defaultNext": "y"}
        insp = self._insp()
        insp.set_node("sw", copy.deepcopy(node))

        # 模拟画布把第 2 个 dict 分支（数据下标 2）连到 y
        after = copy.deepcopy(node)
        after["cases"][2]["next"] = "y"
        insp.update_topology_from_data(after)

        rows = insp._topology_refs["case_rows"]
        self.assertEqual(
            [r["next_edit"].text() for r in rows],
            ["x", "y"],
            "画布连线没同步到对应的表单行（行号被当成了数据下标）",
        )
        # 再改第 0 行，第 2 条分支的新目标不许被打回
        rows[0]["next_edit"].setText("y")
        out = insp.get_node()
        self.assertEqual(
            out["cases"][2]["next"], "y", "画布上拉的那条连线被后续编辑静默打回了"
        )
        self.assertEqual(out["cases"][1], "这条是坏的", "坏元素同时要保住")

    def test_choice_canvas_connection_syncs_with_junk_present(self) -> None:
        options = [
            {"id": "a", "text": "甲", "next": "x"},
            None,
            {"id": "b", "text": "乙", "next": "x"},
        ]
        node = {"type": "choice", "options": copy.deepcopy(options)}
        insp = self._insp()
        insp.set_node("ch", copy.deepcopy(node))
        after = copy.deepcopy(node)
        after["options"][2]["next"] = "y"
        insp.update_topology_from_data(after)
        rows = insp._topology_refs["option_rows"]
        self.assertEqual(
            [r["nx"].text() for r in rows], ["x", "y"], "choice 侧同样错位"
        )
