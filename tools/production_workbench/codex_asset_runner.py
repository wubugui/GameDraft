"""Run GPT asset tasks through the local Codex CLI and persist run evidence."""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from tools.editor.shared.project_paths import ProjectPaths

from .asset_output_validation import (
    format_asset_output_validation_report,
    validate_asset_outputs,
)
from .asset_postprocess import (
    AssetPostprocessOptions,
    AssetPostprocessReport,
    format_asset_postprocess_report,
    postprocess_saved_paths,
)
from .asset_tasks import AssetTask, asset_task_to_dict, build_asset_task_prompt, save_asset_task
from .codex_probe import find_codex_executable


SubprocessRunner = Callable[
    [list[str], str, Path, int],
    subprocess.CompletedProcess[str],
]


@dataclass(frozen=True)
class CodexEventSummary:
    saved_paths: list[str] = field(default_factory=list)
    token_usage: list[dict[str, Any]] = field(default_factory=list)
    models: list[str] = field(default_factory=list)
    event_count: int = 0


@dataclass(frozen=True)
class CodexAssetRunResult:
    ok: bool
    task_id: str
    started_at: str
    ended_at: str
    exit_code: int
    command: list[str]
    run_dir: Path
    prompt_path: Path
    stdout_path: Path
    stderr_path: Path
    events_path: Path
    summary_path: Path
    last_message_path: Path
    event_summary: CodexEventSummary
    postprocess_report: AssetPostprocessReport | None = None
    message: str = ""


def asset_task_runs_root(project_root: Path) -> Path:
    return ProjectPaths(project_root).editor_data_root / "production_workbench" / "asset_task_runs"


def run_codex_asset_task(
    project_root: Path,
    task: AssetTask,
    *,
    timeout_sec: int = 1800,
    runner: SubprocessRunner | None = None,
    executable: str | None = None,
    postprocess_options: AssetPostprocessOptions | None = None,
    progress: Callable[[str], None] | None = None,
) -> CodexAssetRunResult:
    project_root = project_root.resolve()
    saved_task = save_asset_task(project_root, task)
    started_at = _now_stamp()
    run_dir = asset_task_runs_root(project_root) / f"{started_at}-{_safe_slug(saved_task.task_id)}"
    run_dir.mkdir(parents=True, exist_ok=True)

    prompt = build_codex_execution_prompt(saved_task)
    prompt_path = run_dir / "prompt.md"
    stdout_path = run_dir / "stdout.jsonl"
    stderr_path = run_dir / "stderr.txt"
    events_path = run_dir / "events.normalized.jsonl"
    summary_path = run_dir / "summary.json"
    last_message_path = run_dir / "last-message.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    _progress(progress, f"已保存任务和 prompt: {prompt_path}")

    exe = executable or find_codex_executable()
    if not exe:
        ended_at = _now_stamp()
        result = _result(
            ok=False,
            task_id=saved_task.task_id,
            started_at=started_at,
            ended_at=ended_at,
            exit_code=1,
            command=[],
            run_dir=run_dir,
            prompt_path=prompt_path,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            events_path=events_path,
            summary_path=summary_path,
            last_message_path=last_message_path,
            event_summary=CodexEventSummary(),
            postprocess_report=None,
            message="未找到 Codex CLI，无法执行素材任务。",
        )
        _write_run_files(
            result,
            stdout="",
            stderr=result.message,
            task=saved_task,
            project_root=project_root,
        )
        _progress(progress, result.message)
        return result

    command = build_codex_asset_command(exe, project_root, last_message_path)
    runner = runner or _run_subprocess
    _progress(progress, "开始调用 Codex CLI。")
    completed = runner(command, prompt, project_root, timeout_sec)
    ended_at = _now_stamp()
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    stdout_path.write_text(stdout, encoding="utf-8", errors="replace")
    stderr_path.write_text(stderr, encoding="utf-8", errors="replace")
    _progress(progress, f"Codex 进程结束: exit {completed.returncode}")
    event_summary = normalize_codex_events(stdout, events_path)
    _progress(
        progress,
        f"事件解析完成: event={event_summary.event_count}, savedPath={len(event_summary.saved_paths)}",
    )
    ok = completed.returncode == 0
    message = "Codex 素材任务执行完成。" if ok else f"Codex 素材任务失败，exit {completed.returncode}。"
    postprocess_report = _maybe_postprocess_outputs(
        project_root,
        event_summary.saved_paths,
        postprocess_options,
        run_dir=run_dir,
    )
    if postprocess_options is not None:
        if postprocess_report is None:
            _progress(progress, "自动后处理未执行。")
        else:
            _progress(
                progress,
                f"自动后处理完成: ok={postprocess_report.ok_count}, failed={postprocess_report.failed_count}",
            )
    result = _result(
        ok=ok,
        task_id=saved_task.task_id,
        started_at=started_at,
        ended_at=ended_at,
        exit_code=int(completed.returncode),
        command=command,
        run_dir=run_dir,
        prompt_path=prompt_path,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        events_path=events_path,
        summary_path=summary_path,
        last_message_path=last_message_path,
        event_summary=event_summary,
        postprocess_report=postprocess_report,
        message=message,
    )
    _write_run_summary(result, task=saved_task, project_root=project_root)
    _progress(progress, f"已写入 summary: {summary_path}")
    return result


