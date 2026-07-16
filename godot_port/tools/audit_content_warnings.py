#!/usr/bin/env python3
"""Classify every content warning by its cross-runtime fallback contract."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT = REPO_ROOT / "godot_port/compatibility/content-warning-classification.json"
PROJECT_PYTHON = REPO_ROOT / ".tools/venv/bin/python"
if importlib.util.find_spec("PySide6") is None and PROJECT_PYTHON.is_file():
    os.execv(str(PROJECT_PYTHON), [str(PROJECT_PYTHON), __file__, *sys.argv[1:]])
sys.path.insert(0, str(REPO_ROOT))

from tools.editor.validate import run as validate_project  # noqa: E402


CATEGORIES: list[dict[str, object]] = [
    {
        "id": "empty_inspect",
        "pattern": r"Hotspot '.+' inspect 未配置 graphId、非空 text 或非空 actions",
        "fallback": "交互定义保留但 inspect 分支无可执行内容；两端均不合成替代文案或动作。",
        "evidence": ["godot_port/tests/hotspot_test.tscn", "godot_port/tests/interaction_coordinator_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "missing_cutscene_binding",
        "pattern": r"cutsceneIds 包含 '.+'，不在过场 index 列表中",
        "fallback": "未知绑定永远不会成为 active cutscene id；两端均按未绑定实体处理。",
        "evidence": ["godot_port/tests/scene_manager_test.tscn", "godot_port/tests/all_cutscenes_smoke_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "empty_archive_child",
        "pattern": r"书页子条目无任何可显示内容",
        "fallback": "空子条目不生成可见正文；两端保留容器顺序但不注入占位内容。",
        "evidence": ["godot_port/tests/archive_ui_test.tscn", "godot_port/tests/archive_manager_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "unregistered_archive_flag",
        "pattern": r"flag '.+' not in registry static/patterns",
        "fallback": "未登记 flag 只读为缺省未满足；两端写入入口均受 registry 拒绝。",
        "evidence": ["godot_port/tests/flag_store_test.gd", "godot_port/tests/archive_manager_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "empty_condition_flag_key",
        "pattern": r"empty flag key",
        "fallback": "空 flag key 的条件不命中，不读取或写入匿名状态。",
        "evidence": ["godot_port/tests/condition_evaluator_test.gd", "src/systems/NarrativeConditionContext.test.ts"],
        "authoringActionRequired": True,
    },
    {
        "id": "draft_narrative_signal",
        "pattern": r"仍是草稿信号 __draft__",
        "fallback": "__draft__ 没有合法生产发射方，因此迁移不会自行触发该 transition。",
        "evidence": ["godot_port/tests/narrative_signal_queue_test.tscn", "godot_port/tests/narrative_reactive_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "unlistened_narrative_signal_emit",
        "pattern": r"emitNarrativeSignal 信号 '.+' 没有任何 Transition 监听（发出后不会推动任何迁移）",
        "fallback": "信号仍进入统一叙事队列并完成处理，但没有 transition 可选，因此两端都不改变活动状态，只记录 signal.unlistened 诊断。",
        "evidence": ["src/core/NarrativeStateManager.test.ts", "godot_port/tests/narrative_owner_save_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "unemitted_narrative_signal_listener",
        "pattern": r"Transition '.+' 监听信号 '.+'，但全项目没有任何对话/资产/叙事图发出它，也无画布黑盒声明（悬垂监听，永远不会触发）",
        "fallback": "transition 只由收到的同名信号驱动；没有任何生产发射方时，两端都不会合成信号或自行迁移状态。",
        "evidence": ["src/core/NarrativeStateManager.test.ts", "godot_port/tests/narrative_state_manager_direct_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "narrative_canvas_emit_drift",
        "pattern": r"画布黑盒 '.+' 声明发出 '.+'，但对话图里没有对应 emitNarrativeSignal",
        "fallback": "运行时以真实对话图为权威；两端均不会依据编辑器画布声明虚构信号。",
        "evidence": ["godot_port/tests/graph_dialogue_manager_test.tscn", "godot_port/tests/narrative_signal_queue_test.tscn"],
        "authoringActionRequired": True,
    },
    {
        "id": "transition_without_plane_membership",
        "pattern": r"transition '.+' 未声明 planes 归属",
        "fallback": "normal/overlay 位面按通用实体处理；exclusive 位面下两端均视为不存在。",
        "evidence": ["godot_port/tests/plane_runtime_integration_test.tscn", "godot_port/tests/interaction_system_test.tscn"],
        "authoringActionRequired": False,
    },
]


def classify(message: str) -> dict[str, object] | None:
    return next((category for category in CATEGORIES if re.search(str(category["pattern"]), message)), None)


def build_report() -> dict[str, object]:
    issues = validate_project(REPO_ROOT)
    errors = [issue for issue in issues if issue.severity == "error"]
    warnings = [issue for issue in issues if issue.severity != "error"]
    grouped: dict[str, list[dict[str, str]]] = {str(category["id"]): [] for category in CATEGORIES}
    unknown: list[dict[str, str]] = []
    for issue in warnings:
        item = {"dataType": issue.data_type, "itemId": issue.item_id, "message": issue.message}
        category = classify(issue.message)
        if category is None:
            unknown.append(item)
        else:
            grouped[str(category["id"])].append(item)
    categories = []
    for definition in CATEGORIES:
        category = {key: value for key, value in definition.items() if key != "pattern"}
        category["count"] = len(grouped[str(definition["id"])])
        category["issues"] = grouped[str(definition["id"])]
        categories.append(category)
    return {
        "contractVersion": 1,
        "errorCount": len(errors),
        "warningCount": len(warnings),
        "classifiedCount": sum(len(values) for values in grouped.values()),
        "unknownCount": len(unknown),
        "alignmentStatus": "PASS" if not errors and not unknown else "FAIL",
        "policy": "创作 warning 可保留，但每类必须有两端共同回退语义；任何新类别先审计再放行。",
        "categories": categories,
        "unknown": unknown,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    report = build_report()
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.write:
        OUTPUT.write_text(rendered, encoding="utf-8")
    elif not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != rendered:
        print("Content warning classification is stale (run with --write)")
        return 1
    print(
        f"Content warning fallback classification: {report['alignmentStatus']} "
        f"({report['classifiedCount']}/{report['warningCount']} classified, {report['unknownCount']} unknown)"
    )
    return 0 if report["alignmentStatus"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
