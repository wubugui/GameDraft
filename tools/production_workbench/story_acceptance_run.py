"""Semi-automatic story-unit acceptance runs.

This module does not click the browser UI. It turns a story-unit acceptance
script into a concrete run sheet, sends safe DEV runtime commands for the
parts it can parse, clears stale runtime snapshots before the run, and compares
the latest runtime snapshot after the run.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .runtime_command import enqueue_runtime_commands, new_runtime_command
from .runtime_debug import clear_runtime_debug_snapshot
from .story_acceptance_commands import (
    build_acceptance_entry_runtime_commands,
    build_acceptance_route_runtime_commands,
    build_acceptance_save_load_runtime_commands,
    build_acceptance_setup_runtime_commands,
)
from .story_acceptance import (
    AcceptanceRuntimeCompareReport,
    check_story_unit_acceptance_script,
    compare_story_unit_acceptance_to_runtime_snapshot,
    format_acceptance_check_report,
    format_acceptance_runtime_compare_report,
)
from .story_units import StoryUnit


@dataclass(frozen=True)
class StoryAcceptanceRunSheet:
    composition_id: str
    display_name: str
    snapshot_cleared: bool
    command_enqueued: bool
    command_count: int
    command_warnings: list[str]
    text: str


@dataclass(frozen=True)
class StoryAcceptanceRunFinish:
    composition_id: str
    display_name: str
    status: str
    note: str
    compare: AcceptanceRuntimeCompareReport
    text: str


def start_story_acceptance_run(project_root: Path, unit: StoryUnit) -> StoryAcceptanceRunSheet:
    cleared = clear_runtime_debug_snapshot(project_root)
    command_enqueued = False
    command_count = 0
    command_warnings: list[str] = []
    try:
        setup_plan = build_acceptance_setup_runtime_commands(unit)
        entry_plan = build_acceptance_entry_runtime_commands(unit)
        route_plan = build_acceptance_route_runtime_commands(unit)
        save_load_plan = build_acceptance_save_load_runtime_commands(unit)
        command_warnings = [
            *setup_plan.warnings,
            *entry_plan.warnings,
            *route_plan.warnings,
            *save_load_plan.warnings,
        ]
        commands = [
            *setup_plan.commands,
            new_runtime_command(
                "clearNarrativeTrace",
                reason=f"acceptance-start:{unit.record.composition_id}",
            ),
            *entry_plan.commands,
            new_runtime_command(
                "captureSnapshot",
                reason=f"acceptance-ready:{unit.record.composition_id}",
            ),
            *route_plan.commands,
            *save_load_plan.commands,
        ]
        enqueue_runtime_commands(project_root, commands)
        command_enqueued = True
        command_count = len(commands)
    except Exception:
        command_enqueued = False
    static_report = check_story_unit_acceptance_script(project_root, unit)
    text = format_story_acceptance_run_sheet(
        unit,
        snapshot_cleared=cleared,
        command_enqueued=command_enqueued,
        command_count=command_count,
        command_warnings=command_warnings,
    )
    if not static_report.ok or static_report.issues:
        text += "\n\n静态脚本检查:\n" + format_acceptance_check_report(static_report)
    return StoryAcceptanceRunSheet(
        composition_id=unit.record.composition_id,
        display_name=unit.record.display_name or unit.summary.label,
        snapshot_cleared=cleared,
        command_enqueued=command_enqueued,
        command_count=command_count,
        command_warnings=command_warnings,
        text=text,
    )


def finish_story_acceptance_run(project_root: Path, unit: StoryUnit) -> StoryAcceptanceRunFinish:
    compare = compare_story_unit_acceptance_to_runtime_snapshot(project_root, unit)
    status, note = _status_note_from_compare(compare)
    text = "\n\n".join([
        "剧情单元验收运行结果",
        f"剧情单元: {unit.record.display_name or unit.summary.label} ({unit.record.composition_id})",
        f"建议结果: {status}",
        f"备注: {note}",
        format_acceptance_runtime_compare_report(compare),
    ])
    return StoryAcceptanceRunFinish(
        composition_id=unit.record.composition_id,
        display_name=unit.record.display_name or unit.summary.label,
        status=status,
        note=note,
        compare=compare,
        text=text,
    )


def format_story_acceptance_run_sheet(
    unit: StoryUnit,
    *,
    snapshot_cleared: bool,
    command_enqueued: bool = False,
    command_count: int = 0,
    command_warnings: list[str] | None = None,
) -> str:
    rec = unit.record
    script = rec.acceptance_script
    lines = [
        "剧情单元半自动验收运行单",
        f"剧情单元: {rec.display_name or unit.summary.label} ({rec.composition_id})",
        f"旧运行时快照: {'已清空' if snapshot_cleared else '没有旧快照'}",
        f"运行中浏览器命令: {'已发送 ' + str(command_count) + ' 条' if command_enqueued else '未发送'}",
        "",
        "运行前:",
        "- 启动游戏: npm run dev",
        "- 打开浏览器里的游戏页面，确认 F2 Debug 可用。",
        "- 若浏览器页面已经打开，工作台会通过 DEV 命令队列应用可解析的前置状态，然后清空 Narrative trace。",
        "- 如果需要复现纯净状态，请先重新载入页面或读指定存档。",
        "",
        "入口:",
        f"- {script.start_entry or rec.entry or '(未填写)'}",
        "",
        "前置状态:",
    ]
    lines.extend(_section_lines("flag", script.setup_flags))
    lines.extend(_section_lines("quest", script.setup_quests))
    lines.extend(_section_lines("scenario", script.setup_scenarios))
    lines.extend(_section_lines("narrative state", script.setup_narrative_states))
    if command_warnings:
        lines.extend(["", "自动命令 warning:"])
        lines.extend(f"- {warning}" for warning in command_warnings)
    lines.extend([
        "",
        "执行步骤:",
    ])
    if script.actions:
        lines.extend(f"{idx}. {step}" for idx, step in enumerate(script.actions, start=1))
    else:
        lines.append("1. (未填写)")
    if script.option_choices:
        lines.append("")
        lines.append("选项选择:")
        lines.extend(f"- {step}" for step in script.option_choices)
    lines.extend([
        "",
        "期望结果:",
    ])
    lines.extend(_section_lines("signal", script.expected_signals))
    lines.extend(_section_lines("narrative state", script.expected_narrative_states))
    lines.extend(_section_lines("quest", script.expected_quest_changes))
    lines.extend(_section_lines("scenario", script.expected_scenario_changes))
    lines.extend([
        "",
        "存读档复查:",
        f"- {script.save_load_check or '(未填写)'}",
        "",
        "运行后:",
        "- 回到生产工作台，点击“完成验收并对比”。",
        "- 工作台会读取最新 runtime_debug_snapshot.json，对比 signal/state/quest/scenario。",
        "- 如果失败，复制报告给 Codex 继续定位。",
    ])
    return "\n".join(lines)


def _section_lines(label: str, values: list[str]) -> list[str]:
    if not values:
        return [f"- {label}: (无)"]
    return [f"- {label}: {value}" for value in values]


def _status_note_from_compare(compare: AcceptanceRuntimeCompareReport) -> tuple[str, str]:
    if not compare.runtime_ok:
        return "阻塞", compare.message or "没有可用运行时快照。"
    if compare.fail_count > 0:
        return "失败", f"自动对比失败 {compare.fail_count} 项。"
    if compare.warning_count > 0:
        return "阻塞", f"自动对比有 warning {compare.warning_count} 项，需要确认。"
    if compare.manual_count > 0:
        return "通过", "自动对比通过；存读档复查仍需人工确认。"
    return "通过", "自动对比通过。"
