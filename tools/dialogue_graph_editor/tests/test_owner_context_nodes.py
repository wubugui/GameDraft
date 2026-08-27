from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QComboBox, QDialog, QPushButton

from tools.editor.shared.reference_picker import ReferencePickerField

from tools.dialogue_graph_editor.graph_document import (
    default_node,
    extract_flow_edges,
    extract_flow_edges_detailed,
    validate_graph,
    validate_graph_tiered,
)
from tools.dialogue_graph_editor.dialogue_ports import (
    OUT_CHOICE,
    OUT_CONTEXT_STATE_CASE,
    OUT_CONTEXT_STATE_DEFAULT,
    OUT_NEXT,
    OUT_OWNER_STATE_CASE,
    OUT_OWNER_STATE_DEFAULT,
    OUT_OWNER_STATE_MISSING,
    OUT_SWITCH_CASE,
    OUT_SWITCH_DEFAULT,
    port_name_for_spec,
)
from tools.dialogue_graph_editor.graph_mutations import (
    clear_output,
    collect_incoming_refs,
    connect_output_to_target,
    rename_node_id,
)
from tools.dialogue_graph_editor.dialogue_topology import TOPOLOGY_BY_NODE_TYPE
from tools.dialogue_graph_editor.flow_oden_controller import DialogueFlowOdenController
from tools.dialogue_graph_editor.node_inspector import NodeInspector
from tools.dialogue_graph_editor.oden_dialogue_nodes import (
    DialogueFlowNode,
    PN_CONTEXT_STATE_DEFAULT,
    PN_NEXT,
    PN_OWNER_STATE_DEFAULT,
    PN_OWNER_STATE_MISSING,
    PN_SWITCH_DEFAULT,
    parse_dialogue_out_port,
    pn_context_state_case,
    pn_choice,
    pn_owner_state_case,
    pn_switch_case,
)


def _pick_reference(case: unittest.TestCase, field: ReferencePickerField, value: str) -> None:
    """从最外层用户入口驱动弹窗选择器：点「选择…」→ 在弹窗里选中 → 确定。

    护栏必须发真实用户事件（editor-tools-norms 过程义务 §3）——直接调 `set_value`
    连 `value_changed` 都不发（那是程序性路径的正确行为），根本测不到「用户选了图之后
    表单有没有跟上」这条路。弹窗本体的交互由
    `tools/editor/tests/test_dialogue_reference_picker.py` 用真键鼠事件守着，
    这里只替换弹窗的返回值。
    """
    class _AcceptingDialog:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def exec(self) -> QDialog.DialogCode:
            return QDialog.DialogCode.Accepted

        def selected_value(self) -> str:
            return value

    button = next(
        b for b in field.findChildren(QPushButton) if b.text() == "选择…"
    )
    with patch(
        "tools.editor.shared.reference_picker.ReferencePickerDialog",
        _AcceptingDialog,
    ):
        QTest.mouseClick(button, Qt.MouseButton.LeftButton)
    case.assertEqual(field.current_value(), value)


class OwnerContextNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_default_owner_state_node(self) -> None:
        node = default_node("ownerState", {})
        self.assertEqual(node["type"], "ownerState")
        self.assertIn("wrapperGraphId", node)
        self.assertIn("cases", node)
        self.assertIn("defaultNext", node)

    def test_extract_flow_edges_owner_state(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": "line1"}],
                    "defaultNext": "line2",
                    "missingWrapperNext": "line3",
                },
                "line1": {"type": "end"},
                "line2": {"type": "end"},
                "line3": {"type": "end"},
            },
        }
        edges = extract_flow_edges(data["nodes"])
        targets = {e[1] for e in edges}
        self.assertEqual(targets, {"line1", "line2", "line3"})

    def test_connect_owner_state_ports(self) -> None:
        data = {
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": ""}],
                    "defaultNext": "",
                },
                "n1": {"type": "end"},
            }
        }
        err = connect_output_to_target(data, "root", OUT_OWNER_STATE_DEFAULT, -1, "n1")
        self.assertIsNone(err)
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "n1")

    def test_connect_clear_and_rename_owner_state_ports(self) -> None:
        data = {
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": ""}],
                    "defaultNext": "",
                    "missingWrapperNext": "",
                },
                "hit": {"type": "end"},
                "fallback": {"type": "end"},
                "missing": {"type": "end"},
            },
        }

        self.assertIsNone(connect_output_to_target(data, "root", OUT_OWNER_STATE_CASE, 0, "hit"))
        self.assertIsNone(connect_output_to_target(data, "root", OUT_OWNER_STATE_DEFAULT, -1, "fallback"))
        self.assertIsNone(connect_output_to_target(data, "root", OUT_OWNER_STATE_MISSING, -2, "missing"))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "hit")
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "fallback")
        self.assertEqual(data["nodes"]["root"]["missingWrapperNext"], "missing")

        self.assertIsNone(rename_node_id(data, "hit", "hit_renamed"))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "hit_renamed")
        self.assertIsNone(clear_output(data, "root", OUT_OWNER_STATE_CASE, 0))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "")

    def test_validate_owner_state_requires_default_next(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [],
                    "defaultNext": "",
                },
            },
        }
        issues = validate_graph(data)
        self.assertTrue(any("defaultNext" in x for x in issues))

    def test_context_state_default_node(self) -> None:
        node = default_node("contextState", {})
        self.assertEqual(node["type"], "contextState")
        self.assertIn("graphId", node)

    def test_connect_context_state_default(self) -> None:
        data = {
            "nodes": {
                "root": {
                    "type": "contextState",
                    "graphId": "flow_x",
                    "cases": [],
                    "defaultNext": "",
                },
                "n1": {"type": "end"},
            }
        }
        err = connect_output_to_target(data, "root", OUT_CONTEXT_STATE_DEFAULT, -1, "n1")
        self.assertIsNone(err)
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "n1")

    def test_connect_clear_and_rename_context_state_ports(self) -> None:
        data = {
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "contextState",
                    "graphId": "flow_x",
                    "cases": [{"state": "ready", "next": ""}],
                    "defaultNext": "",
                },
                "hit": {"type": "end"},
                "fallback": {"type": "end"},
            },
        }

        self.assertIsNone(connect_output_to_target(data, "root", OUT_CONTEXT_STATE_CASE, 0, "hit"))
        self.assertIsNone(connect_output_to_target(data, "root", OUT_CONTEXT_STATE_DEFAULT, -1, "fallback"))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "hit")
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "fallback")

        self.assertIsNone(rename_node_id(data, "fallback", "fallback_renamed"))
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "fallback_renamed")
        self.assertIsNone(clear_output(data, "root", OUT_CONTEXT_STATE_DEFAULT, -1))
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "")

    def test_oden_output_port_mapping_supports_owner_and_context_state(self) -> None:
        owner = DialogueFlowNode()
        owner.apply_dialogue_shape(
            {
                "type": "ownerState",
                "cases": [{"state": "a", "next": "hit"}],
                "defaultNext": "fallback",
                "missingWrapperNext": "missing",
            },
            is_entry=False,
            diag_tag=None,
        )
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(owner, OUT_OWNER_STATE_CASE, 0))
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(owner, OUT_OWNER_STATE_DEFAULT, -1))
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(owner, OUT_OWNER_STATE_MISSING, -2))

        context = DialogueFlowNode()
        context.apply_dialogue_shape(
            {
                "type": "contextState",
                "graphId": "flow",
                "cases": [{"state": "ready", "next": "hit"}],
                "defaultNext": "fallback",
            },
            is_entry=False,
            diag_tag=None,
        )
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(context, OUT_CONTEXT_STATE_CASE, 0))
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(context, OUT_CONTEXT_STATE_DEFAULT, -1))

    def test_parse_owner_and_context_state_ports(self) -> None:
        self.assertEqual(parse_dialogue_out_port(pn_owner_state_case(0)), (OUT_OWNER_STATE_CASE, 0))
        self.assertEqual(parse_dialogue_out_port(PN_OWNER_STATE_DEFAULT), (OUT_OWNER_STATE_DEFAULT, -1))
        self.assertEqual(parse_dialogue_out_port(PN_OWNER_STATE_MISSING), (OUT_OWNER_STATE_MISSING, -2))
        self.assertEqual(parse_dialogue_out_port(pn_context_state_case(0)), (OUT_CONTEXT_STATE_CASE, 0))
        self.assertEqual(parse_dialogue_out_port(pn_context_state_case(12)), (OUT_CONTEXT_STATE_CASE, 12))
        self.assertEqual(parse_dialogue_out_port(PN_CONTEXT_STATE_DEFAULT), (OUT_CONTEXT_STATE_DEFAULT, -1))

    def test_all_dialogue_output_ports_round_trip_between_names_and_specs(self) -> None:
        samples = [
            (PN_NEXT, OUT_NEXT, 0),
            (pn_choice(0), OUT_CHOICE, 0),
            (pn_choice(12), OUT_CHOICE, 12),
            (pn_switch_case(0), OUT_SWITCH_CASE, 0),
            (pn_switch_case(12), OUT_SWITCH_CASE, 12),
            (PN_SWITCH_DEFAULT, OUT_SWITCH_DEFAULT, -1),
            (pn_owner_state_case(0), OUT_OWNER_STATE_CASE, 0),
            (pn_owner_state_case(12), OUT_OWNER_STATE_CASE, 12),
            (PN_OWNER_STATE_DEFAULT, OUT_OWNER_STATE_DEFAULT, -1),
            (PN_OWNER_STATE_MISSING, OUT_OWNER_STATE_MISSING, -2),
            (pn_context_state_case(0), OUT_CONTEXT_STATE_CASE, 0),
            (pn_context_state_case(12), OUT_CONTEXT_STATE_CASE, 12),
            (PN_CONTEXT_STATE_DEFAULT, OUT_CONTEXT_STATE_DEFAULT, -1),
        ]
        for port_name, kind, index in samples:
            with self.subTest(port_name=port_name):
                self.assertEqual(parse_dialogue_out_port(port_name), (kind, index))
                self.assertEqual(port_name_for_spec(kind, index), port_name)

    def test_topology_registry_feeds_edges_and_mutations_for_all_outputs(self) -> None:
        self.assertTrue({"line", "runActions", "choice", "switch", "ownerState", "contextState"}.issubset(TOPOLOGY_BY_NODE_TYPE))

        data = {
            "entry": "line",
            "nodes": {
                "line": {"type": "line", "speaker": {"kind": "player"}, "text": "", "next": "target"},
                "actions": {"type": "runActions", "actions": [], "next": "target"},
                "choice": {
                    "type": "choice",
                    "options": [{"id": "a", "text": "A", "next": "target"}],
                },
                "switch": {
                    "type": "switch",
                    "cases": [{"conditions": [], "next": "target"}],
                    "defaultNext": "target",
                },
                "owner": {
                    "type": "ownerState",
                    "cases": [{"state": "ready", "next": "target"}],
                    "defaultNext": "target",
                    "missingWrapperNext": "target",
                },
                "context": {
                    "type": "contextState",
                    "graphId": "flow",
                    "cases": [{"state": "done", "next": "target"}],
                    "defaultNext": "target",
                },
                "target": {"type": "end"},
            },
        }

        specs = {(src, kind, index) for src, _dst, _label, kind, index in extract_flow_edges_detailed(data["nodes"])}
        self.assertEqual(
            specs,
            {
                ("line", OUT_NEXT, 0),
                ("actions", OUT_NEXT, 0),
                ("choice", OUT_CHOICE, 0),
                ("switch", OUT_SWITCH_CASE, 0),
                ("switch", OUT_SWITCH_DEFAULT, -1),
                ("owner", OUT_OWNER_STATE_CASE, 0),
                ("owner", OUT_OWNER_STATE_DEFAULT, -1),
                ("owner", OUT_OWNER_STATE_MISSING, -2),
                ("context", OUT_CONTEXT_STATE_CASE, 0),
                ("context", OUT_CONTEXT_STATE_DEFAULT, -1),
            },
        )
        self.assertEqual(len(collect_incoming_refs(data, "target")), len(specs))

        self.assertIsNone(rename_node_id(data, "target", "renamed"))
        self.assertFalse(any(dst == "target" for _src, dst, _label in extract_flow_edges(data["nodes"])))
        self.assertEqual(len(collect_incoming_refs(data, "renamed")), len(specs))

    def test_oden_output_port_mapping_supports_all_dialogue_node_outputs(self) -> None:
        shapes = [
            ({"type": "line", "speaker": {"kind": "player"}, "text": "", "next": "end"}, [(OUT_NEXT, 0)]),
            ({"type": "runActions", "actions": [], "next": "end"}, [(OUT_NEXT, 0)]),
            (
                {
                    "type": "choice",
                    "options": [{"id": "a", "text": "A", "next": "end"}, {"id": "b", "text": "B", "next": "end"}],
                },
                [(OUT_CHOICE, 0), (OUT_CHOICE, 1)],
            ),
            (
                {
                    "type": "switch",
                    "cases": [{"conditions": [], "next": "hit"}, {"conditions": [], "next": "miss"}],
                    "defaultNext": "fallback",
                },
                [(OUT_SWITCH_CASE, 0), (OUT_SWITCH_CASE, 1), (OUT_SWITCH_DEFAULT, -1)],
            ),
            (
                {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": "hit"}, {"state": "b", "next": "miss"}],
                    "defaultNext": "fallback",
                    "missingWrapperNext": "missing",
                },
                [
                    (OUT_OWNER_STATE_CASE, 0),
                    (OUT_OWNER_STATE_CASE, 1),
                    (OUT_OWNER_STATE_DEFAULT, -1),
                    (OUT_OWNER_STATE_MISSING, -2),
                ],
            ),
            (
                {
                    "type": "contextState",
                    "graphId": "flow",
                    "cases": [{"state": "ready", "next": "hit"}, {"state": "done", "next": "miss"}],
                    "defaultNext": "fallback",
                },
                [(OUT_CONTEXT_STATE_CASE, 0), (OUT_CONTEXT_STATE_CASE, 1), (OUT_CONTEXT_STATE_DEFAULT, -1)],
            ),
        ]
        for raw, expected_specs in shapes:
            with self.subTest(node_type=raw["type"]):
                node = DialogueFlowNode()
                node.apply_dialogue_shape(raw, is_entry=False, diag_tag=None)
                for kind, index in expected_specs:
                    self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(node, kind, index))

    def test_context_state_inspector_graph_change_does_not_use_deleted_combo(self) -> None:
        root = Path(__file__).resolve().parents[3]
        changes = 0
        inspector = NodeInspector(lambda: ["root", "hit", "fallback"], project_root=root)

        def mark_changed() -> None:
            nonlocal changes
            changes += 1
            inspector.get_node()

        inspector.set_change_callback(mark_changed)

        with patch("tools.editor.shared.narrative_catalog.list_context_state_graphs") as list_graphs, \
             patch("tools.editor.shared.narrative_catalog.graph_states") as graph_states, \
             patch("tools.editor.shared.narrative_catalog.classify_context_graph") as classify:
            list_graphs.return_value = [
                {"graphId": "flow_a", "label": "Flow A", "detail": "主线/流程图",
                 "ownerType": "flow", "verdict": "ok"},
                {"graphId": "flow_b", "label": "Flow B", "detail": "主线/流程图",
                 "ownerType": "flow", "verdict": "ok"},
            ]
            graph_states.side_effect = lambda _root, gid: {
                "flow_a": ["ready"],
                "flow_b": ["done"],
            }.get(gid, [])
            classify.return_value = ("ok", "flow")

            inspector.set_node(
                "root",
                {
                    "type": "contextState",
                    "graphId": "flow_a",
                    "cases": [{"state": "ready", "next": "hit"}],
                    "defaultNext": "fallback",
                },
            )
            refs = inspector._topology_refs
            gid_field = refs["graph_id_edit"]
            self.assertIsInstance(gid_field, ReferencePickerField)
            _pick_reference(self, gid_field, "flow_b")

            node = inspector.get_node()
            self.assertEqual(node["type"], "contextState")
            self.assertEqual(node["graphId"], "flow_b")
            self.assertGreaterEqual(changes, 1)

        inspector.deleteLater()

    def test_context_state_graph_field_is_popup_picker_not_dropdown(self) -> None:
        """引用字段禁止长下拉（editor-tools-norms 选择器铁律 / 2026-07-11 拍板）。

        旧实现是可编辑 QComboBox，候选 40+ 且跨文件；它还逼出一套「按当前显示文本
        反查 itemData」的解析——标签与真 graphId 对不上就静默写坏数据。
        """
        root = Path(__file__).resolve().parents[3]
        inspector = NodeInspector(lambda: ["root", "hit"], project_root=root)
        inspector.set_node(
            "root",
            {"type": "contextState", "graphId": "wrap_读人_儿子",
             "cases": [{"state": "s", "next": "hit"}], "defaultNext": "hit"},
        )
        gid_field = inspector._topology_refs["graph_id_edit"]
        self.assertIsInstance(gid_field, ReferencePickerField)
        self.assertNotIsInstance(gid_field, QComboBox)
        inspector.deleteLater()

    def test_context_state_keeps_dangling_graph_id_verbatim(self) -> None:
        """悬垂 graphId 必须保值（共享控件保值铁律）——不静默清空、不顶替成第一项。"""
        root = Path(__file__).resolve().parents[3]
        inspector = NodeInspector(lambda: ["root", "hit"], project_root=root)
        inspector.set_node(
            "root",
            {"type": "contextState", "graphId": "根本不存在的图",
             "cases": [{"state": "s", "next": "hit"}], "defaultNext": "hit"},
        )
        gid_field = inspector._topology_refs["graph_id_edit"]
        self.assertEqual(gid_field.current_value(), "根本不存在的图")
        self.assertEqual(inspector.get_node()["graphId"], "根本不存在的图")
        inspector.deleteLater()

    def test_context_state_accepts_entity_wrapper_without_error(self) -> None:
        """contextState 读实体 wrapper：warning 而不是 error（2026-08-26 放开）。

        同一个 `getActiveState` 读取换成 switch 的 narrative 条件叶子完全免检，
        运行时 `evalContextState` 也不查归属——在这里报 error 就是 Python 兜底
        比 TS 权威更严（editor-tools-norms 红线），且拦不住任何东西。
        """
        root = Path(__file__).resolve().parents[3]
        graph = {
            "id": "g", "entry": "n_ctx",
            "nodes": {
                "n_ctx": {
                    "type": "contextState", "graphId": "wrap_读人_儿子",
                    "cases": [], "defaultNext": "n_end",
                },
                "n_end": {"type": "end"},
            },
        }
        errors, warns = validate_graph_tiered(graph, project_root=root)
        self.assertEqual([e for e in errors if "wrap_读人_儿子" in e], [])
        self.assertTrue(
            any("wrap_读人_儿子" in w and "跨实体" in w for w in warns),
            f"应给一条跨实体读取的提醒，实际 warnings={warns}",
        )

    def test_context_state_dangling_graph_id_says_it_is_missing(self) -> None:
        """悬垂 graphId 报「不存在」，不再借 wrapper 的措辞。

        踩过：`后巷_棺材铺交互` 指向从来不存在的 `后巷_街边店铺`，却报成
        「不允许读取（不能选择 npc/hotspot wrapper）」——真毛病被措辞盖住。
        """
        root = Path(__file__).resolve().parents[3]
        graph = {
            "id": "g", "entry": "n_ctx",
            "nodes": {
                "n_ctx": {
                    "type": "contextState", "graphId": "从来没有过这张图",
                    "cases": [], "defaultNext": "n_end",
                },
                "n_end": {"type": "end"},
            },
        }
        errors, _warns = validate_graph_tiered(graph, project_root=root)
        hits = [e for e in errors if "从来没有过这张图" in e]
        self.assertTrue(hits, f"悬垂 graphId 应报 error，实际 errors={errors}")
        self.assertTrue(
            all("不存在" in e for e in hits),
            f"消息要说「不存在」而不是 wrapper 措辞：{hits}",
        )

    def test_switch_condition_expr_uses_structured_tree_not_json_editor(self) -> None:
        class FakeProjectModel:
            flag_registry: dict = {}

            def scenario_ids_ordered(self) -> list[str]:
                return ["scenario_a", "line_a"]

            def phases_for_scenario(self, scenario_id: str) -> list[str]:
                return ["phase_a"] if scenario_id == "scenario_a" else []

        root = Path(__file__).resolve().parents[3]
        condition = {
            "all": [
                {"quest": "q_bridge", "questStatus": "Active"},
                {"scenario": "scenario_a", "phase": "phase_a", "status": "done"},
                {"scenarioLine": "line_a", "lineStatus": "active"},
                {"not": {"flag": "debug_flag", "op": "!=", "value": False}},
            ],
        }
        inspector = NodeInspector(
            lambda: ["root", "hit", "fallback"],
            project_root=root,
            project_model_getter=lambda: FakeProjectModel(),
        )
        inspector.set_node(
            "root",
            {
                "type": "switch",
                "cases": [{"condition": condition, "next": "hit"}],
                "defaultNext": "fallback",
            },
        )

        refs = inspector._topology_refs
        case = refs["case_rows"][0]
        self.assertIn("expr_tree", case)
        self.assertNotIn("expr_edit", case)
        node = inspector.get_node()
        self.assertEqual(node["cases"][0]["condition"], condition)
        self.assertNotIn("conditions", node["cases"][0])

        inspector.deleteLater()

    def test_owner_state_inspector_persists_wrapper_graph_id(self) -> None:
        root = Path(__file__).resolve().parents[3]
        inspector = NodeInspector(
            lambda: ["root", "hit", "fallback"],
            project_root=root,
            project_model_getter=lambda: object(),
            dialogue_graph_id_getter=lambda: "dlg_x",
        )
        with patch("tools.editor.shared.narrative_catalog.resolve_owner_wrapper_states") as resolver:
            resolver.return_value = {
                "stateIds": ["before_event", "after_event"],
                "wrappers": [
                    {
                        "graphId": "npc_ringboy_main",
                        "ownerType": "npc",
                        "ownerId": "npc_ringboy",
                        "stateIds": ["before_event", "after_event"],
                    }
                ],
                "ambiguous": False,
                "message": "ok",
            }
            inspector.set_node(
                "root",
                {
                    "type": "ownerState",
                    "wrapperGraphId": "",
                    "cases": [{"state": "before_event", "next": "hit"}],
                    "defaultNext": "fallback",
                    "missingWrapperNext": "fallback",
                },
            )
            refs = inspector._topology_refs
            wrapper_edit = refs["wrapper_graph_id_edit"]
            wrapper_edit.setText("npc_ringboy_main")
            node = inspector.get_node()
            self.assertEqual(node["type"], "ownerState")
            self.assertEqual(node["wrapperGraphId"], "npc_ringboy_main")
        inspector.deleteLater()

    def test_scene_on_enter_dialogue_derives_scene_owner(self) -> None:
        from tools.editor.shared.narrative_catalog import dialogue_owner_refs_from_scenes

        scenes = {
            "scene_a": {
                "npcs": [],
                "hotspots": [],
                "onEnter": [
                    # 无 owner / 无 npcId → 继承场景 owner
                    {"type": "startDialogueGraph", "params": {"graphId": "dlg_scene"}},
                    # 显式 npcId → npc owner
                    {"type": "startDialogueGraph", "params": {"graphId": "dlg_npc", "npcId": "npc_x"}},
                    # 显式 ownerType/ownerId → 原样
                    {"type": "startDialogueGraph", "params": {"graphId": "dlg_explicit", "ownerType": "quest", "ownerId": "q1"}},
                    # 嵌套在 runActions 内 → 仍计入场景 owner
                    {"type": "runActions", "params": {"actions": [
                        {"type": "startDialogueGraph", "params": {"graphId": "dlg_nested"}},
                    ]}},
                ],
            },
        }
        refs = dialogue_owner_refs_from_scenes(scenes)

        def owner_pairs(dlg: str) -> set[tuple[str, str]]:
            return {(r["ownerType"], r["ownerId"]) for r in refs.get(dlg, [])}

        self.assertIn(("scene", "scene_a"), owner_pairs("dlg_scene"))
        self.assertIn(("npc", "npc_x"), owner_pairs("dlg_npc"))
        self.assertIn(("quest", "q1"), owner_pairs("dlg_explicit"))
        self.assertIn(("scene", "scene_a"), owner_pairs("dlg_nested"))

    def test_owner_state_token_wrapper_graph_id_skips_static_case_validation(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "dlg_x",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "wrapperGraphId": "@scene",
                    "cases": [{"state": "any_runtime_state", "next": "end"}],
                    "defaultNext": "end",
                    "missingWrapperNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        with patch("tools.editor.shared.narrative_catalog.resolve_owner_wrapper_states") as resolver:
            resolver.return_value = {
                "stateIds": ["before_event"],
                "wrappers": [{"graphId": "scene_wrapper", "stateIds": ["before_event"]}],
                "ambiguous": False,
                "message": "ok",
            }
            errors, warnings = validate_graph_tiered(
                data,
                project_root=Path(__file__).resolve().parents[3],
                project_model=object(),
            )
        # 相对 token 运行时解析：不应因 case state 不在 wrapper 而报错
        self.assertFalse(any("不存在于 wrapper" in e for e in errors))
        self.assertFalse(any("指向不存在的 wrapper graph" in e for e in errors))

    def test_context_state_token_graph_id_skips_static_validation(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "contextState",
                    "graphId": "@owner",
                    "cases": [{"state": "any_runtime_state", "next": "end"}],
                    "defaultNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        errors, _ = validate_graph_tiered(data, project_root=Path(__file__).resolve().parents[3])
        self.assertFalse(any("不允许读取" in e for e in errors))
        self.assertFalse(any("不存在于图" in e for e in errors))

    def test_rejects_set_narrative_state_in_run_actions(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "actions",
            "nodes": {
                "actions": {
                    "type": "runActions",
                    "actions": [{"type": "setNarrativeState", "params": {"graphId": "flow", "stateId": "a"}}],
                    "next": "end",
                },
                "end": {"type": "end"},
            },
        }
        errors, warnings = validate_graph_tiered(data)
        self.assertTrue(any("setNarrativeState" in e for e in errors))
        self.assertFalse(any("setNarrativeState" in w for w in warnings))

    def test_context_graph_pointing_at_npc_wrapper_warns_but_does_not_block(self) -> None:
        """曾是 `test_rejects_forbidden_context_graph_without_project`（断言 error
        「不允许读取」）。2026-08-26 降级为 warning——理由见
        `narrative_catalog.classify_context_graph` 的文档串：拦不住（同一读取走
        switch 的 narrative 条件叶子完全免检）、运行时不查、且比 TS 权威更严。
        """
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "contextState",
                    "graphId": "npc_ringboy",
                    "cases": [{"state": "before_event", "next": "end"}],
                    "defaultNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        errors, warnings = validate_graph_tiered(
            data, project_root=Path(__file__).resolve().parents[3],
        )
        self.assertEqual([e for e in errors if "npc_ringboy" in e], [])
        self.assertTrue(
            any("npc_ringboy" in w and "跨实体" in w for w in warnings),
            f"应给一条跨实体读取的提醒，实际 warnings={warnings}",
        )

    def test_owner_state_warns_when_multi_wrapper_without_wrapper_graph_id(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "dlg_x",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [{"state": "before_event", "next": "end"}],
                    "defaultNext": "end",
                    "missingWrapperNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        with patch("tools.editor.shared.narrative_catalog.resolve_owner_wrapper_states") as resolver:
            resolver.return_value = {
                "stateIds": ["before_event", "after_event"],
                "wrappers": [
                    {"graphId": "npc_ringboy_main", "stateIds": ["before_event"]},
                    {"graphId": "npc_ringboy_quest", "stateIds": ["after_event"]},
                ],
                "ambiguous": False,
                "message": "ok",
            }
            errors, warnings = validate_graph_tiered(
                data,
                project_root=Path(__file__).resolve().parents[3],
                project_model=object(),
            )
        self.assertFalse(errors)
        self.assertTrue(any("未设置 wrapperGraphId" in w for w in warnings))

    def test_owner_state_rejects_missing_wrapper_graph_id_target(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "dlg_x",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "wrapperGraphId": "missing_graph",
                    "cases": [{"state": "before_event", "next": "end"}],
                    "defaultNext": "end",
                    "missingWrapperNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        with patch("tools.editor.shared.narrative_catalog.resolve_owner_wrapper_states") as resolver, \
             patch("tools.editor.shared.narrative_catalog.graph_info") as graph_info:
            resolver.return_value = {
                "stateIds": ["before_event"],
                "wrappers": [{"graphId": "npc_ringboy_main", "stateIds": ["before_event"]}],
                "ambiguous": False,
                "message": "ok",
            }
            graph_info.return_value = None
            errors, warnings = validate_graph_tiered(
                data,
                project_root=Path(__file__).resolve().parents[3],
                project_model=object(),
            )
        self.assertTrue(any("指向不存在的 wrapper graph" in e for e in errors))
        self.assertFalse(any("不一致" in w for w in warnings))

    def test_owner_state_rejects_non_wrapper_graph_id_target(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "dlg_x",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "wrapperGraphId": "flow_dock",
                    "cases": [{"state": "ready", "next": "end"}],
                    "defaultNext": "end",
                    "missingWrapperNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        with patch("tools.editor.shared.narrative_catalog.resolve_owner_wrapper_states") as resolver, \
             patch("tools.editor.shared.narrative_catalog.graph_info") as graph_info:
            resolver.return_value = {
                "stateIds": ["before_event"],
                "wrappers": [{"graphId": "npc_ringboy_main", "stateIds": ["before_event"]}],
                "ambiguous": False,
                "message": "ok",
            }
            graph_info.return_value = {
                "graphId": "flow_dock",
                "kind": "mainGraph",
                "ownerType": "flow",
                "ownerId": "dock",
                "stateIds": ["ready"],
            }
            errors, warnings = validate_graph_tiered(
                data,
                project_root=Path(__file__).resolve().parents[3],
                project_model=object(),
            )
        self.assertTrue(any("不是 wrapperGraph" in e for e in errors))
        self.assertFalse(any("与当前对话 owner 不一致" in w for w in warnings))

    def test_owner_state_warns_when_wrapper_graph_cross_owner(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "dlg_x",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "wrapperGraphId": "npc_other_wrapper",
                    "cases": [{"state": "other_state", "next": "end"}],
                    "defaultNext": "end",
                    "missingWrapperNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        with patch("tools.editor.shared.narrative_catalog.resolve_owner_wrapper_states") as resolver, \
             patch("tools.editor.shared.narrative_catalog.graph_info") as graph_info:
            resolver.return_value = {
                "stateIds": ["before_event"],
                "wrappers": [{"graphId": "npc_ringboy_main", "stateIds": ["before_event"]}],
                "ambiguous": False,
                "message": "ok",
            }
            graph_info.return_value = {
                "graphId": "npc_other_wrapper",
                "kind": "wrapperGraph",
                "ownerType": "npc",
                "ownerId": "npc_other",
                "stateIds": ["other_state"],
            }
            errors, warnings = validate_graph_tiered(
                data,
                project_root=Path(__file__).resolve().parents[3],
                project_model=object(),
            )
        self.assertFalse(any("指向不存在的 wrapper graph" in e for e in errors))
        self.assertTrue(any("与当前对话 owner 不一致" in w for w in warnings))


if __name__ == "__main__":
    unittest.main()
