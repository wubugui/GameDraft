"""Runtime command queue used by the production workbench in Vite dev mode."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from tools.editor.shared.project_paths import ProjectPaths


ALLOWED_RUNTIME_COMMANDS = {
    "captureSnapshot",
    "clearNarrativeTrace",
    "emitNarrativeSignal",
    "debugSetNarrativeState",
    "setFlag",
    "debugSetQuestStatus",
    "debugSetScenarioPhase",
    "debugSetScenarioLineLifecycle",
    "debugResetScenarioProgress",
    "debugStartDialogueGraph",
    "debugAdvanceDialogue",
    "debugChooseDialogueOption",
    "debugSwitchScene",
    "debugTriggerHotspot",
    "debugInteractNpc",
    "debugWait",
    "debugSetPlayerPosition",
    "debugMovePlayerTo",
    "debugClick",
    "debugDrag",
    "debugSaveGame",
    "debugLoadGame",
    "debugReloadScene",
}


@dataclass(frozen=True)
class RuntimeCommandQueueReport:
    path: Path
    ok: bool
    commands: list[dict[str, Any]] = field(default_factory=list)
    message: str = ""


def runtime_command_queue_path(project_root: Path) -> Path:
    return ProjectPaths(project_root).editor_data_root / "production_workbench" / "runtime_command_queue.json"


def load_runtime_command_queue(project_root: Path) -> RuntimeCommandQueueReport:
    path = runtime_command_queue_path(project_root)
    if not path.is_file():
        return RuntimeCommandQueueReport(path=path, ok=True, message="当前没有待执行 runtime 命令。")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return RuntimeCommandQueueReport(path=path, ok=False, message=f"runtime command queue 读取失败: {exc}")
    if not isinstance(raw, dict):
        return RuntimeCommandQueueReport(path=path, ok=False, message="runtime command queue 不是 JSON object")
    commands = raw.get("commands")
    if not isinstance(commands, list):
        return RuntimeCommandQueueReport(path=path, ok=False, message="runtime command queue 缺少 commands array")
    return RuntimeCommandQueueReport(
        path=path,
        ok=True,
        commands=[x for x in commands if isinstance(x, dict)],
        message=str(raw.get("updatedAt") or ""),
    )


def enqueue_runtime_command(
    project_root: Path,
    command_type: str,
    *,
    reason: str = "",
    payload: dict[str, Any] | None = None,
) -> RuntimeCommandQueueReport:
    command_type = command_type.strip()
    if command_type not in ALLOWED_RUNTIME_COMMANDS:
        raise ValueError(f"不支持的 runtime 命令: {command_type}")
    report = load_runtime_command_queue(project_root)
    commands = list(report.commands) if report.ok else []
    commands.append(new_runtime_command(command_type, reason=reason, payload=payload))
    return save_runtime_command_queue(project_root, commands)


def enqueue_runtime_commands(
    project_root: Path,
    commands_to_add: list[dict[str, Any]],
) -> RuntimeCommandQueueReport:
    report = load_runtime_command_queue(project_root)
    commands = list(report.commands) if report.ok else []
    for command in commands_to_add:
        commands.append(normalize_outgoing_runtime_command(command))
    return save_runtime_command_queue(project_root, commands)


def new_runtime_command(
    command_type: str,
    *,
    reason: str = "",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    command_type = command_type.strip()
    if command_type not in ALLOWED_RUNTIME_COMMANDS:
        raise ValueError(f"不支持的 runtime 命令: {command_type}")
    command: dict[str, Any] = {
        "id": f"pw-{uuid4().hex[:12]}",
        "type": command_type,
        "createdAt": _now(),
        "source": "production-workbench",
    }
    if reason:
        command["reason"] = reason
    if payload:
        command.update(payload)
    return command


def normalize_outgoing_runtime_command(command: dict[str, Any]) -> dict[str, Any]:
    command_type = str(command.get("type") or "").strip()
    if command_type not in ALLOWED_RUNTIME_COMMANDS:
        raise ValueError(f"不支持的 runtime 命令: {command_type}")
    normalized = dict(command)
    normalized["type"] = command_type
    normalized.setdefault("id", f"pw-{uuid4().hex[:12]}")
    normalized.setdefault("createdAt", _now())
    normalized.setdefault("source", "production-workbench")
    return normalized


def save_runtime_command_queue(project_root: Path, commands: list[dict[str, Any]]) -> RuntimeCommandQueueReport:
    path = runtime_command_queue_path(project_root)
    cleaned = []
    for command in commands[:50]:
        if not isinstance(command, dict):
            continue
        command_type = str(command.get("type") or "").strip()
        if command_type not in ALLOWED_RUNTIME_COMMANDS:
            continue
        cleaned.append({**command, "type": command_type})
    payload = {
        "ok": True,
        "updatedAt": _now(),
        "source": "production-workbench",
        "commands": cleaned,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return RuntimeCommandQueueReport(path=path, ok=True, commands=cleaned, message=f"已写入 {len(cleaned)} 条命令。")


def clear_runtime_command_queue(project_root: Path) -> bool:
    path = runtime_command_queue_path(project_root)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def format_runtime_command_queue_report(report: RuntimeCommandQueueReport) -> str:
    if not report.ok:
        return "\n".join(["Runtime 命令队列: 不可用", f"路径: {report.path}", report.message])
    lines = [
        "Runtime 命令队列",
        f"路径: {report.path}",
        f"待执行: {len(report.commands)}",
    ]
    if report.message:
        lines.append(f"更新时间: {report.message}")
    if report.commands:
        lines.append("")
        for command in report.commands:
            lines.append(
                "- "
                + str(command.get("type") or "?")
                + f"  id={command.get('id') or '?'}"
                + (f"  reason={command.get('reason')}" if command.get("reason") else "")
            )
    else:
        lines.append("当前没有待执行命令。")
    return "\n".join(lines)


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
