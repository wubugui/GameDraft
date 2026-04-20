"""探针 Agent：基于当前 Run 编年史与工具回答用户问题（多轮会话）。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.agents.probe_citation_verify import (
    PROBE_CITATION_FAILURE_MESSAGE,
    PROBE_CITATION_REJECT_MARKER,
    ToolCallLog,
    build_citation_diagnostic_prompt,
    verify_probe_citation,
)
from tools.chronicle_sim_v2.core.agents.tools import probe_tools
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced
from tools.chronicle_sim_v2.core.llm.llm_trace import emit_llm_trace


def _grep_path_covers_full_chronicle_scope(rel: str) -> bool:
    """与 fs.grep_search 一致：空 path = 整 Run 根；仅 chronicle/ 根（非子目录）= 全编年史树。"""
    p = (rel or "").replace("\\", "/").strip()
    if not p:
        return True
    p = p.strip("/")
    return p == "chronicle"


def _grep_return_is_no_match(content: str) -> bool:
    return (content or "").strip() == "未找到匹配"


def _log_used_read_file(tool_log: ToolCallLog) -> bool:
    for row in tool_log:
        n = (row.get("tool_name") or "").lower()
        if n == "read_file" or n.endswith("_read_file"):
            return True
    return False


def _log_has_broad_grep_no_match(tool_log: ToolCallLog) -> bool:
    for row in tool_log:
        n = (row.get("tool_name") or "").lower()
        if n != "grep_search" and not n.endswith("_grep_search"):
            continue
        args = row.get("args") or {}
        path = str(args.get("path", "") or "")
        content = str(row.get("content") or "")
        if _grep_return_is_no_match(content) and _grep_path_covers_full_chronicle_scope(path):
            return True
    return False


_PROBE_MAX_ITER = 72


async def run_probe_user_turn(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    user_text: str,
    *,
    prior_turns_text: str | None = None,
) -> str:
    """执行用户一轮提问；prior_turns_text 为此前多轮（不含本轮 user）的拼接上下文。"""
    if not (user_text or "").strip():
        return ""

    tool_log: ToolCallLog = []
    tools = probe_tools(run_dir, instrument_log=tool_log)

    p = prompts_dir / "probe_agent.md"
    system = (
        p.read_text(encoding="utf-8")
        if p.is_file()
        else (
            "你是编年史素材探针：只能根据本 Run 磁盘 chronicle/ 下已读到的原文作答。"
            "若工具检索后仍无相关内容，直说未找到，禁止编造。"
        )
    )

    suffix = (
        "\n\n（硬约束：凡要写出具体情节/人名/地点等，须对 chronicle/ 下相关路径 read_file 核对原文；"
        "不得使用语义检索，只能依赖本机列目录与读文件。"
        "若已在「Run 根」或「chronicle」根范围调用 grep_search 且工具返回「未找到匹配」，可直说编年史中无该字句，"
        "文末「--- 引用 ---」用 []，不必为凑流程再读文件。"
        "若 grep/list 后仍无相关文件、或 read_file 后仍无用户所问的信息，须直接说明「未找到/未记载」，"
        "禁止为凑答案而编造剧情、人名或引用。"
        "每条有效结论须有依据：相对路径 + id/type_id（若有）+ 短摘录。"
        "文末必须有「--- 引用 ---」及 JSON 数组（无内容时为 []）。）"
    )

    if not prior_turns_text:
        task_body = (
            f"{user_text.strip()}\n\n"
            "（工作空间：本 Run 根目录；仅可用 list_dir / list_chronicle_files / grep_search / glob_search / read_file。）"
            f"{suffix}"
        )
    else:
        task_body = (
            f"以下为此前对话（旧消息在上，新消息在下）：\n\n{prior_turns_text}\n\n"
            f"---\n\n当前用户问题：\n{user_text.strip()}{suffix}"
        )

    crew = make_single_agent_crew(
        pa,
        role="编年史探针",
        goal="仅依据本 Run 已读文件回答用户，并满足文末引用格式。",
        backstory=system,
        tools=tools,
        task_description=task_body,
        expected_output="完整回答正文，含「--- 引用 ---」及 JSON 数组。",
        max_iter=_PROBE_MAX_ITER,
    )

    trace_in = task_body[:200_000]
    out = await run_crew_traced(pa, crew, trace_user_preview=trace_in, audit_system_hint=system[:8000])
    text = crew_output_text(out)

    if not _log_used_read_file(tool_log) and not _log_has_broad_grep_no_match(tool_log):
        nudge = (
            "【系统】检测到你在本轮尚未调用 read_file 打开 chronicle/ 下的具体文件。"
            "请继续在同一轮任务中调用工具：对 list/grep/glob 得到的路径至少执行一次 read_file，"
            "读取事件 JSON 或 summary.md 原文后再输出最终回答（含分条依据与文末 --- 引用 --- JSON）。"
            "禁止在未 read_file 时直接输出长篇灵感。"
            "例外：若你已在 Run 根（grep 的 path 留空）或 chronicle 根目录范围 grep，且工具已返回「未找到匹配」，"
            "可直接作答「未找到」且引用用 []，无需再 read_file。"
        )
        tool_log.clear()
        tools2 = probe_tools(run_dir, instrument_log=tool_log)
        task2 = task_body + "\n\n" + nudge
        crew2 = make_single_agent_crew(
            pa,
            role="编年史探针",
            goal="仅依据本 Run 已读文件回答用户，并满足文末引用格式。",
            backstory=system,
            tools=tools2,
            task_description=task2,
            expected_output="完整回答正文，含「--- 引用 ---」及 JSON 数组。",
            max_iter=_PROBE_MAX_ITER,
        )
        out = await run_crew_traced(
            pa,
            crew2,
            trace_user_preview=task2[:200_000],
            audit_system_hint=system[:8000],
        )
        text = crew_output_text(out)

    if not _log_used_read_file(tool_log) and not _log_has_broad_grep_no_match(tool_log):
        text += (
            "\n\n（系统注：仍未检测到 read_file 工具调用；若模型未遵守提示，请重试或更换模型。"
            "可靠回答应以 chronicle/ 下 JSON 原文为准。）"
        )
        return text

    ok_cite, fail_reasons = verify_probe_citation(text, tool_log)
    if ok_cite:
        return text

    emit_llm_trace(f"[probe·citation] first_pass=false reasons={fail_reasons!r}")
    diag = build_citation_diagnostic_prompt(fail_reasons)
    tool_log.clear()
    tools3 = probe_tools(run_dir, instrument_log=tool_log)
    task_fix = task_body + "\n\n" + diag
    crew3 = make_single_agent_crew(
        pa,
        role="编年史探针",
        goal="修正引用与摘录，输出完整回答。",
        backstory=system,
        tools=tools3,
        task_description=task_fix,
        expected_output="修正后的完整回答，含「--- 引用 ---」及 JSON。",
        max_iter=_PROBE_MAX_ITER,
    )
    out_fix = await run_crew_traced(
        pa,
        crew3,
        trace_user_preview=task_fix[:200_000],
        audit_system_hint=system[:8000],
    )
    text2 = crew_output_text(out_fix)
    ok2, fail2 = verify_probe_citation(text2, tool_log)
    if ok2:
        return text2

    emit_llm_trace(f"[probe·citation] second_pass=false reasons={fail2!r}")
    return PROBE_CITATION_REJECT_MARKER + PROBE_CITATION_FAILURE_MESSAGE
