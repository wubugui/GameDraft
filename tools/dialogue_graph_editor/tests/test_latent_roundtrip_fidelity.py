"""合成 fixture 往返探针：钉住「已发布数据尚未触及、但新写内容会踩」的零丢失不变量。

test_inspector_roundtrip 只覆盖当前 graphs/*.json 里真实出现过的节点形状；下面这些形状目前
没有任何在库文件命中（探针恒绿），因此曾长期潜伏为「表单回写时注入/丢弃字段」的破口：

- switch case 只有 next（无 conditions/condition）  → 曾被回写成 conditions:[]（Bug6）
- switch case 带空 conditions:[]                   → 曾被丢/改（Bug6）
- flag 条件 value 为空串 ""                          → 曾因 falsy 被丢键（Bug7）
- quest 条件无 status/questStatus                    → 曾被注入 questStatus:"Active"（Bug7）
- 多拍 line 顶层有 text 无 textKey、beat0 有 textKey → 曾把 beat0.textKey 注入到顶层（Bug7）
- ownerState/contextState case state/next 全空       → 曾被 `if st or nx_v` 丢弃（Bug5）

本测试用合成节点直接喂 NodeInspector.set_node→get_node，断言深度相等，防止回归。
"""
from __future__ import annotations

import copy
import json
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.dialogue_graph_editor.node_inspector import NodeInspector
from tools.editor.project_model import ProjectModel

_PROJECT_ROOT = Path(__file__).resolve().parents[3]

# (nid, node) —— 合成节点，覆盖上面每条潜伏不变量。
_FIXTURES: list[tuple[str, dict]] = [
    # Bug6: 裸 next 分支保持裸 next，不注入 conditions:[]
    ("sw_bare", {"type": "switch", "cases": [{"next": "n1"}], "defaultNext": "n2"}),
    # Bug6: 空 conditions 数组按原样保留
    ("sw_empty_conds", {
        "type": "switch",
        "cases": [{"next": "n1", "conditions": []}],
        "defaultNext": "n2",
    }),
    # 常规 switch 分支（回归护栏，确保未被上面的改动波及）
    ("sw_normal", {
        "type": "switch",
        "cases": [{"next": "n1", "conditions": [{"flag": "f", "op": "==", "value": True}]}],
        "defaultNext": "n2",
    }),
    # Bug7: flag value 为空串忠实保留（不因 falsy 丢 value 键）
    ("sw_empty_value", {
        "type": "switch",
        "cases": [{"next": "n1", "conditions": [{"flag": "f", "op": "==", "value": ""}]}],
        "defaultNext": "n2",
    }),
    # Bug7: quest 条件无状态键 → 不注入 questStatus
    ("sw_quest_no_status", {
        "type": "switch",
        "cases": [{"next": "n1", "conditions": [{"quest": "q1"}]}],
        "defaultNext": "n2",
    }),
    # Bug7: quest 条件带 questStatus → 原样保留
    ("sw_quest_status", {
        "type": "switch",
        "cases": [{"next": "n1", "conditions": [{"quest": "q1", "questStatus": "Completed"}]}],
        "defaultNext": "n2",
    }),
    # Bug7: quest 条件用旧键 status → 保持 status（不改写成 questStatus）
    ("sw_quest_legacy_status", {
        "type": "switch",
        "cases": [{"next": "n1", "conditions": [{"quest": "q1", "status": "Active"}]}],
        "defaultNext": "n2",
    }),
    # Bug7: 多拍 line 顶层有 text、无 textKey，beat0 带 textKey → 不把 textKey 注入顶层
    ("ln_multi_no_top_textkey", {
        "type": "line",
        "speaker": {"kind": "npc"},
        "text": "hi",
        "lines": [{"speaker": {"kind": "npc"}, "text": "hi", "textKey": "k0"}],
        "next": "n1",
    }),
    # Bug5: contextState 的 state/next 全空分支（已存在）忠实保留
    ("ctx_empty_case", {
        "type": "contextState",
        "graphId": "@owner",
        "cases": [{"state": "", "next": ""}],
        "defaultNext": "d",
    }),
]


class LatentRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _make_inspector(self, node_ids: list[str]) -> NodeInspector:
        return NodeInspector(
            lambda ids=node_ids: list(ids),
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
            dialogue_graph_id_getter=lambda: "",
        )

    def test_latent_shapes_roundtrip_without_loss(self) -> None:
        mismatches: list[str] = []
        for nid, node in _FIXTURES:
            inspector = self._make_inspector(["n1", "n2", "d", "m", nid])
            original = copy.deepcopy(node)
            try:
                inspector.set_node(nid, copy.deepcopy(node))
                got = inspector.get_node()
            except Exception as e:  # noqa: BLE001
                mismatches.append(f"{nid} ({node['type']}): getter 抛异常 {e!r}")
                inspector.deleteLater()
                continue
            if got != original:
                mismatches.append(
                    f"{nid} ({node['type']}):\n"
                    f"  原始: {json.dumps(original, ensure_ascii=False, sort_keys=True)}\n"
                    f"  往返: {json.dumps(got, ensure_ascii=False, sort_keys=True)}"
                )
            inspector.deleteLater()

        if mismatches:
            self.fail(
                f"合成 fixture 往返丢失/改写了 {len(mismatches)} 个节点：\n"
                + "\n".join(mismatches)
            )


if __name__ == "__main__":
    unittest.main()
