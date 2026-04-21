"""Cline 运行所需的 Run 级工作区：--config 共享目录、临时 cwd、MCP 注册、审计快照。"""
from __future__ import annotations

import errno
import hashlib
import json
import logging
import shutil
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_spec import AgentSpec, render_system
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile

CLINE_CONFIG_DIRNAME = ".cline_config"
# Cline CLI ``--config`` 对应官方 ``~/.cline``（其下再有 ``data/`` 放 globalState、secrets）。勿传 ``.../.cline_config/data``，否则会再套一层 ``data/data``。
CLINE_MCP_SETTINGS_REL = Path("data") / "settings" / "cline_mcp_settings.json"
CHRONICLE_SIM_DIR = ".chronicle_sim"
WS_SUBDIR = "ws"
LLM_EFFECTIVE_SUBDIR = "llm_effective"

MCP_SERVER_ID = "chronicle_sim"
_log = logging.getLogger(__name__)

MCP_CLINE_RULE_TEXT = (
    "优先使用已注册的 MCP 工具 chroma_search_world / chroma_search_ideas 做语义检索。"
    "真正的引用仍须来自 Cline 内置 read_file 读到的原文。"
)


def cline_config_path(run_dir: Path) -> Path:
    """Run 级 Cline ``--config`` 目录：``run_dir/.cline_config``（其下 ``data/`` 由 Cline 管理）。

    与 ``cline auth --config <此路径>``、``cline task --config <此路径>`` 一致。
    """
    p = run_dir / CLINE_CONFIG_DIRNAME
    p.mkdir(parents=True, exist_ok=True)
    return p.resolve()


def cline_mcp_settings_path(run_dir: Path) -> Path:
    return cline_config_path(run_dir) / CLINE_MCP_SETTINGS_REL


