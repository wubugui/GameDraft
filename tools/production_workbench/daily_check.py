"""Daily production checks for the GameDraft workbench."""
from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from tools.editor.project_model import ProjectModel
from tools.editor.shared.asset_reference_audit import audit_project_assets

from .asset_audit import audit_asset_specs
from .report_log import save_workbench_report
from .story_acceptance import check_story_unit_acceptance_script
from .story_units import (
    load_story_unit_workspace,
    story_unit_completeness_issues,
)


@dataclass
class CheckIssue:
    severity: str
    area: str
    message: str


@dataclass
class DailyCheckReport:
    project_root: Path
    ok: bool
    issues: list[CheckIssue] = field(default_factory=list)
    passed_checks: list[str] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return sum(1 for x in self.issues if x.severity == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for x in self.issues if x.severity == "warning")

    @property
    def blocker_count(self) -> int:
        return sum(1 for x in self.issues if x.severity == "blocker")


def run_daily_check(
    project_root: Path,
    *,
    progress: Callable[[str], None] | None = None,
    run_toolchain_checks: bool = False,
) -> DailyCheckReport:
    project_root = project_root.resolve()
    issues: list[CheckIssue] = []
    passed_checks: list[str] = []

    def log(message: str) -> None:
        if progress:
            progress(message)

    def add(severity: str, area: str, message: str) -> None:
        issues.append(CheckIssue(severity=severity, area=area, message=message))

    if not (project_root / "public" / "assets").is_dir():
        add("error", "project", "不是有效 GameDraft 工程：缺 public/assets")
        return DailyCheckReport(project_root=project_root, ok=False, issues=issues, passed_checks=passed_checks)

    log("加载工程数据...")
    try:
        model = ProjectModel()
        model.load_project(project_root)
    except Exception as exc:  # noqa: BLE001 - production report should keep going when possible
        add("error", "project", f"工程加载失败: {exc}")
        return DailyCheckReport(project_root=project_root, ok=False, issues=issues, passed_checks=passed_checks)

    log("检查叙事 graph...")
    try:
        from tools.editor.editors.narrative_state_editor import (
            validate_narrative_graphs,
            validate_project_context,
        )

        for issue in validate_narrative_graphs(model.narrative_graphs) + validate_project_context(model.narrative_graphs, model):
            severity = str(issue.get("severity") or "warning")
            if severity not in {"error", "warning", "blocker"}:
                severity = "warning"
            code = str(issue.get("code") or "narrative.issue")
            msg = str(issue.get("message") or "")
            add(severity, "narrative", f"{code}: {msg}")
    except Exception as exc:  # noqa: BLE001
        add("error", "narrative", f"叙事校验失败: {exc}")

    log("检查 dialogue graph 结构...")
    try:
        from tools.dialogue_graph_editor.graph_document import (
            list_graph_files,
            load_json,
            validate_graph_tiered,
        )

        graph_files = list_graph_files(project_root)
        if graph_files:
            for path in graph_files:
                try:
                    data = load_json(path)
                except Exception as exc:  # noqa: BLE001
                    add("error", "dialogue-graph", f"{path.name}: JSON 读取失败: {exc}")
                    continue
                errors, warnings = validate_graph_tiered(
                    data,
                    project_root=project_root,
                    project_model=model,
                )
                for msg in errors:
                    add("error", "dialogue-graph", f"{path.name}: {msg}")
                for msg in warnings:
                    add("warning", "dialogue-graph", f"{path.name}: {msg}")
        else:
            add("warning", "dialogue-graph", "没有 dialogue graph 文件")
    except Exception as exc:  # noqa: BLE001
        add("error", "dialogue-graph", f"dialogue graph 校验失败: {exc}")

    log("检查剧情单元追踪...")
    try:
        ws = load_story_unit_workspace(project_root)
        if not ws.units:
            add("warning", "story-unit", "没有 narrative composition，无法形成剧情单元清单")
        for unit in ws.units:
            missing = story_unit_completeness_issues(unit)
            if missing:
                add(
                    "warning",
                    "story-unit",
                    f"{unit.record.display_name or unit.record.composition_id}: {', '.join(missing)}",
                )
            if unit.record.production_status in {"待验收", "通过"}:
                acceptance = check_story_unit_acceptance_script(
                    project_root,
                    unit,
                    model=model,
                    include_completeness=False,
                )
                for issue in acceptance.issues:
                    add(
                        issue.severity if issue.severity in {"error", "warning", "blocker"} else "warning",
                        "story-acceptance",
                        f"{unit.record.display_name or unit.record.composition_id}: {issue.message}",
                    )
    except Exception as exc:  # noqa: BLE001
        add("error", "story-unit", f"剧情单元追踪检查失败: {exc}")

    log("检查素材引用...")
    try:
        asset_report = audit_project_assets(project_root)
        for issue in asset_report.issues:
            add(
                "error",
                "asset",
                f"{issue.file} {issue.field_path}: {issue.raw_value} ({issue.reason})",
            )
    except Exception as exc:  # noqa: BLE001
        add("error", "asset", f"素材引用检查失败: {exc}")

    log("检查素材规格...")
    try:
        spec_report = audit_asset_specs(project_root)
        unknown_dims = [x for x in spec_report.images if x.width is None or x.height is None]
        mismatches = [
            x for x in spec_report.images
            if x.detected_format and x.ext and x.detected_format != x.ext
        ]
        for item in unknown_dims[:50]:
            reason = f" ({item.note})" if item.note else ""
            add("warning", "asset-spec", f"{item.rel_path}: 无法读取图片尺寸{reason}")
        if len(unknown_dims) > 50:
            add("warning", "asset-spec", f"还有 {len(unknown_dims) - 50} 张图片无法读取尺寸")
        for item in mismatches[:50]:
            add(
                "warning",
                "asset-spec",
                f"{item.rel_path}: 扩展名 .{item.ext} 与实际格式 {item.detected_format} 不一致",
            )
        if len(mismatches) > 50:
            add("warning", "asset-spec", f"还有 {len(mismatches) - 50} 个扩展名/格式不一致问题")
    except Exception as exc:  # noqa: BLE001
        add("error", "asset-spec", f"素材规格检查失败: {exc}")

    if run_toolchain_checks:
        log("运行关键工具链测试...")
        for label, argv, timeout_sec in _daily_toolchain_commands(project_root):
            log(f"运行：{label}...")
            result = _run_command(argv, project_root, timeout_sec)
            if result.returncode != 0:
                log_note = _save_failed_command_log(project_root, label, argv, result)
                add(
                    "error",
                    "toolchain",
                    f"{label} 失败（exit {result.returncode}）: "
                    + _summarize_command_output(result)
                    + log_note,
                )
            else:
                passed_checks.append(label)

    ok = not any(x.severity in {"error", "blocker"} for x in issues)
    return DailyCheckReport(project_root=project_root, ok=ok, issues=issues, passed_checks=passed_checks)