def build_codex_execution_prompt(task: AssetTask) -> str:
    return (
        build_asset_task_prompt(task)
        + "\n\n执行边界:\n"
        + "- 只创建或修改本素材任务明确要求的图片/素材文件。\n"
        + "- 不要修改剧情 JSON、代码、配置或无关资源，除非任务文本明确要求。\n"
        + "- 如果需要生成多版候选，请放在输出目录的子目录中，并在最终报告说明推荐哪一版。\n"
        + "- 如果生成后需要基础后处理，优先使用工程内已有图片工具约定：转格式、缩放、裁剪、调色。\n"
        + "- 最终回复必须列出：输出文件路径、尺寸、透明情况、是否需要人工复查。\n"
    )


def build_codex_asset_command(
    executable: str,
    project_root: Path,
    last_message_path: Path,
) -> list[str]:
    return [
        executable,
        "exec",
        "--json",
        "--cd",
        str(project_root),
        "--sandbox",
        "workspace-write",
        "--enable",
        "image_generation",
        "-o",
        str(last_message_path),
        "-",
    ]


def normalize_codex_events(stdout: str, events_path: Path) -> CodexEventSummary:
    saved_paths: list[str] = []
    token_usage: list[dict[str, Any]] = []
    models: list[str] = []
    count = 0
    events_path.parent.mkdir(parents=True, exist_ok=True)
    with events_path.open("w", encoding="utf-8") as f:
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            count += 1
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
            _collect_event_fields(event, saved_paths, token_usage, models)
    return CodexEventSummary(
        saved_paths=_unique(saved_paths),
        token_usage=token_usage,
        models=_unique(models),
        event_count=count,
    )


def format_codex_asset_run_result(result: CodexAssetRunResult) -> str:
    lines = [
        "Codex 素材任务: " + ("通过" if result.ok else "失败"),
        f"taskId: {result.task_id}",
        f"exit: {result.exit_code}",
        f"runDir: {result.run_dir}",
        f"prompt: {result.prompt_path}",
        f"lastMessage: {result.last_message_path}",
        f"stdout: {result.stdout_path}",
        f"stderr: {result.stderr_path}",
        f"events: {result.events_path}",
        "",
        result.message,
    ]
    if result.event_summary.models:
        lines.append("model: " + ", ".join(result.event_summary.models))
    if result.event_summary.saved_paths:
        lines.append("savedPath:")
        lines.extend(f"- {x}" for x in result.event_summary.saved_paths)
    if result.event_summary.token_usage:
        lines.append("tokenUsage:")
        for usage in result.event_summary.token_usage[-3:]:
            lines.append("- " + _format_token_usage(usage))
    postprocess_path = result.run_dir / "postprocess.txt"
    if postprocess_path.is_file():
        try:
            lines.extend(["", postprocess_path.read_text(encoding="utf-8").strip()])
        except OSError:
            pass
    validation_path = result.run_dir / "output-validation.txt"
    if validation_path.is_file():
        try:
            lines.extend(["", validation_path.read_text(encoding="utf-8").strip()])
        except OSError:
            pass
    return "\n".join(lines)


def _format_token_usage(usage: dict[str, Any]) -> str:
    labels = [
        ("inputTokens", "输入"),
        ("outputTokens", "输出"),
        ("totalTokens", "总计"),
        ("cachedInputTokens", "缓存输入"),
        ("reasoningTokens", "推理"),
    ]
    parts: list[str] = []
    used: set[str] = set()
    for key, label in labels:
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            parts.append(f"{label} {value:g}")
            used.add(key)
    for key in sorted(usage):
        if key in used:
            continue
        value = usage.get(key)
        if isinstance(value, (int, float, str, bool)):
            parts.append(f"{key}={value}")
    return "，".join(parts) if parts else "已收到 token usage 事件"


