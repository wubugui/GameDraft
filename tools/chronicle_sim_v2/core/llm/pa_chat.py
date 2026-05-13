"""向后兼容：实现已迁至 agent_llm。"""
from tools.chronicle_sim_v2.core.llm.agent_llm import (  # noqa: F401
    AgentLLMResources,
    PAChatResources,
    build_agent_llm_resources,
    build_pa_chat_resources,
    merged_llm_kwargs,
    merged_settings,
    trace_options_from_llm_config,
)
