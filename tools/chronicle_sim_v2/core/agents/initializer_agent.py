"""Initializer Agent：从设定库生成 SeedDraft（Cline CLI，TOML spec 单源）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources, build_agent_llm_resources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import describe_api_key_for_log, run_agent_cline
from tools.chronicle_sim_v2.core.llm.config_resolve import provider_profile_for_agent


def build_initializer_pa(llm_config: dict[str, Any], run_dir: Path) -> AgentLLMResources:
    """从 llm_config 解析 initializer 槽（与「覆盖默认」规则一致）；仍为 stub 时回退 default。

    与界面「测试本槽连接」使用同一套 ``effective_connection_block`` / ``ProviderProfile`` 推导。
    """
    prof = provider_profile_for_agent("initializer", llm_config)
    if (prof.kind or "").strip().lower() in ("", "stub"):
        prof = provider_profile_for_agent("default", llm_config)
    return build_agent_llm_resources("initializer", prof, llm_config=llm_config, run_dir=run_dir)


async def run_initializer(
    pa: AgentLLMResources,
    run_dir: Path,
    ideas_text: str,
    log_callback=None,
    *,
    llm_config_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """运行 Initializer，返回 SeedDraft dict。

    ``llm_config_snapshot``：与界面当前表单一致的字典（如 ``LlmConfigForm.to_dict()``），
    避免未点击「保存」时 runner 仍读磁盘旧密钥。
    """
    spec = load_agent_spec("initializer")
    system_ctx = {"TARGET_NPC_COUNT": "10", "TRUNCATION_NOTE": ""}
    user_text = render_user(spec, {"ideas_text": ideas_text})

    if log_callback:
        log_callback("[种子] 步骤 1/4: 已组装 system / user（TOML spec）")
        log_callback("=== Cline 调用详情 ===")
        pk = pa.profile
        log_callback(
            f"  槽位: {pa.agent_id}  kind={pk.kind!r} model={pk.model!r} "
            f"base_url={pk.base_url!r}"
        )
        log_callback(
            f"  将交给 Cline ``auth -k`` 的密钥指纹（与下方 [Cline] 行一致）: "
            f"{describe_api_key_for_log(pk.api_key)}"
        )
        log_callback(f"--- System (.clinerules, {len(spec.system)} 字) 将由 runner 写入 cwd ---")
        log_callback(f"--- User ({len(user_text)} 字) ---")
        log_callback(user_text[:5000] + ("…" if len(user_text) > 5000 else ""))
        log_callback("--- User End ---")
        log_callback("[种子] 步骤 2/4: 启动独立 Cline 子进程…")
        log_callback(
            "[种子] 步骤 3/4: Cline 运行中（stderr 会实时出现在下方；"
            "若仍几乎无输出，可在 llm_config 顶层设 \"cline_verbose\": true）…"
        )

    res = await run_agent_cline(
        pa,
        run_dir,
        spec,
        user_text=user_text,
        system_ctx=system_ctx,
        phase_log=log_callback,
        llm_config_snapshot=llm_config_snapshot,
    )

    if log_callback:
        log_callback("[种子] 步骤 4/4: 解析 JSON…")
        log_callback(f"--- Cline Raw Response ({len(res.text)} 字) ---")
        log_callback(res.text[:5000] + ("…" if len(res.text) > 5000 else ""))
        log_callback("--- Raw Response End ---")

    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object

    return parse_json_object(res.text)
