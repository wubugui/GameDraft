"""从 ProviderProfile + llm_config 构造 CrewAI LLM（显式 api_key/base_url）。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from crewai import LLM

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
    """每个 agent 槽位一份：CrewAI LLM + 默认额外参数 + 可选审计。"""

    agent_id: str
    llm: LLM
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


def _llm_from_parts(
    *,
    model: str,
    api_key: str | None,
    base_url: str | None,
    extra: dict[str, Any],
) -> LLM:
    """构造 CrewAI 0.86 LLM；未声明的键进入 litellm kwargs（如 thinking、extra_body）。"""
    ex = dict(extra)
    mt = ex.pop("max_tokens", None)
    return LLM(model=model, api_key=api_key, base_url=base_url, max_tokens=mt, **ex)


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
        model_name = profile.model or "gpt-4o-mini"
        api_key = (profile.api_key or "").strip() or "no-api-key"
        defaults = _base_extra_for_endpoint(kind="openai_compat", base_url=profile.base_url or "")
        llm = _llm_from_parts(
            model=f"openai/{model_name}",
            api_key=api_key,
            base_url=base_url,
            extra=defaults,
        )
        return AgentLLMResources(
            agent_id=agent_id,
            llm=llm,
            default_extra=defaults,
            audit_run_dir=audit_dir,
            trace=trace_opts,
        )

    if kind == "ollama":
        host = (profile.ollama_host or "http://127.0.0.1:11434").rstrip("/")
        model_name = profile.model or "llama3"
        defaults = _base_extra_for_endpoint(kind="ollama", base_url=host)
        llm = _llm_from_parts(
            model=f"ollama/{model_name}",
            api_key="ollama",
            base_url=host,
            extra=defaults,
        )
        return AgentLLMResources(
            agent_id=agent_id,
            llm=llm,
            default_extra=defaults,
            audit_run_dir=audit_dir,
            trace=trace_opts,
        )

    stub = build_chronicle_stub_llm()
    return AgentLLMResources(
        agent_id=agent_id,
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


def resolve_llm_for_run(res: AgentLLMResources, overrides: dict[str, Any]) -> LLM:
    """将 default_extra 与 overrides 合并后构造新 LLM（用于温度、thinking 等单次覆盖）。"""
    merged = merged_llm_kwargs(res, overrides)
    if isinstance(res.llm, ChronicleStubLLM):
        return res.llm
    b = res.llm
    return _llm_from_parts(
        model=b.model,
        api_key=b.api_key,
        base_url=b.base_url,
        extra=merged,
    )


PAChatResources = AgentLLMResources
build_pa_chat_resources = build_agent_llm_resources
merged_settings = merged_llm_kwargs
