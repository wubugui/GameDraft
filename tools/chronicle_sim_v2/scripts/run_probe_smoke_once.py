"""一次性探针烟测：需设置 PYTHONPATH 指向 GameDraft 根目录。示例：
set PYTHONPATH=F:\\GameDraft && python tools\\chronicle_sim_v2\\scripts\\run_probe_smoke_once.py F:\\GameDraft\\tools\\chronicle_sim_v2\\runs\\2c163634562e
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from tools.chronicle_sim_v2.core.agents.probe_agent import run_probe_user_turn
from tools.chronicle_sim_v2.core.llm.client_factory import ClientFactory
from tools.chronicle_sim_v2.core.llm.config_resolve import provider_profile_for_agent
from tools.chronicle_sim_v2.core.world.fs import read_json
from tools.chronicle_sim_v2.paths import PROMPTS_DIR


async def main() -> None:
    if len(sys.argv) < 2:
        print(
            "usage: run_probe_smoke_once.py <run_dir> [question]",
            file=sys.stderr,
        )
        sys.exit(2)
    run_dir = Path(sys.argv[1]).resolve()
    llm = read_json(run_dir, "config/llm_config.json")
    if not isinstance(llm, dict):
        print("missing config/llm_config.json", file=sys.stderr)
        sys.exit(1)
    pa = ClientFactory.build_pa_chat(
        "probe",
        provider_profile_for_agent("probe", llm),
        llm,
        run_dir=run_dir,
    )
    print("run_dir:", run_dir, file=sys.stderr)
    if len(sys.argv) >= 3:
        q = " ".join(sys.argv[2:])
    else:
        q = (
            "第1周 chronicle/week_001/events 目录下有哪些 .json 文件名？"
            "请只列出文件名清单（每项一行），不要编造未出现的文件名。"
        )
    try:
        out = await run_probe_user_turn(
            pa,
            PROMPTS_DIR,
            run_dir,
            q,
            prior_turns_text=None,
        )
        print(out)
    finally:
        await pa.aclose()


if __name__ == "__main__":
    asyncio.run(main())
