"""Style Rewriter Agent：对月志进行文风润色，增加川渝方言和民国风味。"""
from __future__ import annotations

from pathlib import Path

import yaml
from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings
from tools.chronicle_sim_v2.paths import DATA_DIR


def build_rewriter_agent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
) -> Agent:
    p = prompts_dir / "style_rewriter.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是文风润色者。"

    # 加载文风指纹
    fp_file = DATA_DIR / "style_fingerprints.yaml"
    fingerprint_text = ""
    if fp_file.is_file():
        with open(fp_file, "r", encoding="utf-8") as f:
            fingerprint_text = yaml.safe_dump(yaml.safe_load(f), allow_unicode=True)

    if fingerprint_text:
        system += f"\n\n<style_fingerprints>\n{fingerprint_text}\n</style_fingerprints>"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
    )
    return agent


async def run_style_rewrite(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    text: str,
) -> str:
    """润色文本的川渝/民国风味。"""
    agent = build_rewriter_agent(pa, prompts_dir, run_dir)
    user_prompt = f"请润色以下文本，增强川渝方言和民国市井风味，但不改变事实：\n\n{text}"
    from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced
    result = await run_agent_traced(pa, agent, user_prompt, model_settings=merged_settings(pa))
    return result.output
