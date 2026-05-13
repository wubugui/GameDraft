"""对手动烟测：连续跑几条探针请求。用法见文件末尾。"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from tools.chronicle_sim_v2.core.agents.probe_agent import run_probe_user_turn
from tools.chronicle_sim_v2.core.llm.client_factory import ClientFactory
from tools.chronicle_sim_v2.core.llm.config_resolve import provider_profile_for_agent
from tools.chronicle_sim_v2.core.world.fs import read_json


async def main() -> None:
    if len(sys.argv) < 2:
        print("usage: probe_manual_exercise.py <run_dir>", file=sys.stderr)
        sys.exit(2)
    run_dir = Path(sys.argv[1]).resolve()
    llm = read_json(run_dir, "config/llm_config.json")
    if not isinstance(llm, dict):
        print("missing config", file=sys.stderr)
        sys.exit(1)

    qs = [
        (
            "A filenames",
            "第1周 chronicle/week_001/events 下有哪些 .json 文件名？只列文件名每行一个。",
        ),
        (
            "B summary line",
            "只读 chronicle/week_003/summary.md：把正文第一段的第一句话原样写出来，并在引用 JSON 填 path 与 quote。",
        ),
        (
            "C empty should fail or empty refs",
            "编年史里有没有出现「星际战舰」四个字？若没有，请说明未找到，引用用 []。",
        ),
    ]

    pa = ClientFactory.build_pa_chat(
        "probe",
        provider_profile_for_agent("probe", llm),
        llm,
        run_dir=run_dir,
    )
    try:
        for label, q in qs:
            print("\n" + "=" * 72, file=sys.stderr)
            print(label, file=sys.stderr)
            print("=" * 72 + "\n", file=sys.stderr)
            out = await run_probe_user_turn(
                pa, run_dir, q, prior_turns_text=None
            )
            print(out)
            print()
    finally:
        await pa.aclose()


if __name__ == "__main__":
    asyncio.run(main())
