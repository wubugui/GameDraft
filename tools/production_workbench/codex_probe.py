"""Capability probing for local Codex CLI integration."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class CodexProbeResult:
    executable: str = ""
    ok: bool = False
    image_feature_enabled: bool = False
    app_server_available: bool = False
    saved_path_event_available: bool = False
    token_usage_event_available: bool = False
    messages: list[str] = field(default_factory=list)


def probe_codex(timeout_sec: int = 20) -> CodexProbeResult:
    result = CodexProbeResult()
    exe = _find_codex_executable()
    if not exe:
        result.messages.append("未找到 codex 命令")
        return result
    result.executable = exe
    result.messages.append(f"codex: {exe}")

    features = _run([exe, "features", "list"], timeout_sec=timeout_sec)
    if features.returncode == 0:
        result.image_feature_enabled = any(
            line.split()[0] == "image_generation" and line.rstrip().endswith("true")
            for line in features.stdout.splitlines()
            if line.strip()
        )
        result.messages.append(
            "image_generation: "
            + ("enabled" if result.image_feature_enabled else "not enabled")
        )
    else:
        result.messages.append(f"features list 失败: {features.stderr.strip() or features.stdout.strip()}")

    app_help = _run([exe, "app-server", "--help"], timeout_sec=timeout_sec)
    result.app_server_available = app_help.returncode == 0
    result.messages.append(
        "app-server: " + ("available" if result.app_server_available else "unavailable")
    )

    if result.app_server_available:
        with tempfile.TemporaryDirectory(prefix="gamedraft_codex_schema_") as td:
            out_dir = Path(td)
            schema = _run(
                [exe, "app-server", "generate-json-schema", "--out", str(out_dir), "--experimental"],
                timeout_sec=timeout_sec,
            )
            if schema.returncode == 0:
                text = "\n".join(
                    p.read_text(encoding="utf-8", errors="ignore")
                    for p in out_dir.rglob("*.json")
                )
                result.saved_path_event_available = (
                    '"imageGeneration"' in text and '"savedPath"' in text
                )
                result.token_usage_event_available = (
                    "ThreadTokenUsageUpdatedNotification" in text
                    and '"tokenUsage"' in text
                )
                result.messages.append(
                    "image savedPath event: "
                    + ("available" if result.saved_path_event_available else "missing")
                )
                result.messages.append(
                    "token usage event: "
                    + ("available" if result.token_usage_event_available else "missing")
                )
            else:
                result.messages.append(
                    "app-server schema 生成失败: "
                    + (schema.stderr.strip() or schema.stdout.strip())
                )

    result.ok = (
        bool(result.executable)
        and result.image_feature_enabled
        and result.app_server_available
        and result.saved_path_event_available
        and result.token_usage_event_available
    )
    return result


def format_probe_result(result: CodexProbeResult) -> str:
    lines = ["Codex 能力探针: " + ("通过" if result.ok else "未通过")]
    lines.extend(result.messages)
    if not result.ok:
        lines.append("")
        lines.append("阻塞含义：如果 savedPath 或 token usage 不可用，GUI 不能稳定实现 CLI 产图和实时用量。")
    return "\n".join(lines)


def find_codex_executable() -> str | None:
    return _find_codex_executable()


def _find_codex_executable() -> str | None:
    from_path = shutil.which("codex")
    if from_path:
        return from_path

    candidates: list[Path] = []
    home = Path.home()
    extension_roots = [
        home / ".vscode" / "extensions",
        home / ".vscode-insiders" / "extensions",
    ]
    for root in extension_roots:
        if not root.is_dir():
            continue
        for path in root.glob("openai.chatgpt-*/bin/**/codex*"):
            if path.is_file() and path.suffix.lower() in {"", ".exe", ".cmd"}:
                candidates.append(path)
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return str(candidates[0])


def _run(argv: list[str], *, timeout_sec: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(argv, 1, "", str(exc))
