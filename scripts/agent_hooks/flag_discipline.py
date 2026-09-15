#!/usr/bin/env python3
"""flag 纪律门(制作人 2026-09-15 定):不准自己写 flag,派生 flag 只读;编排一律走叙事状态机。

规则正文只在 agent_docs/content/norms.md 第 10 条;这里只放注入用的摘要和机械检测。
一个脚本按 hook_event_name 分派,接线见 .claude/settings.json:

- PostToolUse(Skill)          载入策划类技能(production-mode 等)后立刻把规则注进上下文。
- UserPromptSubmit            用户提内容/编排类需求时注一条短提醒。
- PreToolUse(Edit|Write)      写 public/assets/**.json 前算"写前 vs 写后"新增的 flag 写入:
                              · 写引擎维护的只读 flag(registry.patterns + FlagKeys.ts + 系统里
                                flagStore.set 的固定键,现场提取)→ 永远拒绝;
                              · 写自造 flag / 往 flag_registry.static 登记新键 → 第一次拒绝,
                                原样重试同一写入才放行(给制作人一条可见提示)。
- PreToolUse(Bash|PowerShell) 只做毫秒级 stat 快照 + 给变更过的文件补算基线。
- PostToolUse(Bash|PowerShell) 脚本改了 JSON(绕过写入门)→ 事后把新增 flag 写入注回上下文。

只查"写":setFlag / appendFlag / addFlagValue 与 static 新登记。条件里读 flag(含派生 flag)不管。
任何异常 fail-open,绝不因门自身的 bug 卡住工作。

自检:`sh scripts/py.sh scripts/agent_hooks/flag_discipline.py --scan <file.json>` 打印该文件的写入计数。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_PREFIX = "public/assets/"
REGISTRY_REL = "public/assets/data/flag_registry.json"

FLAG_WRITE_TYPES = ("setFlag", "appendFlag", "addFlagValue")

PLANNING_SKILLS = {"production-mode", "pure-data-iteration", "gameplay-iteration"}
PROMPT_RE = re.compile(
    r"策划|做内容|编排|叙事|剧情|对话|过场|演出|任务|支线|主线|遭遇|规矩|场景交互|热区|状态机|flag|改数据|json",
    re.IGNORECASE,
)

RULE_SHORT = (
    "【flag 纪律·制作人 2026-09-15 定】不准自己写 flag(setFlag/appendFlag/addFlagValue、登记新 flag);"
    "引擎派生的 flag(has_item_*、rule_*_acquired 等)只读,条件里可以读、绝不许写。"
    "进度/门控/\"做过没有\"/跨线依赖一律走叙事状态机。正文 agent_docs/content/norms.md 第 10 条。"
)

RULE_FULL = "\n".join([
    "【flag 纪律·必读·制作人 2026-09-15 定】",
    "不准自己写 flag:setFlag / appendFlag / addFlagValue、往 flag_registry 登记新 flag,默认一律不做。",
    "编排(任务/对话/过场/场景交互/遭遇)一律走叙事状态机:",
    "  · 推进 / 门控 → 信号驱动状态迁移;读取侧用 {\"narrative\": 图id, \"state\": 状态id} 条件叶",
    "  · \"做过没有 / 一次性\" → 该段 flow 的状态本身",
    "  · 跨线依赖 → narrative 叶直接查对方图的状态",
    "引擎派生 / 维护的 flag 只读:has_item_* / item_count_* / coins / rule_*_acquired / quest_*_status /",
    "archive_* / clue_* / picked_up_* / sysnote_* / current_day / player_health 等,条件里可以读,绝不许写。",
    "少数实在需要自己写的,在汇报里逐条向制作人写明为什么状态机表达不了。",
    "动手前读 agent_docs/content/norms.md 第 10 条 + agent_docs/content/methods/narrative-flow-authoring.md。",
])

READ_ONLY_HINT = (
    "引擎维护的 flag 只读(背包/钱/规矩/任务/档案/线索/说明卡/时间/生命/气味各自的系统在写),"
    "数据里写它等于绕过那个系统,两边会对不上。改用对应系统的 action:giveItem/removeItem、"
    "giveCurrency/removeCurrency、giveRule/grantRuleLayer/giveFragment、updateQuest、addArchiveEntry、"
    "collectClue、showSystemNote、setThreeFiresVisible、advanceTime/endDay、healPlayer/damagePlayer…"
)


# ---------------------------------------------------------------- 检测

_TS_LITERAL_SET = re.compile(r"flagStore\??\.set\(\s*['\"]([^'\"]+)['\"]")
_TS_TEMPLATE_SET = re.compile(r"flagStore\??\.set\(\s*`([A-Za-z0-9_]*)\$\{[^}]*\}([A-Za-z0-9_]*)`")
_FLAGKEYS_LITERAL = re.compile(r":\s*'([^']+)'")
_FLAGKEYS_TEMPLATE = re.compile(r"`([A-Za-z0-9_]*)\$\{[^}]*\}([A-Za-z0-9_]*)`")


def _engine_owned() -> tuple[set[str], list[tuple[str, str]]]:
    """引擎自己维护的 flag(只读):flag_registry.patterns + src/core/FlagKeys.ts + 系统里 flagStore.set 的固定键。

    清单不手抄,现场从这三处取——只在确实检测到新增写入时才调用,平时零开销。
    """
    exact: set[str] = set()
    pats: list[tuple[str, str]] = []
    try:
        reg = json.loads((REPO_ROOT / REGISTRY_REL).read_text(encoding="utf-8-sig"))
        pats += [(str(p.get("prefix") or ""), str(p.get("suffix") or ""))
                 for p in reg.get("patterns") or [] if p.get("prefix") or p.get("suffix")]
    except Exception:
        pass
    flag_keys = read_text(REPO_ROOT / "src/core/FlagKeys.ts")
    exact.update(_FLAGKEYS_LITERAL.findall(flag_keys))
    pats += [m for m in _FLAGKEYS_TEMPLATE.findall(flag_keys) if m[0] or m[1]]
    for root, _dirs, files in os.walk(REPO_ROOT / "src"):
        for name in files:
            if not name.endswith(".ts") or name.endswith(".test.ts"):
                continue
            text = read_text(Path(root) / name)
            if "flagStore" not in text:
                continue
            exact.update(_TS_LITERAL_SET.findall(text))
            pats += [m for m in _TS_TEMPLATE_SET.findall(text) if m[0] or m[1]]
    return exact, pats


def classify(plus: list[str]) -> tuple[list[str], list[str]]:
    """把新增写入分成 (写引擎维护的只读 flag, 自己写 flag)。sig 形如「写 setFlag key [×n]」。"""
    exact, pats = _engine_owned()
    ro, own = [], []
    for sig in plus:
        parts = sig.split(" ")
        key = parts[2] if sig.startswith("写 ") and len(parts) >= 3 else ""
        if key and (key in exact or any(key.startswith(a) and key.endswith(b) for a, b in pats)):
            ro.append(sig)
        else:
            own.append(sig)
    return ro, own


def _usage_of(obj, rel: str) -> Counter:
    counts: Counter = Counter()

    def walk(node) -> None:
        if isinstance(node, dict):
            t = node.get("type")
            if t in FLAG_WRITE_TYPES:
                params = node.get("params") if isinstance(node.get("params"), dict) else node
                key = str(params.get("key") or "?").replace(" ", "_")
                counts[f"写 {t} {key}"] += 1
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    if rel == REGISTRY_REL and isinstance(obj, dict):
        for e in obj.get("static") or []:
            if isinstance(e, dict) and e.get("key"):
                counts[f"登记 {e['key']}"] += 1
    else:
        walk(obj)
    return counts


def usage_of_text(text: str, rel: str) -> Counter | None:
    try:
        return _usage_of(json.loads(text), rel)
    except Exception:
        return None


def added(old: Counter, new: Counter) -> list[str]:
    out = []
    for sig, n in sorted(new.items()):
        d = n - old.get(sig, 0)
        if d > 0:
            out.append(sig if d == 1 else f"{sig} ×{d}")
    return out


def rel_of(path: str) -> str | None:
    if not path:
        return None
    try:
        rel = Path(path).resolve().relative_to(REPO_ROOT).as_posix()
    except (ValueError, OSError):
        return None
    if rel.startswith(ASSETS_PREFIX) and rel.endswith(".json"):
        return rel
    return None


def read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8-sig")
    except Exception:
        return ""


# ---------------------------------------------------------------- 状态(系统临时目录,按会话)

def state_path(sid: str, name: str) -> Path:
    safe = "".join(c for c in sid if c.isalnum() or c in "-_")[:64] or "nosession"
    return Path(tempfile.gettempdir()) / f"gamedraft_flaggate_{name}_{safe}.json"


def load_state(sid: str, name: str) -> dict:
    try:
        return json.loads(state_path(sid, name).read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(sid: str, name: str, data: dict) -> None:
    p = state_path(sid, name)
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)
    except Exception:
        pass


def emit(payload: dict) -> None:
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def bullet(sigs: list[str]) -> str:
    return "\n".join(f"  + {s}" for s in sigs)


# ---------------------------------------------------------------- 各事件

def on_skill_loaded(data: dict) -> None:
    skill = str((data.get("tool_input") or {}).get("skill") or "").split(":")[-1]
    if skill not in PLANNING_SKILLS:
        return
    emit({
        "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": RULE_FULL},
        "suppressOutput": True,
    })


def on_prompt(data: dict) -> None:
    if not PROMPT_RE.search(str(data.get("prompt") or "")):
        return
    emit({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": RULE_SHORT}})


def _after_edit(disk: str, inp: dict) -> str | None:
    edits = inp.get("edits") if isinstance(inp.get("edits"), list) else [inp]
    # Edit 工具按 LF 匹配;CRLF 落盘的 JSON 不先归一就永远对不上,门会静默失效
    text = disk.replace("\r\n", "\n")
    for e in edits:
        old_s, new_s = e.get("old_string"), e.get("new_string")
        if not isinstance(old_s, str) or not isinstance(new_s, str) or old_s not in text:
            return None
        text = text.replace(old_s, new_s) if e.get("replace_all") else text.replace(old_s, new_s, 1)
    return text


def on_pre_write(data: dict) -> None:
    inp = data.get("tool_input") or {}
    rel = rel_of(str(inp.get("file_path") or ""))
    if not rel:
        return
    disk_path = REPO_ROOT / rel
    disk = read_text(disk_path) if disk_path.is_file() else ""
    if data.get("tool_name") == "Write":
        new_text = inp.get("content") if isinstance(inp.get("content"), str) else None
    else:
        new_text = _after_edit(disk, inp)
    if new_text is None:
        return
    new_u = usage_of_text(new_text, rel)
    if new_u is None:  # 写完不是合法 JSON:交给别的门
        return
    old_u = (usage_of_text(disk, rel) if disk else None) or Counter()
    plus = added(old_u, new_u)
    if not plus:
        return

    read_only, plus = classify(plus)
    if read_only:
        emit({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"【flag 纪律门】这次写入 {rel} 在写引擎维护的只读 flag:\n{bullet(read_only)}\n\n"
                    f"{READ_ONLY_HINT}\n这类写入重试也不会放行。\n\n{RULE_FULL}"
                ),
            },
        })
        return

    sid = str(data.get("session_id") or "")
    digest = hashlib.sha1((rel + "\n" + "\n".join(plus)).encode("utf-8")).hexdigest()
    seen = load_state(sid, "denied")
    if digest in seen:
        emit({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "flag 纪律门:同一写入第二次提交,按\"实在需要\"放行",
                "additionalContext": (
                    f"flag 纪律门已放行 {rel} 自己写 flag:\n{bullet(plus)}\n"
                    "给制作人的汇报里必须逐条写明:为什么叙事状态机表达不了。"
                ),
            },
            "systemMessage": f"⚠ flag 纪律门:放行了 {rel} 自己写 flag({len(plus)} 处),agent 须在汇报里说明理由",
        })
        return
    seen[digest] = rel
    save_state(sid, "denied", seen)
    emit({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                f"【flag 纪律门】这次写入 {rel} 在自己写 flag:\n{bullet(plus)}\n\n{RULE_FULL}\n\n"
                "先改用叙事状态机重写这次改动。实在非写 flag 不可 → 原样重试同一写入即放行,"
                "并在汇报里逐条写明理由。"
            ),
        },
    })


def _scan_assets() -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    base = REPO_ROOT / ASSETS_PREFIX
    for root, _dirs, files in os.walk(base):
        for name in files:
            if not name.endswith(".json"):
                continue
            p = Path(root) / name
            try:
                st = p.stat()
            except OSError:
                continue
            out[p.relative_to(REPO_ROOT).as_posix()] = [st.st_mtime_ns, st.st_size]
    return out


def on_pre_shell(data: dict) -> None:
    sid = str(data.get("session_id") or "")
    stats = _scan_assets()
    cache = load_state(sid, "baseline2")
    changed = False
    for rel, st in stats.items():
        entry = cache.get(rel)
        if entry and entry[0] == st:
            continue
        u = usage_of_text(read_text(REPO_ROOT / rel), rel)
        cache[rel] = [st, dict(u) if u is not None else None]
        changed = True
    for rel in [r for r in cache if r not in stats]:
        del cache[rel]
        changed = True
    if changed:
        save_state(sid, "baseline2", cache)


def on_post_shell(data: dict) -> None:
    sid = str(data.get("session_id") or "")
    cache = load_state(sid, "baseline2")
    if not cache:
        return
    stats = _scan_assets()
    per_file: list[tuple[str, list[str]]] = []
    for rel, st in stats.items():
        entry = cache.get(rel)
        if entry and entry[0] == st:
            continue
        new_u = usage_of_text(read_text(REPO_ROOT / rel), rel)
        old_raw = entry[1] if entry else {}
        if new_u is not None and old_raw is not None:
            plus = added(Counter(old_raw), new_u)
            if plus:
                per_file.append((rel, plus))
        cache[rel] = [st, dict(new_u) if new_u is not None else None]
    save_state(sid, "baseline2", cache)
    if not per_file:
        return
    report: list[str] = []
    hit_read_only = False
    for rel, plus in per_file:
        read_only, own = classify(plus)
        hit_read_only = hit_read_only or bool(read_only)
        lines = [f"  + {s}  ← 只读 flag,必须改回" for s in read_only] + [f"  + {s}" for s in own]
        report.append(f"{rel}:\n" + "\n".join(lines))
    tail = (f"标「只读」的必须立即改回:{READ_ONLY_HINT}\n" if hit_read_only else "") + (
        "自己写 flag 的,能改用叙事状态机的立即改回;实在非写不可的,在汇报里逐条写明理由。")
    emit({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": (
                "【flag 纪律门·事后】刚才的命令改了 JSON,绕过了写入前的门,新增了 flag 写入:\n"
                + "\n".join(report) + f"\n\n{RULE_FULL}\n\n{tail}"
            ),
        },
        "systemMessage": f"⚠ flag 纪律门:脚本新增了 flag 写入({len(report)} 个文件),已要求 agent 复查",
    })


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "--scan":
        p = Path(sys.argv[2])
        rel = rel_of(sys.argv[2]) or p.as_posix()
        u = usage_of_text(read_text(p), rel) or Counter()
        read_only, _own = classify(sorted(u))
        sys.stdout.buffer.write(("\n".join(
            f"{n}\t{s}{'  [只读 flag]' if s in read_only else ''}" for s, n in sorted(u.items())
        ) + "\n").encode("utf-8"))
        return
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except Exception:
        return
    event = data.get("hook_event_name")
    tool = data.get("tool_name")
    if event == "UserPromptSubmit":
        on_prompt(data)
    elif event == "PostToolUse" and tool == "Skill":
        on_skill_loaded(data)
    elif event == "PreToolUse" and tool in ("Edit", "Write", "MultiEdit"):
        on_pre_write(data)
    elif event == "PreToolUse" and tool in ("Bash", "PowerShell"):
        on_pre_shell(data)
    elif event == "PostToolUse" and tool in ("Bash", "PowerShell"):
        on_post_shell(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
