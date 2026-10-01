#!/usr/bin/env python3
"""Codex event adapter for the existing GameDraft Claude hook policies.

Codex reports file edits as apply_patch(command=...), while the Claude policies
expect Edit/Write(file_path=..., content=...). Keep policy decisions in the
existing scripts and translate only the event shape here.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import flag_discipline as flags
import validation_gate as validation

ROOT = Path(__file__).resolve().parents[2]
HEADER = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+)$")


def patch_operations(command: str) -> list[tuple[str, str, list[str]]]:
    operations: list[tuple[str, str, list[str]]] = []
    kind = path = ""
    body: list[str] = []
    for line in command.splitlines():
        match = HEADER.match(line)
        if match or line == "*** End Patch":
            if kind:
                operations.append((kind, path, body))
            kind, path, body = (match.group(1), match.group(2), []) if match else ("", "", [])
        elif kind:
            body.append(line)
    if kind:
        operations.append((kind, path, body))
    return operations


def relative_path(raw: str) -> str | None:
    try:
        path = Path(raw)
        if not path.is_absolute():
            path = ROOT / path
        return path.resolve().relative_to(ROOT).as_posix()
    except (OSError, ValueError):
        return None


def result_path(source: str, body: list[str]) -> str:
    for line in body:
        if line.startswith("*** Move to: "):
            return line.removeprefix("*** Move to: ")
    return source


def apply_update(old: str, body: list[str]) -> str | None:
    """Reconstruct a Codex Update File patch without writing to disk."""
    rows = old.replace("\r\n", "\n").splitlines()
    chunks: list[list[str]] = []
    chunk: list[str] = []
    for line in body:
        if line.startswith("@@"):
            if chunk:
                chunks.append(chunk)
                chunk = []
        elif line.startswith("***"):
            continue
        elif line[:1] in (" ", "+", "-"):
            chunk.append(line)
    if chunk:
        chunks.append(chunk)
    cursor = 0
    for chunk in chunks:
        before = [line[1:] for line in chunk if line.startswith((" ", "-"))]
        after = [line[1:] for line in chunk if line.startswith((" ", "+"))]
        if before:
            start = next((i for i in range(cursor, len(rows) - len(before) + 1)
                          if rows[i:i + len(before)] == before), None)
            if start is None:
                return None
        else:
            start = cursor
        rows[start:start + len(before)] = after
        cursor = start + len(after)
    return "\n".join(rows) + ("\n" if old.endswith(("\n", "\r\n")) else "")


def prospective_assets(command: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for kind, raw, body in patch_operations(command):
        rel = relative_path(result_path(raw, body))
        if not rel or not rel.startswith(flags.ASSETS_PREFIX) or not rel.endswith(".json"):
            continue
        if kind == "Add":
            content = "\n".join(line[1:] for line in body if line.startswith("+")) + "\n"
        elif kind == "Update":
            source = relative_path(raw)
            if not source:
                continue
            content = apply_update(flags.read_text(ROOT / source), body)
            if content is None:
                continue
        else:
            continue
        out.append((rel, content))
    return out


def changed_paths(command: str) -> list[str]:
    paths: set[str] = set()
    for _kind, raw, body in patch_operations(command):
        for candidate in (raw, result_path(raw, body)):
            rel = relative_path(candidate)
            if rel:
                paths.add(rel)
    return sorted(paths)


def capture_policy(call, payload: dict) -> list[dict]:
    messages: list[dict] = []
    original = flags.emit
    flags.emit = messages.append
    try:
        call(payload)
    finally:
        flags.emit = original
    return messages


def pre_patch(data: dict) -> dict | None:
    capture_policy(flags.on_pre_shell, data)
    command = str((data.get("tool_input") or {}).get("command") or "")
    notices: list[str] = []
    for rel, content in prospective_assets(command):
        synthetic = dict(data, tool_name="Write", tool_input={"file_path": str(ROOT / rel), "content": content})
        for message in capture_policy(flags.on_pre_write, synthetic):
            output = message.get("hookSpecificOutput") or {}
            if output.get("permissionDecision") == "deny":
                return message
            if output.get("additionalContext"):
                notices.append(output["additionalContext"])
    if notices:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "\n".join(notices)}}
    return None


def state_file(session_id: str) -> Path:
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64] or "nosession"
    return Path(tempfile.gettempdir()) / f"gamedraft_codex_edits_{safe}.jsonl"


def post_patch(data: dict) -> dict | None:
    command = str((data.get("tool_input") or {}).get("command") or "")
    paths = changed_paths(command)
    if not paths:
        return None
    response = data.get("tool_response")
    if isinstance(response, dict) and response.get("isError"):
        return None
    sid = str(data.get("session_id") or "")
    with state_file(sid).open("a", encoding="utf-8") as stream:
        now = time.time()
        for path in paths:
            stream.write(json.dumps([now, path], ensure_ascii=False) + "\n")
    contexts: list[str] = []
    for message in capture_policy(flags.on_post_shell, data):
        context = (message.get("hookSpecificOutput") or {}).get("additionalContext")
        if context:
            contexts.append(context)
    reminder = ROOT / "agent_docs/_meta/hooks/paths_reminder.py"
    for path in paths:
        result = subprocess.run([sys.executable, str(reminder), str(ROOT / path), sid],
                                capture_output=True, text=True, encoding="utf-8", timeout=5, check=False)
        if result.stdout.strip():
            contexts.append(result.stdout.strip())
    if contexts:
        return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "\n".join(contexts)}}
    return None


def skill(data: dict) -> dict | None:
    for message in capture_policy(flags.on_skill_loaded, data):
        context = (message.get("hookSpecificOutput") or {}).get("additionalContext")
        if context:
            return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": context}}
    return None


def stop(data: dict) -> dict:
    if data.get("stop_hook_active"):
        return {"continue": True}
    sid = str(data.get("session_id") or "")
    try:
        edits = [json.loads(line) for line in state_file(sid).read_text(encoding="utf-8").splitlines()]
    except (OSError, ValueError):
        return {"continue": True}
    owed = [gate for predicate, gate in validation.GATE_RULES
            if any(predicate(path) for _when, path in edits)]
    if not owed:
        return {"continue": True}
    marker = Path(validation.marker_path(sid))
    if marker.is_file() and marker.stat().st_mtime >= max(when for when, _path in edits):
        return {"continue": True}
    reason = ("【收尾验证门】本会话改动尚未验证:\n" + "\n".join(f"  欠:{gate}" for gate in owed)
              + "\n按适用门验证后运行 .tools/venv/Scripts/python.exe "
                f"scripts/agent_hooks/validation_gate.py --mark {sid}；若无需这些门，说明理由后再标记。")
    return {"decision": "block", "reason": reason}


def selftest() -> int:
    sample = "{\n  \"actions\": []\n}\n"
    patch = "*** Begin Patch\n*** Update File: x.json\n@@\n-  \"actions\": []\n+  \"actions\": [{\"type\": \"setFlag\"}]\n*** End Patch\n"
    expected = "{\n  \"actions\": [{\"type\": \"setFlag\"}]\n}\n"
    good = apply_update(sample, patch_operations(patch)[0][2]) == expected
    print("codex hook patch reconstruction:", "ok" if good else "FAILED")
    return 0 if good else 1


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        return selftest()
    try:
        data = json.load(sys.stdin)
        mode = sys.argv[1]
        result = {"pre-patch": pre_patch, "post-patch": post_patch, "skill": skill, "stop": stop}[mode](data)
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(f"Codex hook adapter error: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
