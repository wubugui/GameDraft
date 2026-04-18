"""从 run 的 llm_config 字典解析 ProviderProfile（仅来自 GUI/数据库 JSON，不使用环境变量）。"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim.core.llm.client_factory import ProviderProfile


def effective_connection_block(agent_kind: str, cfg: dict[str, Any]) -> dict[str, Any]:
    """解析某槽位实际用于对话/嵌入推导的连接配置块。

    - 「默认」槽始终用 llm_config['default']。
    - 其它槽：override==True 用本槽字段；override==False 或未勾选时用「默认」槽。
    - 旧数据无 override 键时：kind 非 stub 视为曾单独配置（override等价 True），以免破坏已有 run。
    """
    if agent_kind == "default":
        b = cfg.get("default")
        return dict(b) if isinstance(b, dict) else {}
    default_block = cfg.get("default")
    if not isinstance(default_block, dict):
        default_block = {}
    agent_block = cfg.get(agent_kind)
    if not isinstance(agent_block, dict):
        agent_block = {}
    ov = agent_block.get("override")
    if ov is None:
        raw_kind = str(agent_block.get("kind", "")).strip().lower()
        use_slot = raw_kind not in ("", "stub")
    else:
        use_slot = bool(ov)
    return dict(agent_block) if use_slot else dict(default_block)


def provider_profile_for_agent(agent_kind: str, cfg: dict[str, Any]) -> ProviderProfile:
    block = effective_connection_block(agent_kind, cfg)
    if not block:
        block = {"kind": "stub"}
    return ProviderProfile(
        kind=str(block.get("kind", "stub")),
        base_url=str(block.get("base_url", "")),
        api_key=str(block.get("api_key", "")),
        model=str(block.get("model", "stub")),
        ollama_host=str(block.get("ollama_host", "http://127.0.0.1:11434")),
    )


def embedding_profile_explicit_only(llm_config: dict[str, Any]) -> ProviderProfile | None:
    """仅使用 llm_config['embeddings']（表单顶部嵌入区），不从 NPC/默认对话推导。"""
    block = llm_config.get("embeddings")
    if not isinstance(block, dict) or not str(block.get("kind", "")).strip():
        return None
    kind = str(block.get("kind", "")).lower()
    if kind in ("none", "off", "disabled", "stub"):
        return None
    mid = str(block.get("model", "")).strip()
    if not mid:
        return None
    return ProviderProfile(
        kind=str(block.get("kind", "ollama")),
        base_url=str(block.get("base_url", "")),
        api_key=str(block.get("api_key", "")),
        model=mid,
        ollama_host=str(block.get("ollama_host", "http://127.0.0.1:11434")),
    )


def embedding_profile_from_config(llm_config: dict[str, Any]) -> ProviderProfile | None:
    block = llm_config.get("embeddings")
    if isinstance(block, dict) and str(block.get("kind", "")).strip():
        kind = str(block.get("kind", "")).lower()
        if kind in ("none", "off", "disabled", "stub"):
            return None
        mid = str(block.get("model", "")).strip()
        if not mid:
            return None
        return ProviderProfile(
            kind=str(block.get("kind", "ollama")),
            base_url=str(block.get("base_url", "")),
            api_key=str(block.get("api_key", "")),
            model=mid,
            ollama_host=str(block.get("ollama_host", "http://127.0.0.1:11434")),
        )
    # 未配置顶层「嵌入」时，仅从对话槽推导；必须在该槽写明 embed_model / embedding_model，
    # 禁止静默套用与当前网关无关的默认模型 id（否则易404 且难排查）。
    for key in ("tier_s_npc", "tier_a_npc", "default"):
        eff = effective_connection_block(key, llm_config)
        if not eff:
            continue
        kind = str(eff.get("kind", "")).lower()
        emb_id = str(eff.get("embed_model") or eff.get("embedding_model") or "").strip()
        if not emb_id:
            continue
        if kind == "ollama":
            return ProviderProfile(
                kind="ollama",
                base_url="",
                api_key="",
                model=emb_id,
                ollama_host=str(eff.get("ollama_host", "http://127.0.0.1:11434")),
            )
        if kind == "openai_compat":
            return ProviderProfile(
                kind="openai_compat",
                base_url=str(eff.get("base_url", "https://api.openai.com/v1")),
                api_key=str(eff.get("api_key", "")),
                model=emb_id,
                ollama_host="",
            )
    return None
