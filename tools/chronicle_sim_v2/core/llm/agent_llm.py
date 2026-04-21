"""Agent 槽位资源：Provider 配置 + 审计/追踪（由 Cline CLI 执行，不再使用 CrewAI LLM）。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.audit_log import audit_enabled_from_config
from tools.chronicle_sim_v2.core.llm.pa_dashscope import is_dashscope_openai_compat_base
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile
from tools.chronicle_sim_v2.core.llm.stub_llm import ChronicleStubLLM, build_chronicle_stub_llm


def trace_options_from_llm_config(llm_config: dict[str, Any] | None) -> dict[str, Any]:
    """从 runs.llm_config_json['trace'] 解析调试追踪选项（无则用默认）。"""
    raw = (llm_config or {}).get("trace")
    if not isinstance(raw, dict):
        raw = {}
    try:
        mc = int(raw.get("max_chars", 800_000))
    except (TypeError, ValueError):
        mc = 800_000
    return {
        "full_messages_json": bool(raw.get("full_messages_json", True)),
        "max_chars": max(4096, mc),
        "full_user_prompt": bool(raw.get("full_user_prompt", False)),
    }


@dataclass
class AgentLLMResources:
    """每个 agent 槽位：连接配置 + 可选 Stub 标记 + 审计。"""

    agent_id: str
    profile: ProviderProfile
    llm: Any  # ChronicleStubLLM 或 None；保留字段供 isinstance 检测 stub
    default_extra: dict[str, Any]
    audit_run_dir: Path | None
    trace: dict[str, Any] = field(default_factory=dict)

    async def aclose(self) -> None:
        return None


def _merge_extra(base: dict[str, Any] | None, *overrides: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = dict(base or {})
    for o in overrides:
        if not o:
            continue
        for k, v in o.items():
            out[k] = v
    return out


def _base_extra_for_endpoint(*, kind: str, base_url: str) -> dict[str, Any]:
    if kind == "openai_compat":
        if is_dashscope_openai_compat_base(base_url):
            return {
                "thinking": False,
                "extra_body": {"enable_thinking": False},
            }
        return {"max_tokens": 16_384}
    if kind == "ollama":
        return {"max_tokens": 16_384}
    return {}


def build_agent_llm_resources(
    agent_id: str,
    profile: ProviderProfile,
    llm_config: dict[str, Any] | None = None,
    *,
    run_dir: Path | None = None,
) -> AgentLLMResources:
    kind = (profile.kind or "").lower()
    audit = audit_enabled_from_config(llm_config) and run_dir is not None
    audit_dir = run_dir if audit else None
    trace_opts = trace_options_from_llm_config(llm_config)

    if kind == "openai_compat":
        base_url = (profile.base_url or "https://api.openai.com/v1").rstrip("/")
        defaults = _base_extra_for_endpoint(kind="openai_compat", base_url=profile.base_url or "")
        return AgentLLMResources(
            agent_id=agent_id,
            profile=profile,
            llm=None,
            default_extra=defaults,
            audit_run_dir=audit_dir,
            trace=trace_opts,
        )

    if kind == "ollama":
        host = (profile.ollama_host or "http://127.0.0.1:11434").rstrip("/")
        defaults = _base_extra_for_endpoint(kind="ollama", base_url=host)
        return AgentLLMResources(
            agent_id=agent_id,
            profile=profile,
            llm=None,
            default_extra=defaults,
            audit_run_dir=audit_dir,
            trace=trace_opts,
        )

    stub = build_chronicle_stub_llm()
    return AgentLLMResources(
        agent_id=agent_id,
        profile=ProviderProfile(kind="stub", model="", base_url="", api_key="", ollama_host=""),
        llm=stub,
        default_extra={},
        audit_run_dir=audit_dir,
        trace=trace_opts,
    )


def merged_llm_kwargs(
    res: AgentLLMResources,
    *overrides: dict[str, Any] | None,
) -> dict[str, Any]:
    return _merge_extra(res.default_extra, *overrides)


def resolve_llm_for_run(res: AgentLLMResources, overrides: dict[str, Any]) -> Any:
    """兼容旧代码：合并单次覆盖参数（如 initializer 的 thinking）；Cline 路径在 runner 内消费。"""
    return merged_llm_kwargs(res, overrides)


PAChatResources = AgentLLMResources
build_pa_chat_resources = build_agent_llm_resources
merged_settings = merged_llm_kwargs
