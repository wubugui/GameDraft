from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .hub import build_governance_hub, compact_hub_for_prompt


def list_governance_agents() -> dict[str, Any]:
    codex = _find_codex_command()
    claude = _find_claude_command()
    return {
        "agents": [
            _agent_info("codex", "Codex", codex, "设置 GAMEDRAFT_CODEX_EXE 或 CODEX_EXE，或在页面里填 Codex CLI 路径。"),
            _claude_agent_info(claude),
            {"id": "local", "label": "Local", "available": True, "command": "", "reason": "内置本地治理助手，不会修改文件。"},
        ]
    }


def answer_governance_chat(root: Path, payload: dict[str, Any], timeout_sec: int = 180) -> dict[str, Any]:
    root = root.resolve()
    registry = _load_registry(root)
    message = str(payload.get("message") or "").strip()
    references = _resolve_references(root, registry, payload.get("references"))
    history = _trim_history(payload.get("history"))
    prompt = _build_prompt(root, registry, message, references, history, payload)
    provider = _provider_from_payload(payload)
    provider_command = str(payload.get("providerCommand") or "")

    if provider == "codex":
        command_base = _find_codex_command(provider_command)
        if not command_base:
            return _unavailable_reply("codex", registry, message, references)
        reply = _ask_codex(command_base, root, prompt, timeout_sec=timeout_sec)
        if reply:
            return {"ok": True, "provider": "codex", "mode": "codex-readonly", "reply": reply, "references": references}
        return _unavailable_reply("codex", registry, message, references)

    if provider == "claude":
        command_base = _find_claude_command(provider_command)
        if not command_base:
            return _unavailable_reply("claude", registry, message, references)
        auth = _claude_auth_status(command_base)
        if not auth.get("loggedIn"):
            return _unavailable_reply("claude", registry, message, references, reason=str(auth.get("reason") or "Claude 未登录。"))
        reply = _ask_claude(command_base, root, prompt, timeout_sec=timeout_sec)
        if reply:
            return {"ok": True, "provider": "claude", "mode": "claude-readonly", "reply": reply, "references": references}
        return _unavailable_reply("claude", registry, message, references)

    return {
        "ok": True,
        "provider": "local",
        "mode": "local-governance",
        "reply": _fallback_reply(registry, message, references),
        "references": references,
    }


def build_governance_agent_run(root: Path, payload: dict[str, Any], run_dir: Path) -> dict[str, Any]:
    root = root.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    registry = _load_registry(root)
    message = str(payload.get("message") or "").strip()
    references = _resolve_references(root, registry, payload.get("references"))
    history = _trim_history(payload.get("history"))
    provider = _provider_from_payload(payload)
    provider_command = str(payload.get("providerCommand") or "")
    run_mode = str(payload.get("runMode") or "chat").strip().lower()
    can_write = run_mode == "fix"
    prompt = _build_prompt(root, registry, message, references, history, payload, can_write=can_write)
    prompt_path = run_dir / "prompt.md"
    last_message = run_dir / "last-message.md"
    prompt_path.write_text(prompt, encoding="utf-8")

    if provider == "codex":
        command_base = _find_codex_command(provider_command)
        if not command_base:
            return {"ok": False, "provider": provider, "message": "Codex CLI 未连接。"}
        command = [
            *command_base,
            "exec",
            "--json",
            "--cd",
            str(root),
            "--sandbox",
            "workspace-write" if can_write else "read-only",
            "--ephemeral",
            "-o",
            str(last_message),
            "-",
        ]
        return {
            "ok": True,
            "provider": provider,
            "runMode": run_mode,
            "command": command,
            "stdin": prompt,
            "promptPath": str(prompt_path),
            "lastMessagePath": str(last_message),
            "references": references,
        }

    if provider == "claude":
        command_base = _find_claude_command(provider_command)
        if not command_base:
            return {"ok": False, "provider": provider, "message": "Claude CLI 未连接。"}
        auth = _claude_auth_status(command_base)
        if not auth.get("loggedIn"):
            return {
                "ok": False,
                "provider": provider,
                "message": str(auth.get("reason") or "Claude CLI 已安装但未登录。"),
                "loginCommand": str(auth.get("loginCommand") or ""),
            }
        command = [*command_base, "-p", prompt]
        return {
            "ok": True,
            "provider": provider,
            "runMode": run_mode,
            "command": command,
            "stdin": "",
            "promptPath": str(prompt_path),
            "lastMessagePath": str(last_message),
            "references": references,
        }

    reply = _fallback_reply(registry, message, references)
    last_message.write_text(reply, encoding="utf-8")
    return {
        "ok": True,
        "provider": "local",
        "runMode": "chat",
        "command": [],
        "stdin": "",
        "promptPath": str(prompt_path),
        "lastMessagePath": str(last_message),
        "references": references,
        "localReply": reply,
    }


