"""Style Rewriter Agent：对月志进行文风润色（Cline CLI）。"""
from __future__ import annotations

from pathlib import Path

import yaml

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline
from tools.chronicle_sim_v2.paths import DATA_DIR


def _fingerprints_block() -> str:
    fp_file = DATA_DIR / "style_fingerprints.yaml"
    if not fp_file.is_file():
        return ""
    with fp_file.open("r", encoding="utf-8") as f:
        fingerprint_text = yaml.safe_dump(yaml.safe_load(f), allow_unicode=True)
    if not fingerprint_text:
        return ""
    return f"<style_fingerprints>\n{fingerprint_text}\n</style_fingerprints>"


async def run_style_rewrite(
    pa: AgentLLMResources,
    run_dir: Path,
    text: str,
    *,
    world_bible_text: str = "",
) -> str:
    spec = load_agent_spec("style_rewriter")
    system_ctx = {"style_fingerprints_block": _fingerprints_block()}
    user_text = render_user(
        spec,
        {
            "text": text,
            "world_bible_text": world_bible_text or "（本 run 暂无世界 JSON）",
        },
    )
    res = await run_agent_cline(
        pa, run_dir, spec, user_text=user_text, system_ctx=system_ctx
    )
    return res.text