def format_daily_check_report(report: DailyCheckReport) -> str:
    status = "通过" if report.ok else "未通过"
    lines = [
        f"每日检查: {status}",
        f"工程: {report.project_root}",
        f"error={report.error_count}, warning={report.warning_count}, blocker={report.blocker_count}",
        "",
    ]
    if report.passed_checks:
        lines.append("通过项: " + "；".join(report.passed_checks))
        lines.append("")
    if not report.issues:
        lines.append("无问题。")
        return "\n".join(lines)
    for issue in report.issues:
        lines.append(f"[{issue.severity}] {issue.area}: {issue.message}")
    return "\n".join(lines)


def _daily_toolchain_commands(project_root: Path) -> list[tuple[str, list[str], int]]:
    py = _python_executable(project_root)
    commands: list[tuple[str, list[str], int]] = [
        (
            "Python 编辑器/Narrative smoke",
            [
                py,
                "-m",
                "unittest",
                "tools.editor.tests.test_narrative_state_editor",
                "tools.dialogue_graph_editor.tests.test_owner_context_nodes",
                "tools.editor.tests.test_condition_editor_structured",
            ],
            120,
        ),
        (
            "生产工作台 smoke",
            [
                py,
                "-m",
                "unittest",
                "tools.editor.tests.test_production_workbench_asset_audit",
                "tools.editor.tests.test_production_workbench_asset_style_sampler",
                "tools.editor.tests.test_production_workbench_asset_candidates",
                "tools.editor.tests.test_production_workbench_asset_output_validation",
                "tools.editor.tests.test_production_workbench_asset_postprocess",
                "tools.editor.tests.test_production_workbench_asset_tasks",
                "tools.editor.tests.test_production_workbench_animation_sheet",
                "tools.editor.tests.test_production_workbench_codex_asset_runner",
                "tools.editor.tests.test_production_workbench_image_tools",
                "tools.editor.tests.test_production_workbench_runtime_command",
                "tools.editor.tests.test_production_workbench_runtime_debug",
                "tools.editor.tests.test_production_workbench_report_log",
                "tools.editor.tests.test_production_workbench_story_units",
                "tools.editor.tests.test_production_workbench_story_acceptance",
                "tools.editor.tests.test_production_workbench_story_acceptance_run",
                "tools.editor.tests.test_production_workbench_graph_diagnostics",
                "tools.editor.tests.test_production_workbench_daily_check",
                "tools.editor.tests.test_production_workbench_story_unit_gui",
            ],
            120,
        ),
        (
            "Python import smoke",
            [py, "-m", "tools.editor.tests._smoke_imports"],
            120,
        ),
    ]
    npm = shutil.which("npm")
    if npm and (project_root / "package.json").is_file():
        commands.append(
            (
                "TS Narrative/runtime save smoke tests",
                [
                    npm,
                    "test",
                    "--",
                    "src/core/SaveManager.test.ts",
                    "src/core/devRuntimeCommands.test.ts",
                    "src/core/NarrativeStateManager.test.ts",
                    "src/systems/NarrativeRingboyFlow.test.ts",
                    "src/systems/NarrativeConditionContext.test.ts",
                ],
                180,
            )
        )
    return commands


