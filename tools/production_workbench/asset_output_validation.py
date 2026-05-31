"""Validate Codex/GPT asset outputs against their task spec."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .animation_sheet import SheetGridOptions, inspect_animation_sheet
from .asset_tasks import AssetTask, asset_task_from_dict
from .image_tools import inspect_image


@dataclass(frozen=True)
class AssetOutputIssue:
    severity: str
    code: str
    message: str
    path: str = ""


@dataclass(frozen=True)
class AssetOutputItem:
    saved_path: str
    resolved_path: Path
    exists: bool
    width: int | None = None
    height: int | None = None
    has_alpha: bool | None = None
    image_format: str = ""
    sheet_columns: int | None = None
    sheet_rows: int | None = None
    sheet_frame_width: int | None = None
    sheet_frame_height: int | None = None


@dataclass(frozen=True)
class AssetOutputValidationReport:
    task_id: str
    ok: bool
    items: list[AssetOutputItem] = field(default_factory=list)
    issues: list[AssetOutputIssue] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for issue in self.issues if issue.severity == "warning")


def validate_asset_outputs(
    project_root: Path,
    task: AssetTask,
    saved_paths: list[str],
    *,
    run_dir: Path | None = None,
) -> AssetOutputValidationReport:
    project_root = project_root.resolve()
    task = task.normalized()
    issues: list[AssetOutputIssue] = []
    items: list[AssetOutputItem] = []

    def add(severity: str, code: str, message: str, path: str = "") -> None:
        issues.append(AssetOutputIssue(severity=severity, code=code, message=message, path=path))

    clean_paths = _unique([str(path).strip() for path in saved_paths if str(path).strip()])
    if not clean_paths:
        add("error", "asset.output.noSavedPath", "Codex 执行结果没有 savedPath，无法自动验收输出。")

    for saved_path in clean_paths:
        resolved = _resolve_saved_path(project_root, run_dir, saved_path)
        if not resolved.is_file():
            items.append(AssetOutputItem(saved_path=saved_path, resolved_path=resolved, exists=False))
            add("error", "asset.output.missing", f"输出文件不存在: {resolved}", saved_path)
            continue
        try:
            info = inspect_image(resolved)
        except Exception as exc:  # noqa: BLE001
            items.append(AssetOutputItem(saved_path=saved_path, resolved_path=resolved, exists=True))
            add("error", "asset.output.notImage", f"输出不是可识别图片: {exc}", saved_path)
            continue

        item = AssetOutputItem(
            saved_path=saved_path,
            resolved_path=resolved,
            exists=True,
            width=info.width,
            height=info.height,
            has_alpha=info.has_alpha,
            image_format=info.detected_format,
        )

        if task.width and task.height and (info.width != task.width or info.height != task.height):
            add(
                "error",
                "asset.output.sizeMismatch",
                f"尺寸不符合任务: 实际 {info.width}x{info.height}，期望 {task.width}x{task.height}",
                saved_path,
            )
        if task.transparent is not None and info.has_alpha != task.transparent:
            add(
                "error",
                "asset.output.alphaMismatch",
                f"透明通道不符合任务: 实际 {'有' if info.has_alpha else '无'}，期望 {'有' if task.transparent else '无'}",
                saved_path,
            )

        if _needs_sheet_check(task):
            item = _with_sheet_check(project_root, task, item, add)
        items.append(item)

    return AssetOutputValidationReport(
        task_id=task.task_id,
        ok=not any(issue.severity == "error" for issue in issues),
        items=items,
        issues=issues,
    )


def validate_codex_run_summary(project_root: Path, summary_path: Path) -> AssetOutputValidationReport:
    payload = json.loads(summary_path.read_text(encoding="utf-8"))
    task_payload = payload.get("task")
    if not isinstance(task_payload, dict):
        raise ValueError(f"run summary 缺少 task 快照: {summary_path}")
    event_summary = payload.get("eventSummary") if isinstance(payload.get("eventSummary"), dict) else {}
    saved_paths = event_summary.get("savedPaths") if isinstance(event_summary.get("savedPaths"), list) else []
    return validate_asset_outputs(
        project_root,
        asset_task_from_dict(task_payload),
        [str(x) for x in saved_paths],
        run_dir=summary_path.parent,
    )


def format_asset_output_validation_report(report: AssetOutputValidationReport) -> str:
    lines = [
        "素材输出验收: " + ("通过" if report.ok else "未通过"),
        f"taskId: {report.task_id or '(无)'}",
        f"输出: {len(report.items)}，error={report.error_count}, warning={report.warning_count}",
        "",
    ]
    if report.items:
        lines.append("输出文件:")
        for item in report.items:
            status = "存在" if item.exists else "缺失"
            size = f"{item.width}x{item.height}" if item.width and item.height else "未知尺寸"
            alpha = "透明" if item.has_alpha is True else ("不透明" if item.has_alpha is False else "未知透明")
            sheet = ""
            if item.sheet_columns and item.sheet_rows:
                sheet = (
                    f"，sheet={item.sheet_columns}x{item.sheet_rows} "
                    f"frame={item.sheet_frame_width}x{item.sheet_frame_height}"
                )
            lines.append(f"- [{status}] {item.saved_path} | {size} | {alpha}{sheet}")
        lines.append("")
    if report.issues:
        lines.append("问题:")
        for issue in report.issues:
            path = f" [{issue.path}]" if issue.path else ""
            lines.append(f"- {issue.severity}{path} {issue.code}: {issue.message}")
    else:
        lines.append("无问题。")
    return "\n".join(lines)


def _with_sheet_check(
    project_root: Path,
    task: AssetTask,
    item: AssetOutputItem,
    add_issue: Any,
) -> AssetOutputItem:
    try:
        report = inspect_animation_sheet(
            project_root,
            SheetGridOptions(
                source_path=str(item.resolved_path),
                frame_count=task.frame_count,
            ),
        )
    except Exception as exc:  # noqa: BLE001
        add_issue(
            "error",
            "asset.output.sheetInvalid",
            f"无法按任务帧数解释动画 sheet: {exc}",
            item.saved_path,
        )
        return item
    for warning in report.warnings:
        add_issue("warning", "asset.output.sheetWarning", warning, item.saved_path)
    return AssetOutputItem(
        saved_path=item.saved_path,
        resolved_path=item.resolved_path,
        exists=item.exists,
        width=item.width,
        height=item.height,
        has_alpha=item.has_alpha,
        image_format=item.image_format,
        sheet_columns=report.columns,
        sheet_rows=report.rows,
        sheet_frame_width=report.frame_width,
        sheet_frame_height=report.frame_height,
    )


def _needs_sheet_check(task: AssetTask) -> bool:
    return task.operation == "animation_sheet" or task.category == "animation" or bool(task.frame_count)


def _resolve_saved_path(project_root: Path, run_dir: Path | None, saved_path: str) -> Path:
    raw = saved_path.strip().strip('"')
    path = Path(raw)
    if path.is_absolute():
        return path.resolve()
    project_candidate = (project_root / raw).resolve()
    if project_candidate.exists():
        return project_candidate
    if run_dir is not None:
        run_candidate = (run_dir / raw).resolve()
        if run_candidate.exists():
            return run_candidate
    return project_candidate


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            out.append(value)
            seen.add(value)
    return out
