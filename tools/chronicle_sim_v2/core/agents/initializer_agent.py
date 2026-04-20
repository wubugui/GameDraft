"""Initializer Agent：从设定库生成 SeedDraft。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.agents.tools import initializer_tools
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources, build_agent_llm_resources
from tools.chronicle_sim_v2.core.llm.config_resolve import effective_connection_block
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile


def build_initializer_pa(llm_config: dict[str, Any], run_dir: Path) -> AgentLLMResources:
    """从 LLM 配置的 initializer 槽位创建 initializer 资源（fallback 到 default）。"""
    cfg = effective_connection_block("initializer", llm_config)
    if not cfg or str(cfg.get("kind", "")).lower() in ("", "stub"):
        cfg = effective_connection_block("default", llm_config)
    if not cfg:
        cfg = {}
    profile = ProviderProfile(
        kind=cfg.get("kind", "stub"),
        model=cfg.get("model", ""),
        base_url=cfg.get("base_url", ""),
        api_key=cfg.get("api_key", ""),
        ollama_host=cfg.get("ollama_host", ""),
    )
    return build_agent_llm_resources("initializer", profile, llm_config=llm_config, run_dir=run_dir)


def _init_llm_overrides() -> dict[str, Any]:
    """initializer 需要思考，覆盖 DashScope 默认 thinking=False（与 default_extra 合并）。"""
    return {"thinking": True, "extra_body": {"enable_thinking": True}}


async def run_initializer(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    ideas_text: str,
    log_callback=None,
) -> dict[str, Any]:
    """运行 Initializer，返回 SeedDraft dict。"""
    p = prompts_dir / "initializer_agent.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是种子提取器，从设定内容中提取世界种子。"
    system = system.replace("{{TARGET_NPC_COUNT}}", "10")
    system = system.replace("{{TRUNCATION_NOTE}}", "")

    user_text = f"以下是设定库内容，请从中提取世界种子：\n\n{ideas_text}"

    if log_callback:
        log_callback("=== LLM 调用详情 ===")
        log_callback(f"  llm class: {pa.llm.__class__.__name__}")
        log_callback(f"  llm repr: {pa.llm!r}")
        log_callback(f"--- System Prompt ({len(system)} 字) ---")
        log_callback(system)
        log_callback(f"--- User Message ({len(user_text)} 字) ---")
        log_callback(user_text[:5000] + ("…" if len(user_text) > 5000 else ""))
        log_callback("--- User Message End ---")

    crew = make_single_agent_crew(
        pa,
        role="种子提取器",
        goal="从设定库输出 SeedDraft JSON。",
        backstory=system,
        tools=initializer_tools(run_dir),
        task_description=user_text,
        expected_output="符合提示的 JSON 世界种子对象。",
        max_iter=45,
        llm_overrides=_init_llm_overrides(),
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_text, audit_system_hint=system[:8000])
    raw = crew_output_text(out)

    if log_callback:
        log_callback(f"--- LLM Raw Response ({len(raw)} 字) ---")
        log_callback(raw[:5000] + ("…" if len(raw) > 5000 else ""))
        log_callback("--- Raw Response End ---")

    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object

    return parse_json_object(raw)
