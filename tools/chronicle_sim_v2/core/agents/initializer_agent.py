"""Initializer Agent：从设定库生成 SeedDraft。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.agents.tools import initializer_tools
from tools.chronicle_sim_v2.core.llm.config_resolve import effective_connection_block
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, build_pa_chat_resources, merged_settings
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile


def build_initializer_pa(llm_config: dict[str, Any], run_dir: Path) -> PAChatResources:
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
    return build_pa_chat_resources("initializer", profile, llm_config=llm_config, run_dir=run_dir)


def _init_model_settings(pa: PAChatResources) -> dict[str, Any]:
    """initializer 需要思考，覆盖 DashScope 默认 thinking=False。"""
    base = merged_settings(pa)
    return {**(base or {}), "thinking": True, "extra_body": {"enable_thinking": True}}


def build_initializer_agent(pa: PAChatResources, prompts_dir: Path, run_dir: Path) -> Agent:
    p = prompts_dir / "initializer_agent.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是种子提取器，从设定内容中提取世界种子。"
    # 替换模板变量
    system = system.replace("{{TARGET_NPC_COUNT}}", "10")
    system = system.replace("{{TRUNCATION_NOTE}}", "")

    agent = Agent(
        model=pa.model,
        system_prompt=system,
        tools=initializer_tools(run_dir),
        model_settings=_init_model_settings(pa),
        retries=4,
    )
    return agent


async def run_initializer(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    ideas_text: str,
    log_callback=None,
) -> dict[str, Any]:
    """运行 Initializer，返回 SeedDraft dict。"""
    agent = build_initializer_agent(pa, prompts_dir, run_dir)

    # 打印完整输入供调试
    sys_prompts = getattr(agent, '_system_prompts', ())
    sys_text = "\n".join(sys_prompts) if sys_prompts else "(无)"
    user_text = f"以下是设定库内容，请从中提取世界种子：\n\n{ideas_text}"

    if log_callback:
        log_callback("=== LLM 调用详情 ===")
        log_callback(f"  model class: {pa.model.__class__.__name__}")
        log_callback(f"  model repr: {pa.model}")
        log_callback(f"--- System Prompt ({len(sys_text)} 字) ---")
        log_callback(sys_text)
        log_callback(f"--- User Message ({len(user_text)} 字) ---")
        log_callback(user_text[:5000] + ("…" if len(user_text) > 5000 else ""))
        log_callback("--- User Message End ---")

    result = await agent.run(
        user_text,
        model_settings=_init_model_settings(pa),
    )

    if log_callback:
        log_callback(f"--- LLM Raw Response ({len(result.output)} 字) ---")
        log_callback(result.output[:5000] + ("…" if len(result.output) > 5000 else ""))
        log_callback("--- Raw Response End ---")

    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object
    return parse_json_object(result.output)
