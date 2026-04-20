"""探针文末引用 JSON 与本轮 read_file 工具返回的严格校验（子串）。"""
from __future__ import annotations

import json
import re
from typing import Any

from tools.chronicle_sim_v2.core.world.fs import READ_TEXT_AGENT_ERROR_PREFIX

ToolCallLog = list[dict[str, Any]]


def _norm_rel_path(p: str) -> str:
    return (p or "").replace("\\", "/").strip("/")


def _parse_read_file_args_from_log(args: Any) -> str:
    if isinstance(args, dict):
        return str(args.get("path", "") or "")
    return ""


def collect_read_file_path_to_content_from_log(tool_log: ToolCallLog) -> dict[str, str]:
    """从工具调用日志汇总 read_file 的路径与返回正文（posix 相对路径为键）。"""
    out: dict[str, str] = {}
    for row in tool_log:
        name = (row.get("tool_name") or "").lower()
        if name != "read_file" and not name.endswith("_read_file"):
            continue
        args = row.get("args") or {}
        path = _norm_rel_path(_parse_read_file_args_from_log(args))
        if not path:
            continue
        content = str(row.get("content") or "")
        out[path] = content
    return out


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
    """引用为 [] 时：若正文仍写多条灵感却无「未找到」类表述，则不允许。"""
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


def verify_probe_citation(
    answer_text: str,
    tool_log: ToolCallLog,
) -> tuple[bool, list[str]]:
    """
    校验 answer_text 中的引用是否与本轮 read_file 一致。

    返回 (通过, 失败原因列表)；通过时原因列表为空。
    """
    reasons: list[str] = []
    path_map = collect_read_file_path_to_content_from_log(tool_log)

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

    for i, item in enumerate(refs, 1):
        if not isinstance(item, dict):
            reasons.append(f"引用第 {i} 条不是 JSON 对象")
            continue
        path = _norm_rel_path(str(item.get("path", "")))
        quote = str(item.get("quote", "") or "")
        if not path:
            reasons.append(f"引用第 {i} 条缺少 path")
            continue
        if not quote:
            reasons.append(f"引用第 {i} 条缺少 quote")
            continue

        if path not in path_map:
            reasons.append(
                f"引用第 {i} 条 path「{path}」在本轮尚未通过 read_file 打开（与工具记录不一致）"
            )
            continue

        content = path_map[path]
        if content.startswith(READ_TEXT_AGENT_ERROR_PREFIX):
            reasons.append(
                f"path「{path}」本轮 read_file 返回为错误信息，不能作为有效 quote 来源"
            )
            continue

        if not _quote_in_content(quote, content):
            reasons.append(
                f"引用第 {i} 条：path「{path}」的 quote 不是该文件 read_file 返回正文中的连续子串"
            )

    return (len(reasons) == 0), reasons


def build_citation_diagnostic_prompt(failures: list[str]) -> str:
    """校验失败时第二次发给模型的说明（须具体，避免与「未读文件」泛泛 nudge 混用）。"""
    lines = "\n".join(f"{i}. {x}" for i, x in enumerate(failures, 1))
    return (
        "【系统·引用校验未通过】\n"
        "上文输出未通过程序化校验：文末「--- 引用 ---」中的摘录必须出现在对应 path 在本轮 "
        "`read_file` 工具返回的正文中（连续子串）。以下为具体问题：\n\n"
        f"{lines}\n\n"
        "请在本轮对话中直接输出**修正后的完整回答**（保留「--- 引用 ---」与 JSON 数组，"
        "不要重复用户原问题）。\n"
        "做法：对需保留的引用条目，对该 path 重新执行 `read_file`，从返回内容中**逐字**复制 "
        "短摘录到 quote；若确实无据可写，删除不实灵感，并在正文说明「未找到/未记载」，引用使用 []。"
    )


PROBE_CITATION_FAILURE_MESSAGE = (
    "本次回答未通过引用校验：摘录与磁盘读取内容仍不一致，或引用路径未通过 read_file。"
    "请重试提问或更换模型。"
)

PROBE_CITATION_REJECT_MARKER = "[probe:citation_rejected]\n"