def _provider_from_payload(payload: dict[str, Any]) -> str:
    if payload.get("localOnly"):
        return "local"
    provider = str(payload.get("provider") or "codex").strip().lower()
    if provider in {"codex", "claude", "local"}:
        return provider
    return "codex"


def _load_registry(root: Path) -> dict[str, Any]:
    path = root / "tools" / "skill_workflow_governance" / "out" / "registry.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_references(root: Path, registry: dict[str, Any], raw_refs: object) -> list[dict[str, Any]]:
    refs = raw_refs if isinstance(raw_refs, list) else []
    workpacks = {str(item.get("id")): item for item in registry.get("workpacks", []) if isinstance(item, dict)}
    issues = {str(item.get("id")): item for item in registry.get("issues", []) if isinstance(item, dict)}
    artifacts = {str(item.get("id")): item for item in registry.get("artifacts", []) if isinstance(item, dict)}
    hub = build_governance_hub(root, registry, {"references": refs})
    resources = {
        str(item.get("uri")): item
        for item in hub.get("resources", [])
        if isinstance(item, dict) and item.get("uri")
    }
    apps = {str(item.get("id")): item for item in hub.get("apps", []) if isinstance(item, dict)}
    tools = {str(item.get("name")): item for item in hub.get("tools", []) if isinstance(item, dict)}
    prompts = {str(item.get("name")): item for item in hub.get("prompts", []) if isinstance(item, dict)}

    resolved: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        ref_type = str(ref.get("type") or "")
        ref_id = str(ref.get("id") or "")
        ref_uri = str(ref.get("uri") or _uri_for_ref(ref_type, ref_id))
        key = (ref_type, ref_id, ref_uri)
        if not (ref_type or ref_uri) or key in seen:
            continue
        seen.add(key)
        source = None
        if ref_type == "workpack":
            source = workpacks.get(ref_id)
        elif ref_type == "issue":
            source = issues.get(ref_id)
        elif ref_type == "artifact":
            source = artifacts.get(ref_id)
        elif ref_type == "app":
            source = apps.get(ref_id)
        elif ref_type == "tool":
            source = tools.get(ref_id)
        elif ref_type == "prompt":
            source = prompts.get(ref_id)
        elif ref_uri:
            source = resources.get(ref_uri)
        if isinstance(source, dict):
            compact = {k: v for k, v in source.items() if k not in {"agent_prompt", "issue_ids"}}
            compact["type"] = ref_type
            if ref_uri:
                compact["uri"] = ref_uri
            resolved.append(compact)
    return resolved[:12]


def _uri_for_ref(ref_type: str, ref_id: str) -> str:
    if not ref_type or not ref_id:
        return ""
    if ref_type == "workpack":
        return f"governance://workpack/{ref_id}"
    if ref_type == "issue":
        return f"governance://issue/{ref_id}"
    if ref_type == "artifact":
        return f"governance://artifact/{ref_id}"
    if ref_type == "app":
        return f"governance://app/{ref_id}"
    if ref_type == "tool":
        return f"governance://tool/{ref_id}"
    if ref_type == "prompt":
        return f"governance://prompt/{ref_id}"
    if ref_type == "source":
        return f"governance://source/{ref_id}"
    if ref_type == "resource" and ref_id.startswith("governance://"):
        return ref_id
    if ref_type in {"stat", "view"}:
        return f"governance://{ref_type}/{ref_id}"
    return ""


