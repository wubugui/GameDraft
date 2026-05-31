"""Read and summarize runtime debug snapshots published by the Vite dev server."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.editor.shared.project_paths import ProjectPaths


@dataclass(frozen=True)
class RuntimeDebugSnapshotReport:
    path: Path
    ok: bool
    captured_at: str = ""
    source: str = ""
    reason: str = ""
    current_scene_id: str = ""
    game_state: str = ""
    active_states: dict[str, str] = field(default_factory=dict)
    quest_state: dict[str, Any] = field(default_factory=dict)
    scenario_state: dict[str, Any] = field(default_factory=dict)
    flags: dict[str, Any] = field(default_factory=dict)
    trace: list[dict[str, Any]] = field(default_factory=list)
    transitions: list[dict[str, Any]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    runtime_command_results: list[dict[str, Any]] = field(default_factory=list)
    narrative_eval_summary: str = ""
    raw: dict[str, Any] = field(default_factory=dict)
    message: str = ""


def runtime_debug_snapshot_path(project_root: Path) -> Path:
    return ProjectPaths(project_root).editor_data_root / "production_workbench" / "runtime_debug_snapshot.json"


def load_runtime_debug_snapshot(project_root: Path) -> RuntimeDebugSnapshotReport:
    path = runtime_debug_snapshot_path(project_root)
    if not path.is_file():
        return RuntimeDebugSnapshotReport(
            path=path,
            ok=False,
            message=(
                "还没有运行时快照。请先用 npm run dev 启动游戏并打开页面；"
                "运行中浏览器会自动写入 runtime_debug_snapshot.json。"
            ),
        )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return RuntimeDebugSnapshotReport(path=path, ok=False, message=f"快照读取失败: {exc}")
    if not isinstance(raw, dict):
        return RuntimeDebugSnapshotReport(path=path, ok=False, message="快照文件不是 JSON object")
    snapshot = raw.get("snapshot") if isinstance(raw.get("snapshot"), dict) else raw
    if not isinstance(snapshot, dict):
        return RuntimeDebugSnapshotReport(path=path, ok=False, raw=raw, message="快照缺少 snapshot object")

    narrative_state = snapshot.get("narrativeState") if isinstance(snapshot.get("narrativeState"), dict) else {}
    narrative_eval = snapshot.get("narrativeEval") if isinstance(snapshot.get("narrativeEval"), dict) else {}
    runtime_commands = snapshot.get("runtimeCommands") if isinstance(snapshot.get("runtimeCommands"), dict) else {}
    return RuntimeDebugSnapshotReport(
        path=path,
        ok=bool(raw.get("ok", True)),
        captured_at=str(raw.get("capturedAt") or snapshot.get("capturedAt") or ""),
        source=str(raw.get("source") or "runtime"),
        reason=str(snapshot.get("reason") or raw.get("reason") or ""),
        current_scene_id=str(snapshot.get("currentSceneId") or ""),
        game_state=str(snapshot.get("gameState") or ""),
        active_states=_string_dict(narrative_state.get("activeStates")),
        quest_state=_dict(snapshot.get("questState")),
        scenario_state=_dict(snapshot.get("scenarioState")),
        flags=_dict(snapshot.get("flags")),
        trace=_dict_list(narrative_state.get("recentTrace")),
        transitions=_dict_list(narrative_state.get("recentTransitions")),
        issues=_dict_list(narrative_state.get("recentIssues")),
        runtime_command_results=_dict_list(runtime_commands.get("lastResults")),
        narrative_eval_summary=str(narrative_eval.get("summaryText") or ""),
        raw=raw,
        message=str(raw.get("reason") or ""),
    )


def format_runtime_debug_report(report: RuntimeDebugSnapshotReport) -> str:
    if not report.ok:
        return "\n".join([
            "运行时 Debug 快照: 不可用",
            f"路径: {report.path}",
            report.message or "未知原因",
        ])

    age = _age_text(report.captured_at)
    lines = [
        "运行时 Debug 快照: 可用",
        f"路径: {report.path}",
        f"来源: {report.source}",
        f"时间: {report.captured_at or '(未知)'}{f'（{age}）' if age else ''}",
        f"触发: {report.reason or '(未知)'}",
        f"场景: {report.current_scene_id or '(未知)'}",
        f"GameState: {report.game_state or '(未知)'}",
        "",
        "Narrative active states:",
    ]
    if report.active_states:
        lines.extend(f"- {graph}: {state}" for graph, state in sorted(report.active_states.items()))
    else:
        lines.append("- (无)")
    lines.extend([
        "",
        f"Flags: {len(report.flags)}",
        f"Quest state: {len(report.quest_state)}",
        f"Scenario buckets: {len(report.scenario_state)}",
        "",
        "Runtime trace:",
    ])
    if report.trace:
        lines.extend(f"- {_format_trace_event(event)}" for event in report.trace[-20:])
    else:
        lines.append("- (无)")
    if report.issues:
        lines.extend(["", "Runtime issues:"])
        lines.extend(f"- {_format_issue(issue)}" for issue in report.issues[-12:])
    if report.transitions:
        lines.extend(["", "Recent transitions:"])
        lines.extend(f"- {_format_transition(item)}" for item in report.transitions[-12:])
    if report.runtime_command_results:
        lines.extend(["", "Runtime command results:"])
        lines.extend(f"- {_format_runtime_command_result(item)}" for item in report.runtime_command_results[-12:])
    if report.narrative_eval_summary.strip():
        lines.extend(["", "Dialogue / condition summary:", report.narrative_eval_summary.strip()])
    return "\n".join(lines)


def clear_runtime_debug_snapshot(project_root: Path) -> bool:
    path = runtime_debug_snapshot_path(project_root)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string_dict(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items()}


def _dict_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [x for x in value if isinstance(x, dict)]


def _format_trace_event(event: dict[str, Any]) -> str:
    seq = f"#{event.get('seq')} " if event.get("seq") is not None else ""
    typ = str(event.get("type") or "trace")
    graph = f" {event.get('graphId')}" if event.get("graphId") else ""
    transition = f".{event.get('transitionId')}" if event.get("transitionId") else ""
    from_to = f" {event.get('from', '?')} -> {event.get('to', '?')}" if event.get("from") or event.get("to") else ""
    trigger = f" [{event.get('triggerKey')}]" if event.get("triggerKey") else ""
    message = f" - {event.get('message')}" if event.get("message") else ""
    return f"{seq}{typ}{graph}{transition}{from_to}{trigger}{message}"


def _format_transition(item: dict[str, Any]) -> str:
    graph = str(item.get("graphId") or "?")
    transition = str(item.get("transitionId") or "?")
    from_state = str(item.get("from") or "?")
    to_state = str(item.get("to") or "?")
    trigger = str(item.get("triggerKey") or "")
    return f"{graph}: {from_state} -> {to_state} via {transition}{f' ({trigger})' if trigger else ''}"


def _format_issue(issue: dict[str, Any]) -> str:
    severity = str(issue.get("severity") or "issue")
    code = str(issue.get("code") or "unknown")
    message = str(issue.get("message") or "")
    return f"{severity}: {code}{f' - {message}' if message else ''}"


def _format_runtime_command_result(item: dict[str, Any]) -> str:
    status = "OK" if item.get("ok") else "FAIL"
    typ = str(item.get("type") or "?")
    cmd_id = str(item.get("id") or "?")
    message = str(item.get("message") or "")
    return f"{status}: {typ} ({cmd_id}){f' - {message}' if message else ''}"


def _age_text(captured_at: str) -> str:
    if not captured_at:
        return ""
    try:
        dt = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
    except ValueError:
        return ""
    now = datetime.now(timezone.utc).astimezone()
    seconds = max(0, int((now - dt.astimezone()).total_seconds()))
    if seconds < 60:
        return f"{seconds}s ago"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m ago"
    return f"{minutes // 60}h ago"
