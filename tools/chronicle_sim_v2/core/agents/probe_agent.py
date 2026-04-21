"""探针 Agent：与其他 agent 完全一致的运行框架（run_agent_cline + AgentSpec），
在其之上叠加「多轮 nudge」「引用校验」两条高阶策略。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.agents.probe_citation_verify import (
    PROBE_CITATION_FAILURE_MESSAGE,
    PROBE_CITATION_REJECT_MARKER,
    ToolCallLog,
    _log_has_broad_grep_no_match,
    _log_used_read_file,
    build_citation_diagnostic_prompt,
    verify_probe_citation,
)
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import AgentSpec, load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import RunnerResult, run_agent_cline
from tools.chronicle_sim_v2.core.llm.cline_workspace import cleanup_temp_ws
from tools.chronicle_sim_v2.core.llm.llm_trace import emit_llm_trace

_READ_FILE_NUDGE = (
    "【系统】本轮尚未通过 `read_file` 打开 `chronicle/` 下任何具体文件。"
    "请继续按 .clinerules 约束调用工具：先 list/grep 定位路径，然后对事件 JSON 或 "
    "`summary.md`/`month_*.md` 至少 `read_file` 一次，再输出最终回答（含分条依据与文末「--- 引用 ---」JSON）。"
    "例外：若你已在 cwd 根或 `chronicle` 根范围 grep，且返回「未找到匹配」，可直接作答「未找到」，引用用 `[]`。"
)

_SYSTEM_NOTE_NO_TOOL = (
    "\n\n（系统注：仍未检测到 read_file 类工具调用；"
    "若模型未遵守提示，请重试或更换模型。可靠回答应以 chronicle/ 下 JSON 原文为准。）"
)


def _build_user_text(
    spec: AgentSpec, *, user_question: str, prior_turns_text: str | None
) -> str:
    prior_block = ""
    if prior_turns_text and prior_turns_text.strip():
        prior_block = (
            "以下为此前对话（旧消息在上，新消息在下）：\n\n"
            f"{prior_turns_text.strip()}\n\n---\n\n当前用户问题：\n"
        )
    return render_user(
        spec,
        {
            "prior_turns_block": prior_block,
            "user_question": user_question.strip(),
        },
    )


async def _run_once(
    pa: AgentLLMResources,
    run_dir: Path,
    spec: AgentSpec,
    user_text: str,
) -> RunnerResult:
    """保留 cwd 以便引用校验读原文；调用方负责清理。"""
    return await run_agent_cline(
        pa,
        run_dir,
        spec,
        user_text=user_text,
        keep_temp_ws=True,
    )


def _tool_log_ok(tool_log: ToolCallLog) -> bool:
    return _log_used_read_file(tool_log) or _log_has_broad_grep_no_match(tool_log)


async def run_probe_user_turn(
    pa: AgentLLMResources,
    run_dir: Path,
    user_text: str,
    *,
    prior_turns_text: str | None = None,
) -> str:
    """执行用户一轮提问。返回最终给用户看到的文本（不含裁剪标记时即原文）。"""
    if not (user_text or "").strip():
        return ""

    spec = load_agent_spec("probe")
    base_user = _build_user_text(
        spec, user_question=user_text, prior_turns_text=prior_turns_text
    )

    pending_ws: list[Path] = []

    def _remember(res: RunnerResult) -> None:
        if res.temp_ws_path is not None:
            pending_ws.append(res.temp_ws_path)

    def _cleanup_all() -> None:
        while pending_ws:
            ws = pending_ws.pop()
            try:
                cleanup_temp_ws(ws)
            except OSError as e:
                emit_llm_trace(f"[probe·cleanup] rmtree failed ws={ws.name} err={e!r}")

    try:
        r1 = await _run_once(pa, run_dir, spec, base_user)
        _remember(r1)
        text, tool_log, cwd_root = r1.text, r1.tool_log, r1.temp_ws_path

        if not _tool_log_ok(tool_log):
            r2 = await _run_once(pa, run_dir, spec, base_user + "\n\n" + _READ_FILE_NUDGE)
            _remember(r2)
            text, tool_log, cwd_root = r2.text, r2.tool_log, r2.temp_ws_path

        if not _tool_log_ok(tool_log):
            return text + _SYSTEM_NOTE_NO_TOOL

        assert cwd_root is not None
        ok, reasons = verify_probe_citation(text, tool_log, cwd_root)
        if ok:
            return text

        emit_llm_trace(f"[probe·citation] first_pass=false reasons={reasons!r}")
        diag = build_citation_diagnostic_prompt(reasons)
        r3 = await _run_once(pa, run_dir, spec, base_user + "\n\n" + diag)
        _remember(r3)
        text2, tool_log2, cwd_root2 = r3.text, r3.tool_log, r3.temp_ws_path
        assert cwd_root2 is not None
        ok2, reasons2 = verify_probe_citation(text2, tool_log2, cwd_root2)
        if ok2:
            return text2

        emit_llm_trace(f"[probe·citation] second_pass=false reasons={reasons2!r}")
        return PROBE_CITATION_REJECT_MARKER + PROBE_CITATION_FAILURE_MESSAGE
    finally:
        _cleanup_all()