def _trim_history(raw_history: object) -> list[dict[str, str]]:
    history = raw_history if isinstance(raw_history, list) else []
    out: list[dict[str, str]] = []
    for item in history[-8:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "")
        content = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            out.append({"role": role, "content": content[:1800]})
    return out


def _build_prompt(
    root: Path,
    registry: dict[str, Any],
    message: str,
    references: list[dict[str, Any]],
    history: list[dict[str, str]],
    payload: dict[str, Any],
    *,
    can_write: bool = False,
) -> str:
    stats = registry.get("stats") if isinstance(registry.get("stats"), dict) else {}
    workpacks = registry.get("workpacks") if isinstance(registry.get("workpacks"), list) else []
    compact_packs = [
        {
            "id": pack.get("id"),
            "priority": pack.get("priority"),
            "title": pack.get("title"),
            "issue_count": pack.get("issue_count"),
            "artifact_count": pack.get("artifact_count"),
            "summary": pack.get("summary"),
            "next": pack.get("next"),
            "paths": pack.get("paths", [])[:8],
        }
        for pack in workpacks[:8]
        if isinstance(pack, dict)
    ]
    context = {
        "stats": stats,
        "selected_references": references,
        "available_workpacks": compact_packs,
        "recent_history": history,
    }
    hub = compact_hub_for_prompt(build_governance_hub(root, registry, payload))
    boundary = (
        "边界：本轮可以在 GameDraft 工作空间内自动修复被引用治理包/证据对应的问题；"
        "只改必要文件；不要触碰 ~/AIWork/agent-canvas-os；不要做无关重构；修复后运行 "
        "`python3 -B tools/skill_workflow_governance/govern.py audit` 验证。"
        if can_write
        else "边界：本轮只分析、分组、提出治理策略和 agent 任务；不要修改文件；不要要求用户逐条手改。"
    )
    return (
        "你是 GameDraft 的 Skill/Workflow 治理 Agent。你在审计控制台里和用户协作。\n"
        "治理台不是聊天框，而是一个 MCP Host / Agent Workbench：你要把下面的 host、resources、tools、prompts、apps 当作当前工作环境。\n"
        "你不能假装调用不存在的工具；如果需要宿主执行工具，就明确说出 tool name、参数、预期效果和是否需要用户批准。\n"
        f"{boundary}\n"
        "回答要求：中文，短而可执行；优先引用选中的治理包/证据；引用文件时用 path:line；把自动处理、需要确认、建议顺序分清楚。\n"
        "如果执行了修复，最终必须列出：修改了哪些文件、修了哪类问题、验证命令结果、剩余风险。\n\n"
        f"治理台 Host/MCP 快照 JSON：\n{json.dumps(hub, ensure_ascii=False, indent=2)}\n\n"
        f"审计上下文 JSON：\n{json.dumps(context, ensure_ascii=False, indent=2)}\n\n"
        f"用户问题：{message or '请基于当前引用给出治理建议。'}"
    )