def _run_subprocess(
    command: list[str],
    prompt: str,
    cwd: Path,
    timeout_sec: int,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            input=prompt,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(command, 124, exc.stdout or "", exc.stderr or "Codex 执行超时")
    except OSError as exc:
        return subprocess.CompletedProcess(command, 1, "", str(exc))


def _collect_event_fields(
    value: Any,
    saved_paths: list[str],
    token_usage: list[dict[str, Any]],
    models: list[str],
) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            key_l = str(key).lower()
            if key_l == "savedpath" and isinstance(item, str):
                saved_paths.append(item)
            elif key_l in {"model", "modelslug"} and isinstance(item, str):
                models.append(item)
            elif key_l in {"tokenusage", "token_usage"} and isinstance(item, dict):
                token_usage.append(item)
            _collect_event_fields(item, saved_paths, token_usage, models)
    elif isinstance(value, list):
        for item in value:
            _collect_event_fields(item, saved_paths, token_usage, models)


def _result(**kwargs: Any) -> CodexAssetRunResult:
    return CodexAssetRunResult(**kwargs)


def _write_run_files(
    result: CodexAssetRunResult,
    *,
    stdout: str,
    stderr: str,
    task: AssetTask,
    project_root: Path,
) -> None:
    result.stdout_path.write_text(stdout, encoding="utf-8", errors="replace")
    result.stderr_path.write_text(stderr, encoding="utf-8", errors="replace")
    result.events_path.write_text("", encoding="utf-8")
    _write_run_summary(result, task=task, project_root=project_root)


def _write_run_summary(result: CodexAssetRunResult, *, task: AssetTask, project_root: Path) -> None:
    validation = validate_asset_outputs(
        project_root,
        task,
        result.event_summary.saved_paths,
        run_dir=result.run_dir,
    )
    payload = {
        "ok": result.ok,
        "taskId": result.task_id,
        "task": asset_task_to_dict(task),
        "startedAt": result.started_at,
        "endedAt": result.ended_at,
        "exitCode": result.exit_code,
        "command": result.command,
        "runDir": str(result.run_dir),
        "promptPath": str(result.prompt_path),
        "stdoutPath": str(result.stdout_path),
        "stderrPath": str(result.stderr_path),
        "eventsPath": str(result.events_path),
        "lastMessagePath": str(result.last_message_path),
        "message": result.message,
        "eventSummary": {
            "savedPaths": result.event_summary.saved_paths,
            "tokenUsage": result.event_summary.token_usage,
            "models": result.event_summary.models,
            "eventCount": result.event_summary.event_count,
        },
        "outputValidation": {
            "ok": validation.ok,
            "errorCount": validation.error_count,
            "warningCount": validation.warning_count,
        },
        "postprocess": _postprocess_summary(result.postprocess_report),
    }
    result.summary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (result.run_dir / "output-validation.txt").write_text(
        format_asset_output_validation_report(validation),
        encoding="utf-8",
    )
    if result.postprocess_report is not None:
        (result.run_dir / "postprocess.txt").write_text(
            format_asset_postprocess_report(result.postprocess_report),
            encoding="utf-8",
        )


def _maybe_postprocess_outputs(
    project_root: Path,
    saved_paths: list[str],
    options: AssetPostprocessOptions | None,
    *,
    run_dir: Path,
) -> AssetPostprocessReport | None:
    if options is None:
        return None
    if not saved_paths:
        return AssetPostprocessReport(project_root=project_root.resolve(), total=0)
    return postprocess_saved_paths(
        project_root,
        saved_paths,
        options,
        run_dir=run_dir,
        overwrite=False,
    )


def _postprocess_summary(report: AssetPostprocessReport | None) -> dict[str, Any] | None:
    if report is None:
        return None
    return {
        "total": report.total,
        "processed": len(report.processed),
        "okCount": report.ok_count,
        "failedCount": report.failed_count,
        "skipped": len(report.skipped),
        "outputs": [
            str(item.output_path) for item in report.processed
            if item.ok and item.output_path is not None
        ],
    }


def _now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z._-]+", "-", value.strip()).strip("-")
    return slug[:80] or "asset-task"


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            out.append(value)
            seen.add(value)
    return out


def _progress(callback: Callable[[str], None] | None, message: str) -> None:
    if callback is None:
        return
    try:
        callback(message)
    except Exception:
        pass