def _ensure_cline_headless_global_state(run_dir: Path) -> None:
    """Cline 2.x：非交互 ``cline auth`` 后若 ``welcomeViewCompleted`` 仍为 false，``cline task`` 可能报未认证。

    合并为 ``true``，与无头首次使用 Cline 的已知规避一致（参见 Cline 社区 issue 讨论）。
    """
    gs = cline_config_path(run_dir) / "data" / "globalState.json"
    gs.parent.mkdir(parents=True, exist_ok=True)
    data: dict[str, Any] = {}
    if gs.is_file():
        try:
            raw = json.loads(gs.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
        except (OSError, json.JSONDecodeError):
            data = {}
    if data.get("welcomeViewCompleted") is True:
        return
    merged = {**data, "welcomeViewCompleted": True}
    gs.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")


def ensure_mcp_for_run(run_dir: Path) -> Path:
    """合并写入 `cline_mcp_settings.json`：保留已有其它服务，仅更新 `chronicle_sim` 条目。

    同时确保 Cline 无头就绪标志（见 ``_ensure_cline_headless_global_state``）。
    """
    _ensure_cline_headless_global_state(run_dir)
    settings_path = cline_mcp_settings_path(run_dir)
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    existing: dict[str, Any] = {}
    if settings_path.is_file():
        try:
            existing = json.loads(settings_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = {}
    if not isinstance(existing, dict):
        existing = {}

    servers = existing.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}

    servers[MCP_SERVER_ID] = {
        "command": sys.executable,
        "args": [
            "-m",
            "tools.chronicle_sim_v2.scripts.chroma_mcp_stdio",
            "--run-dir",
            str(run_dir.resolve()),
        ],
        "env": {},
        "alwaysAllow": ["chroma_search_world", "chroma_search_ideas"],
        "disabled": False,
    }
    existing["mcpServers"] = servers
    settings_path.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return settings_path


def _ws_root(run_dir: Path) -> Path:
    p = run_dir / CHRONICLE_SIM_DIR / WS_SUBDIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def materialize_temp_ws(
    run_dir: Path,
    spec: AgentSpec,
    *,
    system_ctx: dict[str, str] | None = None,
) -> Path:
    """为一次 agent 调用创建临时 cwd：写 `.clinerules/` 与（探针）`chronicle/` 只读快照。"""
    temp_ws = _ws_root(run_dir) / f"{spec.agent_id}_{uuid.uuid4().hex[:12]}"
    if temp_ws.exists():
        raise RuntimeError(f"临时 cwd 已存在（uuid 冲突）：{temp_ws}")
    temp_ws.mkdir(parents=True)

    rules_dir = temp_ws / ".clinerules"
    rules_dir.mkdir()

    system_text = render_system(spec, system_ctx or {})
    (rules_dir / "01_role.md").write_text(system_text, encoding="utf-8")

    if spec.mcp == "chroma":
        (rules_dir / "02_mcp.md").write_text(MCP_CLINE_RULE_TEXT, encoding="utf-8")

    if spec.copy_chronicle_to_cwd:
        src = run_dir / "chronicle"
        if src.is_dir():
            shutil.copytree(src, temp_ws / "chronicle", dirs_exist_ok=False)
        else:
            (temp_ws / "chronicle").mkdir()

    return temp_ws


def _is_transient_dir_unlink_err(exc: BaseException) -> bool:
    """Windows 上 WinError 32（句柄仍占用）等可稍后重试。"""
    if isinstance(exc, PermissionError):
        return True
    if not isinstance(exc, OSError):
        return False
    if getattr(exc, "winerror", None) == 32:
        return True
    if getattr(exc, "errno", None) in (errno.EACCES, errno.EPERM, errno.EBUSY):
        return True
    return False


def cleanup_temp_ws(temp_ws: Path) -> None:
    """删除一次 agent 调用的临时 cwd。

    Windows 下 Cline 子进程刚退出时，cwd 目录句柄可能仍被占用片刻，``shutil.rmtree`` 会报 WinError 32。
    这里做短暂重试；仍失败则 ``ignore_errors`` 尽力删除。若目录仍存在，只记日志**不抛异常**，
    以免 ``run_agent_cline`` 的 ``finally`` 掩盖 Cline 返回码等真实错误。
    """
    if not temp_ws.is_dir():
        return
    delays_s = (0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0)
    last: BaseException | None = None
    for i, delay in enumerate(delays_s):
        try:
            shutil.rmtree(temp_ws, ignore_errors=False)
            return
        except OSError as e:
            if not _is_transient_dir_unlink_err(e):
                raise
            last = e
            if i < len(delays_s) - 1:
                time.sleep(delay)
    shutil.rmtree(temp_ws, ignore_errors=True)
    if temp_ws.is_dir():
        _log.warning(
            "未能删除临时工作区（可能被占用），路径: %s — 最后异常: %s",
            temp_ws,
            last,
        )


def _mask_secret(val: str) -> str:
    return "***" if (val or "").strip() else ""


def _argv_digest(argv: list[str]) -> str:
    raw = "\x1f".join(str(a) for a in argv).encode("utf-8", errors="replace")
    return hashlib.sha256(raw).hexdigest()[:16]


def write_llm_effective_snapshot(
    run_dir: Path,
    *,
    agent_id: str,
    profile: ProviderProfile,
    argv: list[str],
    timings_ms: dict[str, int] | None = None,
    extra: dict[str, Any] | None = None,
) -> Path:
    """在 `run_dir/.chronicle_sim/llm_effective/` 下落一份脱敏审计快照。"""
    d = run_dir / CHRONICLE_SIM_DIR / LLM_EFFECTIVE_SUBDIR
    d.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = d / f"{agent_id}_{ts}.json"
    rec: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_id,
        "kind": profile.kind or "",
        "model": profile.model or "",
        "base_url": profile.base_url or "",
        "ollama_host": profile.ollama_host or "",
        "api_key_mask": _mask_secret(profile.api_key or ""),
        "argv_digest": _argv_digest(argv),
        "timings_ms": dict(timings_ms or {}),
    }
    if extra:
        rec["extra"] = extra
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