def _python_executable(project_root: Path) -> str:
    # Single source of truth for the project interpreter; falls back to the
    # running interpreter.
    try:
        from tools.dev.paths import project_python

        return str(project_python())
    except Exception:
        local = project_root / ".tools" / "venv" / "bin" / "python"
        if local.is_file():
            return str(local)
        return sys.executable


def _run_command(
    argv: list[str],
    cwd: Path,
    timeout_sec: int,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            argv,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(argv, 1, "", str(exc))


def _summarize_command_output(result: subprocess.CompletedProcess[str]) -> str:
    text = "\n".join(part for part in (result.stderr, result.stdout) if part)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "无输出"
    tail = lines[-8:]
    return " | ".join(tail)


def _save_failed_command_log(
    project_root: Path,
    label: str,
    argv: list[str],
    result: subprocess.CompletedProcess[str],
) -> str:
    text = _format_command_log(label, argv, result)
    try:
        path = save_workbench_report(project_root, f"toolchain-failed-{label}", text)
    except Exception as exc:  # noqa: BLE001
        return f" | 完整日志保存失败: {exc}"
    return f" | 完整日志: {path}"


def _format_command_log(label: str, argv: list[str], result: subprocess.CompletedProcess[str]) -> str:
    return "\n".join([
        f"命令: {label}",
        "argv: " + " ".join(str(part) for part in argv),
        f"exit: {result.returncode}",
        "",
        "stderr:",
        result.stderr or "",
        "",
        "stdout:",
        result.stdout or "",
    ]).rstrip()
