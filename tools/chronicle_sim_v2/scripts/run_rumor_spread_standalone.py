"""单独跑谣言传播阶段，校验图传播与「走样」抽样（默认 stub，不耗真实 API）。

用法（仓库根目录）::

    set PYTHONPATH=%CD%
    python tools\\chronicle_sim_v2\\scripts\\run_rumor_spread_standalone.py

可选：``--seed 42`` 固定随机；``--runs 5`` 多跑几轮看统计。

对真实 Run 目录（已含 ``world/agents``、``world/relationships/graph.json``、``config/llm_config.json``）::

    python tools\\chronicle_sim_v2\\scripts\\run_rumor_spread_standalone.py --run-dir <run_dir绝对路径>
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.chronicle_sim_v2.core.agents.event_normalize import normalize_event_for_rumors
from tools.chronicle_sim_v2.core.agents.rumor_agent import mutation_probability, run_rumor_spread
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile
from tools.chronicle_sim_v2.core.llm.stub_llm import build_chronicle_stub_llm
from tools.chronicle_sim_v2.core.sim.run_manager import load_llm_config
from tools.chronicle_sim_v2.core.world.fs import write_json


def _minimal_run_dir(base: Path) -> None:
    (base / "config").mkdir(parents=True, exist_ok=True)
    llm = {
        "default": {"kind": "stub"},
        "rumor_sim": {
            "p_follow_edge": 1.0,
            "p_each_spreader_starts": 1.0,
            "max_llm_calls_per_event": 8,
            "max_propagation_rounds": 6,
        },
    }
    (base / "config" / "llm_config.json").write_text(
        json.dumps(llm, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    for aid in ("s1", "b1", "b2", "b3"):
        write_json(
            base,
            f"world/agents/{aid}.json",
            {"id": aid, "name": aid, "current_tier": "S" if aid == "s1" else "B", "life_status": "alive"},
        )
    write_json(
        base,
        "world/relationships/graph.json",
        [
            {"from_agent_id": "s1", "to_agent_id": "b1", "strength": 0.9, "edge_type": "x"},
            {"from_agent_id": "b1", "to_agent_id": "b2", "strength": 0.8, "edge_type": "x"},
            {"from_agent_id": "b2", "to_agent_id": "b3", "strength": 0.7, "edge_type": "x"},
        ],
    )


def _sample_event() -> dict:
    return {
        "id": "evt_standalone",
        "type_id": "teahouse_gossip",
        "witness_accounts": [
            {"agent_id": "s1", "account_text": "茶馆里听见两句闲话，未必当真。", "supernatural_hint": ""},
        ],
        "actor_ids": ["s1"],
        "related_agents": ["s1"],
        "spread_agents": ["s1"],
    }


async def _main_async(run_dir: Path, runs: int) -> int:
    from tools.chronicle_sim_v2.core.agents.rumor_agent import _max_llm_per_event

    cfg = load_llm_config(run_dir)
    max_llm = _max_llm_per_event(cfg)
    max_r = int((cfg.get("rumor_sim") or {}).get("max_propagation_rounds", 12))

    print(f"run_dir={run_dir.resolve()}")
    print(f"单条事件谣言走样 LLM 上限 max_llm_calls_per_event = {max_llm}（来自磁盘 llm_config，未配置时默认 32）")
    print(
        f"首跳示例：mutation_probability(rem={max_llm}, max={max_llm}, rnd=1, max_rounds={max_r}) = "
        f"{mutation_probability(max_llm, max_llm, 1, max_r):.4f}"
    )

    pa = AgentLLMResources(
        agent_id="rumor",
        profile=ProviderProfile(kind="stub"),
        llm=build_chronicle_stub_llm(),
        default_extra={},
        audit_run_dir=None,
    )

    total_rumors = 0
    total_stub_distort = 0
    for i in range(runs):
        rec = _sample_event()
        normalize_event_for_rumors(run_dir, rec)
        rumors = await run_rumor_spread(pa, run_dir, [rec], week=1)
        total_rumors += len(rumors)
        base = "茶馆里听见两句闲话，未必当真。"
        stub_text = "码头上有人风传，昨夜货栈闹出动静，细节对不上号，当不得真。"
        for r in rumors:
            c = str(r.get("content", ""))
            if c != base and stub_text in c:
                total_stub_distort += 1
        print(f"  run {i + 1}/{runs}: {len(rumors)} 条谣言, stub 走样条数 {sum(1 for r in rumors if stub_text in str(r.get('content','')))}")

    print(f"合计: {total_rumors} 条谣言, 其中走样后含 stub 典型句: {total_stub_distort}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="单独运行谣言传播（默认临时目录 + stub）")
    ap.add_argument("--run-dir", type=Path, default=None, help="已有 Run；不填则创建临时最小世界")
    ap.add_argument("--seed", type=int, default=None, help="随机种子")
    ap.add_argument("--runs", type=int, default=3, help="重复跑几轮（不同随机边/变异抽样）")
    args = ap.parse_args()
    if args.seed is not None:
        random.seed(args.seed)

    if args.run_dir is not None:
        run_dir = args.run_dir.resolve()
        if not (run_dir / "config" / "llm_config.json").is_file():
            print("错误: run_dir 下缺少 config/llm_config.json", file=sys.stderr)
            return 1
    else:
        tmp = tempfile.mkdtemp(prefix="chronicle_rumor_standalone_")
        run_dir = Path(tmp)
        _minimal_run_dir(run_dir)

    return asyncio.run(_main_async(run_dir, max(1, args.runs)))


if __name__ == "__main__":
    raise SystemExit(main())
