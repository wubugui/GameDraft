"""对已有 Run 的某一周：只跑谣言传播（不调用 Cline），并输出统计。

通过临时目录复制源 Run 的 ``world/``、写入 ``max_llm_calls_per_event=0`` 的
``llm_config.json``（stub），保证 ``run_rumor_spread`` 内变异分支永不触发 LLM。
（不能用 ``world`` 符号链接：``read_json`` 在 ``resolve`` 后会判定路径越界。）

用法（仓库根目录）::

    set PYTHONPATH=%CD%
    python tools\\chronicle_sim_v2\\scripts\\run_rumor_week_stats.py --run-dir tools\\chronicle_sim_v2\\runs\\ed1e6d0493fd --week 1
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.chronicle_sim_v2.core.agents.event_normalize import normalize_event_for_rumors
from tools.chronicle_sim_v2.core.agents.rumor_agent import run_rumor_spread
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile
from tools.chronicle_sim_v2.core.llm.stub_llm import build_chronicle_stub_llm
from tools.chronicle_sim_v2.core.sim.run_manager import load_llm_config
from tools.chronicle_sim_v2.core.world.week_state import read_week_events


def _merge_llm_config_for_stats(source_cfg: dict, *, seed: int | None) -> dict:
    out = json.loads(json.dumps(source_cfg)) if isinstance(source_cfg, dict) else {}
    if not isinstance(out, dict):
        out = {}
    out.setdefault("default", {"kind": "stub"})
    rs = out.get("rumor_sim")
    if not isinstance(rs, dict):
        rs = {}
    rs = dict(rs)
    rs["max_llm_calls_per_event"] = 0
    out["rumor_sim"] = rs
    if seed is not None:
        out.setdefault("trace", {})
        if isinstance(out["trace"], dict):
            out["trace"]["rumor_stats_seed"] = seed
    return out


def _copy_world(src_run: Path, dst_run: Path) -> None:
    """复制 ``world/``，不用符号链接：本仓库 ``fs.read_json`` 在 ``resolve()`` 后会认为路径越界而读不到 symlink 后的文件。"""
    world_src = (src_run / "world").resolve()
    world_dst = dst_run / "world"
    if not world_src.is_dir():
        raise FileNotFoundError(f"缺少 world 目录: {world_src}")
    shutil.copytree(world_src, world_dst, symlinks=True)


async def _run(source_run: Path, week: int, seed: int | None) -> int:
    import random

    if seed is not None:
        random.seed(seed)

    events = read_week_events(source_run, week)
    if not events:
        print(f"错误: {source_run} 第 {week} 周无事件 JSON", file=sys.stderr)
        return 1

    raw_cfg = load_llm_config(source_run)
    merged = _merge_llm_config_for_stats(raw_cfg, seed=seed)

    tmp = Path(tempfile.mkdtemp(prefix="chronicle_rumor_week_stats_"))
    try:
        (tmp / "config").mkdir(parents=True, exist_ok=True)
        (tmp / "config" / "llm_config.json").write_text(
            json.dumps(merged, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        _copy_world(source_run, tmp)

        records: list[dict] = []
        for rec in events:
            if not isinstance(rec, dict):
                continue
            d = json.loads(json.dumps(rec))
            normalize_event_for_rumors(tmp, d)
            records.append(d)

        pa = AgentLLMResources(
            agent_id="rumor",
            profile=ProviderProfile(kind="stub"),
            llm=build_chronicle_stub_llm(),
            default_extra={},
            audit_run_dir=None,
        )
        rumors = await run_rumor_spread(pa, tmp, records, week=week)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    max_llm_cfg = int((merged.get("rumor_sim") or {}).get("max_llm_calls_per_event", -1))
    p_edge = float((merged.get("rumor_sim") or {}).get("p_follow_edge", 0.38))
    p_start = float((merged.get("rumor_sim") or {}).get("p_each_spreader_starts", 0.55))
    max_rounds = int((merged.get("rumor_sim") or {}).get("max_propagation_rounds", 12))

    print("=== 谣言传播统计（仅算法 + stub，max_llm_calls_per_event=0，不调 Cline）===")
    print(f"源 Run: {source_run.resolve()}")
    print(f"周次: {week}")
    print(f"随机种子: {seed!r}")
    print(f"本统计使用的 rumor_sim: max_llm_calls_per_event={max_llm_cfg}, max_propagation_rounds={max_rounds}, p_follow_edge={p_edge}, p_each_spreader_starts={p_start}")
    print()

    print(f"参与传播的事件数: {len(records)}")
    for i, rec in enumerate(records, 1):
        sp = rec.get("spread_agents") or []
        rel = rec.get("related_agents") or []
        print(
            f"  [{i}] id={rec.get('id')} type_id={rec.get('type_id')} "
            f"related_agents={len(rel)} spread_agents={len(sp)} starters_possible={len(sp)}"
        )

    print()
    print(f"谣言边条数（每条为 teller→hearer 一次传递）: {len(rumors)}")

    by_event = Counter(str(r.get("originating_event_id", "")) for r in rumors)
    print("按 originating_event_id 条数:")
    for eid, c in by_event.most_common():
        print(f"  {eid or '(空)'}: {c}")

    hops = Counter(int(r.get("propagation_hop", 0) or 0) for r in rumors)
    print("按 propagation_hop（轮次）条数:")
    for h in sorted(hops):
        print(f"  hop={h}: {hops[h]}")

    max_llm_field = [int(r.get("rumor_llm_used", 0) or 0) for r in rumors]
    print(f"rumor_llm_used 字段最大值（应为 0）: {max(max_llm_field) if max_llm_field else 0}")

    edges = {(str(r.get("teller_id", "")), str(r.get("hearer_id", ""))) for r in rumors}
    agents = set()
    for t, h in edges:
        agents.add(t)
        agents.add(h)
    print(f"不同传播边 (teller, hearer) 数: {len(edges)}")
    print(f"出现在谣言中的不同 agent id 数: {len(agents)}")

    teller_out = Counter(str(r.get("teller_id", "")) for r in rumors)
    hearer_in = Counter(str(r.get("hearer_id", "")) for r in rumors)
    print("传出次数最多的 teller（前 8）:")
    for aid, c in teller_out.most_common(8):
        if aid:
            print(f"  {aid}: {c}")
    print("被传入次数最多的 hearer（前 8）:")
    for aid, c in hearer_in.most_common(8):
        if aid:
            print(f"  {aid}: {c}")

    lens = [len(str(r.get("content", ""))) for r in rumors]
    if lens:
        print(f"content 字符长度: min={min(lens)} max={max(lens)} avg={sum(lens)/len(lens):.1f}")

    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="单周谣言传播统计（不调 LLM）")
    ap.add_argument("--run-dir", type=Path, required=True, help="已有 Run 根目录")
    ap.add_argument("--week", type=int, default=1)
    ap.add_argument("--seed", type=int, default=42, help="固定随机；传 -1 表示不固定")
    args = ap.parse_args()
    src = args.run_dir.resolve()
    seed = None if args.seed is not None and args.seed < 0 else args.seed
    return asyncio.run(_run(src, args.week, seed))


if __name__ == "__main__":
    raise SystemExit(main())
