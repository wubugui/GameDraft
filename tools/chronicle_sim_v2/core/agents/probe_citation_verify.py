"""探针文末「--- 引用 ---」JSON 与本轮 cwd 内 chronicle/ 原文、tool_log read_file 记录的严格校验。"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

ToolCallLog = list[dict[str, Any]]


def _norm_rel_path(p: str) -> str:
    return (p or "").replace("\\", "/").strip("/")


def _collect_read_file_paths(tool_log: ToolCallLog) -> set[str]:
    """从 tool_log 中取出 read_file 类调用的相对路径集合（posix 归一化）。"""
    out: set[str] = set()
    for row in tool_log:
        name = (row.get("tool_name") or "").lower()
        if name != "read_file" and not name.endswith("_read_file"):
            continue
        args = row.get("args") or {}
        if not isinstance(args, dict):
            continue
        path = _norm_rel_path(str(args.get("path", "") or ""))
        if path:
            out.add(path)
    return out


def _log_used_read_file(tool_log: ToolCallLog) -> bool:
    for row in tool_log:
        n = (row.get("tool_name") or "").lower()
        if n == "read_file" or n.endswith("_read_file"):
            return True
    return False


def _grep_path_covers_full_chronicle_scope(rel: str) -> bool:
    p = _norm_rel_path(rel)
    return p == "" or p == "chronicle"


def _grep_return_is_no_match(content: str) -> bool:
    s = (content or "").strip()
    if not s:
        return True
    return s == "未找到匹配" or "no matches" in s.lower() or s.lower() == "no results"


def _log_has_broad_grep_no_match(tool_log: ToolCallLog) -> bool:
    for row in tool_log:
        n = (row.get("tool_name") or "").lower()
        if n != "grep_search" and not n.endswith("_grep_search"):
            continue
        args = row.get("args") or {}
        if not isinstance(args, dict):
            continue
        path = str(args.get("path", "") or "")
        content = str(row.get("content") or "")
        if _grep_return_is_no_match(content) and _grep_path_covers_full_chronicle_scope(path):
            return True
    return False


def _main_and_refs_block(text: str) -> tuple[str, str | None, str | None]:
    """返回 (main, raw_json_tail or None, error_reason or None)。"""
    if "--- 引用 ---" not in text:
        return text, None, "缺少「--- 引用 ---」区块"
    main, _, tail = text.partition("--- 引用 ---")
    raw = tail.strip()
    if not raw:
        return main.strip(), None, "「--- 引用 ---」后无内容"
    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        return main.strip(), None, f"引用 JSON 无法解析: {e}"
    return main.strip(), raw, None


def _empty_refs_allowed_with_main(main: str) -> bool:
    """引用为 [] 时：若正文写多条「灵感」却无「未找到」类表述，则不允许。"""
    if not re.search(r"- \*\*灵感\*\*", main):
        return True
    if re.search(r"未找到|未记载|未在本地|未检索到|无相关|查无|没有记载", main):
        return True
    return False


def _quote_in_content(quote: str, content: str) -> bool:
    if not quote:
        return False
    q = quote.strip()
    if not q:
        return False
    if q in content:
        return True
    q2 = re.sub(r"\s+", " ", q)
    c2 = re.sub(r"\s+", " ", content)
    return q2 in c2


def _read_cwd_text(cwd_root: Path, rel: str) -> str | None:
    """安全读 cwd 下相对路径文本；越界/不存在返回 None。"""
    if not rel:
        return None
    try:
        base = cwd_root.resolve()
        target = (cwd_root / rel).resolve()
        target.relative_to(base)
    except (OSError, ValueError):
        return None
    if not target.is_file():
        return None
    try:
        return target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def verify_probe_citation(
    answer_text: str,
    tool_log: ToolCallLog,
    cwd_root: Path,
) -> tuple[bool, list[str]]:
    """
    校验 answer_text 中的引用是否与本轮 cwd 下 chronicle/ 原文一致。

    规则：
      - 引用数组每项：`path` 必须指向 `cwd_root/<path>` 下实际存在的文件；
      - `quote` / `excerpt` 必须是该文件正文的连续子串；
      - 且 `tool_log` 中必须有对应 `read_file` 记录（path 归一化后匹配）；
      - 引用为 `[]` 时：正文需含「未找到/未记载」类措辞，或未列「灵感」条目。
    """
    reasons: list[str] = []
    main, raw_json, err = _main_and_refs_block(answer_text)
    if err:
        return False, [err]
    if raw_json is None:
        return False, ["缺少「--- 引用 ---」区块"]

    try:
        refs = json.loads(raw_json)
    except json.JSONDecodeError as e:
        return False, [f"引用 JSON 无法解析: {e}"]

    if not isinstance(refs, list):
        return False, ["引用须为 JSON 数组"]

    if len(refs) == 0:
        if not _empty_refs_allowed_with_main(main):
            reasons.append("引用为 [] 但正文仍含「灵感」条目且未明确说明未找到/未记载")
        return (len(reasons) == 0), reasons

    logged_paths = _collect_read_file_paths(tool_log)

    for i, item in enumerate(refs, 1):
        if not isinstance(item, dict):
            reasons.append(f"引用第 {i} 条不是 JSON 对象")
            continue
        path = _norm_rel_path(str(item.get("path", "")))
        quote = str(item.get("quote", item.get("excerpt", "")) or "")
        if not path:
            reasons.append(f"引用第 {i} 条缺少 path")
            continue
        if not quote:
            reasons.append(f"引用第 {i} 条缺少 quote/excerpt")
            continue

        content = _read_cwd_text(cwd_root, path)
        if content is None:
            reasons.append(f"引用第 {i} 条 path「{path}」在 cwd 下不存在或越界")
            continue

        if path not in logged_paths:
            reasons.append(
                f"引用第 {i} 条 path「{path}」未出现在本轮 read_file 工具日志中"
            )
            continue

        if not _quote_in_content(quote, content):
            reasons.append(
                f"引用第 {i} 条：path「{path}」的 quote 不是该文件的连续子串"
            )

    return (len(reasons) == 0), reasons


def build_citation_diagnostic_prompt(failures: list[str]) -> str:
    """校验失败时发给模型的修正说明。"""
    lines = "\n".join(f"{i}. {x}" for i, x in enumerate(failures, 1))
    return (
        "【系统·引用校验未通过】\n"
        "上文输出未通过程序化校验：文末「--- 引用 ---」中的摘录必须出现在对应 path 在本轮 "
        "`read_file` 工具返回（cwd 下 chronicle/ 的原文）中。以下为具体问题：\n\n"
        f"{lines}\n\n"
        "请在本轮对话中直接输出**修正后的完整回答**（保留「--- 引用 ---」与 JSON 数组，"
        "不要重复用户原问题）。\n"
        "做法：对需保留的引用条目，对该 path 重新执行 `read_file`，从返回内容中**逐字**复制"
        "短摘录到 `quote`；若确实无据可写，删除不实灵感，并在正文说明「未找到/未记载」，引用使用 `[]`。"
    )


PROBE_CITATION_FAILURE_MESSAGE = (
    "本次回答未通过引用校验：摘录与磁盘读取内容仍不一致，或引用路径未通过 read_file。"
    "请重试提问或更换模型。"
)

PROBE_CITATION_REJECT_MARKER = "[probe:citation_rejected]\n"


__all__ = [
    "ToolCallLog",
    "PROBE_CITATION_FAILURE_MESSAGE",
    "PROBE_CITATION_REJECT_MARKER",
    "build_citation_diagnostic_prompt",
    "verify_probe_citation",
    "_log_used_read_file",
    "_log_has_broad_grep_no_match",
]
