#!/usr/bin/env python3
"""Claude Code Stop hook:收尾验证门(廉价判定,不跑真实校验)。

原则:高频触发点只放毫秒级判定,贵的验证(validator 六门)由主会话委派 subagent 跑。
- 只在会话 transcript 里出现过 Edit/Write 且命中门规则时拦截(纯聊天/纯文档轮零干扰)。
- stop_hook_active 时直接放行 → 每轮最多拦一次,绝不循环阻塞。
- validator 全 PASS 后主会话执行 `sh scripts/py.sh scripts/agent_hooks/validation_gate.py --mark <session_id>`
  写标记;标记时间晚于最后一次编辑即放行。
- 任何异常放行(fail-open),绝不因为门本身的 bug 卡住收尾。

门规则与 .claude/agents/validator.md 的门清单对齐;改那边记得同步这边。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}

GATE_RULES = [
    (lambda p: p.startswith("src/") or p.endswith((".ts", ".tsx")),
     "TS 类型(npx tsc --noEmit)+ 运行时测试(npx vitest run)"),
    (lambda p: p.startswith("public/assets/") and p.endswith(".json"),
     "数据校验(./dev.sh validate-data)"),
    (lambda p: p.startswith("public/assets/"),
     "素材存在性(tools.editor.shared.asset_reference_audit)"),
    (lambda p: p.startswith("tools/editor/"),
     "编辑器测试(pytest tools/editor/tests)"),
    (lambda p: p.startswith("tools/dialogue_graph_editor/") or p.startswith("tools/json_lang/"),
     "图对话编辑器测试(pytest tools/dialogue_graph_editor/tests)"),
]


def marker_path(session_id: str) -> str:
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")[:64]
    return os.path.join(tempfile.gettempdir(), f"gamedraft_validated_{safe}")


def to_epoch(ts: str) -> float:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def collect_edits(transcript: str, cwd: str) -> list[tuple[float, str]]:
    prefix = cwd.replace("\\", "/").rstrip("/") + "/"
    edits: list[tuple[float, str]] = []
    with open(transcript, encoding="utf-8", errors="replace") as f:
        for line in f:
            if not any(f'"{t}"' in line for t in EDIT_TOOLS):
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue
            content = (entry.get("message") or {}).get("content") or []
            if not isinstance(content, list):
                continue
            ts = to_epoch(str(entry.get("timestamp") or ""))
            for block in content:
                if not (isinstance(block, dict) and block.get("type") == "tool_use"
                        and block.get("name") in EDIT_TOOLS):
                    continue
                inp = block.get("input") or {}
                fp = str(inp.get("file_path") or inp.get("notebook_path") or "").replace("\\", "/")
                if fp.lower().startswith(prefix.lower()):
                    edits.append((ts, fp[len(prefix):]))
    return edits


def main() -> int:
    if "--mark" in sys.argv:
        idx = sys.argv.index("--mark")
        sid = sys.argv[idx + 1] if len(sys.argv) > idx + 1 else ""
        if not sid:
            print("用法: validation_gate.py --mark <session_id>", file=sys.stderr)
            return 1
        with open(marker_path(sid), "w", encoding="utf-8") as f:
            f.write(datetime.now().isoformat())
        # Windows 控制台默认 GBK，`✓` 编不出去会抛 UnicodeEncodeError——标记其实已经写成了
        # （就在上面两行），但调用方看到一个 traceback 只会以为失败，然后重跑或去手工找原因。
        # 打印失败不该改变结果，所以吞掉它。
        try:
            print(f"[OK] 会话 {sid} 已标记验证完成,收尾门放行")
        except UnicodeEncodeError:
            pass
        return 0

    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("stop_hook_active"):
        return 0
    transcript = str(data.get("transcript_path") or "")
    sid = str(data.get("session_id") or "")
    cwd = str(data.get("cwd") or os.getcwd())
    if not transcript or not os.path.isfile(transcript):
        return 0

    try:
        edits = collect_edits(transcript, cwd)
    except Exception:
        return 0
    if not edits:
        return 0

    owed = []
    for pred, gate in GATE_RULES:
        if any(pred(p) for _, p in edits) and gate not in owed:
            owed.append(gate)
    if not owed:
        return 0

    last_edit = max(t for t, _ in edits)
    mp = marker_path(sid)
    if os.path.isfile(mp) and os.path.getmtime(mp) >= last_edit:
        return 0

    touched = sorted({p for _, p in edits})
    msg = [
        "【收尾验证门】本会话有改动尚未过验证门:",
        *[f"  欠:{g}" for g in owed],
        f"  (本会话改过 {len(touched)} 个仓库内文件)",
        "处理:委派 validator 子代理跑上述门;全 PASS 后执行",
        f"  sh scripts/py.sh scripts/agent_hooks/validation_gate.py --mark {sid}",
        "再收尾。FAIL 则修复后重验。若本次改动确实无需这些门,说明理由后直接 --mark。",
        "(此门每轮最多拦一次,不会循环阻塞。)",
    ]
    print("\n".join(msg), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
