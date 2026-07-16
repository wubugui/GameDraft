#!/usr/bin/env python3
"""编辑命中 paths-triggers.json 登记路径 → 非阻断"必读卡"提醒(客户端无关)。

两种调用方式:
  1. Claude Code hook 模式(stdin 收 PostToolUse JSON)→ 输出 additionalContext JSON。
     接线见 .claude/settings.json 的 hooks.PostToolUse(由 cli.py install 维护)。
  2. 通用模式:`paths_reminder.py <file_path> [session_id]` → 命中则输出纯文本提醒,
     未命中无输出。任何客户端的 after-edit 钩子机制都可这样接。

给了 session_id 才做"每会话每文件只提醒一次"去重(状态存 /tmp/agent_docs_reminded_<sid>)。
任何异常都静默退出 0,绝不阻断编辑。
"""

from __future__ import annotations

import fnmatch
import json
import sys
from pathlib import Path

META_DIR = Path(__file__).resolve().parent.parent
DOCS_ROOT = META_DIR.parent
REPO_ROOT = DOCS_ROOT.parent


def main() -> None:
    plain_mode = False
    if len(sys.argv) > 1:
        plain_mode = True
        payload = {
            "tool_input": {"file_path": sys.argv[1]},
            "session_id": sys.argv[2] if len(sys.argv) > 2 else "",
        }
    else:
        try:
            payload = json.load(sys.stdin)
        except Exception:
            return
    fp = (payload.get("tool_input") or {}).get("file_path") or ""
    if not fp:
        return
    try:
        rel = Path(fp).resolve().relative_to(REPO_ROOT).as_posix()
    except (ValueError, OSError):
        return

    trig = DOCS_ROOT / "paths-triggers.json"
    try:
        mapping = json.loads(trig.read_text(encoding="utf-8"))
    except Exception:
        return
    hits = sorted({
        doc
        for entry in mapping.get("map", [])
        for doc in entry.get("docs", [])
        if fnmatch.fnmatch(rel, entry.get("glob", ""))
    })
    if not hits:
        return

    sid = str(payload.get("session_id") or "")[:64]
    if sid:
        state = Path("/tmp") / f"agent_docs_reminded_{sid}"
        try:
            seen = set(state.read_text(encoding="utf-8").splitlines()) if state.is_file() else set()
        except Exception:
            seen = set()
        if rel in seen:
            return
        try:
            with state.open("a", encoding="utf-8") as f:
                f.write(rel + "\n")
        except Exception:
            pass

    ids = ", ".join(hits)
    if plain_mode:
        print(f"[agent_docs] {rel} 登记了必读机制卡: {ids} —— 先读 agent_docs 对应卡再动手"
              f"(定位: python3 agent_docs/_meta/audit.py --paths {rel})。")
        return
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": (
                f"[agent_docs 提醒] 你正在改 {rel},该路径登记了必读机制卡: {ids}。"
                f"若本会话尚未读过,先读 agent_docs 对应卡再继续"
                f"(定位命令: python3 agent_docs/_meta/audit.py --paths {rel});已读过则忽略。"
                f"本会话此文件只提醒一次。"
            ),
        },
        "systemMessage": f"📚 agent_docs: {rel} → 必读卡 {ids}",
        "suppressOutput": True,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
    sys.exit(0)