def _ask_codex(command_base: list[str], root: Path, prompt: str, timeout_sec: int) -> str:
    with tempfile.TemporaryDirectory(prefix="gamedraft_governance_agent_") as tmp:
        last_message = Path(tmp) / "last-message.md"
        command = [
            *command_base,
            "exec",
            "--cd",
            str(root),
            "--sandbox",
            "read-only",
            "--ephemeral",
            "-o",
            str(last_message),
            "-",
        ]
        try:
            completed = subprocess.run(
                command,
                input=prompt,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_sec,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return ""
        if last_message.exists():
            try:
                text = last_message.read_text(encoding="utf-8", errors="replace").strip()
                if text:
                    return text
            except OSError:
                pass
        if completed.returncode == 0:
            return (completed.stdout or "").strip()
    return ""


def _ask_claude(command_base: list[str], root: Path, prompt: str, timeout_sec: int) -> str:
    commands = [
        [*command_base, "-p", prompt],
        [*command_base, "--print", prompt],
    ]
    for command in commands:
        try:
            completed = subprocess.run(
                command,
                cwd=str(root),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_sec,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        text = (completed.stdout or "").strip()
        if completed.returncode == 0 and text:
            return text
    return ""


def _agent_info(agent_id: str, label: str, command: list[str], missing_reason: str) -> dict[str, Any]:
    return {
        "id": agent_id,
        "label": label,
        "available": bool(command),
        "installed": bool(command),
        "command": _join_command(command),
        "reason": "" if command else missing_reason,
    }


def _claude_agent_info(command: list[str]) -> dict[str, Any]:
    if not command:
        return {
            "id": "claude",
            "label": "Claude",
            "available": False,
            "installed": False,
            "authenticated": False,
            "command": "",
            "reason": "未找到 Claude CLI。已检查 PATH、登录 shell、Homebrew、nvm/volta/bun 和 VS Code Claude Code 扩展。",
            "loginCommand": "",
        }
    auth = _claude_auth_status(command)
    logged_in = bool(auth.get("loggedIn"))
    return {
        "id": "claude",
        "label": "Claude",
        "available": logged_in,
        "installed": True,
        "authenticated": logged_in,
        "command": _join_command(command),
        "reason": "" if logged_in else str(auth.get("reason") or "Claude CLI 已安装但未登录。"),
        "loginCommand": str(auth.get("loginCommand") or _join_command([*command, "auth", "login"])),
    }


def _claude_auth_status(command: list[str]) -> dict[str, Any]:
    login_command = _join_command([*command, "auth", "login"])
    try:
        completed = subprocess.run(
            [*command, "auth", "status"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "loggedIn": False,
            "reason": f"Claude auth status 探测失败：{exc}",
            "loginCommand": login_command,
        }
    text = (completed.stdout or completed.stderr or "").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = {}
    if isinstance(data, dict) and data.get("loggedIn") is True:
        return {"loggedIn": True, "reason": "", "loginCommand": login_command}
    auth_method = data.get("authMethod") if isinstance(data, dict) else ""
    provider = data.get("apiProvider") if isinstance(data, dict) else ""
    detail = f"authMethod={auth_method or 'unknown'}, apiProvider={provider or 'unknown'}" if data else text
    return {
        "loggedIn": False,
        "reason": f"Claude CLI 已安装但未登录（{detail}）。请运行：{login_command}",
        "loginCommand": login_command,
    }


def _find_codex_command(override: str = "") -> list[str]:
    return _find_agent_command(
        command_name="codex",
        env_names=("GAMEDRAFT_CODEX_EXE", "CODEX_EXE"),
        override=override,
        extra_candidates=[Path("/Applications/Codex.app/Contents/Resources/codex")],
    )


def _find_claude_command(override: str = "") -> list[str]:
    home = Path.home()
    candidates = [
        Path("/opt/homebrew/bin/claude"),
        Path("/usr/local/bin/claude"),
        home / ".local" / "bin" / "claude",
        home / ".npm-global" / "bin" / "claude",
        home / ".volta" / "bin" / "claude",
        home / ".bun" / "bin" / "claude",
    ]
    nvm_root = home / ".nvm" / "versions" / "node"
    if nvm_root.is_dir():
        candidates.extend(sorted(nvm_root.glob("*/bin/claude"), reverse=True))
    candidates.extend(_claude_vscode_extension_candidates(home))
    return _find_agent_command(
        command_name="claude",
        env_names=("GAMEDRAFT_CLAUDE_EXE", "CLAUDE_EXE"),
        override=override,
        extra_candidates=candidates,
    )


def _claude_vscode_extension_candidates(home: Path) -> list[Path]:
    candidates: list[Path] = []
    for root in (home / ".vscode" / "extensions", home / ".vscode-insiders" / "extensions"):
        if not root.is_dir():
            continue
        candidates.extend(root.glob("anthropic.claude-code-*/resources/native-binary/claude"))
        candidates.extend(root.glob("anthropic.claude-code-*/native-binary/claude"))
    candidates = [path for path in candidates if path.is_file()]
    candidates.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return candidates


def _find_agent_command(
    *,
    command_name: str,
    env_names: tuple[str, ...],
    override: str = "",
    extra_candidates: list[Path] | None = None,
) -> list[str]:
    override_parts = _split_command(override)
    if override_parts:
        return override_parts
    for env_name in env_names:
        parts = _split_command(os.environ.get(env_name, ""))
        if parts:
            return parts
    from_path = shutil.which(command_name)
    if from_path:
        return [from_path]
    shell_path = _find_in_login_shell(command_name)
    if shell_path:
        return [shell_path]
    for candidate in extra_candidates or []:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return [str(candidate)]
    return []


def _find_in_login_shell(command_name: str) -> str:
    shells = [os.environ.get("SHELL", ""), "/bin/zsh", "/bin/bash"]
    seen: set[str] = set()
    for shell in shells:
        if not shell or shell in seen or not Path(shell).exists():
            continue
        seen.add(shell)
        try:
            completed = subprocess.run(
                [shell, "-lc", f"command -v {shlex.quote(command_name)}"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        path = (completed.stdout or "").strip().splitlines()
        if completed.returncode == 0 and path:
            return path[0].strip()
    return ""


def _split_command(value: str) -> list[str]:
    text = value.strip()
    if not text:
        return []
    try:
        return shlex.split(text)
    except ValueError:
        return [text.strip('"')]


def _join_command(command: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def _unavailable_reply(
    provider: str,
    registry: dict[str, Any],
    message: str,
    references: list[dict[str, Any]],
    reason: str = "",
) -> dict[str, Any]:
    name = "Claude" if provider == "claude" else "Codex"
    command = "claude" if provider == "claude" else "codex"
    fallback = _fallback_reply(registry, message, references)
    detail = reason or f"找不到 `{command}` 命令，或命令没有返回内容。"
    return {
        "ok": True,
        "provider": provider,
        "mode": f"{provider}-unavailable",
        "reply": (
            f"{name} 当前不能执行：{detail}\n\n"
            f"我没有用别的 agent 冒充它。下面是本地治理助手基于同一组引用给出的临时分析：\n\n{fallback}"
        ),
        "references": references,
    }


def _fallback_reply(registry: dict[str, Any], message: str, references: list[dict[str, Any]]) -> str:
    if references:
        lines = ["我先按你引用的上下文治理，不逐条摊开。", ""]
        for ref in references[:6]:
            if ref.get("type") == "workpack":
                lines.extend(
                    [
                        f"【{ref.get('priority', '')} {ref.get('title', ref.get('id'))}】",
                        f"- 范围：{ref.get('issue_count', 0)} 项证据，{ref.get('artifact_count', 0)} 个文件",
                        f"- 判断：{ref.get('summary', '')}",
                        f"- 治理动作：{ref.get('next', '')}",
                    ]
                )
            elif ref.get("type") == "issue":
                loc = f"{ref.get('path')}:{ref.get('line')}"
                lines.extend(
                    [
                        f"【证据 {loc}】",
                        f"- 问题：{ref.get('title', '')}",
                        f"- 证据：{ref.get('evidence', '')}",
                        f"- 建议：{ref.get('suggestion', '')}",
                    ]
                )
        lines.extend(
            [
                "",
                "建议下一步：先让 agent 按文件分组处理；能确定的直接修，无法判断的最后合并成不超过 5 个确认点。",
            ]
        )
        return "\n".join(lines)

    packs = registry.get("workpacks") if isinstance(registry.get("workpacks"), list) else []
    lines = ["当前不要看原始列表，按治理包推进："]
    for pack in packs[:5]:
        if not isinstance(pack, dict):
            continue
        lines.append(
            f"- {pack.get('priority')} {pack.get('title')}：{pack.get('issue_count')} 项，{pack.get('next')}"
        )
    lines.append("")
    lines.append("建议先引用 P0/P1 治理包问我，我会继续拆成 agent 可执行任务。")
    return "\n".join(lines)
