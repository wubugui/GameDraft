"""Style Rewriter Agent：对月志进行文风润色，增加川渝方言和民国风味。"""
from __future__ import annotations

from pathlib import Path

import yaml

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced
from tools.chronicle_sim_v2.paths import DATA_DIR


async def run_style_rewrite(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    text: str,
) -> str:
    """润色文本的川渝/民国风味。"""
    _ = run_dir
    p = prompts_dir / "style_rewriter.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是文风润色者。"
    fp_file = DATA_DIR / "style_fingerprints.yaml"
    fingerprint_text = ""
    if fp_file.is_file():
        with open(fp_file, "r", encoding="utf-8") as f:
            fingerprint_text = yaml.safe_dump(yaml.safe_load(f), allow_unicode=True)

    if fingerprint_text:
        system += f"\n\n<style_fingerprints>\n{fingerprint_text}\n</style_fingerprints>"

    user_prompt = f"请润色以下文本，增强川渝方言和民国市井风味，但不改变事实：\n\n{text}"
    crew = make_single_agent_crew(
        pa,
        role="文风润色者",
        goal="润色文本并保持事实。",
        backstory=system,
        tools=[],
        task_description=user_prompt,
        expected_output="润色后的正文。",
        max_iter=15,
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_prompt, audit_system_hint=system[:8000])
    return crew_output_text(out)
