"""探针 Agent：基于当前 Run 编年史与工具回答用户问题（多轮会话）。"""
from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.agent import AgentRunResult
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.usage import UsageLimits

from tools.chronicle_sim_v2.core.agents.tools import probe_tools
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings
from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced


def _is_read_file_tool(tool_name: str) -> bool:
    n = (tool_name or "").lower()
    return n == "read_file" or n.endswith("_read_file")


def _result_used_read_file(result: AgentRunResult[Any]) -> bool:
    """本轮 agent.run 的消息里是否出现过 read_file 工具调用或返回。"""
    for msg in result.all_messages():
        if not isinstance(msg, ModelResponse):
            continue
        for part in msg.parts:
            if isinstance(part, ToolCallPart) and _is_read_file_tool(part.tool_name):
                return True
            if isinstance(part, ToolReturnPart) and _is_read_file_tool(part.tool_name):
                return True
    return False


# 单轮内允许较多「模型↔工具」往返；过紧会导致只调一次 chroma 就收尾。
_PROBE_USAGE = UsageLimits(request_limit=160, tool_calls_limit=72)


def build_probe_agent(pa: PAChatResources, prompts_dir: Path, run_dir: Path) -> Agent:
    p = prompts_dir / "probe_agent.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是编年史素材探针。"

    return Agent(
        model=pa.model,
        system_prompt=system,
        tools=probe_tools(run_dir),
        model_settings=merged_settings(pa),
    )


async def run_probe_user_turn(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    user_text: str,
    *,
    message_history: Sequence[ModelMessage] | None = None,
) -> str:
    """执行用户一轮提问；message_history 为此前轮次（不含本轮 user）。"""
    agent = build_probe_agent(pa, prompts_dir, run_dir)
    if not (user_text or "").strip():
        return ""

    suffix = (
        "\n\n（硬约束：给出实质性内容前须对 chronicle/ 下相关文件调用 read_file 核对原文；"
        "chroma_search_world 仅用于找路径，不可替代 read_file。"
        "每条结论须有依据：相对路径 + id/type_id（若有）+ 短摘录。"
        "文末必须有「--- 引用 ---」及 JSON 数组，字段含 path、ref、quote。）"
    )
    if not message_history:
        user_prompt = (
            f"{user_text.strip()}\n\n"
            "（工作空间：本 Run 根目录；可用 list/grep/glob/read_file 与（可选）语义检索。）"
            f"{suffix}"
        )
    else:
        user_prompt = user_text.strip() + suffix

    base_hist = list(message_history) if message_history else []

    result = await run_agent_traced(
        pa,
        agent,
        user_prompt,
        message_history=base_hist,
        model_settings=merged_settings(pa),
        usage_limits=_PROBE_USAGE,
    )

    if not _result_used_read_file(result):
        nudge = (
            "【系统】检测到你在本轮尚未调用 read_file 打开 chronicle/ 下的具体文件。"
            "请继续在同一轮任务中调用工具：对 chroma/grep 得到的路径至少执行一次 read_file，"
            "读取事件 JSON 或 summary.md 原文后再输出最终回答（含分条依据与文末 --- 引用 --- JSON）。"
            "禁止在未 read_file 时直接输出长篇灵感。"
        )
        hist2 = base_hist + list(result.new_messages())
        result = await run_agent_traced(
            pa,
            agent,
            nudge,
            message_history=hist2,
            model_settings=merged_settings(pa),
            usage_limits=_PROBE_USAGE,
        )

    out = result.output
    if isinstance(out, str):
        text = out
    else:
        text = str(out)
    if not _result_used_read_file(result):
        text += (
            "\n\n（系统注：仍未检测到 read_file 工具调用；若模型未遵守提示，请重试或更换模型。"
            "可靠回答应以 chronicle/ 下 JSON 原文为准。）"
        )
    return text
